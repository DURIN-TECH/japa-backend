# Database Architecture

JAPA Platform -- Firestore Document Database

---

## Collection Hierarchy

```
Firestore
│
├── users/{userId}                                    Top-level
├── agents/{agentId}
│   └── reviews/{reviewId}                            Subcollection
├── agencies/{agencyId}
├── agencyInvitations/{invitationId}
├── countries/{countryCode}
│   └── visaTypes/{visaTypeId}                        Subcollection
│       └── requirements/{requirementId}              Nested subcollection
├── applications/{applicationId}
│   ├── documents/{documentId}                        Subcollection
│   ├── timeline/{timelineId}                         Subcollection
│   └── notes/{noteId}                                Subcollection
├── consultations/{consultationId}
├── transactions/{transactionId}
├── paymentRequests/{paymentRequestId}
├── bankAccounts/{bankAccountId}
├── notifications/{notificationId}
├── conversations/{conversationId}
│   └── messages/{messageId}                          Subcollection
├── newsArticles/{articleId}
├── newsSources/{sourceId}
│   └── scrapeRuns/{runId}                            Subcollection
└── newsSubscriptions/{subscriptionId}
```

**15 top-level collections, 8 subcollections**

---

## Entity Relationship Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          CORE PLATFORM                                  │
│                                                                         │
│  ┌──────────┐         ┌──────────┐         ┌──────────────┐             │
│  │          │ 1    1  │          │ N    1  │              │             │
│  │   User   │────────▶│  Agent   │────────▶│   Agency     │             │
│  │          │ has     │          │ belongs │              │             │
│  └────┬─────┘         └────┬─────┘  to     └──────┬───────┘             │
│       │                    │                       │                    │
│       │ 1                  │ 1                     │ 1                  │
│       │                    │                       │                    │
│       │    ┌───────────────┼───────────────────────┘                    │
│       │    │               │                                            │
│       │    │               ▼ N                                          │
│       │    │         ┌──────────┐                                       │
│       │    │         │  Review  │  (subcollection of Agent)             │
│       │    │         └──────────┘                                       │
│       │    │                                                            │
│       │    │  ┌────────────────────┐                                    │
│       │    │  │  AgencyInvitation  │  Agency ──1:N──▶ Invitation        │
│       │    │  └────────────────────┘                                    │
│       │    │                                                            │
│       ▼ N  ▼ N                                                          │
│  ┌──────────────┐                                                       │
│  │              │──────▶ ┌──────────┐  (subcollection)                  │
│  │ Application  │──────▶ │ Document │                                   │
│  │              │──────▶ ┌──────────┐  (subcollection)                  │
│  │              │──────▶ │ Timeline │                                   │
│  │              │──────▶ ┌──────────┐  (subcollection)                  │
│  │              │──────▶ │   Note   │                                   │
│  └──────┬───────┘                                                       │
│         │                                                               │
│         │ references                                                    │
│         ▼                                                               │
│  ┌──────────────┐     ┌──────────┐                                      │
│  │   Country    │────▶│ VisaType │──▶ [Requirements]  (nested subcol)   │
│  └──────────────┘ 1:N └──────────┘ 1:N                                  │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│                    FINANCIAL & COMMUNICATION                            │
│                                                                         │
│  ┌───────────────┐   ┌──────────────┐   ┌──────────────┐              │
│  │  Transaction  │   │PaymentRequest│   │ BankAccount  │              │
│  │               │   │              │   │              │              │
│  │ User ◀── 1:N  │   │ Agent ◀─ 1:N │   │ User ◀── 1:N │              │
│  │ Agent ◀─ opt  │   │ Client ◀─ref │   └──────────────┘              │
│  │ Application ◀─│   │ Application ◀│                                  │
│  │ Consultation ◀│   └──────────────┘                                  │
│  └───────────────┘                                                      │
│                                                                         │
│  ┌───────────────┐   ┌──────────────┐                                  │
│  │ Consultation  │   │ Conversation │──▶ [Messages]  (subcollection)   │
│  │               │   │              │                                   │
│  │ User ◀── 1:N  │   │ User ◀── ref │                                  │
│  │ Agent ◀── ref │   │ Agent ◀── ref│                                  │
│  │ Application ◀─│   │ Application ◀│                                  │
│  └───────────────┘   └──────────────┘                                  │
│                                                                         │
│  ┌───────────────┐                                                      │
│  │ Notification  │   User ◀── 1:N                                      │
│  └───────────────┘                                                      │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│                        NEWS SCRAPING                                    │
│                                                                         │
│  ┌────────────┐        ┌─────────────┐                                 │
│  │ NewsSource │──────▶ │  ScrapeRun  │  (subcollection, 1:N)           │
│  └──────┬─────┘        └─────────────┘                                 │
│         │ produces                                                      │
│         ▼ N                                                             │
│  ┌─────────────┐       ┌──────────────────┐                            │
│  │ NewsArticle │       │ NewsSubscription  │                            │
│  │             │       │                   │                            │
│  │ Source ◀─ref│       │ User ◀── 1:1      │                            │
│  └─────────────┘       └──────────────────┘                            │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│                        ELIGIBILITY                                      │
│                                                                         │
│  ┌───────────────┐    ┌─────────────────────┐                          │
│  │VisaExemption  │    │ EligibilityQuestion  │                         │
│  │               │    │                      │                         │
│  │ (nationality  │    │ (scoped by country,  │                         │
│  │  x destination│    │  nationality, visa)  │                         │
│  │  matrix)      │    └─────────────────────┘                          │
│  └───────────────┘                                                      │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Entity Schemas

### User

```
users/{userId}
```

The central identity. Every person on the platform is a User. Agents also have a User account linked via `Agent.userId`.

| Field                | Type       | Description                                        |
| -------------------- | ---------- | -------------------------------------------------- |
| id                   | string     | Firebase Auth UID                                  |
| email                | string     |                                                    |
| firstName, lastName  | string     |                                                    |
| middleName           | string?    |                                                    |
| phone                | string?    |                                                    |
| dateOfBirth          | Timestamp? |                                                    |
| address              | Address?   | Embedded: street, city, state, postalCode, country |
| residentialCountry   | string?    |                                                    |
| profilePhotoUrl      | string?    |                                                    |
| onboardingCompleted  | boolean    |                                                    |
| hasPassport          | boolean    |                                                    |
| passportNumber       | string?    |                                                    |
| passportExpiryDate   | Timestamp? |                                                    |
| passportCountry      | string?    | ISO code                                           |
| fcmTokens            | string[]?  | Push notification device tokens                    |
| createdAt, updatedAt | Timestamp  |                                                    |

**Relationships:** 1:1 with Agent (via `Agent.userId`), 1:N with Applications, Transactions, Consultations, Notifications, Conversations, BankAccounts, NewsSubscriptions

---

### Agent

```
agents/{agentId}
  └── reviews/{reviewId}
```

A professional profile linked to a User. May belong to an Agency or operate independently.

| Field              | Type                   | Description                                          |
| ------------------ | ---------------------- | ---------------------------------------------------- |
| id                 | string                 |                                                      |
| userId             | string                 | **FK → users**                                       |
| agencyId           | string?                | **FK → agencies** (null = independent)               |
| agencyRole         | "owner" \| "agent"?    |                                                      |
| displayName, bio   | string                 |                                                      |
| licenseNumber      | string?                |                                                      |
| yearsOfExperience  | number                 |                                                      |
| specializations    | string[]               | e.g., ["Student Visa", "Work Visa"]                  |
| languages          | string[]               |                                                      |
| featuredVisas      | string[]               | Visa type IDs                                        |
| verificationStatus | enum                   | pending, under_review, verified, rejected, suspended |
| rating             | number                 | 1-5 average (denormalized, updated by trigger)       |
| totalReviews       | number                 | Denormalized count                                   |
| totalApplications  | number                 | Denormalized count                                   |
| successRate        | number                 | Percentage                                           |
| consultationFeeUsd | Money                  | `{ amountMinor, currency: "USD" }`, US cents (#179); new agents start at 0 |
| migratedFrom       | map?                   | #179 audit: `{ consultationFee: PriceMigrationRecord }` |
| serviceFees        | Record<string, number>? | Deprecated, never used or written (#103)            |
| isAvailable        | boolean                |                                                      |
| availableSlots     | AvailabilitySlot[]?    | Embedded: dayOfWeek, startTime, endTime              |

**Subcollection -- Review:**

| Field            | Type    | Description               |
| ---------------- | ------- | ------------------------- |
| id               | string  |                           |
| agentId          | string  | **FK → agents**           |
| userId           | string  | **FK → users** (reviewer) |
| applicationId    | string? | **FK → applications**     |
| rating           | number  | 1-5                       |
| title            | string? |                           |
| comment          | string  |                           |
| isVerifiedClient | boolean |                           |

---

### Agency

```
agencies/{agencyId}
```

A company that employs multiple agents. Owns applications through its agents.

| Field                   | Type            | Description                     |
| ----------------------- | --------------- | ------------------------------- |
| id                      | string          |                                 |
| name                    | string          |                                 |
| ownerId                 | string          | **FK → users** (agency creator) |
| ownerName               | string          | Denormalized                    |
| address, state          | string?         |                                 |
| description             | string?         |                                 |
| logoUrl                 | string?         |                                 |
| consultationFeeUsd      | Money?          | Agency-level default, US cents (#179); absent = no fee |
| services                | AgencyService[] | Embedded: id, name, priceUsd (Money, US cents) |
| migratedFrom            | map?            | #179 audit: `{ consultationFee?, services?: { [serviceId]: PriceMigrationRecord } }` |
| totalAgents             | number          | Denormalized                    |
| totalCases, activeCases | number          | Denormalized                    |

---

### AgencyInvitation

```
agencyInvitations/{invitationId}
```

| Field          | Type      | Description                              |
| -------------- | --------- | ---------------------------------------- |
| id             | string    |                                          |
| agencyId       | string    | **FK → agencies**                        |
| agencyName     | string    | Denormalized                             |
| invitedBy      | string    | **FK → users**                           |
| invitedByName  | string    | Denormalized                             |
| invitedEmail   | string    |                                          |
| invitedAgentId | string?   | **FK → agents** (if already on platform) |
| status         | enum      | pending, accepted, declined, expired     |
| expiresAt      | Timestamp |                                          |

---

### Country & VisaType & VisaRequirement

```
countries/{countryCode}
  └── visaTypes/{visaTypeId}
      └── requirements/{requirementId}
```

Three-level hierarchy. Countries contain visa types, which contain requirements.

**Country:**

| Field             | Type    | Description                           |
| ----------------- | ------- | ------------------------------------- |
| code              | string  | ISO 3166-1 alpha-2 (e.g., "IE", "CA") |
| name              | string  |                                       |
| isSupported       | boolean |                                       |
| visaTypesCount    | number  | Denormalized (updated by trigger)     |
| minProcessingDays | number  | Denormalized                          |
| minCostUsd        | number  | Denormalized                          |
| popularityRank    | number? |                                       |

**VisaType:**

| Field                 | Type     | Description                                                        |
| --------------------- | -------- | ------------------------------------------------------------------ |
| id                    | string   |                                                                    |
| countryCode           | string   | Parent country                                                     |
| name                  | string   | e.g., "H-1B Work Visa"                                             |
| code                  | string   | e.g., "H1B"                                                        |
| category              | enum     | work, student, tourist, business, family, investor, transit, other |
| processingTime        | string   | e.g., "6-8 months"                                                 |
| processingDaysMin/Max | number   |                                                                    |
| baseCostUsd           | number   | Government fees                                                    |
| validityPeriod        | string   |                                                                    |
| isExtendable          | boolean  |                                                                    |
| eligibilityCriteria   | string[] |                                                                    |
| applicationUrl        | string?  | Official application link                                          |
| isActive              | boolean  |                                                                    |
| quotaLimit            | number?  |                                                                    |
| agentIds              | string[] | **FK → agents** (who handle this visa)                             |

**VisaRequirement:**

| Field              | Type               | Description                                      |
| ------------------ | ------------------ | ------------------------------------------------ |
| id                 | string             |                                                  |
| visaTypeId         | string             | Parent visa type                                 |
| title, description | string             |                                                  |
| orderIndex         | number             | Sequencing                                       |
| requiredDocuments  | RequiredDocument[] | Embedded: id, name, formats, maxSize, isRequired |
| dependsOn          | string[]?          | IDs of prerequisite requirements                 |
| isOptional         | boolean            |                                                  |

---

### Application

```
applications/{applicationId}
  ├── documents/{documentId}
  ├── timeline/{timelineId}
  └── notes/{noteId}
```

The central workflow entity. A User applies for a VisaType, optionally assisted by an Agent.

| Field                                        | Type              | Description                                                                                                                                         |
| -------------------------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| id                                           | string            |                                                                                                                                                     |
| userId                                       | string            | **FK → users** (applicant)                                                                                                                          |
| visaTypeId                                   | string            | **FK → visaTypes**                                                                                                                                  |
| countryCode                                  | string            | **FK → countries**                                                                                                                                  |
| mode                                         | "self" \| "agent" |                                                                                                                                                     |
| agentId                                      | string?           | **FK → agents**                                                                                                                                     |
| agencyId                                     | string?           | **FK → agencies**                                                                                                                                   |
| status                                       | enum              | draft → pending_payment → pending_documents → under_review → submitted_to_embassy → interview_scheduled → approved / rejected / withdrawn / expired |
| progress                                     | number            | 0-100                                                                                                                                               |
| currentStep, nextStep                        | string            |                                                                                                                                                     |
| documentsRequired/Uploaded/Verified/Rejected | number            | Denormalized counts                                                                                                                                 |
| totalCost, amountPaid                        | number            | Cents                                                                                                                                               |
| paymentStatus                                | enum              | pending, partial, paid, refunded, failed                                                                                                            |
| clientName, clientEmail                      | string?           | Denormalized                                                                                                                                        |
| visaTypeName, countryName                    | string?           | Denormalized                                                                                                                                        |

**Subcollection -- Document:**

| Field              | Type    | Description                                                                                  |
| ------------------ | ------- | -------------------------------------------------------------------------------------------- |
| id                 | string  |                                                                                              |
| applicationId      | string  | Parent application                                                                           |
| requirementId      | string  | **FK → requirements**                                                                        |
| userId             | string  | **FK → users** (uploader)                                                                    |
| fileName, fileType | string  |                                                                                              |
| fileSizeMb         | number  |                                                                                              |
| storageUrl         | string  | Firebase Storage path                                                                        |
| status             | enum    | pending_upload, uploading, uploaded, under_review, verified, rejected, resubmission_required |
| reviewedBy         | string? | **FK → agents**                                                                              |
| resubmissionCount  | number  |                                                                                              |

**Subcollection -- Timeline:**

| Field              | Type   | Description                           |
| ------------------ | ------ | ------------------------------------- |
| id                 | string |                                       |
| applicationId      | string |                                       |
| title, description | string |                                       |
| status             | enum   | completed, current, upcoming, blocked |
| responsibility     | enum   | user, agent, embassy, system          |

**Subcollection -- Note:**

| Field         | Type   | Description                 |
| ------------- | ------ | --------------------------- |
| id            | string |                             |
| applicationId | string |                             |
| authorId      | string | **FK → users**              |
| authorName    | string | Denormalized                |
| authorRole    | enum   | agent, owner, admin, system |
| content       | string |                             |

---

### Consultation

```
consultations/{consultationId}
```

A scheduled meeting between a User and an Agent.

| Field                   | Type      | Description                                                                             |
| ----------------------- | --------- | --------------------------------------------------------------------------------------- |
| id                      | string    |                                                                                         |
| userId                  | string    | **FK → users**                                                                          |
| agentId                 | string    | **FK → agents**                                                                         |
| agencyId                | string?   | **FK → agencies**                                                                       |
| applicationId           | string?   | **FK → applications**                                                                   |
| clientName, clientEmail | string    | Denormalized                                                                            |
| agentName               | string    | Denormalized                                                                            |
| type                    | enum      | initial, document_review, interview_prep, follow_up, general                            |
| scheduledDate           | Timestamp |                                                                                         |
| scheduledTime           | string    | e.g., "10:30"                                                                           |
| durationMinutes         | number    |                                                                                         |
| status                  | enum      | pending_payment → scheduled → confirmed → in_progress → completed / cancelled / no_show |
| fee                     | number    | Whole naira (#148); Paystack kobo is computed at charge time                            |
| paymentStatus           | enum      |                                                                                         |
| transactionId           | string?   | **FK → transactions**                                                                   |
| meetingLink             | string?   |                                                                                         |
| meetingPlatform         | enum?     | zoom, google_meet, teams                                                                |
| summary                 | string?   | Post-consultation                                                                       |
| recordingUrl            | string?   |                                                                                         |

---

### Transaction

```
transactions/{transactionId}
```

Every financial event. System-managed (Cloud Functions only -- client writes disabled via security rules).

| Field                   | Type    | Description                                                                       |
| ----------------------- | ------- | --------------------------------------------------------------------------------- |
| id                      | string  |                                                                                   |
| userId                  | string  | **FK → users**                                                                    |
| agentId                 | string? | **FK → agents**                                                                   |
| applicationId           | string? | **FK → applications**                                                             |
| consultationId          | string? | **FK → consultations**                                                            |
| type                    | enum    | consultation_fee, service_fee, government_fee, refund, escrow_release, withdrawal |
| amount                  | number  | Minor units of `currency` (kobo for NGN, cents for USD); never read without `currency` |
| currency                | string  | ISO 4217, e.g., "NGN"                                                             |
| status                  | enum    | pending, processing, completed, failed, refunded, held_in_escrow, released        |
| isEscrow                | boolean |                                                                                   |
| escrowReleaseCondition  | string? |                                                                                   |
| paymentProvider         | enum    | stripe, paypal, manual                                                            |
| providerTransactionId   | string? |                                                                                   |
| description             | string  |                                                                                   |
| metadata                | Record? | e.g., bank account details for withdrawals                                        |
| clientName, clientEmail | string? | Denormalized                                                                      |

---

### Money, exchange rates and the charge snapshot (issue #178)

Prices are set and stored in US dollars; a client sees the price in their local currency at the current rate and pays that amount. This slice is the foundation (nothing user-visible changes yet). Code: `functions/src/money/`, types in `functions/src/types/money.ts`.

**Money** is `{ amountMinor: integer, currency: ISO 4217 }`. The currency table (`money/currencies.ts`) holds each currency's minor-unit exponent (NGN 2, USD 2) and is the only place a minor-unit factor is applied. Rounding is defined once in `convertUsdToLocal`: `USD cents x rate x (10000 + marginBps) / 10000`, in the target currency's minor unit, rounded half up, once, with integer (BigInt) arithmetic.

```
appConfig/currencies          backend-only config (no firestore.rules match)
exchangeRates/{CURRENCY}      one rate doc per currency, backend-only
exchangeRateAudit/{auto id}   append-only admin override history, backend-only
```

`appConfig/currencies` (missing doc = these defaults):

| Field               | Type   | Description                                                                                   |
| ------------------- | ------ | --------------------------------------------------------------------------------------------- |
| defaultCurrency     | string | Charge currency when the client has no profile country or an unmapped one ("NGN")             |
| currencies          | map    | `{ NGN: { enabled: true, countries: ["NG","Nigeria"], marginBps: 0, minRate: 200, maxRate: 5000 } }`; adding a currency = config. A stored entry merges over the default entry field by field (#214): omitting `minRate`/`maxRate` keeps the default range; `{ NGN: { enabled: false } }` switches NGN off |
| freshnessHours      | number | How long a provider rate may serve after the provider last confirmed it (72; cap 168)        |
| defaultMarginBps    | number | Margin in basis points when a currency sets none (0)                                          |
| maxRateAgeHours     | number | Oldest a rate's own date (`asOf`) may be and still price (144 = 6 days, covers a four-day closure such as Easter; cap 240). Re-reading an old row never refreshes it |
| maxProviderJumpPercent | number | A new provider rate further than this from the stored one is rejected and logged (10; cap 50). Accept a real move via `POST /admin/exchange-rates/:currency/reset-reference` |
| currencies.X.minRate / maxRate | number | Plausible range for first-run provider rates and unreferenced overrides (NGN 200-5000). For a currency with a default range (NGN) a stored range may only NARROW it (#229): a min below the default min or a max above the default max falls back to the default bound. For a currency with no default: judged as a pair (min > 0, max > min, max <= 1e9, max/min <= 50), an invalid pair means no range. Without a range those are refused |
| provider            | enum   | `cbn` (default) or `oanda` (used only when the `OANDA_API_KEY` secret exists)                 |
| overrideBandPercent | number | An admin override must be within this % of the last provider rate (10)                        |
| overrideTtlHours    | number | Default life of an admin override (24; cap 168; request may set 1-168). An unreferenced override (no provider rate to check it against) lasts 24h at most |

`exchangeRates/{CURRENCY}`:

| Field     | Type    | Description                                                                                              |
| --------- | ------- | -------------------------------------------------------------------------------------------------------- |
| currency  | string  | Doc id                                                                                                   |
| provider  | map?    | `{ rate, asOf, fetchedAt, source: "cbn"\|"oanda" }`. `rate` = local units per 1 USD. Freshness = `fetchedAt` |
| override  | map?    | `{ rate, reason, setBy, setAt, expiresAt, unreferenced?, referenceRate? }`; wins while unexpired (source `manual`), except (#229) an unreferenced override, or a legacy one with neither `unreferenced` nor `referenceRate` (the provider rate a referenced override was checked against), stops pricing once a FRESH provider rate exists more than `overrideBandPercent` from it (flagged `OVERRIDE_SUPERSEDED`). When a refresh stores a provider rate outside `overrideBandPercent` of an active override, it is logged at error level and flagged in `GET /admin/exchange-rates` (`warnings`) |
| manualRefreshAt | timestamp? | Last admin "refresh now" (rate limit: one per currency per 5 minutes)                           |
| lastError | map?    | `{ at, message }` of the last failed provider attempt                                                    |

Effective rate: active override, else provider rate within `freshnessHours`, else `quote()` fails with a typed error (`RATE_STALE`, `RATE_UNAVAILABLE`, `CURRENCY_UNSUPPORTED`, `CURRENCY_DISABLED`). A rate is never invented. A scheduled function (`refreshExchangeRates`, every 6 hours) refreshes enabled currencies; CBN reads https://www.cbn.gov.ng/api/GetAllNFEM_Rates (the data source behind the official rates page; weighted-average NFEM rate).

`exchangeRateAudit`: `{ currency, action: override_set|override_cleared|provider_reset|provider_refresh, by, at, reason, old, new, unreferenced?, outcome? }`, indexed by (`currency`, `at` desc). `old`/`new` are the effective rates before and after (freshness included); each override change is written with its audit entry in one transaction. `outcome` (refresh only) says what the refresh did.

**Charge snapshot.** Bookings, payment requests and transactions that are charged in local currency store (type `ChargeSnapshot`, names fixed): `priceUsdCents`, `chargedCurrency`, `chargedAmountMinor`, `fxRate` (margin not included), `fxRateAsOf`, `fxRateSource`, `fxMarginBps`. The existing visa-fee FX (`appConfig/fx`, Frankfurter/ECB) is a separate flow and is unchanged.

Public view: `GET /rates` (no auth, cacheable) returns only currency, exponent, availability, rate and asOf. Each instance caches the body for 60 s, dropped at once when that instance changes a rate.

Admin "refresh now": `POST /admin/exchange-rates/:currency/refresh` (admin only, `{ reason? }`) runs the same refresh as the schedule for one currency, audited as `provider_refresh`; a second call within 5 minutes gets 429 with `Retry-After`.

#### Agent and agency prices in US dollars (#179)

Every price an agent or agency owner sets is stored as a `Money` in US cents, never a bare number:

| Where | Field | Was (naira) |
| ----- | ----- | ----------- |
| `agents/{id}` | `consultationFeeUsd` | `consultationFee` (+ #148 `consultationFeeUnit` marker) |
| `agencies/{id}` | `consultationFeeUsd` | `consultationFee` |
| `agencies/{id}.services[]` | `priceUsd` | `price` |
| `agencies/{id}/visaPrices/{cc}__{visaTypeId}` | `priceUsd` | `price` |

- **Writes** go through the API only (`PUT /agents/me`, `POST /agents`, `POST /agencies`, `PUT /agencies/me`, `PUT /agency/visa-prices/:cc/:visaTypeId`). The body sends dollars, `{ "amount": "12.50", "currency": "USD" }` (currency optional; anything other than USD is a 400). Rules (`parseUsdPriceInput`, `functions/src/money/usd-price.ts`): finite, not negative, whole cents (at most 2 decimals, never rounded), at most **$100,000.00** (`MAX_PRICE_USD_CENTS` = 10,000,000 cents), no other keys. The old naira keys (`consultationFee`, `services[].price`, visa `price`) are refused with a 400. Writing a dollar price removes the old naira field from the doc. `firestore.rules` lets no client write any money field (agents: `consultationFeeUsd`, `consultationFee`, `consultationFeeUnit`, `serviceFees`, `migratedFrom`; agencies: `consultationFeeUsd`, `consultationFee`, `services`, `migratedFrom`; `visaPrices` is backend-only).
- **Reads** (`GET /agents`, `/agents/top`, `/agents/:id`, `/agents/visa/:id`, `/agencies/browse*`, `/agencies/public/:slug`) return each price as the stored dollar `Money` plus its local figure, `{ amountMinor, currency, rate, asOf, available }` (type `LocalPriceQuote`), next to it: `consultationFeeUsd` + `consultationFeeLocal`, services `priceUsd` + `priceLocal`, visa prices `priceUsd` + `priceLocal`. One rate lookup per request; the currency is the signed-in viewer's profile currency, else the default (NGN). If the rate is missing or stale the read still succeeds: `available: false` with null amount, rate and asOf. A doc without a valid dollar price shows `null` (never an old naira number). `migratedFrom` is never returned publicly.
- **Charging** from the dollar price is #180 (bookings) and #181 (payment requests). Until #180 lands, a guest booking with an agency whose fee is above zero answers `503 PRICING_UNAVAILABLE` and creates nothing.
- **Migration** (`npm run migrate:prices-usd -- --project <id> --rate <naira per USD> --cutoff <#148 deploy ISO time> [--apply]`, `functions/src/scripts/migrate-prices-to-usd.ts`) replaces the #148 naira migration (do not run both). The rate is required (no built-in number); the script prints `exchangeRates/NGN` for reference. Half-up rounding to a whole cent. Each converted value records `migratedFrom.<old field>` = `PriceMigrationRecord` `{ amount (whole naira), currency: "NGN", rate, storedValue, storedUnit: "naira"|"kobo", migratedAt }`. Values that are not whole naira (or kobo of whole naira), would round to $0.00, or docs that hold both a naira and a dollar price are listed and left alone. Historical `consultations.fee` rows stay naira.

---

### PaymentRequest

```
paymentRequests/{paymentRequestId}
```

An invoice sent by an Agent to a Client for application services.

| Field                   | Type       | Description                       |
| ----------------------- | ---------- | --------------------------------- |
| id                      | string     |                                   |
| applicationId           | string     | **FK → applications**             |
| agentId                 | string     | **FK → agents**                   |
| agencyId                | string?    | **FK → agencies**                 |
| clientId                | string     | **FK → users**                    |
| clientName, clientEmail | string     | Denormalized                      |
| amount                  | number     | Smallest currency unit            |
| currency                | string     |                                   |
| description             | string     |                                   |
| status                  | enum       | pending, paid, cancelled, expired |
| expiresAt               | Timestamp? |                                   |

---

### BankAccount

```
bankAccounts/{bankAccountId}
```

Agent bank accounts for receiving withdrawals.

| Field         | Type    | Description            |
| ------------- | ------- | ---------------------- |
| id            | string  |                        |
| userId        | string  | **FK → users**         |
| accountName   | string  |                        |
| bankName      | string  |                        |
| accountNumber | string  |                        |
| isMain        | boolean | Primary payout account |

---

### Notification

```
notifications/{notificationId}
```

In-app notifications. Created by Cloud Function triggers, read/managed by client.

| Field             | Type       | Description                                                                                                       |
| ----------------- | ---------- | ----------------------------------------------------------------------------------------------------------------- |
| id                | string     |                                                                                                                   |
| userId            | string     | **FK → users**                                                                                                    |
| type              | enum       | application_update, document_status, consultation_reminder, payment_received, message_received, visa_news, system |
| title, body       | string     |                                                                                                                   |
| actionUrl         | string?    | Deep link path                                                                                                    |
| relatedEntityType | enum?      | application, consultation, document, message, news_article                                                        |
| relatedEntityId   | string?    | Polymorphic FK                                                                                                    |
| isRead            | boolean    |                                                                                                                   |
| readAt            | Timestamp? |                                                                                                                   |

---

### Conversation & Message

```
conversations/{conversationId}
  └── messages/{messageId}
```

Real-time chat between a User and an Agent, optionally tied to an Application.

**Conversation:**

| Field            | Type      | Description           |
| ---------------- | --------- | --------------------- |
| id               | string    |                       |
| userId           | string    | **FK → users**        |
| agentId          | string    | **FK → agents**       |
| applicationId    | string?   | **FK → applications** |
| lastMessageAt    | Timestamp |                       |
| lastMessage      | string?   | Denormalized preview  |
| unreadCountUser  | number    |                       |
| unreadCountAgent | number    |                       |

**Message (subcollection):**

| Field          | Type      | Description         |
| -------------- | --------- | ------------------- |
| id             | string    |                     |
| conversationId | string    | Parent conversation |
| senderId       | string    | **FK → users**      |
| senderType     | enum      | user, agent         |
| content        | string    |                     |
| attachmentUrls | string[]? |                     |
| isRead         | boolean   |                     |

---

### NewsArticle

```
newsArticles/{articleId}
```

Scraped visa/immigration news. Top-level (not nested under countries) because articles can span multiple countries.

| Field                    | Type      | Description                                        |
| ------------------------ | --------- | -------------------------------------------------- |
| id                       | string    |                                                    |
| title, summary           | string    |                                                    |
| body                     | string?   | Full text (optional)                               |
| originalUrl              | string    | Link to source                                     |
| imageUrl                 | string?   |                                                    |
| countryCodes             | string[]  | e.g., ["CA", "AU"] -- multi-country                |
| tags                     | string[]  | Auto-extracted: "work-visa", "express-entry", etc. |
| importance               | enum      | breaking, high, normal, low                        |
| sourceId                 | string    | **FK → newsSources**                               |
| sourceName               | string    | Denormalized                                       |
| sourceIsOfficial         | boolean   | Denormalized                                       |
| urlHash, titleHash       | string    | SHA-256 for deduplication                          |
| publishedAt              | Timestamp | Original publish date                              |
| scrapedAt                | Timestamp | When we ingested it                                |
| isPublished              | boolean   |                                                    |
| isNotificationSent       | boolean   |                                                    |
| viewCount, bookmarkCount | number    |                                                    |

---

### NewsSource & ScrapeRun

```
newsSources/{sourceId}
  └── scrapeRuns/{runId}
```

Registry of scraping targets with health tracking.

**NewsSource:**

| Field                     | Type           | Description                                                |
| ------------------------- | -------------- | ---------------------------------------------------------- |
| id                        | string         |                                                            |
| name, slug, url           | string         |                                                            |
| countryCodes              | string[]       | Which countries covered                                    |
| strategy                  | enum           | rss, html_scrape, news_api                                 |
| config                    | ScrapingConfig | Embedded: selectors, feedUrl, apiConfig, maxArticlesPerRun |
| scrapeIntervalMinutes     | number         |                                                            |
| nextScrapeAt              | Timestamp?     | When due next                                              |
| status                    | enum           | active, paused, broken, retired                            |
| reliabilityScore          | number         | 0-100                                                      |
| consecutiveFailures       | number         | Auto-pauses at 5                                           |
| totalRuns, successfulRuns | number         |                                                            |
| isOfficial                | boolean        | Government vs third-party                                  |
| priority                  | number         | 1 (highest) to 10                                          |

**ScrapeRun (subcollection):**

| Field                              | Type    | Description                       |
| ---------------------------------- | ------- | --------------------------------- |
| id                                 | string  |                                   |
| sourceId                           | string  | Parent source                     |
| status                             | enum    | running, success, partial, failed |
| articlesFound/New/Duplicate/Failed | number  |                                   |
| durationMs                         | number? |                                   |
| errorMessage                       | string? |                                   |

---

### NewsSubscription

```
newsSubscriptions/{subscriptionId}
```

User preferences for visa news push notifications.

| Field               | Type     | Description                 |
| ------------------- | -------- | --------------------------- |
| id                  | string   |                             |
| userId              | string   | **FK → users** (1:1)        |
| countryCodes        | string[] | Empty = all countries       |
| importanceThreshold | enum     | breaking, high, normal, low |
| pushEnabled         | boolean  |                             |

---

## Relationship Summary

```
User ──1:1──▶ Agent
User ──1:N──▶ Application
User ──1:N──▶ Consultation
User ──1:N──▶ Transaction
User ──1:N──▶ Notification
User ──1:N──▶ Conversation
User ──1:N──▶ BankAccount
User ──1:1──▶ NewsSubscription

Agent ──N:1──▶ Agency
Agent ──1:N──▶ Review              (subcollection)
Agent ──1:N──▶ Application         (as assigned agent)
Agent ──1:N──▶ Consultation
Agent ──1:N──▶ PaymentRequest

Agency ──1:N──▶ Agent
Agency ──1:N──▶ AgencyInvitation
Agency ──1:N──▶ Application        (via agent)
Agency ──1:N──▶ Consultation       (via agent)

Country ──1:N──▶ VisaType          (subcollection)
VisaType ──1:N──▶ VisaRequirement  (subcollection)

Application ──N:1──▶ User
Application ──N:1──▶ VisaType
Application ──N:1──▶ Agent          (optional)
Application ──1:N──▶ Document       (subcollection)
Application ──1:N──▶ Timeline       (subcollection)
Application ──1:N──▶ Note           (subcollection)
Application ──1:N──▶ PaymentRequest

Consultation ──N:1──▶ User
Consultation ──N:1──▶ Agent
Consultation ──N:1──▶ Application   (optional)
Consultation ──1:1──▶ Transaction   (optional)

Conversation ──N:1──▶ User
Conversation ──N:1──▶ Agent
Conversation ──1:N──▶ Message       (subcollection)

NewsSource ──1:N──▶ NewsArticle
NewsSource ──1:N──▶ ScrapeRun       (subcollection)
```

---

## Denormalization Patterns

Firestore has no joins. The codebase uses strategic denormalization to avoid multi-document reads:

| Denormalized Field                                  | On Entity        | Source Entity       | Why                                              |
| --------------------------------------------------- | ---------------- | ------------------- | ------------------------------------------------ |
| `ownerName`                                         | Agency           | User                | Display agency owner without fetching User       |
| `agencyName`, `invitedByName`                       | AgencyInvitation | Agency, User        | Display invitation details in list               |
| `clientName`, `clientEmail`                         | Application      | User                | Show client info on agent dashboard              |
| `visaTypeName`, `countryName`                       | Application      | VisaType, Country   | Display in application list                      |
| `clientName`, `clientEmail`, `agentName`            | Consultation     | User, Agent         | Show booking details                             |
| `clientName`, `clientEmail`, `visaTypeName`         | Transaction      | User, VisaType      | Show in transaction history                      |
| `clientName`, `clientEmail`                         | PaymentRequest   | User                | Show in payment request list                     |
| `authorName`, `authorRole`                          | ApplicationNote  | User                | Display note author inline                       |
| `sourceName`, `sourceIsOfficial`                    | NewsArticle      | NewsSource          | Display source attribution without join          |
| `lastMessage`, `unreadCount*`                       | Conversation     | Message             | Show preview in conversation list                |
| `rating`, `totalReviews`, `totalApplications`       | Agent            | Review, Application | Display agent stats without aggregation          |
| `visaTypesCount`, `minProcessingDays`, `minCostUsd` | Country          | VisaType            | Display country card without subcollection query |

---

## Subcollection Design Rationale

| Parent → Sub                       | Why subcollection (not top-level)                                                               |
| ---------------------------------- | ----------------------------------------------------------------------------------------------- |
| Agent → Reviews                    | Reviews are always accessed in the context of a specific agent. Natural parent-child hierarchy. |
| Country → VisaTypes → Requirements | Three-level hierarchy models the real-world structure. Queries are always scoped to a country.  |
| Application → Documents            | Documents belong to exactly one application. Access control inherits from parent.               |
| Application → Timeline             | Timeline entries are meaningless outside their application.                                     |
| Application → Notes                | Notes are always viewed in application context.                                                 |
| Conversation → Messages            | Messages are always loaded within a conversation. Pagination is per-conversation.               |
| NewsSource → ScrapeRuns            | Execution logs are always viewed per-source. Cleanup can target a single source's history.      |

---

## Top-Level Collection Rationale

| Collection          | Why top-level (not subcollection)                                                                                                                                |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `newsArticles`      | Articles can reference multiple countries via `countryCodes[]`. Primary query is "latest news, optionally filtered by country" -- not scoped to a single parent. |
| `newsSubscriptions` | Queried by country codes array-contains to find subscribers across all users.                                                                                    |
| `transactions`      | Queried across users (admin view), by agent, and by application. No single natural parent.                                                                       |
| `notifications`     | Queried by user, but also by type + time range for cleanup. Simpler as top-level.                                                                                |
| `consultations`     | Queried from both user and agent perspectives. No single parent.                                                                                                 |
| `paymentRequests`   | Queried by agent, agency, and client. Cross-cutting entity.                                                                                                      |
| `bankAccounts`      | Queried by userId but also directly by ID for withdrawal processing.                                                                                             |
| `agencyInvitations` | Queried by agency, by inviter, and by invitee email. Cross-cutting.                                                                                              |

---

## Composite Indexes

Firestore requires composite indexes for queries with multiple where/orderBy clauses. The project defines 28 indexes in `firestore.indexes.json`:

| Collection        | Fields                                                 | Purpose                                |
| ----------------- | ------------------------------------------------------ | -------------------------------------- |
| agents            | verificationStatus + rating DESC                       | Browse verified agents by rating       |
| agents            | verificationStatus + isAvailable + rating DESC         | Available verified agents              |
| agents            | verificationStatus + featuredVisas CONTAINS            | Agents for a specific visa             |
| agents            | agencyId + displayName                                 | List agency members alphabetically     |
| applications      | userId + createdAt DESC                                | User's applications (recent first)     |
| applications      | userId + status + updatedAt DESC                       | User's applications filtered by status |
| applications      | agentId + status                                       | Agent's applications by status         |
| applications      | agentId + updatedAt DESC                               | Agent's recent applications            |
| applications      | agencyId + updatedAt DESC                              | Agency's recent applications           |
| consultations     | userId + scheduledDate                                 | User's upcoming consultations          |
| consultations     | agentId + scheduledDate ASC/DESC                       | Agent's schedule (both directions)     |
| consultations     | agencyId + scheduledDate DESC                          | Agency consultation history            |
| consultations     | status + scheduledDate                                 | Find consultations by status           |
| transactions      | agentId + createdAt DESC                               | Agent's transaction history            |
| notifications     | userId + createdAt DESC                                | User's recent notifications            |
| notifications     | isRead + createdAt                                     | Cleanup of old read notifications      |
| paymentRequests   | agentId + createdAt DESC                               | Agent's payment requests               |
| paymentRequests   | agencyId + createdAt DESC                              | Agency's payment requests              |
| conversations     | userId + lastMessageAt DESC                            | User's recent conversations            |
| conversations     | agentId + lastMessageAt DESC                           | Agent's recent conversations           |
| newsArticles      | isPublished + publishedAt DESC                         | Public news feed                       |
| newsArticles      | isPublished + countryCodes CONTAINS + publishedAt DESC | News filtered by country               |
| newsSources       | status + nextScrapeAt                                  | Find sources due for scraping          |
| newsSources       | status + priority                                      | Active sources by priority             |
| newsSubscriptions | countryCodes CONTAINS + pushEnabled                    | Find subscribers for a country         |

**Collection group indexes** (query across all subcollections with the same name):

| Collection Group | Fields                     | Purpose                                |
| ---------------- | -------------------------- | -------------------------------------- |
| reviews          | agentId + createdAt DESC   | Agent's reviews across all agents      |
| visaTypes        | isActive + category        | Search visa types across all countries |
| messages         | conversationId + createdAt | Load messages for a conversation       |
| scrapeRuns       | startedAt DESC             | Recent scrape runs                     |

---

## Access Control Model

Access is enforced at two levels:

1. **Firestore Security Rules** (`firestore.rules`) -- client-side enforcement
2. **Express Middleware** (`src/middleware/auth.ts`) -- server-side enforcement via Cloud Functions

| Role  | Custom Claim  | Access                                                          |
| ----- | ------------- | --------------------------------------------------------------- |
| User  | (none)        | Own data only (applications, transactions, notifications, etc.) |
| Agent | `agent: true` | Own data + assigned applications + consultations                |
| Admin | `admin: true` | Full read/write across all collections                          |

Transactions and notifications are **system-managed** -- client writes are blocked in security rules. All mutations go through Cloud Functions.

---

## Trigger-Driven Updates

| Trigger                 | Source    | Action                                                                               |
| ----------------------- | --------- | ------------------------------------------------------------------------------------ |
| `onUserCreated`         | Auth      | Creates initial User document                                                        |
| `onUserDeleted`         | Auth      | Deletes User document                                                                |
| `onApplicationUpdated`  | Firestore | Sends FCM + creates Notification on status change; updates Agent stats on completion |
| `onConsultationCreated` | Firestore | Notifies Agent via FCM                                                               |
| `onReviewCreated`       | Firestore | Recalculates Agent rating                                                            |
| `onVisaTypeUpdated`     | Firestore | Updates Country stats (visaTypesCount, minProcessingDays, etc.)                      |
| `onNewsArticleCreated`  | Firestore | Sends FCM + creates Notification for subscribed users                                |

---

## Scheduled Jobs

| Job                         | Schedule           | Action                                         |
| --------------------------- | ------------------ | ---------------------------------------------- |
| `cleanupNotifications`      | Daily 3 AM         | Delete read notifications older than 30 days   |
| `sendConsultationReminders` | Daily 8 AM         | FCM reminder for tomorrow's consultations      |
| `scrapeNewsOrchestrator`    | Every 30 min       | Scrape due news sources (max 5 per run)        |
| `cleanupOldNews`            | Weekly Sunday 4 AM | Delete articles >90 days, scrape runs >30 days |
