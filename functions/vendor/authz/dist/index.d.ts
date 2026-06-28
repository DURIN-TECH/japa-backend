/**
 * @durin-tech/authz — shared RBAC + subscription-entitlement authorization
 * contract (repo: DURIN-TECH/seli-authz).
 *
 * Consumed by japa-backend (enforcement), japa-portal and japa-mobile (UI gating)
 * so authorization rules and the feature catalog are authored once and can never
 * drift between platforms.
 */
export * from "./catalog";
export * from "./types";
export * from "./ability";
export * from "./billing";
