// ============================================
// Public agent projection (issue #147)
// ============================================
//
// Every unauthenticated agent route (GET /agents, /agents/top, /agents/:id,
// /agents/visa/:visaTypeId) must answer with `PublicAgent`, never with the raw
// Firestore `Agent` document: that document carries the agent's account uid,
// licence number, verification documents, the admin who verified them and
// their booking slots, none of which an anonymous caller may see.
//
// `toPublicAgent` is a field-by-field ALLOW-LIST. Do not rewrite it as
// `{ ...agent }` or "omit these keys": new `Agent` fields must stay private
// until they are added here deliberately.
//
// Reused by other public surfaces (e.g. #144's GET /agencies/browse/:id/agents).

import type { Agent, PublicAgent } from "../types";

/**
 * The exact key set of a public agent response. Exported so tests (and any
 * other public route) can assert against the same list.
 * Optional keys (agencyId, agencyRole, profilePhotoUrl) appear only when the doc has them.
 */
export const PUBLIC_AGENT_FIELDS = [
  "id",
  "agencyId",
  "agencyRole",
  "displayName",
  "bio",
  "profilePhotoUrl",
  "yearsOfExperience",
  "specializations",
  "languages",
  "featuredVisas",
  "verificationStatus",
  "rating",
  "totalReviews",
  "totalApplications",
  "successRate",
  "responseTime",
  "consultationFee",
  "isAvailable",
  "createdAt",
  "updatedAt",
] as const;

/**
 * Project a stored agent onto the public allow-list.
 * Optional fields are only set when present, so absent stays absent in JSON.
 *
 * @param agent - The full agent document
 * @returns The anonymous-safe view of that agent
 */
export function toPublicAgent(agent: Agent): PublicAgent {
  const pub: PublicAgent = {
    id: agent.id,
    displayName: agent.displayName,
    bio: agent.bio,
    yearsOfExperience: agent.yearsOfExperience,
    specializations: agent.specializations,
    languages: agent.languages,
    featuredVisas: agent.featuredVisas,
    verificationStatus: agent.verificationStatus,
    rating: agent.rating,
    totalReviews: agent.totalReviews,
    totalApplications: agent.totalApplications,
    successRate: agent.successRate,
    responseTime: agent.responseTime,
    consultationFee: agent.consultationFee,
    isAvailable: agent.isAvailable,
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
  };
  if (agent.agencyId !== undefined) pub.agencyId = agent.agencyId;
  if (agent.agencyRole !== undefined) pub.agencyRole = agent.agencyRole;
  if (agent.profilePhotoUrl !== undefined) pub.profilePhotoUrl = agent.profilePhotoUrl;
  return pub;
}
