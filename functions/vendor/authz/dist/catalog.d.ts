/**
 * Feature & limit catalog — the single source of truth for every gateable
 * capability in Seli. Plans reference these keys; the backend, portal, and mobile
 * all import them so the set can never drift between platforms.
 */
/**
 * Boolean capabilities that a plan can grant. A feature is either present in a
 * subscriber's entitlements (unlocked) or absent (locked / paywalled).
 */
export declare const FEATURE_KEYS: readonly ["applications.create", "applications.bulk", "messaging", "consultations.book", "documents.upload", "analytics.view", "agency.invite_agents", "self_service", "priority_support", "news.alerts", "payments.request"];
export type FeatureKey = (typeof FEATURE_KEYS)[number];
/**
 * Named constants for every feature key. **Always reference features through this
 * object** (e.g. `FEATURES.MESSAGING`) instead of hardcoding the string literal,
 * so a key can be renamed in one place. Mirrors `FEATURE_KEYS`.
 */
export declare const FEATURES: {
    readonly APPLICATIONS_CREATE: "applications.create";
    readonly APPLICATIONS_BULK: "applications.bulk";
    readonly MESSAGING: "messaging";
    readonly CONSULTATIONS_BOOK: "consultations.book";
    readonly DOCUMENTS_UPLOAD: "documents.upload";
    readonly ANALYTICS_VIEW: "analytics.view";
    readonly AGENCY_INVITE_AGENTS: "agency.invite_agents";
    readonly SELF_SERVICE: "self_service";
    readonly PRIORITY_SUPPORT: "priority_support";
    readonly NEWS_ALERTS: "news.alerts";
    readonly PAYMENTS_REQUEST: "payments.request";
};
/**
 * Numeric ceilings a plan can impose. Enforced by counting current usage and
 * comparing against the limit (see `isWithinLimit`). `UNLIMITED` (-1) means no cap.
 */
export declare const LIMIT_KEYS: readonly ["max_active_applications", "max_agents", "max_documents_per_application", "max_consultations_per_month"];
export type LimitKey = (typeof LIMIT_KEYS)[number];
/**
 * Named constants for every limit key. **Always reference limits through this
 * object** (e.g. `LIMITS.MAX_ACTIVE_APPLICATIONS`) rather than the raw string.
 */
export declare const LIMITS: {
    readonly MAX_ACTIVE_APPLICATIONS: "max_active_applications";
    readonly MAX_AGENTS: "max_agents";
    readonly MAX_DOCUMENTS_PER_APPLICATION: "max_documents_per_application";
    readonly MAX_CONSULTATIONS_PER_MONTH: "max_consultations_per_month";
};
/** Sentinel value for an uncapped limit. */
export declare const UNLIMITED = -1;
/** Runtime guards (useful for validating plan config / API input). */
export declare function isFeatureKey(value: unknown): value is FeatureKey;
export declare function isLimitKey(value: unknown): value is LimitKey;
