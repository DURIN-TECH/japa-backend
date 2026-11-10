// ============================================
// Scrapers module: public types (issue #91)
// ============================================
//
// Type-only counterpart of scrapers/index.ts. The visa-catalog scraper types
// (VisaScrapeMeta, VisaFeeMeta, ExtractedVisa, ...) are part of the app's
// VisaType, so src/types/index.ts re-exports them from here rather than
// deep-importing scrapers/visa-catalog/types.ts (see the boundary rule in
// .eslintrc.js). The file it re-exports declares no runtime values.
export * from "./visa-catalog/types";
