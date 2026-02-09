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
│   │   │   ├── user.controller.ts
│   │   │   ├── visa.controller.ts
│   │   │   ├── agent.controller.ts
│   │   │   ├── application.controller.ts
│   │   │   ├── document.controller.ts
│   │   │   ├── agency.controller.ts
│   │   │   └── note.controller.ts
│   │   ├── services/           # Business logic
│   │   │   ├── user.service.ts
│   │   │   ├── visa.service.ts
│   │   │   ├── agent.service.ts
│   │   │   ├── application.service.ts
│   │   │   ├── document.service.ts
│   │   │   ├── agency.service.ts
│   │   │   └── note.service.ts
│   │   ├── middleware/         # Express middleware
│   │   │   └── auth.ts
│   │   ├── types/              # TypeScript types
│   │   │   ├── index.ts
│   │   │   └── eligibility.ts
│   │   ├── utils/              # Utilities
│   │   │   ├── firebase.ts     # Firestore collections & subcollections
│   │   │   └── response.ts
│   │   ├── data/               # Seed data
│   │   │   ├── seed-portal-data.ts
│   │   │   ├── seed-ireland-visa.ts
│   │   │   └── eligibility-seed-nigeria-ireland.ts
│   │   ├── scripts/            # Seed runners
│   │   │   ├── seed-portal.ts
│   │   │   ├── seed-eligibility.ts
│   │   │   └── seed-questions.ts
│   │   ├── app.ts              # Express app & routes
│   │   └── index.ts            # Cloud Functions entry
│   ├── package.json
│   └── tsconfig.json
├── firebase.json
├── firestore.rules
├── firestore.indexes.json
├── storage.rules
└── README.md
```

## Setup

### Prerequisites

- Node.js 20+
- Firebase CLI: `npm install -g firebase-tools`
- Firebase project created

### Installation

1. **Clone and install dependencies:**
   ```bash
   cd japa-backend/functions
   npm install
   ```

2. **Login to Firebase:**
   ```bash
   firebase login
   ```

3. **Select your project:**
   ```bash
   firebase use your-project-id
   ```

4. **Start emulators for local development:**
   ```bash
   npm run serve
   ```

### Environment Setup

For production, set up environment variables:

```bash
firebase functions:config:set stripe.secret_key="sk_xxx"
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

Seed scripts populate Firestore with test data for development.

### Portal seed (users, agency, agents, applications, timelines, documents, notes)

```bash
# Against emulator (recommended for development)
cd functions
npm run seed:portal:emulator

# Against production (use with caution)
npm run seed:portal
```

Creates:
- 8 users (1 owner, 2 agents, 5 clients)
- 1 agency with 4 services
- 3 agents linked to the agency
- 5 applications across statuses: `under_review`, `pending_documents`, `approved`, `rejected`, `pending_payment`
- 13 timeline entries
- 8 documents (verified, under review, rejected)
- 5 case notes from agent and owner

All IDs are deterministic (`seed-*`) so the script is idempotent.

### Eligibility seed (Ireland visa questions)

```bash
cd functions
npm run seed:emulator    # Against emulator
npm run seed             # Against production
```

Creates eligibility questions for Nigeria-to-Ireland visa routes.

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

### Local Emulators

```bash
npm run serve
```

- Functions: http://localhost:5001/japa-platform/us-central1/api
- Firestore UI: http://localhost:4000
- Auth UI: http://localhost:4000/auth
- Auth emulator: port 9099
- Firestore emulator: port 8080

### Portal Integration

Set the portal's API URL to the local emulator:

```
NEXT_PUBLIC_API_URL=http://localhost:5001/japa-platform/us-central1/api
```

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
