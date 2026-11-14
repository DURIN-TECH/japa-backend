// ============================================
// Feedback service (issue #257)
// ============================================
//
// In-app tester feedback: a signed-in user sends a bug report or an idea from
// the mobile app, optionally with a screenshot. This service
//   1. rate limits (10 notes per user per hour),
//   2. stores the note in the backend-only `feedback` collection,
//   3. emails the team (best effort: the note is already saved).
//
// All side effects sit behind `FeedbackDeps` so the tests can run the real
// logic against in-memory fakes (no Firestore, Storage or Resend).

import { Timestamp } from "firebase-admin/firestore";
import { collections, db } from "../utils/firebase";
import { emailService } from "./email/email.service";
import type { EmailResult } from "./email/email.types";
import { storageService } from "./storage.service";
import type { Feedback } from "../types";

// ============================================
// Constants
// ============================================

/** Notes one user may send per rolling hour. */
export const FEEDBACK_HOURLY_LIMIT = 10;

/** Window the limit counts over. */
export const FEEDBACK_WINDOW_MS = 60 * 60 * 1000;

/** Where feedback goes when FEEDBACK_TO_EMAIL is not set. */
export const DEFAULT_FEEDBACK_RECIPIENT = "info@weareseli.com";

/** How long the screenshot link in the email stays valid, in minutes (just under the 7-day v4 maximum). */
export const SCREENSHOT_LINK_MINUTES = 7 * 24 * 60 - 5;

/** Screenshot upload URLs one user may mint per clock hour. */
export const SCREENSHOT_URL_HOURLY_LIMIT = 20;

/** How much of the message goes into the email subject. */
const SUBJECT_PREVIEW_CHARS = 60;

// ============================================
// Types
// ============================================

/** What the controller hands over: validated input plus facts from the token. */
export type NewFeedback = Omit<Feedback, "id" | "status" | "createdAt">;

/** Side effects the service needs. Tests replace these. */
export interface FeedbackDeps {
  /** How many notes `userId` created at or after `sinceMs`. */
  countSince(userId: string, sinceMs: number): Promise<number>;
  /** Persist a note, return its id. */
  save(doc: Omit<Feedback, "id">): Promise<string>;
  /** True when an object exists in the bucket. */
  fileExists(path: string): Promise<boolean>;
  /** Signed read link for a stored screenshot. */
  signDownload(path: string, minutes: number): Promise<string>;
  /** Send the team email. */
  sendEmail(message: { to: string; subject: string; html: string; text: string }): Promise<EmailResult>;
  /** Atomically use one screenshot-URL slot for the hour; false when the hour's limit is reached. */
  consumeUploadSlot(userId: string, hour: number, limit: number): Promise<boolean>;
  /** Clock, epoch ms. */
  now(): number;
}

/** Result of `submit`. */
export type SubmitResult =
  | { ok: true; id: string; screenshotAttached: boolean }
  | { ok: false; reason: "RATE_LIMITED"; retryAfterSeconds: number };

// ============================================
// Pure helpers (exported for tests)
// ============================================

/** Escape user-controlled text before it goes into HTML. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** `[Seli feedback] bug: <first 60 chars>`, on one line (no header injection). */
export function buildSubject(kind: string, message: string): string {
  const oneLine = message.replace(/\s+/g, " ").trim();
  const preview =
    oneLine.length > SUBJECT_PREVIEW_CHARS ? `${oneLine.slice(0, SUBJECT_PREVIEW_CHARS)}…` : oneLine;
  return `[Seli feedback] ${kind}: ${preview}`;
}

/**
 * Build the email body (HTML and plain text) listing every field. Every
 * user-supplied value is HTML-escaped; the screenshot link is the one value
 * we generate ourselves, and it is escaped too before it goes in an attribute.
 */
export function buildEmailBody(
  fb: NewFeedback,
  feedbackId: string,
  screenshotUrl: string | null
): { html: string; text: string } {
  const rows: [string, string][] = [
    ["Kind", fb.kind],
    ["From", `${fb.userEmail} (${fb.userId})`],
    ["Role", fb.role],
    ["Screen", fb.route],
    ["App version", fb.appVersion],
    ["Environment", fb.appEnv],
    ["Platform", `${fb.platform} ${fb.osVersion}`.trim()],
    ["Feedback id", feedbackId],
  ];

  const htmlRows = rows
    .map(
      ([k, v]) =>
        `<tr><td style="padding:2px 12px 2px 0;color:#555;">${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`
    )
    .join("");

  const screenshotHtml = screenshotUrl
    ? `<p><a href="${escapeHtml(screenshotUrl)}">Open the screenshot</a> (link valid for 7 days)</p>`
    : "<p>No screenshot.</p>";

  // white-space:pre-wrap keeps the tester's line breaks.
  const html =
    "<div style=\"font-family:Arial,sans-serif;font-size:14px;color:#111;\">" +
    `<table>${htmlRows}</table>` +
    "<h3 style=\"margin:16px 0 4px;\">Message</h3>" +
    `<div style="white-space:pre-wrap;">${escapeHtml(fb.message)}</div>` +
    screenshotHtml +
    "</div>";

  const text =
    rows.map(([k, v]) => `${k}: ${v}`).join("\n") +
    `\n\nMessage:\n${fb.message}\n\n` +
    (screenshotUrl ? `Screenshot (valid 7 days): ${screenshotUrl}` : "No screenshot.");

  return { html, text };
}

// ============================================
// Service
// ============================================

export class FeedbackService {
  /** Real side effects by default; tests assign fakes. */
  deps: FeedbackDeps = {
    // Needs the composite index (userId ==, createdAt >=) in firestore.indexes.json.
    countSince: async (userId, sinceMs) => {
      const snap = await collections.feedback
        .where("userId", "==", userId)
        .where("createdAt", ">=", Timestamp.fromMillis(sinceMs))
        .count()
        .get();
      return snap.data().count;
    },
    save: async (doc) => {
      const ref = await collections.feedback.add(doc);
      return ref.id;
    },
    fileExists: (path) => storageService.fileExists(path),
    signDownload: (path, minutes) => storageService.getSignedDownloadUrl(path, minutes),
    sendEmail: (message) => emailService.send(message),
    // One counter doc per user and clock hour, read and bumped in a transaction
    // so parallel requests cannot both slip under the limit.
    consumeUploadSlot: (userId, hour, limit) =>
      db.runTransaction(async (tx) => {
        const ref = collections.feedbackUploadLimits.doc(`${userId}__${hour}`);
        const snap = await tx.get(ref);
        const count = snap.exists ? Number((snap.data() as { count?: number }).count ?? 0) : 0;
        if (count >= limit) return false;
        tx.set(ref, { userId, hour, count: count + 1 });
        return true;
      }),
    now: () => Date.now(),
  };

  /** True when the user may mint another screenshot upload URL this hour. */
  async allowScreenshotUrl(userId: string): Promise<boolean> {
    const hour = Math.floor(this.deps.now() / FEEDBACK_WINDOW_MS);
    return this.deps.consumeUploadSlot(userId, hour, SCREENSHOT_URL_HOURLY_LIMIT);
  }

  /** Team inbox: FEEDBACK_TO_EMAIL (non-secret env) or the default. */
  get recipient(): string {
    return process.env.FEEDBACK_TO_EMAIL?.trim() || DEFAULT_FEEDBACK_RECIPIENT;
  }

  /**
   * Store a note and email the team.
   *
   * The caller has already validated the input and checked that
   * `screenshotPath` belongs to this user. Here we only drop a path whose
   * upload never completed (the note is still worth keeping).
   *
   * The rate-limit check is a read followed by a write, so a burst of
   * parallel requests can overshoot the limit slightly; that is acceptable
   * for an abuse guard on an authenticated, low-volume endpoint.
   */
  async submit(input: NewFeedback): Promise<SubmitResult> {
    const now = this.deps.now();

    // 1. Abuse guard.
    const recent = await this.deps.countSince(input.userId, now - FEEDBACK_WINDOW_MS);
    if (recent >= FEEDBACK_HOURLY_LIMIT) {
      // The oldest note in the window ages out within the hour; a flat
      // "try again later" hint is enough, so report the full window.
      return { ok: false, reason: "RATE_LIMITED", retryAfterSeconds: FEEDBACK_WINDOW_MS / 1000 };
    }

    // 2. Keep the screenshot only if the client really uploaded it.
    let screenshotPath = input.screenshotPath;
    if (screenshotPath && !(await this.deps.fileExists(screenshotPath))) {
      console.warn("[feedback] screenshot path was never uploaded; saving the note without it");
      screenshotPath = null;
    }

    // 3. Store.
    const doc: Omit<Feedback, "id"> = {
      ...input,
      screenshotPath,
      status: "new",
      createdAt: Timestamp.fromMillis(now),
    };
    const id = await this.deps.save(doc);

    // 4. Email, best effort. The note is saved, so nothing below may throw.
    try {
      const screenshotUrl = screenshotPath
        ? await this.deps.signDownload(screenshotPath, SCREENSHOT_LINK_MINUTES)
        : null;
      const { html, text } = buildEmailBody(input, id, screenshotUrl);
      const result = await this.deps.sendEmail({
        to: this.recipient,
        subject: buildSubject(input.kind, input.message),
        html,
        text,
      });
      if (result.status !== "sent") {
        console.warn(`[feedback] team email ${result.status} for ${id}: ${result.error ?? ""}`);
      }
    } catch (e) {
      console.error(`[feedback] team email failed for ${id}:`, e);
    }

    return { ok: true, id, screenshotAttached: screenshotPath !== null };
  }
}

export const feedbackService = new FeedbackService();
