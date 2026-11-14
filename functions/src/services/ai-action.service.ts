import { createHash } from "crypto";
import { Timestamp } from "firebase-admin/firestore";
import { ROLES } from "@durin-tech/authz";
import { db, subcollections } from "../utils/firebase";
import { layerVersionsOf, rubricRouteKey, rubricStore, sameStackVersions, type VisaRubric } from "../scrapers";
import { defaultRulebookStack } from "./ai/application-rulebook";
import type { Application, DocumentRequest } from "../types";
import type {
  ApplicationAssessment,
  ProposedAction,
  ProposedActionEffort,
  ProposedActionOrigin,
  ProposedActionOwner,
} from "../types/assessment";
import type { AssessmentContent } from "./ai/assessment-engine";
import { findBannedWording } from "./ai/prompt-safety";
import { documentRequestService } from "./document-request.service";
import { noteService } from "./note.service";

// ============================================
// AI PROPOSED ACTIONS (issue #44)
// ============================================
//
// An assessment finding says what is wrong and `whatWouldHelp`. This service
// turns each finding into a PROPOSED ACTION, and turns an accepted blocking,
// client-owned action into a real DocumentRequest. The rules it holds:
//
//   1. PROPOSALS ARE INERT. `writeForAssessment` writes documents under the
//      assessment and nothing else: no DocumentRequest, no notification, no
//      note, nothing an applicant can see. Only `accept` makes anything real,
//      and only a human with access reaches it (the handler checks).
//   2. NO FREE-FLOATING ADVICE. Every action carries a `criterionId`, and it is
//      checked against the rubric VERSION THE ASSESSMENT USED. One that does not
//      resolve is dropped at write time and logged (a count, never the text).
//   3. NO NEW WRITE PATH. Accept calls `documentRequestService.create` (the
//      existing service), inside the same transaction that flips the action.
//   4. IDEMPOTENT. Action ids are deterministic (same finding, same id), the
//      DocumentRequest id is deterministic from the action id, and accept reads
//      the action inside a transaction: two concurrent accepts make one request.
//   5. HONEST WORDING. A judgement criterion is phrased as strengthening
//      evidence, never as "fix this refusal". Banned wording (the #42 list) and
//      advice to omit or misstate the applicant's circumstances are dropped.
//   6. NOTHING INTERNAL. The model's credibility reasoning (`detail`) and
//      `internalCall` are never copied into an action. An action carries the
//      finding's `whatWouldHelp` (already part of the full response a client
//      sees) and rubric text only.

/** Longest text stored in an action. Keeps a runaway model string out of a request. */
const MAX_TITLE = 200;
const MAX_EVIDENCE = 600;
const MAX_REASON = 500;

/**
 * Advice to leave something out or to misstate it is never proposed (plan rule
 * 2): an action may lead with a third party's evidence, it may not tell the
 * applicant to omit or hide their own circumstances.
 */
const DISHONEST_ADVICE: RegExp[] = [
  /\b(omit|omitting|leave out|leaving out|conceal|concealing|hide|hiding|withhold|withholding)\b/i,
  /\b(do not|don't|dont|avoid|no need to)\s+(mention|disclose|declare|say|state|tell|reveal)\b/i,
  /\bnot\s+(mention|disclose|declare|reveal)\b/i,
  /\b(misstate|misrepresent|exaggerate|falsify|pretend)\b/i,
];

/** True when proposed text breaks the wording rules. */
export function breaksWordingRules(text: string): boolean {
  return findBannedWording(text) || DISHONEST_ADVICE.some((re) => re.test(text));
}

/** Action id: deterministic from the assessment, the criterion and the kind of finding. */
export function actionIdFor(assessmentId: string, criterionId: string, origin: ProposedActionOrigin): string {
  return createHash("sha256").update(`${assessmentId}:${criterionId}:${origin}`).digest("hex").slice(0, 32);
}

/** The DocumentRequest id an accepted action creates. Deterministic, so a repeat collapses onto it. */
export function documentRequestIdFor(actionId: string): string {
  return `ai_${actionId}`;
}

/** Trim and cap a string. */
function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

// ============================================
// Derivation (pure)
// ============================================

/** One finding, reduced to what an action needs. */
interface Finding {
  criterionId: string;
  origin: ProposedActionOrigin;
  // The finding's `whatWouldHelp`, or "" when it has none (an insufficient item).
  whatWouldHelp: string;
}

/** What `derive` returns: the actions to write, and how many findings were dropped. */
export interface DerivedActions {
  actions: Array<Omit<ProposedAction, "createdAt" | "updatedAt">>;
  droppedCount: number;
}

/**
 * Derive proposals from an assessment's findings. PURE: no Firebase call.
 *
 * Shape per finding, decided in code from the rubric criterion's `kind`
 * (never from model text):
 *   - judgement criterion      -> client, NOT blocking, "Strengthen your evidence: ...";
 *   - mandatory bar            -> agent, NOT blocking (a rule that applies to the
 *                                 applicant; an agent considers the route, the
 *                                 client has no document to supply);
 *   - objective criterion      -> client, BLOCKING when it is a failed check or an
 *                                 undecided one (a document is what is missing).
 * `estEffort` follows the same split.
 */
export function deriveProposedActions(
  assessment: Pick<ApplicationAssessment, "id" | "applicationId" | "userId" | "agencyId">,
  rubric: Pick<VisaRubric, "criteria" | "evidenceItems">,
  content: Pick<AssessmentContent, "refusalGrounds" | "credibilityFlags" | "insufficientInformation">
): DerivedActions {
  const findings: Finding[] = [
    ...content.refusalGrounds.map((g) => ({ criterionId: g.criterionId, origin: "refusal_ground" as const, whatWouldHelp: g.whatWouldHelp ?? "" })),
    ...content.credibilityFlags.map((f) => ({ criterionId: f.criterionId, origin: "credibility_flag" as const, whatWouldHelp: f.whatWouldHelp ?? "" })),
    // (#207) A rule that could not be told to apply is waiting on an intake
    // answer, not on a document: no evidence action is proposed for it.
    ...content.insufficientInformation.filter((i) => !i.notAssessed).map((i) => ({ criterionId: i.criterionId, origin: "insufficient_information" as const, whatWouldHelp: "" })),
  ];

  const actions: DerivedActions["actions"] = [];
  const seen = new Set<string>();
  let droppedCount = 0;

  for (const f of findings) {
    // Rule 2: the cited criterion must exist in the rubric version used.
    const criterion = rubric.criteria.find((c) => c.criterionId === f.criterionId);
    if (!criterion) {
      droppedCount++;
      continue;
    }
    const id = actionIdFor(assessment.id, f.criterionId, f.origin);
    if (seen.has(id)) continue;
    seen.add(id);

    // Evidence items of the rubric that name this criterion (applicant's first).
    const items = rubric.evidenceItems
      .filter((e) => e.criterionIds.includes(f.criterionId))
      .sort((a, b) => Number(b.party === "applicant") - Number(a.party === "applicant"));

    const isJudgement = criterion.kind === "judgement";
    const isBar = criterion.kind === "mandatory_bar";

    // Title: a judgement action strengthens evidence; otherwise name the document
    // the rubric asks for, else the criterion. Rubric text only.
    const title = clip(
      isJudgement
        ? `Strengthen your evidence: ${criterion.title}`
        : isBar
          ? `Check with your agent: ${criterion.title}`
          : items[0]?.title ?? `Evidence for: ${criterion.title}`,
      MAX_TITLE
    );

    // What is needed: the finding's own `whatWouldHelp`, else the rubric's evidence
    // item titles, else a fixed line from the criterion title.
    const fromItems = items.length ? `Documents that help: ${items.map((i) => i.title).join("; ")}.` : "";
    const evidenceNeeded = clip(
      f.whatWouldHelp.trim() || fromItems || `Provide evidence that addresses: ${criterion.title}.`,
      MAX_EVIDENCE
    );

    // Rule 5: wording and honesty checks on everything that may reach an applicant.
    if (breaksWordingRules(title) || breaksWordingRules(evidenceNeeded)) {
      droppedCount++;
      continue;
    }

    const ownerRole: ProposedActionOwner = isBar ? "agent" : "client";
    const blocking = !isJudgement && !isBar;
    const estEffort: ProposedActionEffort = isBar ? "significant" : isJudgement ? "moderate" : f.origin === "insufficient_information" ? "quick" : "moderate";

    actions.push({
      id,
      assessmentId: assessment.id,
      applicationId: assessment.applicationId,
      userId: assessment.userId,
      agencyId: assessment.agencyId ?? null,
      title,
      ownerRole,
      blocking,
      criterionId: f.criterionId,
      evidenceNeeded,
      estEffort,
      status: "proposed",
      origin: f.origin,
      acceptedBy: null,
      acceptedAt: null,
      rejectedBy: null,
      rejectedAt: null,
      rejectReason: null,
      documentRequestId: null,
    });
  }
  return { actions, droppedCount };
}

// ============================================
// Serialization (the only path to a response body)
// ============================================

/** The whitelisted body of one action. A new object: a field added to the document later cannot leak. */
export interface ProposedActionView {
  id: string;
  assessmentId: string;
  title: string;
  ownerRole: ProposedActionOwner;
  blocking: boolean;
  criterionId: string;
  evidenceNeeded: string;
  estEffort: ProposedActionEffort;
  status: ProposedAction["status"];
  // Present once an accept created a request: lets a client link to the ask.
  documentRequestId: string | null;
  // Staff only (absent for a client-role caller).
  decision?: { acceptedBy: string | null; acceptedAt: string | null; rejectedBy: string | null; rejectedAt: string | null; rejectReason: string | null };
}

function iso(ts: { toDate?: () => Date } | null | undefined): string | null {
  return ts && typeof ts.toDate === "function" ? ts.toDate().toISOString() : null;
}

/**
 * Serialize an action for a caller. `origin` and the owner fields are never served.
 * A client-role caller gets no decision metadata (who on the agency side decided).
 */
export function serializeProposedAction(a: ProposedAction, role: string | undefined): ProposedActionView {
  const view: ProposedActionView = {
    id: a.id,
    assessmentId: a.assessmentId,
    title: a.title,
    ownerRole: a.ownerRole,
    blocking: a.blocking,
    criterionId: a.criterionId,
    evidenceNeeded: a.evidenceNeeded,
    estEffort: a.estEffort,
    status: a.status,
    documentRequestId: a.documentRequestId ?? null,
  };
  if (role !== ROLES.CLIENT) {
    view.decision = {
      acceptedBy: a.acceptedBy ?? null,
      acceptedAt: iso(a.acceptedAt),
      rejectedBy: a.rejectedBy ?? null,
      rejectedAt: iso(a.rejectedAt),
      rejectReason: a.rejectReason ?? null,
    };
  }
  return view;
}

// ============================================
// Outcomes
// ============================================

export type AcceptOutcome =
  | { kind: "accepted"; action: ProposedAction; documentRequestId: string | null }
  // Already accepted (or beyond): same answer, no second request.
  | { kind: "already_accepted"; action: ProposedAction; documentRequestId: string | null }
  | { kind: "not_found" }
  | { kind: "rejected_already" }
  // The rubric version the assessment used is no longer the approved one: the caller must acknowledge.
  | { kind: "rubric_not_current"; approvedVersion: number | null; assessmentVersion: number };

export type RejectOutcome =
  | { kind: "rejected"; action: ProposedAction }
  | { kind: "already_rejected"; action: ProposedAction }
  | { kind: "not_found" }
  | { kind: "not_rejectable"; status: ProposedAction["status"] };

/** Who is deciding. `role` is the caller's authz role. */
export interface ActionActor {
  uid: string;
  name: string;
}

// ============================================
// Service
// ============================================

export class AiActionService {
  /**
   * Write the proposals for a finished assessment. Called by the worker after a
   * successful result is stored. Best-effort by design: a failure here must not
   * fail the assessment (the verdict is already stored), so it is logged and the
   * proposals can be written again by a re-run.
   *
   * CREATE-IF-ABSENT per action id: an existing action is never overwritten, so a
   * rejected or accepted action is not re-proposed (nor reset) when the same
   * inputs (same assessment id) are processed again. Writes nothing visible to
   * an applicant: no request, no note, no notification.
   */
  async writeForAssessment(
    assessment: Pick<ApplicationAssessment, "id" | "applicationId" | "userId" | "agencyId">,
    rubric: Pick<VisaRubric, "criteria" | "evidenceItems">,
    content: Pick<AssessmentContent, "refusalGrounds" | "credibilityFlags" | "insufficientInformation">
  ): Promise<void> {
    try {
      const { actions, droppedCount } = deriveProposedActions(assessment, rubric, content);
      if (droppedCount > 0) {
        // A count only: the text may carry an applicant's words.
        console.warn(`[ai-actions] assessment ${assessment.id}: ${droppedCount} proposed action(s) dropped (unknown criterion or wording rule)`);
      }
      const now = Timestamp.now();
      for (const a of actions) {
        try {
          await subcollections.proposedActions(assessment.id).doc(a.id).create({ ...a, createdAt: now, updatedAt: now });
        } catch (e) {
          // gRPC ALREADY_EXISTS (6): the action is already there; leave it exactly as it is.
          if ((e as { code?: number }).code !== 6) throw e;
        }
      }
    } catch (e) {
      console.error(`[ai-actions] writing proposed actions for assessment ${assessment.id} failed:`, e);
    }
  }

  /** One action, or null. */
  async getAction(assessmentId: string, actionId: string): Promise<ProposedAction | null> {
    const snap = await subcollections.proposedActions(assessmentId).doc(actionId).get();
    return snap.exists ? (snap.data() as ProposedAction) : null;
  }

  /** Every action of an assessment, in a stable order (blocking first, then by criterion). */
  async listForAssessment(assessmentId: string): Promise<ProposedAction[]> {
    const snap = await subcollections.proposedActions(assessmentId).get();
    return snap.docs
      .map((d) => d.data() as ProposedAction)
      .sort((a, b) => Number(b.blocking) - Number(a.blocking) || a.criterionId.localeCompare(b.criterionId) || a.id.localeCompare(b.id));
  }

  /**
   * Accept a proposed action. The handler has already checked the caller's plan,
   * their access to the application, and (for a client caller) that the action is
   * theirs to accept.
   *
   * In ONE transaction: read the action, then flip it to `accepted` and, when it
   * is blocking and client-owned, create the DocumentRequest through the existing
   * service with the action as back-reference and a deterministic id. A second or
   * concurrent accept reads `accepted` and returns the same request. A non-blocking
   * or agent-owned action changes `status` only.
   *
   * `acknowledgeRubricChange`: when the rubric version the assessment used is no
   * longer the approved one, the caller must acknowledge, else nothing happens.
   */
  async accept(
    app: Application,
    assessment: ApplicationAssessment,
    actionId: string,
    actor: ActionActor,
    opts: { acknowledgeRubricChange: boolean }
  ): Promise<AcceptOutcome> {
    const actionRef = subcollections.proposedActions(assessment.id).doc(actionId);

    // Reads that need no transaction: the warning and the name shown on the request.
    // (#233) An assessment made on a rulebook STACK is current only while EVERY
    // layer still serves the version it used; a single-layer assessment keeps
    // the head check exactly as before.
    let approvedVersion: number | null;
    let rubricCurrent: boolean;
    if (assessment.layerVersions) {
      const stack = await defaultRulebookStack(app);
      const current = stack.usable ? stack.rubric : null;
      approvedVersion = current ? current.version : null;
      rubricCurrent = current !== null && sameStackVersions({ version: assessment.rubricVersion, layerVersions: assessment.layerVersions }, { version: current.version, layerVersions: layerVersionsOf(current) });
    } else {
      const head = await rubricStore.getHead(rubricRouteKey(app.countryCode, app.visaTypeId));
      approvedVersion = head?.approvedVersion ?? null;
      rubricCurrent = approvedVersion === assessment.rubricVersion;
    }
    const requestedByName = actor.name || "Your agent";

    const outcome = await db.runTransaction(async (tx): Promise<AcceptOutcome> => {
      const snap = await tx.get(actionRef);
      if (!snap.exists) return { kind: "not_found" };
      const action = snap.data() as ProposedAction;
      // Defence in depth: the action must belong to this application.
      if (action.applicationId !== app.id) return { kind: "not_found" };

      if (action.status === "rejected") return { kind: "rejected_already" };
      if (action.status !== "proposed") {
        // accepted / satisfied / withdrawn: idempotent, no second request.
        return { kind: "already_accepted", action, documentRequestId: action.documentRequestId ?? null };
      }
      if (!rubricCurrent && !opts.acknowledgeRubricChange) {
        return { kind: "rubric_not_current", approvedVersion, assessmentVersion: assessment.rubricVersion };
      }

      const now = Timestamp.now();
      let documentRequestId: string | null = null;
      if (action.blocking && action.ownerRole === "client") {
        // The existing service, inside this transaction. `userId` is the
        // application's client; the accepting human is `requestedBy`.
        const request: DocumentRequest = await documentRequestService.create(
          {
            id: documentRequestIdFor(action.id),
            applicationId: app.id,
            userId: app.userId,
            agencyId: app.agencyId ?? null,
            documentType: action.title,
            notes: action.evidenceNeeded,
            requestedBy: actor.uid,
            requestedByName,
            visaTypeName: app.visaTypeName,
            countryName: app.countryName,
            sourceAssessmentId: assessment.id,
            sourceActionId: action.id,
          },
          tx
        );
        documentRequestId = request.id;
      }

      tx.update(actionRef, {
        status: "accepted",
        acceptedBy: actor.uid,
        acceptedAt: now,
        documentRequestId,
        updatedAt: now,
      });
      return {
        kind: "accepted",
        action: { ...action, status: "accepted", acceptedBy: actor.uid, acceptedAt: now, documentRequestId, updatedAt: now },
        documentRequestId,
      };
    });

    // Activity note AFTER the commit. `addActivityNote` swallows its own errors
    // (note.service.ts), and the extra catch means a note can neither fail the
    // accept nor make it look failed.
    if (outcome.kind === "accepted") {
      const what = outcome.documentRequestId ? "accepted a suggested action and requested a document from the client" : "accepted a suggested action";
      await noteService
        .addActivityNote(app.id, `${requestedByName} ${what}: ${outcome.action.title}.`, { id: actor.uid, name: requestedByName })
        .catch((e) => console.error("[ai-actions] accept note failed:", e));
    }
    return outcome;
  }

  /** Reject a proposed action, recording who and when, with an optional reason. */
  async reject(
    app: Application,
    assessmentId: string,
    actionId: string,
    actor: ActionActor,
    reason: string | null
  ): Promise<RejectOutcome> {
    const actionRef = subcollections.proposedActions(assessmentId).doc(actionId);
    const cleanReason = reason ? clip(reason, MAX_REASON) : null;

    const outcome = await db.runTransaction(async (tx): Promise<RejectOutcome> => {
      const snap = await tx.get(actionRef);
      if (!snap.exists) return { kind: "not_found" };
      const action = snap.data() as ProposedAction;
      if (action.applicationId !== app.id) return { kind: "not_found" };
      if (action.status === "rejected") return { kind: "already_rejected", action };
      // Only a still-proposed action can be rejected: an accepted one has a request behind it.
      if (action.status !== "proposed") return { kind: "not_rejectable", status: action.status };

      const now = Timestamp.now();
      tx.update(actionRef, {
        status: "rejected",
        rejectedBy: actor.uid,
        rejectedAt: now,
        rejectReason: cleanReason,
        updatedAt: now,
      });
      return { kind: "rejected", action: { ...action, status: "rejected", rejectedBy: actor.uid, rejectedAt: now, rejectReason: cleanReason, updatedAt: now } };
    });

    if (outcome.kind === "rejected") {
      const name = actor.name || "Your agent";
      await noteService
        .addActivityNote(app.id, `${name} declined a suggested action: ${outcome.action.title}.` + (cleanReason ? ` Reason: ${cleanReason}` : ""), {
          id: actor.uid,
          name,
        })
        .catch((e) => console.error("[ai-actions] reject note failed:", e));
    }
    return outcome;
  }

  /**
   * Fulfilment back-propagation: when a DocumentRequest that came from an action
   * is fulfilled, the action is `satisfied`; when it is waived or cancelled, it is
   * `withdrawn`, so the plan stops asking for it. A no-op for a request with no
   * back-reference. Best-effort (logged, never thrown): the request's own change
   * has already happened and must not look failed.
   *
   * Only an action that is `accepted` AND points at THIS request moves, so a stale
   * or mismatched call cannot change an unrelated action.
   */
  async syncFromRequest(request: Pick<DocumentRequest, "id" | "sourceAssessmentId" | "sourceActionId">, to: "satisfied" | "withdrawn"): Promise<void> {
    if (!request.sourceAssessmentId || !request.sourceActionId) return;
    const actionRef = subcollections.proposedActions(request.sourceAssessmentId).doc(request.sourceActionId);
    try {
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(actionRef);
        if (!snap.exists) return;
        const action = snap.data() as ProposedAction;
        if (action.status !== "accepted" || action.documentRequestId !== request.id) return;
        tx.update(actionRef, { status: to, updatedAt: Timestamp.now() });
      });
    } catch (e) {
      console.error("[ai-actions] syncing action from document request failed:", e);
    }
  }
}

export const aiActionService = new AiActionService();
