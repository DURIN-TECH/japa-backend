// ============================================
// Test harness: AI message access (issue #172)
// ============================================
//
// Not a test file (`npm test` runs *.test.ts only). Gives the message-access
// suites an in-memory Firestore (test/helpers/fake-firestore.ts) with the new
// collections faked, an in-memory transaction runner for the settings service,
// and a stubbed role resolver (the real one calls Firebase Auth, which the
// hermetic preload blocks).

import { Timestamp } from "firebase-admin/firestore";
import { FEATURES, ROLES, type Entitlements, type Role } from "@durin-tech/authz";
import { fakeCollection, fakeRunTransaction, installFakes, resetStore, store } from "../helpers/fake-firestore";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** uid -> the role + agency the stubbed resolver returns. */
const roles = new Map<string, { role: Role; agencyId: string | null }>();

/** Install every fake once (call in `before`). */
export async function installMessageAccessFakes(): Promise<void> {
  await installFakes();
  const firebase: any = await import("../../src/utils/firebase");
  firebase.collections.aiMessageAccess = fakeCollection("aiMessageAccess");
  firebase.collections.aiMessageAccessAudit = fakeCollection("aiMessageAccessAudit");
  firebase.subcollections.messages = (id: string) => fakeCollection(`conversations/${id}/messages`);

  const svc: any = await import("../../src/services/ai-message-access.service");
  svc.aiMessageAccessService.runTransaction = fakeRunTransaction;

  const claims: any = await import("../../src/services/claims.service");
  claims.claimsService.resolveRoleFromDb = async (uid: string) =>
    roles.get(uid) ?? { role: ROLES.CLIENT, agencyId: null };
}

/** Reset between tests. */
export function resetMessageAccess(): void {
  resetStore();
  roles.clear();
}

/** Ids used by the standard chat. */
export const APPLICANT = "uid-applicant";
export const AGENT_USER = "uid-agent";
export const AGENT_DOC = "agent-doc-1";
export const CONV = "conv-1";

/** Options for `seedChat`. */
export interface SeedChatOpts {
  convId?: string;
  applicantUid?: string;
  agentUid?: string;
  agentDocId?: string;
  /** Agency the agent belongs to (role agent). Omit for an independent agent. */
  agencyId?: string;
  aiAccessOffUser?: boolean;
  aiAccessOffAgent?: boolean;
}

/** Seed a conversation, its agent doc, both users' roles and one message each way. */
export function seedChat(o: SeedChatOpts = {}): { convId: string; applicantUid: string; agentUid: string } {
  const convId = o.convId ?? CONV;
  const applicantUid = o.applicantUid ?? APPLICANT;
  const agentUid = o.agentUid ?? AGENT_USER;
  const agentDocId = o.agentDocId ?? AGENT_DOC;
  roles.set(applicantUid, { role: ROLES.CLIENT, agencyId: null });
  roles.set(agentUid, { role: ROLES.AGENT, agencyId: o.agencyId ?? null });
  store.set(`agents/${agentDocId}`, { id: agentDocId, userId: agentUid, ...(o.agencyId ? { agencyId: o.agencyId } : {}) });
  const conv: Record<string, unknown> = {
    id: convId,
    userId: applicantUid,
    agentId: agentDocId,
    lastMessageAt: Timestamp.fromMillis(1000),
    unreadCountUser: 0,
    unreadCountAgent: 0,
    createdAt: Timestamp.fromMillis(1),
    updatedAt: Timestamp.fromMillis(1),
  };
  if (o.aiAccessOffUser !== undefined) conv.aiAccessOffUser = o.aiAccessOffUser;
  if (o.aiAccessOffAgent !== undefined) conv.aiAccessOffAgent = o.aiAccessOffAgent;
  store.set(`conversations/${convId}`, conv);
  seedMessage(convId, "m-app-1", applicantUid, "user", "applicant words", 10);
  seedMessage(convId, "m-agent-1", agentUid, "agent", "agent words", 20);
  seedMessage(convId, "m-app-2", applicantUid, "user", "applicant again", 30);
  return { convId, applicantUid, agentUid };
}

/** Seed one message. */
export function seedMessage(convId: string, id: string, senderId: string, senderType: "user" | "agent", content: string, ms: number): void {
  store.set(`conversations/${convId}/messages/${id}`, {
    id,
    conversationId: convId,
    senderId,
    senderType,
    content,
    isRead: false,
    createdAt: Timestamp.fromMillis(ms),
  });
}

/** An active (or lapsed) AI-plan entitlement document keyed by subscriber id. */
export function seedPlan(subscriberId: string, status: "active" | "past_due" = "active", withAi = true): void {
  const ent: Entitlements = {
    subscriberType: "client",
    subscriberId,
    planId: "plan",
    status,
    features: withAi ? [FEATURES.AI_CASE_OFFICER] : [],
    limits: {},
  } as unknown as Entitlements;
  store.set(`entitlements/${subscriberId}`, ent as unknown as Record<string, unknown>);
}

/** Seed an ACTIVE approval for a user (as the service would have written it). */
export function seedApproval(uid: string, revoked = false): void {
  store.set(`aiMessageAccess/${uid}`, {
    userId: uid,
    approval: {
      userId: uid,
      grantedAt: Timestamp.fromMillis(5),
      wordingVersion: "ai-message-access-approval.draft-1",
      wording: "x",
      ...(revoked ? { revokedAt: Timestamp.fromMillis(6) } : {}),
    },
    updatedAt: Timestamp.fromMillis(5),
  });
}

/** Seed the account-wide off setting (keeps any approval already seeded). */
export function seedAccountWideOff(uid: string, off = true): void {
  const cur = store.get(`aiMessageAccess/${uid}`) ?? { userId: uid };
  store.set(`aiMessageAccess/${uid}`, { ...cur, accountWideOff: off, updatedAt: Timestamp.fromMillis(7) });
}

/** Register a principal's role for the stubbed resolver (for agency tests). */
export function setRole(uid: string, role: Role, agencyId: string | null): void {
  roles.set(uid, { role, agencyId });
}

/** The audit rows written so far, oldest first. */
export function auditRows(): Record<string, any>[] {
  return [...store.entries()].filter(([p]) => p.startsWith("aiMessageAccessAudit/")).map(([, d]) => d as Record<string, any>);
}
