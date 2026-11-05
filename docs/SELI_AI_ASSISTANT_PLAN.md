# Japa AI Assistant — Implementation Plan

## Context

We're adding a Claude-powered AI assistant to the Japa platform so applicants on mobile can chat for personalized advice, generate documents (cover letters, SOPs, financial affidavits), have their uploaded docs reviewed by vision, and ask about visa requirements — and so agency agents/owners on the portal can do the same for their applicants plus look up current visa info. The motivation: today applicants get stuck mid-application waiting on a human agent for things an LLM can answer instantly with full case context, and agents spend disproportionate time on document gap-checking and boilerplate drafting that an assistant can pre-fill. The intended outcome is a single feature, shipped in three independently shippable phases, that reuses our existing Firestore/Storage/FCM infrastructure with no migration of existing routes.

## Locked-in design choices

- **LLM provider:** Anthropic Claude via `@anthropic-ai/sdk`. Default chat & vision model: `claude-sonnet-4-6`. Cheap classifier calls: `claude-haiku-4-5-20251001`. Aggressive prompt caching on system prompts and visa-context blocks.
- **Chat storage:** New `aiConversations` collection separate from existing `conversations`.
- **Generated document formats:** All three — markdown+browser-print PDF (reusing the `downloadReceipt` HTML pattern), DOCX (via `docx` npm), and plain text in chat.
- **Document review depth:** Full vision analysis. Backend fetches signed URL bytes and passes them to Claude as a `document` content block.

## Architecture

```
[Mobile RN app] ── HTTPS ──┐                       ┌── Anthropic Messages API
                           │                       │   (Sonnet 4.6 / Haiku 4.5)
                           ▼                       │   prompt caching on system blocks
                   ┌───────────────┐               │
                   │ japa-backend  │── tool use ───┘
                   │  /ai/* routes │
                   │  Cloud Funcs  │── reads ──▶ Firestore: countries, applications, documents
[Portal Next.js]── HTTPS ─▶              │── writes ─▶ Firestore: aiConversations/{id}/messages
       │                  │              │── fetch ──▶ Cloud Storage (doc signed URLs)
       │                  └──────────────┘── upload ─▶ Cloud Storage (DOCX artifacts)
       │                         │
       └── Firestore onSnapshot ◀┘  (assistant message doc grows as tokens stream in)

Mobile: short-poll GET /ai/conversations/:id/messages?since=<ts> every 1.5s while last message
        status === "streaming". Avoids adding @react-native-firebase/firestore as a native dep.
```

**Streaming under Cloud Functions Gen 1:** the function does _not_ stream its HTTP response. Instead the assistant turn writes Claude's text deltas (batched ~250ms) into the in-flight assistant message doc in Firestore. Portal renders via `onSnapshot`; mobile polls only while `status="streaming"`. If true SSE is later needed, move just `/ai/*` to Cloud Run sharing the same Express app — no Gen 2 migration of the rest.

## Backend changes (`japa-backend/functions/src/`)

### New files

- `types/ai.ts` — `AIConversation`, `AIMessage`, `AIToolCall`, `AIToolResult`, `AIArtifact`, `AIMessageStatus`. Uses Firestore `Timestamp`.
- `services/ai-assistant.service.ts` — orchestration. Key functions:
  - `startConversation({ userId, role, applicationId? })`
  - `sendUserMessage({ conversationId, userId, role, text, attachmentDocIds? })` — runs the agentic loop.
  - `streamAndPersistAssistantTurn(...)` — wraps `anthropic.messages.stream(...)`, batches deltas into Firestore.
  - `runToolCall(name, input, ctx)` — switch over tools (see table).
  - `buildSystemPrompt(role, ctx)` — returns 3 cached blocks: persona+rules, role guidance, country/visa context.
  - `buildAnthropicClient()` — reads `ANTHROPIC_API_KEY` from Secret Manager.
- `services/ai-tools.service.ts` — pure tool handlers.
- `services/ai-document-generation.service.ts` — markdown templates + `docx` generator; uploads via `storage.service.ts`.
- `services/ai-rate-limit.service.ts` — daily Firestore counter at `aiUsage/{userId}/days/{YYYY-MM-DD}`. Caps: 200k tokens/day applicant, 1M/day agent.
- `controllers/ai.controller.ts` — thin HTTP layer.
- `routes/ai.routes.ts` — Express router, all routes `verifyAuth`.
- `utils/access.ts` — extract `checkApplicationAccess` from `application.controller.ts` so tools can call it.

### Tools the model can invoke

Every handler validates caller role + access via shared `checkApplicationAccess` before returning data.

| Tool                         | Input                                                              | Returns                                                                             | Wraps                               |
| ---------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------- | ----------------------------------- |
| `get_application_context`    | `{ applicationId }`                                                | Application core + timeline + counts + denormalized names                           | `application.service.ts`            |
| `list_application_documents` | `{ applicationId }`                                                | `Document[]` (no raw `storageUrl`) + requirement name                               | `document.service.ts`               |
| `read_document_content`      | `{ documentId }`                                                   | Anthropic `document` content block (PDF) or `image` (JPEG/PNG), base64 from Storage | `storage.service.ts`                |
| `search_visa_requirements`   | `{ countryCode, visaTypeId?, query? }`                             | Country + visa type + requirements                                                  | `visa.service.ts`                   |
| `list_user_applications`     | `{ userId? }` (defaults to caller; agent must already have access) | Lightweight `Application[]`                                                         | `application.service.ts`            |
| `propose_application_note`   | `{ applicationId, content }`                                       | `{ proposedNoteId }` — writes to a _staging_ subcollection, NOT to real notes       | (new)                               |
| `generate_document_artifact` | `{ kind, markdown, title, applicationId? }`                        | `{ artifactId, signedDocxUrl, markdownPath }`                                       | `ai-document-generation.service.ts` |

### New routes (mount in `app.ts` as `/ai`)

| Method | Path                                                 | Purpose                                                                      |
| ------ | ---------------------------------------------------- | ---------------------------------------------------------------------------- |
| POST   | `/ai/conversations`                                  | Create conversation                                                          |
| GET    | `/ai/conversations`                                  | List caller's conversations                                                  |
| GET    | `/ai/conversations/:id`                              | Conversation metadata                                                        |
| POST   | `/ai/conversations/:id/messages`                     | Append user msg, start assistant turn; returns immediately with both msg IDs |
| GET    | `/ai/conversations/:id/messages?since=<iso>`         | Mobile polling fallback                                                      |
| POST   | `/ai/documents/:id/review`                           | One-shot vision review (optionally attached to a conversation)               |
| POST   | `/ai/documents/generate`                             | Generate artifact in requested `formats`                                     |
| POST   | `/ai/conversations/:id/notes/:proposedNoteId/accept` | Agent commits a proposed note via real `note.service.ts`                     |

### Firestore schema

`aiConversations/{conversationId}`: `id, userId, applicationId?, agencyId?, participantRole, title, createdAt, updatedAt, lastMessageAt, totalMessages, totalInputTokens, totalOutputTokens, status: "active"|"archived"`

`aiConversations/{conversationId}/messages/{messageId}`: `id, conversationId, role: "user"|"assistant"|"tool", content[], status: "pending"|"streaming"|"complete"|"error", toolCalls?, toolResults?, artifacts?, attachmentDocIds?, tokensUsed?, model?, stopReason?, errorMessage?, createdAt, updatedAt`

`aiConversations/{conversationId}/proposedNotes/{id}`: `id, applicationId, content, status: "pending"|"accepted"|"rejected", proposedAt, decidedBy?, decidedAt?`

`aiUsage/{userId}/days/{YYYY-MM-DD}`: token counters.

### Secrets & runtime

- `firebase functions:secrets:set ANTHROPIC_API_KEY`
- AI function variant: `runWith({ memory: "1GB", timeoutSeconds: 300, secrets: ["ANTHROPIC_API_KEY"] })`
- Deps: `@anthropic-ai/sdk`, `docx`

### System prompt strategy

Three `cache_control: { type: "ephemeral" }` blocks per request: (1) static persona+rules+tool guidance, (2) role-specific block, (3) country/visa context block (identical text on repeat = cache hit) when `applicationId` is bound.

## Mobile changes (`japa-mobile/src/`)

### Routes & screens

- `app/(tabs)/me/ai-assistant/index.tsx` — conversation list + "New chat" CTA.
- `app/(tabs)/me/ai-assistant/[conversationId].tsx` — chat screen. Reuse the `KeyboardAvoidingView` + `FlatList` layout from `app/(tabs)/me/chat/[conversationId].tsx`.
- CTAs added to: `app/(tabs)/index.tsx` ("Ask AI" card), `app/apply/self-service/[id].tsx` header ("Ask AI about this application" — opens conversation with `applicationId` bound), document tiles ("Have AI review this doc").

### Hooks (`src/hooks/useAIAssistant.ts`)

- `useAIConversations()`, `useAIConversation(id)` — standard React Query.
- `useAIMessages(conversationId)` — initial fetch then poll `?since=<lastUpdatedAt>` every 1.5s **only while** last msg status is `streaming`.
- `useSendAIMessage()`, `useReviewDocument()`, `useGenerateDocument()`, `useAIRateLimit()`.

### Components (`src/components/ai/`)

- `AIMessageBubble.tsx` — `react-native-markdown-display` for text; collapsible tool-call rows; renders `artifacts` as `GeneratedDocCard`.
- `GeneratedDocCard.tsx` — "Open PDF" via `expo-print`, "Download .docx" via `expo-file-system` + `expo-sharing`.
- `DocumentReviewResultCard.tsx`, `AIComposer.tsx`, `StreamingDots.tsx`.

### Misc

- `services/push-notification.service.ts` — add `ai_assistant` type, deep-link `/me/ai-assistant/[conversationId]`.
- `services/analytics.service.ts` — new events: `ai_assistant_opened`, `ai_conversation_started`, `ai_message_sent`, `ai_response_received`, `ai_document_review_requested`, `ai_document_review_completed`, `ai_document_generated`, `ai_artifact_downloaded`, `ai_rate_limit_hit`.
- New deps: `react-native-markdown-display`, `expo-print`.

## Portal changes (`japa-portal/src/`)

### Pages

- `app/(authenticated-routes)/ai-assistant/page.tsx` — standalone full-screen chat for cross-case queries.
- `app/(authenticated-routes)/case-management/[caseId]/page.tsx` — add a right slide-over `<CaseAIAssistantPanel caseId>` with `applicationId` bound. Preserves case context visually rather than navigating away.

### Components (`src/components/ai/`)

- `AIChatView.tsx` — subscribes via Firebase web SDK `onSnapshot` to `aiConversations/{id}/messages` ordered by `createdAt`.
- `AIMessageBubble.tsx` — `react-markdown` + `remark-gfm`.
- `GeneratedDocCard.tsx` — "Open PDF preview" reuses `downloadReceipt`-style HTML in `lib/export.ts` then `window.print()`. "Download .docx" uses signed URL.
- `DocumentReviewPanel.tsx` — embedded in `components/documents/DocumentViewer.tsx` toolbar.
- `ProposedNoteAcceptCard.tsx` — Accept/Reject buttons for `propose_application_note` results.
- `CaseAIAssistantPanel.tsx` — wraps `AIChatView` for the case page.

### State, API, types

- `src/store/useAIAssistantStore.ts` — Zustand following `useCountriesStore` pattern. Holds conversation list, current ID, draft, attachments, active unsubscribers. **Messages are NOT in the store** — they live in component state populated by `onSnapshot`.
- `src/lib/api/aiClient.ts` — typed wrappers around `lib/api/client.ts#request`.
- `src/types/ai.ts` — string-date mirrors of backend types.
- `src/lib/api/mappers.ts` — add `toAIMessage(raw)` that handles Firestore `Timestamp.toDate().toISOString()`.

### Analytics (`src/lib/analytics/events.ts`)

Same events as mobile plus: `ai_panel_opened_in_case`, `ai_proposed_note_accepted`, `ai_proposed_note_rejected`, `ai_visa_lookup_used`.

## Shared types strategy

Backend canonical types in `functions/src/types/ai.ts` with Firestore `Timestamp`. Clients mirror with `string` ISO dates and convert at the boundary — same pattern as existing `Application` ↔ `CaseItem` in `japa-portal/src/lib/api/mappers.ts`.

## Phasing

### Phase A — Text chat end-to-end (no docs, no generation)

- Backend: `types/ai.ts`, `services/ai-assistant.service.ts`, `controllers/ai.controller.ts`, `routes/ai.routes.ts`, `app.ts` mount, secret wiring, `services/ai-rate-limit.service.ts`, `utils/access.ts` extraction, tools: `search_visa_requirements` + `get_application_context` + `list_user_applications`.
- Mobile: `hooks/useAIAssistant.ts`, `components/ai/{AIMessageBubble,AIComposer,StreamingDots}.tsx`, screens under `app/(tabs)/me/ai-assistant/`, home CTA, polling fallback.
- Portal: `aiClient.ts`, `useAIAssistantStore.ts`, `AIChatView.tsx`, `AIMessageBubble.tsx`, `ai-assistant/page.tsx`, `CaseAIAssistantPanel.tsx`.
- **Ships:** applicants and agents have a markdown-rendering chat that knows their case + visa.

### Phase B — Document vision review + agent tools

- Backend: `list_application_documents`, `read_document_content`, `propose_application_note` tools; `POST /ai/documents/:id/review`; vision content blocks; accept-note route.
- Mobile: `DocumentReviewResultCard.tsx`, "Ask AI to review" on document tiles, `useReviewDocument()`.
- Portal: `DocumentReviewPanel.tsx` inside `DocumentViewer.tsx`, `ProposedNoteAcceptCard.tsx`.
- **Ships:** agents can vision-review from case page; applicants can ask "what's wrong with this doc?".

### Phase C — Document generation (all three formats)

- Backend: `services/ai-document-generation.service.ts`, `docx` dep, `generate_document_artifact` tool, `POST /ai/documents/generate`, Storage uploads at `documents/ai-generated/{userId}/`.
- Mobile: `GeneratedDocCard.tsx`, `expo-print` PDF flow, share-sheet for DOCX.
- Portal: `GeneratedDocCard.tsx`, markdown→print HTML via `lib/export.ts`, DOCX `<a download>`.
- **Ships:** full feature.

## Verification

**Phase A**

- Unit: system-prompt builder snapshot tests; rate-limit Firestore emulator test; `runToolCall` access-denial test (caller without access to `applicationId` → `FORBIDDEN`).
- Integration: emulator test — `POST /ai/conversations/:id/messages` writes user msg then assistant msg with `status: "complete"`.
- Manual mobile: home → "Ask AI" → "What visa do I need for Canada study?" → confirm streaming bubbles, markdown lists, polling stops on completion.
- Manual portal: case → AI panel → "Summarize this case" → tool-call row shows `get_application_context`; response cites real applicant fields.

**Phase B**

- Unit: vision content-block builder picks correct `media_type` for PDF vs JPEG.
- Manual: upload a passport JPEG → ask "Is my passport valid for this visa?" → reasoning references the doc. Confirm access denial when agent from another agency tries.

**Phase C**

- Unit: DOCX generator produces non-empty Buffer; mapper handles missing artifacts.
- Manual: applicant asks "Draft a cover letter" → card appears → DOCX opens correctly in Word; PDF print preview matches.

**Cross-cutting**

- Verify cache hit rate via Anthropic response headers (`cache_read_input_tokens > 0` on 2nd+ turn).
- Run `firebase emulators:start` + existing `test-dev.sh`.
- Send messages in a loop until 429 → confirm `ai_rate_limit_hit` analytics fires.

## Critical files to modify

- `japa-backend/functions/src/app.ts` — mount `/ai` router
- `japa-backend/functions/src/controllers/application.controller.ts` — extract `checkApplicationAccess` to `utils/access.ts`
- `japa-backend/functions/src/types/index.ts` — re-export new AI types or keep in separate `types/ai.ts`
- `japa-portal/src/app/(authenticated-routes)/case-management/[caseId]/page.tsx` — add AI panel
- `japa-portal/src/components/documents/DocumentViewer.tsx` — add review button (Phase B)
- `japa-portal/src/lib/export.ts` — reuse for AI-generated PDF (Phase C)
- `japa-mobile/src/services/push-notification.service.ts` — `ai_assistant` deep-link type
- `japa-mobile/src/services/analytics.service.ts` — new event names
- `japa-mobile/src/app/(tabs)/me/chat/[conversationId].tsx` — reference for new AI chat screen layout

## Risks & open questions

1. **Mobile streaming lag** — 1.5s polling feels less live than Firestore listeners. If the lag is unacceptable in user testing, add `@react-native-firebase/firestore` (a native module, triggers a rebuild). Decide before Phase A ships.
2. **Gen 1 timeouts** — long agentic loops with multiple vision reads can exceed 60s. The AI function gets 300s, but heavy turns may still time out → fall back to Cloud Run for `/ai/*`.
3. **PII through Anthropic** — applicant passports flow through. Anthropic doesn't train on API data, but confirm with legal whether to enable zero-retention endpoint.
4. **`checkApplicationAccess` is private** on `ApplicationController` today — Phase A must refactor it to `utils/access.ts` before the tool handlers can use it.
5. **`propose_application_note` UX** — confirm agents (not applicants) see the Accept button and that proposed notes are invisible to applicants until accepted.
6. **Rate limits** — per-user cap is blunt; agency-level caps + admin override may be needed.
7. **Vision file size** — Claude limits (~5MB image, ~32MB PDF). Precheck in `read_document_content` and surface friendly error.
8. **Generated doc storage** — under `documents/ai-generated/{userId}/` for signed-URL uniformity, but **not** indexed in the Firestore `documents` collection (would pollute applicant doc counts).
