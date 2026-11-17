# E2E emulators and fixture (mobile Maestro suite)

Issue: DURIN-TECH/japa#361. The mobile suite in `seli-mobile/.maestro/` runs
against the local Firebase emulators started from this repo, with the full seed
plus a small e2e fixture. Nothing in this setup touches `durin-seli-dev` or
`japa-platform`.

## Emulator config: `firebase.e2e.json`

A separate config so the suite never collides with a developer's emulators on
the default ports (`firebase.json`, unchanged) or with the rules-test config
(`firebase.emulator-test.json`). **The JSON file is the source of truth for the
ports**: the mobile runner reads it. At the time of writing:

| Emulator            | Port  |
|---------------------|-------|
| hub                 | 19600 |
| logging             | 19601 |
| functions           | 19602 |
| firestore           | 19603 |
| firestore websocket | 19604 |
| auth                | 19605 |
| storage             | 19606 |
| pubsub              | 19607 |
| eventarc (reserved) | 19608 |
| tasks (reserved)    | 19609 |

The UI is off. `singleProjectMode` is on, as in `firebase.json`. Eventarc and
tasks are listed so that if the emulator suite starts them, they land in the
block too.

### Why the project id is `durin-seli-dev`

The simulator dev build's native Firebase config is `durin-seli-dev`, so the
Auth emulator mints tokens for that id; emulators on a `demo-*` id reject them
with 401. Because that is the REAL dev project id, real access must be cut off
before the emulators start:

- `functions/.secret.local` holds a dummy value for **every** secret the
  functions declare (otherwise the functions emulator fetches the real ones
  from Secret Manager). The file is git-ignored. List the declared names from a
  build with the command in "Declared secrets" below.
- `GOOGLE_APPLICATION_CREDENTIALS` points at a fake service-account JSON whose
  `token_uri` is unreachable (keep it outside the repo).
- `CLOUDSDK_CONFIG` and `XDG_CONFIG_HOME` point at empty temporary folders, so
  no gcloud / firebase login is picked up.

Local email sending is already off under the functions emulator
(`EMAIL_SENDING_ENABLED` unset, see `services/email/email.service.ts`).

### Commands

```bash
# from the seli-backend root, with the cut-off environment above exported
npm --prefix functions run build
firebase emulators:start --project durin-seli-dev --config firebase.e2e.json \
  --only functions,firestore,auth,storage,pubsub

# in another shell (same cut-off environment), seed
export FIRESTORE_EMULATOR_HOST=127.0.0.1:19603
export FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:19605
export FIREBASE_STORAGE_EMULATOR_HOST=127.0.0.1:19606
npm --prefix functions run seed:e2e
```

API base for the app and for curl:
`http://127.0.0.1:19602/durin-seli-dev/us-central1/api`.

### Declared secrets

```bash
# after a build; prints the names, space-separated
cd functions && FIRESTORE_EMULATOR_HOST=127.0.0.1:1 GCLOUD_PROJECT=demo-list node -e '
const m=require("./lib/index.js"),s=new Set();
for (const v of Object.values(m)) for (const x of (v&&v.__endpoint&&v.__endpoint.secretEnvironmentVariables)||[]) s.add(x.key);
console.log([...s].sort().join(" ")); process.exit(0)'
```

## The fixture: `npm run seed:e2e`

`functions/src/scripts/seed-e2e.ts` (builders in
`functions/src/scripts/e2e/e2e-fixture-data.ts`):

1. **Safety guard** (`functions/src/scripts/e2e/emulator-guard.ts`), before any
   Firebase module loads: refuses (exit 2, nothing written) unless
   `FIRESTORE_EMULATOR_HOST`, `FIREBASE_AUTH_EMULATOR_HOST` and
   `FIREBASE_STORAGE_EMULATOR_HOST` are all set to `localhost:<port>` or
   `127.0.0.1:<port>` (an `http://` prefix is accepted), the project is
   `durin-seli-dev` (default) or a `demo-*` id, and `GCLOUD_PROJECT` /
   `GOOGLE_CLOUD_PROJECT`, when set, name that same project.
2. **Full seed**: `seed-all.js --project <project>` as a child process with
   the same environment. Skip it with `-- --fixture-only` when the full seed
   has already run.
3. **Fixture**, all fixed ids and timestamps (running it twice writes the same
   data):

| What | Id / value |
|------|------------|
| Visa (from the full seed) | `IE` / `short-stay-c` (Short Stay 'C' Visa, Ireland) |
| Rulebook | `visaRubrics/IE_short-stay-c`, version `1`, `approved` |
| Intake question 1 | `e2e-visit-purpose`, single choice: `tourism` "Tourism", `business` "Business", `family` "Visiting family or friends" |
| Intake question 2 | `e2e-visited-before`, yes/no: "Have you visited Ireland before?" |
| Intake question 3 | `e2e-accommodation`, text: "Where will you stay?" |
| Checklist items (after any answer) | `ev-e2e-passport` "Passport", `ev-e2e-accommodation-proof` "Proof of accommodation" |
| Client | uid `seed-user-e2e-client-001`, `delivered+e2e.amaka.obi@resend.dev`, Amaka Obi, free plan (`client_free`), onboarding complete, role `client` |
| Client's applications | none: every application of this client is deleted on each run |

The client's password is the seed password (`SEED_PASSWORD` in
`functions/src/data/seed-portal-data.ts`), like every seeded account.

The rulebook's quotes are fixture text that says it is not real guidance, under
a `.invalid` URL. It is written straight to Firestore as approved (the real
path, extraction plus automatic approval, calls a model), so the
auto-publish trigger ignores it.

Until the intake has an answer, the checklist answers `intake_needed` (no
rows); that is the backend's normal behaviour for a route with questions.
