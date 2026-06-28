# Backend — TODO (RBAC + Entitlements + Paystack billing)

The RBAC/entitlement *framework* and Paystack *integration* are built, build clean, and the core pipeline is
emulator-verified. Two kinds of work remain: **deferred dev work** (§0, code) and **manual/ops** (§1+,
secrets/dashboards/deploy — can't be automated from the codebase).

## 0. Granular enforcement — status

**DONE (this pass):**
- [x] **Feature guards applied** via `requireFeature(FEATURES.*)` at the routes: messaging (create
      conversation + send message), consultations (book), documents (upload-url + create), payment-requests
      (create), applications (create + for-client), analytics (all dashboard GETs), agency invitations.
- [x] **Limits enforced** via `checkWithinLimit`: `max_active_applications` (both create paths) and
      `max_documents_per_application` (document create). Agency agent **seats** enforced inline at invite/accept.
- [x] **Admin-source reconciled.** `payment-request.controller` no longer reads the legacy `users/{id}.admin`
      field — uses `req.authz.role === ROLES.ADMIN`.
- [x] Guards are **safe-rollout** (admins + not-yet-resolved entitlements pass), so nothing 402s before plans
      are seeded/assigned.

**DONE (follow-up pass):**
- [x] **`max_consultations_per_month`** enforced in `consultation.controller.createConsultation` (counts the
      booking subscriber's consultations for the current month).
- [x] **CASL access-migration finished.** `consultation`/`transaction`/`analytics` `?role=` switches now use
      `req.authz` + `ROLES` (no `getAgentForUser` re-lookups); `note` & `consultation` `checkAccess` →
      `can(req, "read", asSubject(...))`; `agency.getMembers` uses the role claim. Remaining `getAgentForUser`
      uses are legitimate data fetches (consultation author profile, transaction same-agency check), not role
      derivation. Verified live on the emulator: a feature-locked action returns **402**, unlocked returns 2xx.

**STILL REMAINING:**
- [ ] Paystack flows are coded but **not runtime-tested** — verify checkout + webhook with test keys/cards
      once §2 secrets are set.

> Net: RBAC + feature gates + all numeric limits are enforced and unified on the shared CASL ability +
> `ROLES`/`FEATURES`/`LIMITS` constants. Only the Paystack runtime test remains (needs secrets).

---

## Manual / Ops (human action — secrets, dashboards, deploy)

## 1. Private package access — `@durin-tech/authz` (GitHub Packages)
The backend installs the private `@durin-tech/authz` from GitHub Packages (`.npmrc` is committed and reads
`${NODE_AUTH_TOKEN}`). A `firebase deploy` reinstalls deps in Google's cloud build (it ignores
`node_modules`), so that build needs the token too.
- [ ] Create **ONE read-only token** — a fine-grained PAT scoped to the **DURIN-TECH org → Packages:
      read-only** (or a machine/bot account). **Do NOT** bake a personal PAT into the build.
- [ ] Make `NODE_AUTH_TOKEN` available to the **Firebase Functions cloud build** (the fiddly one — 1st-gen
      functions don't expose build env cleanly). Pick one:
      - inject the token into the build's npm auth, **or**
      - bundle `@durin-tech/authz` into the deploy output so it isn't fetched at install time, **or**
      - vendor a built copy as a fallback.
      → Decide + implement before the first deploy (a `firebase deploy` will otherwise fail on `npm install`).

## 2. Paystack billing secrets + dashboard
- [ ] `firebase functions:secrets:set PAYSTACK_SECRET_KEY`  (use test key first)
- [ ] `firebase functions:secrets:set PAYSTACK_CALLBACK_URL`
- [ ] Register the webhook URL in the **Paystack dashboard** → points to the deployed
      `…/api/webhooks/paystack` (raw-body verified via HMAC-SHA512).
- [ ] If using Paystack-managed recurring plans, create the plans in Paystack and set each plan's
      `paystackPlanCode` (via the admin Plans UI / `PUT /admin/plans/:id`).

## 3. Firestore indexes
- [ ] Verify composite indexes for the new queries (e.g. `plans` where `audience ==` + `isDefault ==`,
      `plans` where `audience ==` ordered by `priceKobo`). Add to `firestore.indexes.json` and
      `firebase deploy --only firestore:indexes` if the emulator/logs flag a missing index.

## 4. Data migration — run against the REAL project (not the emulator)
> Set `GCLOUD_PROJECT=japa-platform` and **do not** set the emulator host vars.
- [ ] `cd functions && npm run build`
- [ ] `node lib/scripts/backfill-claims.js`  → sets `role` (+ `agencyId`) custom claims for all existing users
- [ ] `node lib/scripts/seed-plans.js`        → creates the 9 plans (3 tiers × client/agent/agency)
- [ ] (optional) Assign plans to existing agencies/clients via the admin UI or `POST /subscriptions/assign`
      — otherwise the free default plan applies.
- [ ] Note: already-signed-in users get role claims lazily on their next request (attachAuthz backfills),
      or force a client token refresh.

## 5. Deploy + verify
- [ ] `firebase deploy --only functions` (predeploy runs lint + build; needs §1 resolved).
- [ ] Smoke test `GET /users/me/authorization` as each role → returns role + entitlements + packed rules.
- [ ] Test agent invite/accept over the paid-seat limit → expect **HTTP 402** (`SeatLimitError`).
- [ ] Test a Paystack checkout + webhook with **test keys + test cards**; confirm the subscription +
      entitlements update only on a verified event.

## Notes
- Entitlement gating is **safe-rollout**: until a subscriber has an entitlements doc, access is RBAC-only —
  so nothing locks before plans are seeded/assigned.
- The legacy `users/{id}.admin` field is now superseded by the `role` claim; keep it read-only during the
  transition, then drop it.
