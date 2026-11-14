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
| fee                     | number?   | LEGACY only (before #180): whole naira (#148). Not written any more; shown as naira, never re-priced |
| priceUsdCents           | number?   | #180: the agent's / agency's dollar fee at booking time, US cents (0 = free booking)    |
| chargedCurrency         | string?   | #180: ISO 4217 code the client is charged in (their profile currency; guests: default NGN) |
| chargedAmountMinor      | number?   | #180: the amount charged, minor units of `chargedCurrency` (kobo for NGN)               |
| fxRate, fxRateAsOf, fxRateSource, fxMarginBps | | #180: the rate snapshot (`ChargeSnapshot`, see Exchange rates)                |
| quoteLockedAt           | Timestamp? | #180: when the charge was priced                                                       |
| quoteExpiresAt          | Timestamp? | #180: `quoteLockedAt` + 30 min. After it the snapshot is never charged: verify/retry re-price |
| paymentStatus           | enum      |                                                                                         |
| transactionId           | string?   | The Paystack reference of the current checkout while pending; of the settling payment once paid |
| checkoutUrl             | string?   | #180: the Paystack checkout page for `transactionId` (a retry inside the lock returns it) |
| checkoutCallbackUrl     | string?   | #180: where Paystack returns the payer                                                  |
| paidAt                  | Timestamp? | #180: when the payment was confirmed                                                   |
| paystackPaidAt          | Timestamp? | #180: Paystack's `paid_at` for the settling payment                                     |
| paidAfterQuoteExpiry    | boolean?  | #180: true when an exact payment landed after `quoteExpiresAt` and was honoured (review flag; also on the transaction) |
| supersededCheckouts     | array?    | #180: every checkout this booking replaced, each `{ reference, supersededAt, priceUsdCents, chargedCurrency, chargedAmountMinor, fxRate, fxRateAsOf, fxRateSource, fxMarginBps, quoteLockedAt?, quoteExpiresAt? }` (type `SupersededCheckout`); appended in the same transaction that stores the new reference |
| paidOnSupersededReference | boolean? | #180: true when an exact payment on a superseded reference settled the booking (the booking then carries that reference's snapshot; also on the transaction) |
| cancelledAt, cancelledBy, cancellationReason | | Set on cancel. `legacyCancellation` `{ issue: 180, previousStatus, fee, at }` marks a row closed by the #180 cleanup |
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
| paymentProvider         | enum    | stripe, paypal, manual, paystack                                                  |
| priceUsdCents, chargedCurrency, chargedAmountMinor, fxRate, fxRateAsOf, fxRateSource, fxMarginBps | | #180, `consultation_fee` only: the booking's charge snapshot. `amount` = `chargedAmountMinor`, `currency` = `chargedCurrency`. Absent on legacy naira rows and other kinds |
| paystackPaidAt, paidAfterQuoteExpiry | | #180, `consultation_fee` only: Paystack's `paid_at`, and the review flag for an exact payment honoured after the booking's quote lock |
| paidOnSupersededReference | boolean? | #180, `consultation_fee` only: settled by an exact payment on a superseded checkout |
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
| currencies.X.minRate / maxRate | number | Plausible range for first-run provider rates and unreferenced overrides (NGN 200-5000). For a currency with a default range (NGN) a stored range may only NARROW it (#229): a min below the default min or a max above the default max falls back to the default bound. So raising NGN's range above the default ceiling (5000) needs a code change to `DEFAULT_CURRENCIES_CONFIG` in `src/money/config.ts` and a deploy; a stored `maxRate` above it is ignored and every provider rate above it is refused. For a currency with no default: judged as a pair (min > 0, max > min, max <= 1e9, max/min <= 50), an invalid pair means no range. Without a range those are refused |
| provider            | enum   | `cbn` (default) or `oanda` (used only when the `OANDA_API_KEY` secret exists)                 |
| overrideBandPercent | number | An admin override must be within this % of the last provider rate (10)                        |
| overrideTtlHours    | number | Default life of an admin override (24; cap 168; request may set 1-168). An unreferenced override (no provider rate to check it against) lasts 24h at most |

`exchangeRates/{CURRENCY}`:

| Field     | Type    | Description                                                                                              |
| --------- | ------- | -------------------------------------------------------------------------------------------------------- |
| currency  | string  | Doc id                                                                                                   |
| provider  | map?    | `{ rate, asOf, fetchedAt, source: "cbn"\|"oanda" }`. `rate` = local units per 1 USD. Freshness = `fetchedAt` |
| override  | map?    | `{ rate, reason, setBy, setAt, expiresAt, unreferenced?, referenceRate? }`; wins while unexpired (source `manual`), except (#229) an unreferenced override, or a legacy one with neither `unreferenced` nor `referenceRate` (the provider rate a referenced override was checked against), stops pricing once a stored provider rate (fresh or stale) is more than `overrideBandPercent` from it (flagged `OVERRIDE_SUPERSEDED`); pricing then uses that provider rate while it is fresh and fails with `RATE_STALE` once it is not, never the superseded override. Since #241 a provider map that is present but unreadable (damaged outside the app) also supersedes an unreferenced or legacy override (pricing fails with `RATE_UNAVAILABLE` until the map is reset), and `reset-reference` clears an active unreferenced or legacy override that it supersedes at that moment (audited as `override_cleared` in the same transaction), so neither can bring it back. When a refresh stores a provider rate outside `overrideBandPercent` of an active override, it is logged at error level and flagged in `GET /admin/exchange-rates` (`warnings`) |
| hold      | map?    | Issue #241. `{ rate, reason, setBy, setAt, expiresAt }`: an admin-held (pinned) rate. While unexpired it IS the effective rate (source `hold`), ahead of any override and whatever the provider rate is or however fresh; only its own expiry (1-168h, required on every request) or a clear ends it. Refreshes still fetch and store `provider` behind it with the same guards (jump, range, age). A hold is re-checked every time it is read: one whose rate is outside the currency's current plausible range (or no range), or whose `expiresAt` is more than 168h after `setAt` or from now (5 min clock-skew allowance), does not price and the overview shows `HOLD_INVALID`. A malformed (unreadable) map reads as no hold too, and the overview shows `HOLD_CORRUPT`; both warnings say what prices instead (the normal rules: override, else provider rate, else a typed error). `DELETE .../hold` clears either (a corrupt one is audited with `holdCorrupt: true`); a new PUT replaces it |
| manualRefreshAt | timestamp? | Last admin "refresh now" (rate limit: one per currency per 5 minutes)                           |
| lastError | map?    | `{ at, message }` of the last failed provider attempt                                                    |

Effective rate: active hold (#241), else active override (unless superseded, see above), else provider rate within `freshnessHours`, else `quote()` fails with a typed error (`RATE_STALE`, `RATE_UNAVAILABLE`, `CURRENCY_UNSUPPORTED`, `CURRENCY_DISABLED`). A rate is never invented. A scheduled function (`refreshExchangeRates`, every 6 hours) refreshes enabled currencies; CBN reads https://www.cbn.gov.ng/api/GetAllNFEM_Rates (the data source behind the official rates page; weighted-average NFEM rate).

Runbook: to stop a misbehaving provider from pricing (e.g. it lags a real devaluation), take the provider or the currency out of service in `appConfig/currencies`: switch `provider` to the other one (`oanda` needs its secret; CBN stays the fallback, so it cannot be switched off by config alone), or set `currencies.X.enabled: false` (charging in that currency stops with `CURRENCY_DISABLED`). Do not rely on an override to pin the rate: after a reset-reference the override is unreferenced, and the provider's next rate supersedes it if they differ by more than `overrideBandPercent`.

Runbook, provider lags a real move (#241; e.g. CBN stays at 1300 while the market is at 1800 and OANDA has no key): hold the rate with `PUT /admin/exchange-rates/NGN/hold { rate: 1800, reason, ttlHours }` (admin only; reason 5-500 chars; ttlHours 1-168, required; the rate must be inside the plausible range, no band check against the provider; refused while the provider map is unreadable, reset it first). Charges then price at 1800 with `fxRateSource: "hold"`. Refreshes keep storing CBN's rate; `GET /admin/exchange-rates` shows `hold` (rate, reason, setBy, setAt, expiresAt, the latest stored `provider` rate with `fresh`, and `gap` = held minus provider as `{ rate, bps, outsideBand }`) and a `HOLD_OUTSIDE_PROVIDER_BAND` warning while the gap is past `overrideBandPercent`. When CBN catches up, its first rate more than `maxProviderJumpPercent` from the stored one is rejected as usual: use reset-reference (the hold keeps pricing meanwhile), let the next refresh store the new level, then clear the hold with `DELETE /admin/exchange-rates/NGN/hold { reason }`. If the hold expires first, normal rules apply at once: the override, else the stored provider rate while fresh, else `RATE_STALE`. Renew before expiry if the provider is still wrong. `GET /rates` shows the held rate as the rate and nothing about the hold.

`exchangeRateAudit`: `{ currency, action: override_set|override_cleared|provider_reset|provider_refresh|hold_set|hold_cleared, by, at, reason, old, new, effective?, unreferenced?, outcome?, holdExpiresAt?, holdCorrupt? }`, indexed by (`currency`, `at` desc). `old`/`new` are the effective rates before and after (freshness included); each override change is written with its audit entry in one transaction. Exception (#241): for `override_set`, `new` is always the override the admin entered (`{ rate, source: "manual" }`) and `effective` is the rate really in effect after the change (the override, an active hold that outranks it, or `null` when nothing usable prices), so an override typed during a hold is on record even though it only prices once the hold ends (an expiry writes no entry). `holdCorrupt: true` on `hold_cleared` means the cleared map was unreadable. `outcome` (refresh only) says what the refresh did.

**Charge snapshot.** Bookings, payment requests and transactions that are charged in local currency store (type `ChargeSnapshot`, names fixed): `priceUsdCents`, `chargedCurrency`, `chargedAmountMinor`, `fxRate` (margin not included), `fxRateAsOf`, `fxRateSource` (`cbn`, `oanda`, `manual` for an override, `hold` for a held rate, #241), `fxMarginBps`. The existing visa-fee FX (`appConfig/fx`, Frankfurter/ECB) is a separate flow and is unchanged.

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
- **Charging** from the dollar price: bookings are #180 (below), payment requests #181.

#### Consultation bookings charged in local currency (#180)

- **Who sets the price**: the server. `POST /agencies/public/:slug/consultations` reads the agency's `consultationFeeUsd`; `POST /consultations` reads the booking agent's own `consultationFeeUsd` (client-initiated: the agent must be `verified` and `isAvailable`, and its agency, if any, `approved`, else 404). Any `fee`, `amount`, `rate` or `currency` in a request body is ignored (#166).
- **Free** only when the stored fee is missing (or null) or a valid `$0`: the booking is `scheduled`/`paid` with `priceUsdCents: 0` and no Paystack. Any other stored shape (string amount, `"usd"`, another currency, over the cap, a leftover naira `consultationFee` of any type) is refused with `503 PRICING_UNAVAILABLE` and nothing is written.
- **Paid**: `quote()` prices the dollar fee in the client's charge currency (signed-in: profile country via `resolveChargeCurrency`; guest: the config default, NGN, because a guest is anonymous) and the booking stores the `ChargeSnapshot` plus `quoteLockedAt`/`quoteExpiresAt` (30 minutes). `RATE_STALE`, `RATE_UNAVAILABLE`, `CURRENCY_UNSUPPORTED`, `CURRENCY_DISABLED` or a price that converts to zero: `503 PRICING_UNAVAILABLE` before anything is written and before any Paystack call. Paystack `transaction/initialize` gets `amount = chargedAmountMinor`, `currency = chargedCurrency`.
- **Issuing a checkout** (booking, re-price, retry) is race-safe. Inside ONE Firestore transaction the booking is re-read and the checkout goes on only if it is still `pending_payment`, not paid, still carries the reference the caller saw, and has no live checkout (no `checkoutUrl` yet, or its lock passed). A reference WE generate (`cons-<id>-<uuid>`) is stored there with the new snapshot, and the reference it replaces is appended to `supersededCheckouts` with its own snapshot. Only then is Paystack `transaction/initialize` called with that `reference`, and `checkoutUrl` is published (in a transaction) only if the booking still carries it. A caller that loses gets the booking's current state: paid (success) or the winner's checkout, so at most one checkout per lock is handed out. If Paystack fails, the claimed reference stays with no `checkoutUrl` (never handed out) and a retry or verify issues a new one.
- **No re-price while a payment is in flight**: a checkout is only replaced when Paystack reports it `failed` or `abandoned`. Any other status (`ongoing`, `pending`, `processing`, `queued`, `reversed`, unknown) answers `409 PAYMENT_IN_PROGRESS` with the current `authorizationUrl`/`reference`, and nothing changes.
- **Verify** (`POST /consultations/public/verify`): a paid reference is settled in ONE Firestore transaction (`settlePayment`). It must be the booking's current reference or one in `supersededCheckouts`, else `400` and an error log. Paystack's `requested_amount` (what the checkout asked, when Paystack reports it; fees passed to the customer inflate `amount`), else `amount`, plus `currency`, must equal what THAT checkout asked (current: `chargedAmountMinor`/`chargedCurrency`, legacy rows `fee` as NGN; superseded: the entry's own snapshot), else `400 PAYMENT_MISMATCH` with nothing recorded. An EXACT payment is honoured even when it completed after its `quoteExpiresAt` (the lock governs issuing a checkout, not honouring one we issued): booking and transaction get `paidAfterQuoteExpiry: true` and a warn-level log. A superseded reference settles a still-unpaid booking at its own snapshot (`paidOnSupersededReference: true`; the then-current checkout moves to `supersededCheckouts`). On a booking already paid by another reference it is a second charge: a `consultationPaymentExceptions` record, an error-level log, `200 { verified, refundPending: true }`, and never a second transaction. A payment on a booking no longer awaiting payment (cancelled) is recorded the same way (`409 BOOKING_NOT_PAYABLE`). Whenever Paystack reports `paid_at`, it is stored as `paystackPaidAt`. Not paid: in progress is `409 PAYMENT_IN_PROGRESS`; failed/abandoned on the current reference is `400` inside the lock and, after it, a fresh quote and a new checkout (`409 QUOTE_EXPIRED` with the new `authorizationUrl`); failed/abandoned on a superseded reference is `409 CHECKOUT_REPLACED` with the current checkout (or a new one when the current never opened). A Paystack failure while re-pricing is `502 BILLING_PROVIDER_ERROR`. A second verify writes nothing.
- **Retry** (`POST /consultations/:id/checkout`, the booking's own client): the same checkout inside the lock, a fresh quote after it (both only when Paystack reports the current checkout `failed`/`abandoned`; in progress is `409 PAYMENT_IN_PROGRESS`); if the current reference was in fact paid it is settled instead (same rules as verify). `409 CHECKOUT_OPENING` when another request is still opening the checkout.
- **`consultationPaymentExceptions/{reference}`** (backend only, `firestore.rules` has no match so every client is denied): `{ id, consultationId, reference, amountMinor, currency, paystackPaidAt, reason: "paid_on_superseded_reference_after_booking_paid" | "booking_not_payable", status: "open", createdAt }`. Money we hold but cannot apply, for a human to refund (no automated refund yet). Doc id = the Paystack reference, so the same payment is never recorded twice.
- **Legacy rows** (`fee` only) keep working: shown as naira, verified against `fee` in NGN, never re-priced. Pending, unpaid signed-in bookings from before #180 (client-supplied `fee`, no Paystack reference) are cancelled by `npm run cancel:legacy-consultations -- --project <id> [--apply]` (`functions/src/scripts/cancel-legacy-pending-consultations.ts`; dry run by default, `--project` checked by the shared target guard, `--emulator` required when `FIRESTORE_EMULATOR_HOST` is set, each row re-checked in its own transaction). Paid legacy rows and legacy guest checkouts with a Paystack reference are left alone.
- **Migration** (`npm run migrate:prices-usd -- --project <id> --rate <naira per USD> --cutoff <#148 deploy ISO time> [--apply]`, `functions/src/scripts/migrate-prices-to-usd.ts`) replaces the #148 naira migration (do not run both). The rate is required (no built-in number); the script prints `exchangeRates/NGN` for reference. Half-up rounding to a whole cent. Each converted value records `migratedFrom.<old field>` = `PriceMigrationRecord` `{ amount (whole naira), currency: "NGN", rate, storedValue, storedUnit: "naira"|"kobo", migratedAt }`. Values that are not whole naira (or kobo of whole naira), would round to $0.00, or docs that hold both a naira and a dollar price are listed and left alone. Historical `consultations.fee` rows stay naira (see #180 below).

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
