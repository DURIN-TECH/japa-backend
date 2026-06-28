"use strict";
/**
 * Feature & limit catalog — the single source of truth for every gateable
 * capability in Seli. Plans reference these keys; the backend, portal, and mobile
 * all import them so the set can never drift between platforms.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.UNLIMITED = exports.LIMITS = exports.LIMIT_KEYS = exports.FEATURES = exports.FEATURE_KEYS = void 0;
exports.isFeatureKey = isFeatureKey;
exports.isLimitKey = isLimitKey;
/**
 * Boolean capabilities that a plan can grant. A feature is either present in a
 * subscriber's entitlements (unlocked) or absent (locked / paywalled).
 */
exports.FEATURE_KEYS = [
    "applications.create", // start/own an application
    "applications.bulk", // bulk operations on applications (agency tooling)
    "messaging", // agent <-> client chat
    "consultations.book", // book/offer consultations
    "documents.upload", // upload documents to an application
    "analytics.view", // view analytics dashboards
    "agency.invite_agents", // invite/add agents to an agency
    "self_service", // self-service (no-agent) application flow
    "priority_support", // priority support tier
    "news.alerts", // visa news alert subscriptions
    "payments.request", // agents requesting payments from clients
];
/**
 * Named constants for every feature key. **Always reference features through this
 * object** (e.g. `FEATURES.MESSAGING`) instead of hardcoding the string literal,
 * so a key can be renamed in one place. Mirrors `FEATURE_KEYS`.
 */
exports.FEATURES = {
    APPLICATIONS_CREATE: "applications.create",
    APPLICATIONS_BULK: "applications.bulk",
    MESSAGING: "messaging",
    CONSULTATIONS_BOOK: "consultations.book",
    DOCUMENTS_UPLOAD: "documents.upload",
    ANALYTICS_VIEW: "analytics.view",
    AGENCY_INVITE_AGENTS: "agency.invite_agents",
    SELF_SERVICE: "self_service",
    PRIORITY_SUPPORT: "priority_support",
    NEWS_ALERTS: "news.alerts",
    PAYMENTS_REQUEST: "payments.request",
};
/**
 * Numeric ceilings a plan can impose. Enforced by counting current usage and
 * comparing against the limit (see `isWithinLimit`). `UNLIMITED` (-1) means no cap.
 */
exports.LIMIT_KEYS = [
    "max_active_applications",
    "max_agents",
    "max_documents_per_application",
    "max_consultations_per_month",
];
/**
 * Named constants for every limit key. **Always reference limits through this
 * object** (e.g. `LIMITS.MAX_ACTIVE_APPLICATIONS`) rather than the raw string.
 */
exports.LIMITS = {
    MAX_ACTIVE_APPLICATIONS: "max_active_applications",
    MAX_AGENTS: "max_agents",
    MAX_DOCUMENTS_PER_APPLICATION: "max_documents_per_application",
    MAX_CONSULTATIONS_PER_MONTH: "max_consultations_per_month",
};
/** Sentinel value for an uncapped limit. */
exports.UNLIMITED = -1;
/** Runtime guards (useful for validating plan config / API input). */
function isFeatureKey(value) {
    return typeof value === "string" && exports.FEATURE_KEYS.includes(value);
}
function isLimitKey(value) {
    return typeof value === "string" && exports.LIMIT_KEYS.includes(value);
}
