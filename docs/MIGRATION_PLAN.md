# Japa Backend — Firebase → Self-Hosted Migration Plan

## 0. Executive summary

You are running an Express app inside Firebase Cloud Functions, backed by Firestore, Firebase Auth, Cloud Storage, FCM, and Cloud Scheduler. Because the app layer is already Express, **~70% of your code ports untouched** — the migration work is almost entirely about swapping managed Firebase services for self-hosted equivalents behind a repository abstraction, then executing a zero-downtime cutover using the strangler + dual-write pattern.

**Recommended target stack** (minimal external coupling, low-cost):

| Firebase service | Replacement | Why |
|---|---|---|
| Cloud Functions (Node 22 + Express) | Node 22 + Express on a VPS (Docker Compose / systemd) | Keep the framework; just host the process |
| Firestore | **PostgreSQL 16** (+ JSONB for flex fields) | Relational data (agents↔agencies↔applications), mature tooling, free |
| Firebase Auth | **Self-hosted GoTrue** (Supabase Auth, MIT-licensed, standalone) OR custom JWT + argon2 | GoTrue supports Firebase password-hash import; minimal ops overhead |
| Cloud Storage + signed URLs | **MinIO** (S3-compatible) | Drop-in for `@aws-sdk/client-s3`; presigned URL pattern identical |
| FCM push | **Keep FCM directly** (not via Firebase SDK) via HTTP v1 API; long term: `node-pushnotifications` → FCM + APNs | FCM itself is free forever and sending tokens doesn't require Firebase project lock-in — you just keep one Google project for FCM, everything else leaves |
| Cloud Scheduler + Pub/Sub triggers | **node-cron** (in-process) for light jobs; **BullMQ + Redis** for the scraper | Redis is already useful for caching; avoids Cloud Tasks |
| Firestore document triggers | **Outbox table + worker** OR explicit service calls inside transactions | Deterministic, easier to debug than event-sourced |
| Firestore security rules | Application-layer authorization (already partly in middleware) | Consolidate in one place |
| Firebase config / secrets | `.env` + **SOPS-encrypted** secrets in git, decrypted at deploy time | Free, no external secret manager |
| Monitoring/logging | **Loki + Prometheus + Grafana** (Docker) or **Uptime Kuma** + journald | Free, runs on the same box to start |
| TLS / reverse proxy | **Caddy** (auto HTTPS via Let's Encrypt) | Zero-config TLS |
| CDN / WAF | **Cloudflare free tier** | Free DDoS + TLS at edge, optional |
| Backups | `pg_dump` + `mc mirror` (MinIO) to **Backblaze B2** offsite | ~$0.005/GB/mo; cheapest offsite option |

**One piece of unavoidable external coupling remains**: FCM and APNs for mobile push. There is no truly self-hosted option for iOS/Android push that reaches the OS-level notification tray — the phone vendor controls the last mile. Keeping FCM is free and only couples one service. The Firebase project can be reduced to *just* FCM after migration.

**Migration strategy**: strangler fig + dual-write. Nothing is switched off in Firebase until the self-hosted system has served production traffic successfully for at least one full business week and all data has been reconciled byte-for-byte.

---

## 1. Target architecture (single VPS → optional HA later)

### Phase-one topology (single VPS, ~$20–40/mo)

```
Internet
  │
  ▼
Cloudflare (free tier — DNS, DDoS, WAF)
  │
  ▼
VPS (4 vCPU / 8 GB RAM / 160 GB NVMe — Hetzner CCX13 ~€13, or DO 4GB ~$24)
  ├── Caddy (reverse proxy, TLS)
  ├── Docker Compose:
  │     ├── api         (Node 22, Express) — 2 replicas behind Caddy
  │     ├── worker      (BullMQ consumer for scraper + notifications)
  │     ├── scheduler   (tiny container running node-cron → enqueues jobs)
  │     ├── postgres    (v16, primary)
  │     ├── redis       (cache + queue broker)
  │     ├── minio       (object storage)
  │     ├── gotrue      (auth) + postgres `auth` schema
  │     ├── prometheus, loki, grafana
  │     └── backup-sidecar (pg_dump → b2 nightly)
  └── Systemd unit supervising docker-compose
```

### Phase-two (when you outgrow it)

- Move Postgres to a managed Postgres or to its own node with streaming replica; promote on failure with **Patroni** or **repmgr**.
- Put MinIO in distributed mode (4 nodes, erasure-coded) — still self-hosted.
- Front-end load balancer: Caddy or HAProxy on a separate tiny node.
- Keep Redis single-node until it's actually a bottleneck; `redis-sentinel` when needed.

**Do not build for Phase 2 now.** A single VPS will carry this workload for the foreseeable future — the scraper is the heaviest component and it's I/O-bound, not compute-bound.

---

## 2. Decoupling the code from Firebase (prerequisite to any migration)

Today, every service and controller talks directly to `firebase-admin`. Before migration, introduce a **thin repository + event-emitter abstraction** so the rest of the code doesn't know whether it's talking to Firestore or Postgres.

This is the single most important preparatory step. Do it on `main` before any data migration, and ship it behind feature flags.

### 2.1 Repository layer
Create `functions/src/db/` with one interface per aggregate:

- `UserRepository`, `AgentRepository`, `AgencyRepository`, `ApplicationRepository`, `DocumentRepository`, `TimelineRepository`, `NoteRepository`, `ConsultationRepository`, `ConversationRepository`, `MessageRepository`, `TransactionRepository`, `PaymentRequestRepository`, `NotificationRepository`, `BankAccountRepository`, `NewsArticleRepository`, `NewsSourceRepository`, `ScrapeRunRepository`, `NewsSubscriptionRepository`, `VisaTypeRepository`, `CountryRepository`, `EligibilityRepository`, `AnalyticsEventRepository`.

Each interface has two implementations:
- `FirestoreXRepository` — the current behavior, lifted verbatim from `*.service.ts`.
- `PostgresXRepository` — new, written against `pg` / Kysely / Drizzle (see §3.2).

Wire via a `REPO_BACKEND=firestore|postgres|dual` env var selected per-route at startup.

### 2.2 Domain event bus
Firestore triggers do two things today: **side effects after writes**, and **denormalization**. Replace both with an in-process event emitter that:

1. A service method publishes a domain event (`ApplicationStatusChanged`, `ConsultationCreated`, etc.) as part of its DB transaction.
2. A transactional outbox row is written in the same transaction (Postgres side) or the same batch (Firestore side).
3. A worker picks outbox rows and calls the handler (`sendPushNotification`, `createNotificationRecord`, `updateAgentStats`).

This maps 1:1 with what the current triggers do but is backend-agnostic.

**Events to define (from `index.ts`):**
- `UserCreated` — side effects: seed user doc, send welcome push.
- `UserDeleted` — side effects: anonymize references.
- `ApplicationStatusChanged` — side effects: notify user, update agent stats.
- `ConsultationCreated` — side effects: notify agent.
- `PaymentRequestCreated` — side effects: notify client, write notification row.
- `ReviewCreated` — placeholder.
- `VisaTypeWritten` — side effects: recompute country stats.
- `NewsArticleCreated` (where `isPublished && importance!='low'`) — side effects: fan out FCM to subscribers.

### 2.3 Feature flags
Add `src/config/flags.ts`:
```
USE_POSTGRES_FOR=applications,users,agents,...   // comma list
WRITE_TO_POSTGRES=true
READ_FROM_POSTGRES=applications
```
Lets you flip one aggregate at a time without redeploy in tight loops (read from `process.env`; ok to redeploy for changes — keep it simple).

### 2.4 Exit criterion for §2
- `grep -R "firestore()" functions/src/` only returns results inside `db/firestore/`.
- Same for `admin.auth()`, `admin.storage()`, `admin.messaging()`.
- All tests green on Firestore backend.

Nothing else should proceed until this is true — otherwise every future step is blocked on tangled code.

---

## 3. PostgreSQL schema design

### 3.1 General rules

- One table per Firestore collection. Document ID → `id TEXT PRIMARY KEY` (keep the existing string IDs — don't renumber).
- Timestamps: `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`, `updated_at` maintained by a trigger.
- Arrays of scalars (`countryCodes[]`, `fcmTokens[]`, `specializations[]`): `TEXT[]` with GIN index.
- Small embedded structs (e.g., `agencies.services`, `requiredDocuments`): **JSONB column**, not a child table. These are bounded, always read/written together, and schema-lite.
- Subcollections with unbounded growth (documents, timeline, notes, messages, scrapeRuns): **separate tables** with FK + index on parent.
- Denormalized fields stay (`applications.client_name`, etc.) — the denormalization was there for read perf and that reason doesn't go away in Postgres.

### 3.2 Toolchain choice
- **Drizzle ORM** (my recommendation) — typed, SQL-first, small. Migration DSL is Postgres-native.
- Alternative: **Kysely** (query builder) + **node-pg-migrate**. Also good.
- Avoid Prisma: their engine adds weight and their migration story on an existing imported DB is painful.

### 3.3 Indexes to create (1:1 with firestore.indexes.json — derived list)
For each Firestore composite index, create the equivalent B-tree index. Examples:
- `CREATE INDEX agents_verification_rating ON agents (verification_status, rating DESC);`
- `CREATE INDEX applications_user_created ON applications (user_id, created_at DESC);`
- `CREATE INDEX applications_agent_status ON applications (agent_id, status, created_at DESC);`
- `CREATE INDEX news_published_country ON news_articles USING GIN (country_codes) WHERE is_published = true;` — partial + GIN for `array-contains`.
- `CREATE INDEX messages_conv_created ON messages (conversation_id, created_at DESC);`
- `CREATE INDEX notifications_user_read ON notifications (user_id, created_at DESC);`

Full mapping belongs in a migration file; generate programmatically from `firestore.indexes.json` to avoid omissions.

### 3.4 Firestore features → Postgres equivalents
- `FieldValue.increment(1)` → `UPDATE ... SET view_count = view_count + 1`.
- `FieldValue.arrayUnion(x)` → `UPDATE ... SET fcm_tokens = array(SELECT DISTINCT unnest(fcm_tokens || $1))`.
- `FieldValue.arrayRemove(x)` → `UPDATE ... SET fcm_tokens = array_remove(fcm_tokens, $1)`.
- `Timestamp.serverTimestamp()` → `DEFAULT now()` or `SET updated_at = now()` in the repo.
- `db.batch()` → a single `BEGIN ... COMMIT` txn.
- `db.runTransaction(...)` → `BEGIN ISOLATION LEVEL SERIALIZABLE ... COMMIT`, with retry-on-serialization-failure.
- Collection group query (`collectionGroup("reviews")`, `collectionGroup("messages")`) → just a regular query, since there's only one `reviews` or `messages` table.

### 3.5 Outbox table
```sql
CREATE TABLE domain_events (
  id             BIGSERIAL PRIMARY KEY,
  event_type     TEXT NOT NULL,
  aggregate_id   TEXT NOT NULL,
  payload        JSONB NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at   TIMESTAMPTZ,
  attempts       INT NOT NULL DEFAULT 0,
  last_error     TEXT
);
CREATE INDEX domain_events_unprocessed ON domain_events (created_at) WHERE processed_at IS NULL;
```
Worker loops `SELECT ... FOR UPDATE SKIP LOCKED LIMIT 100 WHERE processed_at IS NULL`, dispatches, marks processed. This fully replaces all Firestore triggers.

---

## 4. Auth migration (the hardest part)

This is the step most likely to cause user-visible breakage. Plan it carefully.

### 4.1 What Firebase Auth gives you today
- Email/password (Firebase stores salted **scrypt** hashes with Firebase-specific parameters).
- Google OAuth (browser popup).
- Phone auth (SMS OTP).
- ID token minted with `kid` + RS256, verified server-side via `auth.verifyIdToken()`.
- Custom claims: `admin`, `agent`.
- Auth triggers: `onCreate`, `onDelete`.

### 4.2 Recommendation: **GoTrue (Supabase Auth) standalone**

**Why:**
- MIT-licensed, single Go binary, Dockerized; run it in the same compose.
- Native support for **importing Firebase password hashes** (scrypt with Firebase's key derivation) — users never see a "please reset your password" email. This is a *huge* win.
- Google OAuth built in.
- JWT compatible shape — `user.id`, `user.email`, `user.app_metadata.roles`, signed HS256 or RS256.
- Admin endpoints for setting custom claims.

**Downsides:**
- Phone auth via Twilio only (you'd pay Twilio — but Firebase was also using the underlying SMS provider and charging you). If phone auth is ≤5% of signups, **drop it** or keep it on Firebase-only during a transitional period.
- Adds one moving part you have to keep patched.

### 4.3 If you want zero external deps: **custom JWT**
Viable but more work:
- `pg_crypto` / `argon2` (via `argon2` npm pkg) for hashing.
- `jsonwebtoken` for signing RS256 with a key pair you generate (`openssl genrsa 4096`).
- `@panva/jose` to publish a JWKS endpoint so old Firebase clients can grace-migrate.
- Write Google OAuth yourself with `openid-client` — 150 lines.
- Passwords: **cannot verify Firebase scrypt hashes natively in Node** unless you import Firebase's parameters (`base64_signer_key`, `salt_separator`, `rounds`, `mem_cost`) — available via `firebase auth:export`. Use the `firebase-scrypt` npm package (community implementation) to verify during a grace window, and on successful login re-hash with argon2 and overwrite.

I'd only pick this route if you deeply dislike having GoTrue in the stack. The hash-import dance is identical either way.

### 4.4 Token verification shim
Replace the inside of `middleware/auth.ts:verifyIdToken`:

```
// verifyIdToken now dispatches based on token.iss:
//   - iss=https://securetoken.google.com/<project> → old Firebase path
//   - iss=<our-own-issuer>                         → new path
// Clients get new tokens after first post-migration login;
// old tokens keep working until expiry (max 1 hour).
```
This gives a **seamless 1-hour grace period**. No user ever gets logged out.

### 4.5 Custom claims port
Add a `user_roles (user_id TEXT, role TEXT)` table. `verifyAdmin` / `verifyAgent` middleware reads from this table (cached 60s in Redis) instead of trusting token claims, OR we copy the roles into the new JWT `app_metadata` at login time. Either works; table-with-cache is simpler and keeps role changes instant.

### 4.6 Auth migration playbook

1. Stand up GoTrue pointed at the Postgres `auth` schema.
2. `firebase auth:export users.json` — dumps all users with hashes.
3. Feed `users.json` into GoTrue admin API / direct SQL (it has a documented Firebase import format).
4. Copy custom claims into `user_roles` table.
5. Ship the dual-issuer token verifier (§4.4) to production — **no user impact**.
6. Flip `AUTH_BACKEND=gotrue` for *new logins only*. Existing sessions continue against Firebase.
7. Watch login success rates for 24–48 h. Rollback = flip flag back.
8. After 30 days (longer than any refresh token lifetime in your app), disable Firebase Auth.

### 4.7 What the mobile/portal clients need to change
- New login endpoint URL *or* a proxied `/auth/*` path that backend rewrites to GoTrue.
- New SDK: drop `firebase/auth`, use `@supabase/auth-js` or plain `fetch` against GoTrue.
- Google OAuth: change redirect URL to GoTrue's callback.
- **This requires coordinated mobile app releases** — treat mobile release as a blocker for the final cutover.

---

## 5. Storage migration

### 5.1 Target
MinIO, single-node to start (distributed later). Presigned PUT/GET — identical API to S3.

### 5.2 Code changes
`services/storage.service.ts` (139 lines) is the only file that touches Cloud Storage. Replace with `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`:

```
getSignedUploadUrl  → getSignedUrl(s3, new PutObjectCommand({...}), {expiresIn: 900})
getSignedDownloadUrl → getSignedUrl(s3, new GetObjectCommand({...}), {expiresIn: 3600})
deleteFile          → s3.send(new DeleteObjectCommand({...}))
fileExists          → HeadObjectCommand + catch NotFound
getFileMetadata     → HeadObjectCommand → map ContentLength/ContentType
```

Keep the storage *paths* identical (`users/{uid}/profile/...`, `applications/{id}/documents/...`) — zero client changes.

### 5.3 Storage security rules → backend-enforced
`storage.rules` (140 lines) becomes backend code: the presign endpoint (`POST /documents/upload-url`, `POST /agents/me/verification/upload-url`) must validate ownership and size limits before issuing a URL. Most of this is already implemented in the presign controllers — just tighten the size/MIME assertions.

### 5.4 Bulk file migration
```
gcloud storage cp -r gs://japa-app.appspot.com/ /tmp/dump/
mc mirror /tmp/dump/ minio/japa/
```
For a zero-downtime switch:
1. Full initial copy (can take hours — run while live; file list is stable per ID).
2. Ship backend that writes new uploads to **both** GCS and MinIO (dual-write in the presign → add `?replicate=1` header, client uploads once, backend copies).
   - *Alternative*: write only to MinIO for new uploads, keep reading old IDs from GCS until backfill completes. Simpler.
3. Incremental re-sync twice a day until cutover.
4. Validate by sampling: pick 1% of rows in `application_documents`, HEAD both backends, compare size+md5.
5. Cutover: backend stops reading from GCS. Keep GCS around for 30 days as cold backup, then delete.

---

## 6. Push notifications (FCM)

### 6.1 Keep FCM, remove Firebase Admin SDK dependency for it
Today: `messaging.sendEachForMulticast(...)` via `firebase-admin`. This transitively pulls the Firebase project identity.

You can call FCM HTTP v1 API directly with a service account JWT:
- Generate JWT locally (`jsonwebtoken`, RS256) signed with service account private key.
- POST to `https://fcm.googleapis.com/v1/projects/<project-id>/messages:send`.
- 200 lines total.

This keeps FCM (free) but drops `firebase-admin` from the dependency tree once Firestore & Auth are gone. The **only** Google resource you retain is a single Firebase project used purely for FCM — billing stays at $0 because FCM has no usage fees.

### 6.2 Or drop FCM entirely
Run a self-hosted **Novu** or use **node-pushnotifications** directly against APNs + FCM. `node-pushnotifications` still calls FCM/APNs but gives you a single abstraction — useful if you ever add APNs tokens. Given you already have FCM tokens in `users.fcmTokens[]`, keeping FCM is lower-risk.

**Recommendation**: keep FCM via HTTP v1 API direct. Accept this as your one residual external coupling.

---

## 7. Scheduled jobs

Your four scheduled functions port to:

| Current | Replacement | Owner |
|---|---|---|
| `cleanupNotifications` (daily 3 AM) | node-cron in scheduler container → enqueues BullMQ job → worker deletes | worker |
| `sendConsultationReminders` (daily 8 AM) | same pattern | worker |
| `scrapeNewsOrchestrator` (every 30 min, 9 min timeout) | BullMQ repeatable job; concurrency=1, hard timeout 15 min | worker |
| `cleanupOldNews` (Sunday 4 AM) | node-cron → job | worker |

`node-cron` runs in a 1-container "scheduler" service whose only job is to enqueue. The **worker** container does the work. This survives API restarts.

---

## 8. Triggers migration (outbox pattern)

Every current Firestore trigger becomes: `domain_events` row + worker handler. The worker is the same container as the scheduler (or split if load demands).

Example for `onApplicationUpdated`:
```
// In ApplicationService.updateStatus(), inside the SQL txn:
//   UPDATE applications SET status = $1 WHERE id = $2;
//   INSERT INTO domain_events (event_type, aggregate_id, payload)
//     VALUES ('ApplicationStatusChanged',
//             $2,
//             jsonb_build_object('from', $from, 'to', $to, 'userId', $userId));
// COMMIT;
// Worker handler: fan-out to FCM + create notification row.
```

At-least-once delivery. Handlers must be idempotent (check "already notified" before sending). This is stricter than Firestore triggers but in exchange you get replay, audit, and no dependency on Google infrastructure.

---

## 9. Data migration (Firestore → Postgres)

### 9.1 ETL tool
Write a one-shot Node script (`scripts/migrate-firestore-to-pg.ts`) that:
1. Streams each collection via `db.collection(name).stream()` (avoids loading all docs into memory).
2. Transforms each doc (Timestamp → Date, snake_case keys, flatten where needed).
3. Bulk inserts via `pg` `COPY` protocol (`pg-copy-streams`) — ~100× faster than row-by-row INSERTs.
4. Writes a `_migration_manifest` table with row counts + checksums per collection.

Per-collection order (respect FKs):
1. `users` → `countries` → `visaTypes` → `requirements`
2. `agencies` → `agents` (after agencies exist) → `agencyInvitations`
3. `applications` → `documents`, `timeline`, `notes`
4. `consultations`, `conversations` → `messages`
5. `transactions`, `paymentRequests`, `bankAccounts`
6. `notifications`
7. `newsSources` → `scrapeRuns` → `newsArticles` → `newsSubscriptions`
8. `reviews` (flatten `agents/{id}/reviews/{r}` subcollection → flat `agent_reviews` table with `agent_id` column)
9. `analyticsEvents`

### 9.2 Dual-write transition (the key to zero downtime)
1. **Day 0**: Ship code that writes to Firestore *and* Postgres inside every repository method (`REPO_BACKEND=dual`). Read from Firestore. Latency increases ~20%; acceptable for the transition window. If a Postgres write fails, log to a `write_failures` table for retry — do not fail the request.
2. **Day 0–3**: Run the initial bulk ETL (historical data). Inserts go on top of whatever dual-writes already populated. Use `ON CONFLICT (id) DO UPDATE` to handle the overlap.
3. **Day 4–7**: Run a **reconciler** job every 30 min that scans Firestore for docs missing or mismatched in Postgres, and backfills. Target: reconciler finds <10 diffs per hour in steady state.
4. **Day 8**: Flip reads for one read-only endpoint (`GET /news`) to Postgres. Monitor.
5. **Day 9–14**: Flip reads per aggregate, lowest-risk first: news → countries → agents → agencies → users → applications → consultations → conversations → transactions → paymentRequests.
6. **Day 15**: Stop writes to Firestore (`REPO_BACKEND=postgres`). Run the reconciler one last time to export any lingering Firestore-only writes.
7. **Day 15–45**: Firestore is now a read-only backup. Verify no read paths hit it (`grep` the logs for `firestore` calls).
8. **Day 45**: Delete Firestore data, delete `firestore.rules`, `firestore.indexes.json`, remove `firebase-admin` from deps.

### 9.3 Handling in-flight transactions
For collections with high write rates (`messages`, `notifications`, `applications`), use a **Firestore change stream** (polling `updatedAt > lastSeenTs`) during the cutover hour to catch writes that slipped between the dual-write flag flip and the Postgres read switch. Keep a 1-hour overlap window.

### 9.4 Validation
After backfill, run:
- `SELECT COUNT(*)` per table vs. Firestore counts (export counts with `firebase firestore:indexes` + admin SDK count).
- Row-level checksum on a 1% random sample per collection: serialize both to canonical JSON, SHA256, compare.
- Foreign key validation: every `applications.user_id` exists in `users`, etc.

**Do not proceed to read-cutover** unless all three pass.

---

## 10. Security rules → application authorization

`firestore.rules` (344 lines) and `storage.rules` (140 lines) become backend-enforced authorization. Most of this is already in controllers/middleware, but some checks only exist in the rules today. Audit systematically:

1. For each rule block, find the corresponding controller(s).
2. Verify the rule's check is also performed in the controller.
3. If missing, add it (this is the most common source of security regressions during this kind of migration).

Build a checklist of ~50 rule statements → ~50 controller assertions. Track in a spreadsheet. **Do not skip this.**

---

## 11. News scraper

Zero Firebase dependencies except the final `batch.commit()`. Once `NewsArticleRepository` is the Postgres implementation, the scraper works unchanged. Keep it in the worker container. The scraper is the heaviest workload — give it its own BullMQ queue with `concurrency: 1` so parallel orchestrator runs don't clobber each other.

---

## 12. Observability (before cutover, not after)

Stand up **before** any traffic moves:
- **Prometheus** scraping a `/metrics` endpoint in the API (Prom-client middleware — 10 lines).
- **Loki** for log aggregation; API logs to stdout → Promtail → Loki.
- **Grafana** dashboards: request rate, p50/p95/p99 latency, error rate, Postgres connection pool usage, BullMQ queue depth, outbox lag.
- **Uptime Kuma** as an external heartbeat from a separate provider (e.g., Fly.io free tier) that hits `/health` every 30s.
- **Alerts**: push to Slack webhook or an email via `smtp2go` free tier. Do not use Pagerduty unless you already pay for it.

This is table stakes — you can't safely migrate what you can't see.

---

## 13. CI/CD

Replace the current GH Action that does `firebase deploy` with one that:
1. Runs lint + build + tests.
2. Builds a Docker image, tags it with the SHA, pushes to **GHCR** (free).
3. SSHes to the VPS, runs `docker compose pull && docker compose up -d api worker scheduler`, respecting a rolling restart (Caddy already has graceful handover).
4. Runs post-deploy smoke test hitting `/health` and a few canary endpoints.
5. Rolls back on failure by pinning the previous image tag.

Migrations: run `drizzle-kit migrate` in a one-shot container as part of the deploy, **before** swapping the app image. Never include DDL in the app image itself — it runs at the wrong time.

---

## 14. Secrets management

- `.env` files are fine for non-secret config.
- Secrets (DB password, MinIO keys, GoTrue JWT secret, Google OAuth client secret, FCM service account key, Backblaze keys) go into a `secrets.enc.yaml` encrypted with **SOPS** (age recipient). Committed to the repo. Deploy script decrypts at container start via `sops exec-env`.
- One age key lives on the VPS (`/etc/japa/age.key`, root:600). One lives encrypted in 1Password for humans.
- Rotate every 90 days; write the runbook now so it's not invented during an incident.

---

## 15. Backup & disaster recovery

- **Nightly `pg_dump` (custom format, compressed)** → MinIO `backups/postgres/YYYY-MM-DD.dump`.
- **MinIO `mc mirror`** → **Backblaze B2** `japa-offsite` bucket, nightly. ~$0.005/GB/mo.
- Retention: 7 daily, 4 weekly, 12 monthly.
- **PITR** via WAL archiving once you're past migration: `archive_command` ships WAL to B2; `pg_basebackup` weekly. Skip until after cutover — overkill during migration.
- Rehearse restore monthly: spin up a disposable VM, run `pg_restore`, boot API against it, hit `/health`. If you don't rehearse, you don't have backups.

---

## 16. Phased roadmap (calendar-time estimate)

Assuming one engineer at ~70% focus. Double for two engineers pairing on high-risk phases.

| # | Phase | Duration | Exit criterion | Rollback |
|---|---|---|---|---|
| 1 | **Repository abstraction + domain events** | 2–3 wk | `grep firestore()` only hits `db/firestore/`. All tests green. Deployed to prod unchanged in behavior. | Revert PR; no data touched. |
| 2 | **Infra bring-up** (VPS, Caddy, Docker Compose, Postgres, Redis, MinIO, GoTrue, Prom/Loki/Grafana, SOPS, CI pipeline) | 1–2 wk | `https://api-next.japa.app/health` returns 200; backups running; alerts test-fired. | Tear down VPS; no prod impact. |
| 3 | **Postgres schema + Drizzle migrations + PG repo impls** | 2–3 wk | All `PostgresXRepository` pass the same contract tests as `FirestoreX`. Indexes match firestore.indexes.json. | Not deployed yet. |
| 4 | **Dual-write in prod** | 3–5 days | Dual-writes stable for 48 h. `write_failures` table <50 rows/day and all retry-recoverable. | Flip `REPO_BACKEND=firestore`; drop Postgres writes. |
| 5 | **Historical ETL + reconciler** | 1 wk | Counts match; 1% sample checksums match; reconciler steady-state <10 diffs/hr. | ETL is additive; just truncate Postgres and retry. |
| 6 | **Storage migration** | 1 wk | All blobs in MinIO; HEAD-check sample passes; new uploads to MinIO only. | Flip backend env var to GCS; files still there for 30 days. |
| 7 | **Auth migration** (GoTrue, dual-issuer tokens, hash import) | 2 wk | 48 h of production logins via GoTrue with ≥99.5% success rate. Custom claims → `user_roles` parity verified. | Flip `AUTH_BACKEND=firebase`; old tokens still valid; GoTrue remains deployed. |
| 8 | **Read cutover** (per-aggregate, news → ... → applications) | 1–2 wk | p95 latency within 20% of Firestore baseline; zero error rate regression over 72 h per aggregate. | Flip `READ_FROM_POSTGRES` env var back per aggregate. |
| 9 | **Triggers → outbox + scheduled jobs → BullMQ** | 1 wk | All 7 Firestore triggers disabled; outbox handlers processing with <60s lag p95. All 4 cron jobs firing on schedule on new infra. | Re-enable Firestore triggers (unchanged code still deployed); disable outbox handlers. |
| 10 | **FCM direct HTTP v1** | 2–3 days | 24 h of prod pushes via HTTP v1; delivery rate matches firebase-admin baseline within 1%. | Flip `FCM_BACKEND=firebase-admin`. |
| 11 | **Cutover** — stop writes to Firestore | 1 day | `REPO_BACKEND=postgres`. Firestore read-only. No error spike. | `REPO_BACKEND=dual` + reconciler fills the gap. |
| 12 | **Soak + decommission** | 30 days then cleanup | 30 days of clean production on self-hosted. Firestore deleted; `firebase.json`, rules, indexes removed from repo; `firebase-admin` dropped. | Not applicable once decommissioned. |

**Total calendar time**: 3–4 months with one engineer at reasonable pace, 6–8 weeks with a focused two-person team.

---

## 17. Rollback stance

At every phase, **one env-var flip** returns you to the Firebase path. This is the non-negotiable design rule. If at any point the flip no longer works, pause and fix that before proceeding. Rollback isn't a button you press once — it's a capability you maintain the whole way.

Final cutover (phase 11) is the only step without a one-variable rollback, because Firestore is now behind the writes. Mitigation: keep the reconciler running during soak (phase 12) so if you *do* have to restore Firestore from its 30-day soft-deleted state, you can replay Postgres events back into it.

---

## 18. Risks & mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Firestore scrypt hash import breaks for edge-case users (e.g., OAuth-only, no password) | Medium | Low (they sign in via Google, no hash needed) | Handle both paths in migration script; OAuth users get a row with `encrypted_password = NULL`. |
| Mobile clients pin a Firebase SDK that assumes Firebase-signed tokens | High | High | Ship the dual-issuer verifier **first**; do not change token issuer until all clients are on a version that uses the new auth endpoint. This is a **hard gate** on mobile release cadence. |
| Dual-write latency on hot path (message send) is noticeable | Medium | Medium | Make Postgres write fire-and-forget via `setImmediate` during dual-write phase; only Firestore is on the critical path until read-cutover. |
| Postgres write fails silently during dual-write, causing data drift | Medium | High | Writes go to a `write_failures` table on any error. Reconciler + manifest checksums will catch drift. Alert if `write_failures` > 100/hr. |
| MinIO single-node disk failure | Low | Catastrophic | Nightly mirror to B2 offsite. Move to distributed MinIO (4-node erasure) once cost-justified. |
| FCM service account key leak | Low | High | SOPS-encrypted; rotate quarterly; IAM-scope the Google project to *only* FCM. |
| Scraper hammers news sites from a new IP and gets blocked | Medium | Medium | Keep the existing 1 s politeness delay. Set `User-Agent` honestly. Add per-host rate limit in the scraper. Monitor `consecutiveFailures` per source and alert at 5. |
| Hidden Firestore security-rule check not ported to backend → auth bypass | Medium | **Critical** | §10 checklist. Treat this as a release blocker. Add integration tests that hit each role × endpoint matrix before cutover. |
| VPS fails catastrophically during migration | Low | High | Backups rehearsed monthly. Provider snapshot daily (Hetzner/DO provide this). RTO target: 2 h from cold. |

---

## 19. What stays on Firebase forever

- **FCM** — free, lock-in is tolerable, no self-hosted equivalent for OS-level push.

That's it. Google Cloud project is reduced to:
1. Firebase project with FCM enabled.
2. Service account with `cloudmessaging.messages.create` and nothing else.
3. Billing: $0/mo (FCM is free at any volume).

---

## 20. Cost projection

| Line item | Today (Firebase) | After migration |
|---|---|---|
| Cloud Functions invocations + compute | ~$X/mo | $0 |
| Firestore reads/writes/storage | ~$Y/mo | $0 |
| Cloud Storage | ~$Z/mo | $0 (in MinIO, on the VPS disk) |
| Cloud Scheduler | ~$0.10/mo/job × 4 | $0 |
| FCM | $0 | $0 |
| VPS | — | $15–30/mo (Hetzner CCX13 or DO 4 GB) |
| Backblaze B2 offsite (~50 GB) | — | ~$0.25/mo |
| Cloudflare | — | $0 (free tier) |
| Uptime Kuma probe host | — | $0 (Fly.io free tier) or $4 (tiny VPS) |
| Domain / TLS | — | $0 (Let's Encrypt via Caddy) |
| **Total** | **$X+Y+Z** | **~$20–35/mo** |

Concrete numbers depend on your current Firebase bill. Assume 70–95% cost reduction based on typical Firestore-heavy workloads at modest scale.

---

## 21. Deliverables checklist (in order, short form)

- [ ] Phase-1 spike: stand up a DB-agnostic repo interface for `UserRepository` only. Prove it works end-to-end. Get feedback.
- [ ] Repository abstraction for all aggregates.
- [ ] Domain event emitter + outbox.
- [ ] VPS provisioned + Docker Compose stack committed.
- [ ] Postgres schema + Drizzle migrations.
- [ ] Postgres repo impls + contract tests.
- [ ] CI deploys to both Firebase (current prod) and staging VPS.
- [ ] Dual-write env-var flag wired, shipped.
- [ ] ETL script + reconciler.
- [ ] MinIO wired; dual-write for storage.
- [ ] GoTrue + hash import from `firebase auth:export`.
- [ ] Dual-issuer token verifier.
- [ ] Mobile app release with new auth endpoint.
- [ ] Storage cutover (reads from MinIO only).
- [ ] Read cutover per aggregate.
- [ ] Scheduled jobs on BullMQ/node-cron.
- [ ] Triggers on outbox worker.
- [ ] FCM HTTP v1 direct.
- [ ] Full write cutover (`REPO_BACKEND=postgres`).
- [ ] 30-day soak.
- [ ] Decommission: delete Firestore, delete GCS, strip `firebase-admin`, simplify to FCM-only Google project.

---

## 22. What to do this week

Not the whole plan — just the first brick. Pick `UserRepository` and prove end-to-end that the abstraction works:
1. Define `UserRepository` interface in `functions/src/db/user.repo.ts`.
2. Move every `firestore()` call about users from `user.service.ts` into a `FirestoreUserRepository`.
3. Wire the service through the interface.
4. Deploy — behavior identical.
5. Skeleton `PostgresUserRepository` that throws `NotImplemented`; hide behind flag.

If this takes longer than a week or the abstraction leaks, the estimates in §16 need to be revised upward before committing to them.
