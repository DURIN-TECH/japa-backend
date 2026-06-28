# CLAUDE.md

## Code Style Requirements

- **All files accessed or added must be heavily commented.** Every function, class, interface, constant, and non-trivial block of logic should have clear, descriptive comments explaining what it does and why. When editing existing files, add comments to any uncommented code you touch.

## Authorization constants (ALWAYS use)

- **Never hardcode role / feature / limit string literals** (e.g. `"owner"`, `"messaging"`,
  `"max_active_applications"`) in app code. Always reference the named constants from
  `@durin-tech/authz`: **`ROLES`** (`ROLES.OWNER`…), **`FEATURES`** (`FEATURES.MESSAGING`…),
  **`LIMITS`** (`LIMITS.MAX_ACTIVE_APPLICATIONS`…), and role groups like **`AGENT_SIDE_ROLES`**.
  This keeps the lists changeable in one place and prevents drift across backend/portal/mobile.
- Prefer the shared CASL ability (`req.ability` via `can(req, action, asSubject(...))`) and the
  `requireFeature` / `checkWithinLimit` guards over re-deriving access from the DB.
- When you add a new gateable capability, add it to the `@durin-tech/authz` catalog first
  (`FEATURE_KEYS`/`FEATURES` or `LIMIT_KEYS`/`LIMITS`), publish, then use the constant.
