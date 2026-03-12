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

- Node.js 20 (required by `engines` in `package.json`)
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

# Seed everything (auth users + all Firestore data)
npm run seed:portal:emulator

# Seed individually
npm run seed:auth:emulator     # Auth users only
npm run seed:news:emulator     # News sources only
npm run seed:emulator          # Eligibility questions only
```

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

```bash
# Deploy everything
firebase deploy

# Deploy only functions
firebase deploy --only functions

# Deploy only rules
firebase deploy --only firestore:rules,storage:rules

# Deploy only indexes
firebase deploy --only firestore:indexes
```

## License

Private - Japa Inc.
