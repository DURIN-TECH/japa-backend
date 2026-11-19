// ============================================
// Rule 1: shared contact detail across applicant accounts (issue #121)
// ============================================
//
// Source: Home Office, "Modern slavery: statutory guidance for England and
// Wales (under s49 of the Modern Slavery Act 2015) and non-statutory guidance
// for Scotland and Northern Ireland", General Indicators, para 3.10
// ("Victims may:").
//
// IMPORTANT: the guidance describes what a victim may do. A phone number or
// email that recurs on many unrelated accounts is only a loose PROXY for
// "someone else is speaking for them". The signal therefore says "pattern for
// review" and nothing more; it never says anyone is a victim or an offender.
//
// This file is PURE (no Firestore). The runner loads the data.

import { ContactKind, hashContact } from "./contact-normalise";
import type { RiskRule } from "./types";

export const SHARED_CONTACT_RULE_ID = "shared_contact_across_accounts";
export const SHARED_CONTACT_RULE_VERSION = "1";

/** Signal `type` raised by this rule (neutral wording, per #121). */
export const SHARED_CONTACT_SIGNAL_TYPE = "shared_contact_across_accounts";

/**
 * N: how many distinct client accounts must share one contact value before a
 * signal is raised.
 *
 * Why 5: a household legitimately shares a phone or email (two parents, two
 * or three children, a grandparent), so 2-4 accounts is ordinary. Five or more
 * unrelated accounts on one number is rare enough in normal use that a human
 * look is worth the time, and common enough in the pattern the guidance
 * describes to be worth having. It is a starting point: change it here, in one
 * place, once admins tell us whether the queue is too noisy or too quiet.
 */
export const SHARED_CONTACT_MIN_ACCOUNTS = 5;

export const SHARED_CONTACT_SOURCE_URL =
  "https://www.gov.uk/government/publications/modern-slavery-how-to-identify-and-support-victims/modern-slavery-statutory-guidance-for-england-and-wales-under-s49-of-the-modern-slavery-act-2015-and-non-statutory-guidance-for-scotland-and-northe";

/** Verbatim, para 3.10 ("Victims may:"). Do not paraphrase. */
export const SHARED_CONTACT_SOURCE_QUOTE = "Allow others to speak for them when addressed directly";

/** One account that carries the contact value, as loaded by the runner. */
export interface SharedContactAccount {
  userId: string;
  /** True for staff: an agent, an agency owner. Their details are exempt. */
  isStaff: boolean;
  /** Applications this account is the applicant on (empty = not a client). */
  applicationIds: string[];
}

export interface SharedContactInput {
  kind: ContactKind;
  /** Normalised, non-placeholder value (the runner has already checked). */
  key: string;
  /** Every account whose profile carries this value. */
  accounts: SharedContactAccount[];
  /** Override for tests; defaults to SHARED_CONTACT_MIN_ACCOUNTS. */
  minAccounts?: number;
}

export interface SharedContactFinding {
  kind: ContactKind;
  /** `sha256:...` of the value. The raw value is not part of the finding. */
  hash: string;
  /** Distinct client accounts after the companion exemption. */
  accountCount: number;
  /** All client user ids in the cluster, sorted (stable evidence). */
  userIds: string[];
  /** All their application ids, sorted. */
  applicationIds: string[];
}

/**
 * Collapse accounts that appear on the same application into one group
 * (union-find over application ids). This is exemption (a): companions on ONE
 * application, such as a family applying together, count once, because
 * families legitimately share a phone or an email. Applications are
 * single-applicant today, so each account is its own group; the exemption
 * takes effect as soon as an application can name more than one account.
 */
function countGroups(accounts: SharedContactAccount[]): number {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root) as string;
    parent.set(x, root);
    return root;
  };
  const union = (a: string, b: string) => parent.set(find(a), find(b));

  for (const a of accounts) parent.set(`u:${a.userId}`, `u:${a.userId}`);
  for (const a of accounts) for (const appId of a.applicationIds) {
    const node = `a:${appId}`;
    if (!parent.has(node)) parent.set(node, node);
    union(`u:${a.userId}`, node);
  }
  return new Set(accounts.map((a) => find(`u:${a.userId}`))).size;
}

/** The pure decision. */
export function evaluateSharedContact(input: SharedContactInput): SharedContactFinding | null {
  const min = input.minAccounts ?? SHARED_CONTACT_MIN_ACCOUNTS;

  // Exemption (b): if staff (an agent, an agency owner) carry this value it is
  // an agency contact detail, e.g. an agent registering clients with the
  // office number. Skip the whole value.
  if (input.accounts.some((a) => a.isStaff)) return null;

  // Only accounts that actually have an application are "client accounts".
  const clients = input.accounts.filter((a) => a.applicationIds.length > 0);
  const accountCount = countGroups(clients);
  if (accountCount < min) return null;

  return {
    kind: input.kind,
    hash: hashContact(input.kind, input.key),
    accountCount,
    userIds: clients.map((c) => c.userId).sort(),
    applicationIds: [...new Set(clients.flatMap((c) => c.applicationIds))].sort(),
  };
}

export const sharedContactRule: RiskRule<SharedContactInput, SharedContactFinding> = {
  ruleId: SHARED_CONTACT_RULE_ID,
  version: SHARED_CONTACT_RULE_VERSION,
  category: "trafficking",
  sourceUrl: SHARED_CONTACT_SOURCE_URL,
  sourceQuote: SHARED_CONTACT_SOURCE_QUOTE,
  evaluate: evaluateSharedContact,
};
