import { Timestamp } from "firebase-admin/firestore";
import type { Transaction } from "firebase-admin/firestore";
import { FEATURES, hasFeature, type AuthzSubject } from "@durin-tech/authz";
import { collections, db } from "../utils/firebase";
import { entitlementService } from "./entitlement.service";
import { claimsService } from "./claims.service";
import {
  CURRENT_APPROVAL_WORDING,
  CURRENT_NOTICE_WORDING,
  findApprovalWording,
  wordingText,
  type WordingVersion,
} from "./message-access/wording";
import type {
  AiMessageAccessAuditAction,
  AiMessageAccessAuditRecord,
  AiMessageAccessRecord,
  Conversation,
} from "../types";

// ============================================
// AI message access: approvals, account-wide setting, notice, chat switch (#172)
// ============================================
//
// Owns every WRITE to the consent state and the audit trail. It never reads
// message content (that is message-access.service.ts, the one choke point).
//
// Every change runs in ONE transaction that writes the new state and its audit
// record together, so there is no change without an audit record and no audit
// record for a change that did not happen. There is no cache: the next read
// (including the access check) sees the change.

/** Errors the controllers map to HTTP codes. */
export class AiMessageAccessError extends Error {
  constructor(
    public readonly code: "NOT_FOUND" | "FORBIDDEN" | "WORDING_VERSION_MISMATCH",
    message: string
  ) {
    super(message);
    this.name = "AiMessageAccessError";
  }
}

/** The switch / plan view of one conversation for ONE participant. */
export interface ConversationAiAccessView {
  /** Effective state for me: "off" when my chat switch OR my account-wide setting is off. */
  myAiAccess: "on" | "off";
  /** My own per-chat switch only (true = I switched this chat off). */
  myChatSwitchOff: boolean;
  /** My account-wide off setting (so the UI can say "off in all your chats"). */
  accountWideOff: boolean;
  /** Yes/no only: the OTHER person has this chat off (their switch or their account-wide off). */
  otherSwitchedOff: boolean;
  /** I currently qualify (active approval or AI plan). Says nothing about the other person. */
  qualifies: boolean;
}

/** A wording block as the API returns it. */
export interface WordingView extends WordingVersion {
  /** The paragraphs joined by blank lines: exactly what is stored on an approval. */
  text: string;
}

/** The signed-in person's own AI message access state. */
export interface UserAiAccessState {
  /** Active (non-revoked) approval on file. */
  approved: boolean;
  approvedAt: Timestamp | null;
  /** Version id and exact text of the person's ACTIVE approval; null when not approved. */
  wordingVersion: string | null;
  wording: string | null;
  /** Their resolved plan includes AI. */
  hasAiPlan: boolean;
  /** Approval or AI plan. */
  qualifies: boolean;
  /** Plan but no approval: the one-time notice case. */
  planOnly: boolean;
  /** Account-wide off setting. */
  accountWideOff: boolean;
  /** The one-time notice has been dismissed (for the current notice wording version). */
  noticeDismissed: boolean;
  /** The wording an approval made today would record. */
  currentApprovalWording: WordingView;
  /** The notice wording shown today. */
  noticeWording: WordingView;
}

/** Add the joined `text` to a wording block for the API. */
function wordingView(w: WordingVersion): WordingView {
  return { ...w, text: wordingText(w) };
}

/** True when the record holds an approval that has not been revoked. */
export function isApprovalActive(record: AiMessageAccessRecord | null | undefined): boolean {
  return !!record?.approval && !record.approval.revokedAt;
}

class AiMessageAccessService {
  /** Transaction runner as a property so a hermetic test can swap in an in-memory one. */
  runTransaction: <T>(fn: (tx: Transaction) => Promise<T>) => Promise<T> = (fn) => db.runTransaction(fn);

  // ---------- reads ----------

  /** The person's record, or null when they have never touched the feature. */
  async getRecord(userId: string): Promise<AiMessageAccessRecord | null> {
    const snap = await collections.aiMessageAccess.doc(userId).get();
    return snap.exists ? (snap.data() as AiMessageAccessRecord) : null;
  }

  /**
   * True when the subject's resolved entitlements include `ai.case_officer`.
   *
   * Subscriber resolution is the shared one (`resolveSubscriber`): an agent in an
   * agency draws on the agency's plan, an independent agent or a client on their
   * own. Reads the entitlements cache only (no write, no default-plan fallback):
   * a missing cache means "unresolved", which is NOT a pass. `hasFeature` is false
   * for a lapsed or unpaid status.
   */
  async subjectHasAiPlan(subject: AuthzSubject): Promise<boolean> {
    const subscriber = entitlementService.resolveSubscriber(subject);
    if (!subscriber) return false; // admin, or no subscriber: no plan
    const ent = await entitlementService.getEntitlements(subscriber.id);
    return hasFeature(ent, FEATURES.AI_CASE_OFFICER);
  }

  /** Same, starting from a bare uid (resolves role + agency from the database). */
  async uidHasAiPlan(uid: string): Promise<boolean> {
    const { role, agencyId } = await claimsService.resolveRoleFromDb(uid);
    return this.subjectHasAiPlan({ uid, role, agencyId });
  }

  /**
   * The signed-in person's own state. The plan comes from `uidHasAiPlan` (role and
   * agency resolved from the database), the SAME source the access check uses, so
   * a label here can never disagree with what is actually released (token claims
   * can be stale after an agency change).
   */
  async getUserState(userId: string): Promise<UserAiAccessState> {
    const [record, hasAiPlan] = await Promise.all([
      this.getRecord(userId),
      this.uidHasAiPlan(userId),
    ]);
    const approved = isApprovalActive(record);
    return {
      approved,
      approvedAt: approved ? record!.approval!.grantedAt : null,
      wordingVersion: approved ? record!.approval!.wordingVersion : null,
      wording: approved ? record!.approval!.wording : null,
      hasAiPlan,
      qualifies: approved || hasAiPlan,
      planOnly: hasAiPlan && !approved,
      accountWideOff: record?.accountWideOff === true,
      // Re-shown if the notice wording changes: a new version is new information.
      noticeDismissed: record?.noticeDismissedVersion === CURRENT_NOTICE_WORDING.versionId,
      currentApprovalWording: wordingView(CURRENT_APPROVAL_WORDING),
      noticeWording: wordingView(CURRENT_NOTICE_WORDING),
    };
  }

  /**
   * Build the switch view of a conversation for one participant.
   * `side` says which participant the caller is; `otherUid` is the other
   * person's USER uid (the applicant's, or the agent doc's user), `null` when it
   * cannot be resolved (then the other side is treated as off: unknown is not on).
   */
  buildConversationView(
    conv: Conversation,
    side: "user" | "agent",
    me: { record: AiMessageAccessRecord | null; hasAiPlan: boolean },
    otherRecord: AiMessageAccessRecord | null,
    otherResolved: boolean
  ): ConversationAiAccessView {
    const mySwitch = (side === "user" ? conv.aiAccessOffUser : conv.aiAccessOffAgent) === true;
    const otherSwitch = (side === "user" ? conv.aiAccessOffAgent : conv.aiAccessOffUser) === true;
    const myAccountOff = me.record?.accountWideOff === true;
    const otherAccountOff = otherRecord?.accountWideOff === true;
    return {
      myAiAccess: mySwitch || myAccountOff ? "off" : "on",
      myChatSwitchOff: mySwitch,
      accountWideOff: myAccountOff,
      otherSwitchedOff: otherSwitch || otherAccountOff || !otherResolved,
      qualifies: isApprovalActive(me.record) || me.hasAiPlan,
    };
  }

  // ---------- writes ----------

  /** Queue an audit record on a transaction (a fresh id, so it can never overwrite one). */
  private queueAudit(
    tx: Transaction,
    rec: Omit<AiMessageAccessAuditRecord, "id" | "createdAt"> & { action: AiMessageAccessAuditAction }
  ): void {
    const ref = collections.aiMessageAccessAudit.doc();
    const row: Record<string, unknown> = { ...rec, id: ref.id, createdAt: Timestamp.now() };
    // Firestore rejects `undefined` values; drop the optional keys that are not set.
    for (const k of Object.keys(row)) if (row[k] === undefined) delete row[k];
    tx.set(ref, row);
  }

  /**
   * Record the person's express approval.
   *
   * The client names the wording VERSION it showed; the server stores the exact
   * text for that version from its own constant (never client text). The version
   * must be the current one, otherwise the person approved text that is no longer
   * what a fresh screen would show (409 WORDING_VERSION_MISMATCH, nothing stored).
   * Already actively approved under the same version: no new record (idempotent).
   * After a revoke, approving again creates a NEW approval record.
   */
  async approve(userId: string, wordingVersion: string, ipAddress?: string): Promise<void> {
    const wording = findApprovalWording(wordingVersion);
    if (!wording || wording.versionId !== CURRENT_APPROVAL_WORDING.versionId) {
      throw new AiMessageAccessError(
        "WORDING_VERSION_MISMATCH",
        "That wording version is not the current one. Reload and read the wording again."
      );
    }
    const ref = collections.aiMessageAccess.doc(userId);
    await this.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const record = snap.exists ? (snap.data() as AiMessageAccessRecord) : null;
      if (isApprovalActive(record) && record!.approval!.wordingVersion === wording.versionId) return;
      const now = Timestamp.now();
      const approval: Record<string, unknown> = {
        userId,
        grantedAt: now,
        wordingVersion: wording.versionId,
        wording: wordingText(wording),
      };
      if (ipAddress) approval.ipAddress = ipAddress;
      // `update` (not a merged `set`) when the doc exists: a merge would deep-merge
      // the new approval map into an old revoked one and keep its `revokedAt`,
      // so the new approval would look revoked. `update` replaces the field whole.
      if (snap.exists) tx.update(ref, { userId, approval, updatedAt: now });
      else tx.set(ref, { userId, approval, updatedAt: now });
      this.queueAudit(tx, {
        actorUid: userId,
        subjectUid: userId,
        action: "approval_granted",
        newValue: true,
        wordingVersion: wording.versionId,
      });
    });
  }

  /** Withdraw the approval. No-op when there is no active approval. Keeps the old record (stamped revoked). */
  async revoke(userId: string): Promise<void> {
    const ref = collections.aiMessageAccess.doc(userId);
    await this.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const record = snap.exists ? (snap.data() as AiMessageAccessRecord) : null;
      if (!isApprovalActive(record)) return;
      const now = Timestamp.now();
      tx.update(ref, { "approval.revokedAt": now, updatedAt: now });
      this.queueAudit(tx, {
        actorUid: userId,
        subjectUid: userId,
        action: "approval_revoked",
        newValue: false,
        wordingVersion: record!.approval!.wordingVersion,
      });
    });
  }

  /** Set the account-wide "off" setting. Audited only when the value actually changes. */
  async setAccountWideOff(userId: string, off: boolean): Promise<void> {
    const ref = collections.aiMessageAccess.doc(userId);
    await this.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const record = snap.exists ? (snap.data() as AiMessageAccessRecord) : null;
      if ((record?.accountWideOff === true) === off) return;
      const now = Timestamp.now();
      tx.set(ref, { userId, accountWideOff: off, accountWideOffChangedAt: now, updatedAt: now }, { merge: true });
      this.queueAudit(tx, {
        actorUid: userId,
        subjectUid: userId,
        action: off ? "account_wide_off_enabled" : "account_wide_off_disabled",
        newValue: off,
      });
    });
  }

  /** Record that the person dismissed the one-time notice (server-side, so it follows them across devices). */
  async dismissNotice(userId: string): Promise<void> {
    const now = Timestamp.now();
    await collections.aiMessageAccess.doc(userId).set(
      { userId, noticeDismissedAt: now, noticeDismissedVersion: CURRENT_NOTICE_WORDING.versionId, updatedAt: now },
      { merge: true }
    );
  }

  /**
   * Set the caller's OWN side of a chat's switch.
   *
   * Participant rule is the messaging module's: the applicant (`conv.userId`) or
   * the agent whose doc id is `conv.agentId`. Exactly one side is written: the
   * caller's own (applicant side first if they somehow match both). The
   * conversation is re-read inside the transaction so the decision and the write
   * see the same document. Returns the updated conversation.
   *
   * @param callerAgentId the caller's agent doc id (null when they are not an agent)
   */
  async setChatSwitch(
    conversationId: string,
    userId: string,
    callerAgentId: string | null,
    off: boolean
  ): Promise<Conversation> {
    const ref = collections.conversations.doc(conversationId);
    return this.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new AiMessageAccessError("NOT_FOUND", "Conversation not found");
      const conv = snap.data() as Conversation;
      // ONE side only. The applicant side wins if the caller matches both (the
      // same person on both sides is not a legitimate chat; it is what an id-swap
      // attack looks like), so a caller can never reach the other side's switch.
      const userSide = conv.userId === userId;
      const agentSide = !userSide && !!callerAgentId && conv.agentId === callerAgentId;
      if (!userSide && !agentSide) throw new AiMessageAccessError("FORBIDDEN", "Not a participant");

      const updates: Record<string, unknown> = {};
      const changed: ("user" | "agent")[] = [];
      if (userSide && (conv.aiAccessOffUser === true) !== off) {
        updates.aiAccessOffUser = off;
        changed.push("user");
      }
      if (agentSide && (conv.aiAccessOffAgent === true) !== off) {
        updates.aiAccessOffAgent = off;
        changed.push("agent");
      }
      // Deliberately no `updatedAt` bump: a privacy switch is not chat activity.
      if (changed.length === 0) return conv;
      tx.update(ref, updates);
      for (const side of changed) {
        this.queueAudit(tx, {
          actorUid: userId,
          subjectUid: userId,
          action: off ? "chat_switched_off" : "chat_switched_on",
          newValue: off,
          conversationId,
          side,
        });
      }
      return { ...conv, ...updates } as Conversation;
    });
  }

  // ---------- admin read of the audit trail ----------

  /** Newest-first audit rows for one person (admin route only). Capped at 200. */
  async listAudit(subjectUid: string, limit = 100): Promise<AiMessageAccessAuditRecord[]> {
    const cap = Math.min(Math.max(1, Math.floor(limit) || 100), 200);
    const snap = await collections.aiMessageAccessAudit
      .where("subjectUid", "==", subjectUid)
      .orderBy("createdAt", "desc")
      .limit(cap)
      .get();
    return snap.docs.map((d) => d.data() as AiMessageAccessAuditRecord);
  }
}

export const aiMessageAccessService = new AiMessageAccessService();
