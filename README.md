# Japa Backend

Firebase Cloud Functions backend for the Japa immigration platform.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│            Clients: Portal (Next.js) / Mobile (Expo)        │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    Firebase Services                        │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐ │
│  │   Auth      │  │  Firestore  │  │  Cloud Functions    │ │
│  │             │  │             │  │                     │ │
│  │ - Email/Pass│  │ - users     │  │ - api (Express)     │ │
│  │ - Google    │  │ - agents    │  │ - onUserCreated     │ │
│  │ - Phone     │  │ - agencies  │  │ - onApplicationUpd  │ │
│  │             │  │ - apps      │  │ - scheduled jobs    │ │
│  └─────────────┘  │ - documents │  └─────────────────────┘ │
│                   │ - notes     │                           │
│  ┌─────────────┐  │ - countries │   ┌─────────────────────┐ │
│  │  Storage    │  │ - visaTypes │   │  Cloud Messaging    │ │
│  │             │  └─────────────┘   │                     │ │
│  │ - documents │                    │ - push notifications│ │
│  │ - photos    │                    │                     │ │
│  └─────────────┘                    └─────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

## Project Structure

```
japa-backend/
├── functions/
│   ├── src/
│   │   ├── controllers/        # HTTP request handlers
│   │   ├── services/           # Business logic (Firestore operations)
│   │   ├── routes/             # Express route definitions
│   │   ├── middleware/         # Auth verification, role checks
│   │   ├── types/              # TypeScript type definitions
│   │   ├── utils/              # Firebase init, response helpers
│   │   ├── data/               # Seed data definitions
│   │   ├── scripts/            # Seed script runners
│   │   ├── app.ts              # Express app & route mounting
│   │   └── index.ts            # Cloud Functions entry point
│   ├── lib/                    # Compiled JS output (gitignored)
│   ├── package.json
│   └── tsconfig.json
├── firebase.json               # Emulator and deployment config
├── firestore.rules             # Firestore security rules
├── firestore.indexes.json      # Composite indexes
├── storage.rules               # Cloud Storage security rules
├── api.http                    # REST Client test file
├── .vscode.sample/             # REST Client environment template
└── README.md
```

## Setup

### Prerequisites

- Node.js 22 (required by `engines` in `package.json` / the Cloud Functions runtime)
- Firebase CLI: `npm install -g firebase-tools`

### Quick Start (recommended)

The easiest way to run everything is from the monorepo root:

```bash
./dev.sh --seed --no-mobile
```

This builds the functions, starts all emulators, seeds test data, and launches the portal in one command. See `./dev.sh --help` for options.

### Manual Setup

```bash
# Install dependencies
cd japa-backend/functions
npm install

# Build TypeScript
npm run build

# Start emulators (run from japa-backend/, not functions/)
cd ..
firebase emulators:start --project japa-platform
```

### Portal Integration

Set the portal's `NEXT_PUBLIC_API_URL` in `japa-portal/.env.local`:

```
NEXT_PUBLIC_API_URL=http://localhost:5001/japa-platform/us-central1/api
```

## User Roles

| Role | Description |
|------|-------------|
| **Agency Owner** | Creates agency, invites/manages agents, sees all agency cases |
| **Agent** | Independent or part of agency, handles assigned cases |
| **Admin** | Super user, sees everything |

Cases belong to the agency and persist when agents leave.

## API Endpoints

### Authentication
All protected endpoints require `Authorization: Bearer <firebase-id-token>` header.

### Users

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/users/me` | Yes | Get current user profile |
| PUT | `/users/me` | Yes | Update user profile |
| DELETE | `/users/me` | Yes | Delete user account |
| POST | `/users/onboarding` | Yes | Complete onboarding |
| GET | `/users/onboarding/status` | Yes | Check onboarding status |
| POST | `/users/fcm-token` | Yes | Register FCM token |
| POST | `/users/login` | Yes | Record login |

### Countries & Visas

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/countries` | No | List supported countries |
| GET | `/countries/:code` | No | Get country details |
| GET | `/countries/:code/visas` | No | List visa types |
| GET | `/countries/:code/visas/:id` | No | Get visa type details |
| GET | `/countries/:code/visas/:id/full` | No | Get visa with requirements |
| GET | `/countries/:code/visas/:id/requirements` | No | List requirements |
| GET | `/visas/search?q=` | No | Search visa types |
| GET | `/visas/popular` | No | Get popular visas |

### Agents

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/agents` | No | List verified agents |
| GET | `/agents/top` | No | Get top-rated agents |
| GET | `/agents/:id` | No | Get agent profile |
| GET | `/agents/:id/reviews` | No | Get agent reviews |
| GET | `/agents/visa/:visaTypeId` | No | Get agents for visa type |
| POST | `/agents` | Yes | Create agent profile |
| GET | `/agents/me` | Yes | Get my agent profile |
| PUT | `/agents/me` | Yes | Update my agent profile |
| PUT | `/agents/me/availability` | Yes | Set availability |
| POST | `/agents/:id/reviews` | Yes | Add review |

### Applications

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/applications?role=agent\|owner\|admin` | Yes | List applications (role-based) |
| POST | `/applications` | Yes | Create application |
| GET | `/applications/:id` | Yes | Get application detail |
| PUT | `/applications/:id` | Yes | Update application |
| PUT | `/applications/:id/status` | Yes | Update application status |
| DELETE | `/applications/:id` | Yes | Delete application |
| GET | `/applications/:id/timeline` | Yes | Get application timeline |

The `role` query parameter controls which applications are returned:
- `agent` — applications assigned to the current user as agent
- `owner` — all applications in the user's agency (agency owners only)
- `admin` — all applications (admin users only)
- _(omitted)_ — applications owned by the current user

### Documents

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/applications/:id/documents` | Yes | List application documents |
| POST | `/documents` | Yes | Create document record |
| POST | `/documents/upload-url` | Yes | Get signed upload URL |
| PUT | `/documents/:id/status` | Yes | Update document status (approve/reject) |
| GET | `/documents/:id/download` | Yes | Get download URL |
| DELETE | `/documents/:id` | Yes | Delete document |

### Agencies

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| POST | `/agencies` | Yes | Create agency |
| GET | `/agencies/me` | Yes | Get my agency |
| PUT | `/agencies/me` | Yes | Update my agency |
| GET | `/agencies/:id/members` | Yes | List agency members |
| DELETE | `/agencies/:id/members/:agentId` | Yes | Remove member |
| POST | `/agencies/:id/invitations` | Yes | Invite member |
| GET | `/agencies/:id/invitations` | Yes | List pending invitations |
| PUT | `/agencies/:agencyId/invitations/:invitationId/accept` | Yes | Accept invitation |
| PUT | `/agencies/:agencyId/invitations/:invitationId/decline` | Yes | Decline invitation |

### Application Notes

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/applications/:id/notes` | Yes | List notes for application |
| POST | `/applications/:id/notes` | Yes | Add note |
| PUT | `/applications/:id/notes/:noteId` | Yes | Update note (author only) |
| DELETE | `/applications/:id/notes/:noteId` | Yes | Delete note (author only) |

## Firestore Collections

### Top-level collections

| Collection | Description |
|------------|-------------|
| `users` | User accounts and profiles |
| `agents` | Agent professional profiles (linked to user via `userId`) |
| `agencies` | Agency profiles with embedded services and stats |
| `agencyInvitations` | Pending/accepted/declined agency invitations |
| `countries` | Supported destination countries |
| `applications` | Visa applications with denormalized client/visa info |
| `consultations` | Agent-client consultation bookings |
| `transactions` | Payment records |
| `notifications` | Push notification records |
| `conversations` | Agent-user chat conversations |

### Subcollections

| Path | Description |
|------|-------------|
| `countries/{code}/visaTypes/{id}` | Visa types for a country |
| `countries/{code}/visaTypes/{id}/requirements/{id}` | Required documents per visa |
| `applications/{id}/documents/{id}` | Uploaded documents for an application |
| `applications/{id}/timeline/{id}` | Status timeline entries |
| `applications/{id}/notes/{id}` | Agent/owner case notes |
| `agents/{id}/reviews/{id}` | Client reviews for an agent |
| `conversations/{id}/messages/{id}` | Chat messages |

### Key Data Model Patterns

- **Denormalization**: `Application` stores `clientName`, `clientEmail`, `visaTypeName`, `countryName` to avoid joins
- **Embedded bounded lists**: `Agency.services` is embedded directly (small, bounded array)
- **Colocated stats**: `Agency.totalAgents`, `totalCases`, `activeCases` updated on write
- **Subcollections for unbounded data**: documents, timeline, notes, messages

## Seed Data

Seed scripts populate the emulator with test users and Firestore data.

### Seed Users

All seeded with password `password123`:

| Role | Email | UID | Custom Claims |
|------|-------|-----|---------------|
| Admin | admin@japatest.com | seed-user-admin-001 | `admin: true` |
| Admin 2 | admin2@japatest.com | seed-user-admin-002 | `admin: true` |
| Agency Owner | owner@japatest.com | seed-user-owner-001 | — |
| Agent 1 | agent1@japatest.com | seed-user-agent-001 | — |
| Agent 2 | agent2@japatest.com | seed-user-agent-002 | — |
| Client | john.doe@example.com | seed-user-client-001 | — |

Additional clients (jane.smith, ahmed.ali, etc.) are also seeded for case data.

### Running Seeds

```bash
cd functions

# Seed everything (auth users + all Firestore data) into the running emulators
npm run seed:emulator
```

**The emulator seed must run under the project the emulators + portal use.** The
Firestore emulator namespaces data per project: this repo's emulators run as
`japa-platform` (`.firebaserc` `default`) and the portal points at
`localhost:5001/japa-platform/…`. `seed:emulator` therefore pins
`GCLOUD_PROJECT=japa-platform`; without it, `seed-all` falls back to `demo-seli`
and the data lands in a namespace the Emulator UI + portal never read — the seed
"succeeds" but nothing shows. Start the emulators first
(`firebase emulators:start`), then seed.

### Seeding a real project (dev / prod) — use a service account

`seed:dev` / `seed:prod` run the **full** seed against a live Firebase project
(`durin-seli-dev` / `japa-platform`). Two gotchas:

**1. Authenticate with a service account, not user ADC.** The seed creates Auth
users (`identitytoolkit`). With user credentials (`gcloud auth
application-default login`) that call fails with:

```
FirebaseAuthError: ... identitytoolkit.googleapis.com API requires a quota
project, which is not set by default.
```

firebase-admin's Auth client does **not** apply the ADC quota project, so
`gcloud auth application-default set-quota-project` does **not** fix it. Use a
service account with the `firebase.admin` role instead — its own project is the
quota consumer, so it just works:

```bash
cd functions

# One-off: create a key for an existing SA (e.g. the CI deployer)
gcloud iam service-accounts keys create /tmp/seli-dev-sa.json \
  --iam-account=ci-deployer@durin-seli-dev.iam.gserviceaccount.com
#   (list SAs with: gcloud iam service-accounts list --project durin-seli-dev)

# Run the full seed with the SA
GOOGLE_APPLICATION_CREDENTIALS=/tmp/seli-dev-sa.json npm run seed:dev
# prod is guarded:  GOOGLE_APPLICATION_CREDENTIALS=... npm run seed:prod -- --confirm-prod
```

Delete the key when done (`rm /tmp/seli-dev-sa.json`).

**2. Changing plan features requires the full seed, not just `seed-plans`.**
Entitlements are **cached** per subscriber (`entitlements/{subscriberId}`), and
`attachAuthz` reads that cache. Re-seeding only the `plans` collection updates
the plan definitions but leaves the stale cache in place, so accounts won't see
the change. `seed:dev`/`seed:prod` recompute the cache (the "subscriptions &
entitlements" step) — so run the **full** seed after editing `seed-plans.ts`
(e.g. the free-plan feature list), not `node lib/scripts/seed-plans.js` alone.

> After seeding, deploy code changes separately:
> `firebase deploy --only functions --project durin-seli-dev`.

### What Gets Created

The portal seed creates:
- 10+ auth users (admins, owner, agents, clients)
- 1 agency with 4 services
- 3 agents linked to the agency
- 5 applications across statuses
- Timeline entries, documents, notes, reviews
- Transactions, consultations, notifications
- Conversations, payment requests, bank accounts

All IDs are deterministic (`seed-*`) so the script is idempotent.

## API Testing (`api.http`)

Test endpoints directly in VS Code using the [REST Client](https://marketplace.visualstudio.com/items?itemName=humao.rest-client) extension.

### Setup

```bash
cd japa-backend
cp -r .vscode.sample .vscode
```

This creates `.vscode/settings.json` with REST Client environment variables. The `.vscode/` directory is gitignored so your local settings (including any production API keys) won't be committed.

### Environments

Switch between environments from the VS Code status bar (bottom right corner):

| Environment | Auth URL | API URL | API Key |
|-------------|----------|---------|---------|
| **local** | Firebase Auth emulator (port 9099) | Cloud Functions emulator (port 5001) | `fake-api-key` (anything works) |
| **production** | `identitytoolkit.googleapis.com` | Deployed Cloud Functions | Your real Firebase API key |

For production, open `.vscode/settings.json` and replace `YOUR_FIREBASE_API_KEY` with your key from [Firebase Console](https://console.firebase.google.com/) > Project Settings > Web app > `apiKey`.

### How It Works

1. Start emulators with seed data (`./dev.sh --seed --no-mobile` from monorepo root)
2. Open `api.http` in VS Code
3. Select the **local** environment from the status bar
4. Click **Send Request** on a login block (e.g. "Sign in as Admin") — this calls the Firebase Auth REST API to get a real ID token
5. Run any subsequent request — it uses the captured token automatically via `{{adminToken}}`, `{{ownerToken}}`, etc.

The login blocks sign in against Firebase Auth (emulator or production, depending on environment) and capture the `idToken` from the response. Tokens expire after ~1 hour; just re-run the login request to get a fresh one.

## Development

### Commands

```bash
cd functions

npm run build            # Compile TypeScript
npm run build:watch      # Compile with watch mode
npm run serve            # Build + start emulators
npm run lint             # Run ESLint
npm run lint:fix         # Auto-fix lint issues
npm run deploy           # Deploy to Firebase
```

### Emulator Ports

| Service | Port | URL |
|---------|------|-----|
| Emulator UI | 4000 | http://localhost:4000 |
| Cloud Functions | 5001 | http://localhost:5001/japa-platform/us-central1/api |
| Firestore | 8080 | http://localhost:8080 |
| Auth | 9099 | http://localhost:9099 |
| Storage | 9199 | http://localhost:9199 |

## Deployment

Three environments — **local** (emulators), **dev/staging** (`durin-seli-dev`), and
**prod** (`japa-platform`). Deploys are **push-to-branch** via GitHub Actions:

| Push to | Deploys to | Workflow |
|---------|-----------|----------|
| `dev` | `durin-seli-dev` | `.github/workflows/deploy-dev.yml` |
| `main` | `japa-platform` | `.github/workflows/deploy-prod.yml` |

Each workflow lints, builds, and runs `firebase deploy --project <alias>` (aliases in
`.firebaserc`: `dev` → durin-seli-dev, `default`/`prod` → japa-platform). See the
meta-repo **`ENVIRONMENTS.md`** for the full runbook (one-time project setup, App
Hosting, CI auth gotchas). Manual deploy is still available when needed:

```bash
firebase deploy --only functions --project dev    # or: default (prod)
firebase deploy --only firestore:rules,storage:rules --project dev
firebase deploy --only firestore:indexes --project dev
```

## Secrets & Configuration

Runtime secrets are **Cloud Secret Manager** entries, bound to functions via
`.runWith({ secrets: [...] })` in `src/index.ts` — never committed to git. They
**bind at deploy time**: after changing a secret's value you must redeploy (push the
branch, or `firebase deploy --only functions`) for functions to pick up the new
version.

| Secret | Used by | Notes |
|--------|---------|-------|
| `PAYSTACK_SECRET_KEY` | billing / checkout | `sk_test_…` on dev, `sk_live_…` on prod |
| `PAYSTACK_CALLBACK_URL` | billing | **portal** URL Paystack redirects to after payment — points at `<portal>/account-settings`, *not* a backend endpoint (see Payments below) |
| `PAYSTACK_PUBLIC_KEY` | portal (client) | not bound to functions; used for inline checkout |
| `RESEND_API_KEY` | email | Resend API key (`re_…`) |
| `EMAIL_FROM` | email | verified sender, e.g. `Seli <info@weareseli.com>` |

Set/rotate a value (per project):

```bash
printf '%s' 'sk_test_XXXX' \
  | gcloud secrets versions add PAYSTACK_SECRET_KEY --project durin-seli-dev --data-file=-
# then redeploy so functions bind the new version
```

Locally (emulators) these are read from `functions/.env` (see `.env.example`); an
unset secret is safe — email/billing degrade rather than crash (see below).

### Non-secret config (plain env vars)

Some runtime config is **not** sensitive and lives in plain env vars (not Secret
Manager). Set these in `functions/.env.local` for emulators, and in the committed
**per-project** env files for deployed environments:

| File | Loaded when | Committed? |
|------|-------------|------------|
| `functions/.env.durin-seli-dev` | deploying to durin-seli-dev (`--project dev`) | yes — no secrets in it |
| `functions/.env.japa-platform` | deploying to japa-platform (`--project default`/`prod`) | yes — no secrets in it |
| `functions/.env.local` | **emulator only** | no (git-ignored) |

Firebase reads `functions/.env.<PROJECT_ID>` at **deploy time** and injects those
keys into **every** deployed function — unlike `runWith({ secrets })`, which is
bound per function. So config here also reaches the Firestore/auth/scheduled email
triggers, not just `api`. These files are **committed on purpose**: they contain no
secrets, and keeping them in-repo is what makes dev-vs-prod values reviewable
instead of an implicit code fallback.

> **Local dev gotcha.** The emulator loads `.env.<PROJECT_ID>` as well, and dotenv
> files **override the shell environment** — so `APP_URL=… npm start` has no
> effect. Files are merged in order (`.env` → `.env.<PROJECT_ID>` → `.env.local`),
> so **`.env.local` is the only thing that reliably wins locally**. Keep
> `APP_URL=http://localhost:3000` in it (it's in `.env.example`), or local emails
> will link at a deployed portal whose `oobCode`s can't validate against your
> emulator. Also note `.env.<PROJECT_ID>` and `.env.<alias>` are mutually
> exclusive — firebase-tools errors if both exist — hence the project-ID naming.

| Env var | Used by | Notes |
|---------|---------|-------|
| `APP_URL` | email links | Portal base URL used to build every link in transactional email — footer, the auth deep-links (`/reset-password?oobCode=…`, `/verify-email`, `/claim`, `/login?magic=1`), agent invites (`/create-account?invite=…`), the guest-consultation Paystack return (`/a/<slug>/confirm`) and client payment returns. Falls back to the prod portal (`https://portal.weareseli.com`) when unset — which is why it **must** be set per project: the `oobCode` is project-scoped, so a prod URL in dev emails produces links that don't validate. **Local dev:** `APP_URL=http://localhost:3000`; the local startup scripts (`npm start`, `npm --prefix functions run serve`) already default it. |
| `EMAIL_LOGO_URL` | email header | Hosted logo shown in the email header. Intentionally left at the prod portal (`https://portal.weareseli.com/assets/seli_logo.png`) in **all** environments — it's a public static asset, and pointing dev emails at a dev host only risks a broken image. |

## Authorization & Entitlements

Authorization uses the shared **`@durin-tech/authz`** package (private GitHub Packages).

- **Roles** (`admin`/`owner`/`agent`/`client`) live in Firebase **custom claims**, set by `claims.service`
  on signup / onboarding / invite-accept / leave, plus an admin `PUT /users/:uid/role`. Backfill existing
  users: `node lib/scripts/backfill-claims.js`.
- **Enforcement**: `verifyAuth` → `attachAuthz` builds `req.authz` + a CASL `req.ability` (RBAC +
  entitlements). Controllers gate with `can(req, action, asSubject(...))` and `requireFeature` /
  `checkWithinLimit`. `GET /users/me/authorization` returns role + entitlements + packed CASL rules.
- **Entitlements**: `plans` / `subscriptions` / `entitlements` collections (`entitlement.service`). Seed
  plans: `node lib/scripts/seed-plans.js`. Gating is safe-rollout (RBAC-only until a subscriber has an
  entitlements doc).
- **Billing**: Paystack (`services/billing/`) behind a provider-agnostic `BillingProvider`; webhook at
  `/webhooks/paystack` (HMAC-verified, raw body). Agency **per-seat** billing is enforced at agent
  invite/accept (HTTP 402 when over paid seats).

Install needs a GitHub Packages token: `NODE_AUTH_TOKEN="$(gh auth token)" npm install` (the committed
`.npmrc` reads it). See [`todo.md`](./todo.md) for deploy secrets, Paystack config, and the Firebase
Functions build-token caveat.

### Payments flow (Paystack)

The subscription **upgrade/downgrade** flow (`POST /subscriptions/checkout`):

1. **Free plan** (`priceKobo <= 0`, e.g. a downgrade to the free tier) — there is
   nothing to charge and Paystack rejects a zero amount (`Invalid Amount Sent`), so
   the backend **skips Paystack**: it cancels any active paid subscription at the
   provider (stops recurring billing), applies the plan + recomputes entitlements
   immediately, and returns `{ applied: true }` (no redirect).
2. **Paid plan** — the backend initializes a Paystack transaction and returns a hosted
   `{ url }`. The **portal** redirects the browser there.
3. After payment Paystack redirects the **browser** back to `PAYSTACK_CALLBACK_URL`,
   which is a **portal** page (`<portal>/account-settings?reference=…`) — *not* a
   backend endpoint. The portal reads the `reference` and calls `POST /subscriptions/verify`
   to confirm + apply (verify-on-return).
4. `POST /webhooks/paystack` is the authoritative server-to-server confirmation
   (both verify and webhook are idempotent).

Provider failures (bad/misconfigured key, Paystack down, rejected charge) are
normalized by the provider into a `PAYSTACK_ERROR: <msg> (HTTP <status>)` and
surfaced by `createCheckout` as a clean **502** (detail logged), not a naked 500.

Test card (Paystack test mode): `4084 0840 8408 4081`, any future expiry, any CVV.

### Transactional email (Resend)

Email goes through a provider interface (`services/email/`, default **Resend**).
It's **safe-rollout**: until `RESEND_API_KEY` + `EMAIL_FROM` are set the channel is
skipped (logged, not thrown). A `403` from Resend means the `EMAIL_FROM` domain
isn't verified in Resend — verify the sending domain (dev uses `weareseli.com`,
sender `info@weareseli.com`). On deployed environments `NODE_ENV=production`, so the
`EMAIL_FROM_DEV_OVERRIDE` (local-only `onboarding@resend.dev` fallback) is inert.

**Whitelabeled password reset** (`POST /auth/forgot-password`, public): the Admin SDK
mints a Firebase reset link, we extract its `oobCode`, and email a branded link to the
portal's own `${APP_URL}/reset-password?oobCode=…` page (the portal completes the reset
client-side). The endpoint is **enumeration-safe** (identical response whether or not the
account exists). Set [`APP_URL`](#non-secret-config-plain-env-vars) to the portal for
_this_ backend's Firebase project — the `oobCode` is project-scoped, so a mismatched
`APP_URL` produces links that won't validate.

## License

Private - Japa Inc.
