# Japa Backend

Firebase Cloud Functions backend for the Japa visa application assistant.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Mobile App (Expo)                      │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    Firebase Services                        │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │   Auth      │  │  Firestore  │  │  Cloud Functions    │  │
│  │             │  │             │  │                     │  │
│  │ - Email/Pass│  │ - users     │  │ - api (Express)     │  │
│  │ - Google    │  │ - agents    │  │ - onUserCreated     │  │
│  │ - Phone     │  │ - countries │  │ - onApplicationUpd  │  │
│  │             │  │ - visaTypes │  │ - scheduled jobs    │  │
│  └─────────────┘  │ - apps      │  └─────────────────────┘  │
│                   │ - consults  │                           │
│  ┌─────────────┐  └─────────────┘   ┌─────────────────────┐ │
│  │  Storage    │                    │  Cloud Messaging    │ │
│  │             │                    │                     │ │
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
│   │   ├── controllers/     # HTTP request handlers
│   │   │   ├── user.controller.ts
│   │   │   ├── visa.controller.ts
│   │   │   └── agent.controller.ts
│   │   ├── services/        # Business logic
│   │   │   ├── user.service.ts
│   │   │   ├── visa.service.ts
│   │   │   └── agent.service.ts
│   │   ├── middleware/      # Express middleware
│   │   │   └── auth.ts
│   │   ├── types/           # TypeScript types
│   │   │   └── index.ts
│   │   ├── utils/           # Utilities
│   │   │   ├── firebase.ts
│   │   │   └── response.ts
│   │   ├── app.ts           # Express app
│   │   └── index.ts         # Cloud Functions entry
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

## API Endpoints

### Authentication
All protected endpoints require `Authorization: Bearer <firebase-id-token>` header.

### Users

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/users/me` | ✓ | Get current user profile |
| PUT | `/users/me` | ✓ | Update user profile |
| DELETE | `/users/me` | ✓ | Delete user account |
| POST | `/users/onboarding` | ✓ | Complete onboarding |
| GET | `/users/onboarding/status` | ✓ | Check onboarding status |
| POST | `/users/fcm-token` | ✓ | Register FCM token |
| POST | `/users/login` | ✓ | Record login |

### Countries & Visas

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/countries` | - | List supported countries |
| GET | `/countries/:code` | - | Get country details |
| GET | `/countries/:code/visas` | - | List visa types |
| GET | `/countries/:code/visas/:id` | - | Get visa type details |
| GET | `/countries/:code/visas/:id/full` | - | Get visa with requirements |
| GET | `/countries/:code/visas/:id/requirements` | - | List requirements |
| GET | `/visas/search?q=` | - | Search visa types |
| GET | `/visas/popular` | - | Get popular visas |

### Agents

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/agents` | - | List verified agents |
| GET | `/agents/top` | - | Get top-rated agents |
| GET | `/agents/:id` | - | Get agent profile |
| GET | `/agents/:id/reviews` | - | Get agent reviews |
| GET | `/agents/visa/:visaTypeId` | - | Get agents for visa type |
| POST | `/agents` | ✓ | Create agent profile |
| GET | `/agents/me` | ✓ | Get my agent profile |
| PUT | `/agents/me` | ✓ | Update my agent profile |
| PUT | `/agents/me/availability` | ✓ | Set availability |
| POST | `/agents/:id/reviews` | ✓ | Add review |

## Firestore Collections

### users
```typescript
{
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  onboardingCompleted: boolean;
  hasPassport: boolean;
  // ...
}
```

### agents
```typescript
{
  id: string;
  userId: string;
  displayName: string;
  verificationStatus: 'pending' | 'verified' | 'rejected';
  rating: number;
  specializations: string[];
  // ...
}
```

### countries/{code}/visaTypes/{id}
```typescript
{
  id: string;
  name: string;
  category: 'work' | 'student' | 'tourist' | ...;
  processingTime: string;
  baseCostUsd: number;
  // ...
}
```

## Deployment

```bash
# Deploy everything
firebase deploy

# Deploy only functions
firebase deploy --only functions

# Deploy only rules
firebase deploy --only firestore:rules,storage:rules
```

## Local Development

1. Start emulators:
   ```bash
   npm run serve
   ```

2. Access:
   - Functions: http://localhost:5001/your-project/us-central1/api
   - Firestore UI: http://localhost:4000
   - Auth UI: http://localhost:4000/auth

## Mobile App Integration

In your React Native app, update Firebase config to use emulators in development:

```typescript
import { connectFunctionsEmulator, getFunctions } from 'firebase/functions';
import { connectFirestoreEmulator, getFirestore } from 'firebase/firestore';

if (__DEV__) {
  const functions = getFunctions();
  const firestore = getFirestore();
  
  connectFunctionsEmulator(functions, 'localhost', 5001);
  connectFirestoreEmulator(firestore, 'localhost', 8080);
}
```

## Next Steps

1. **Applications Service** - Create, track, and manage visa applications
2. **Consultations Service** - Book and manage agent consultations
3. **Documents Service** - Upload, validate, and track documents
4. **Payments Service** - Stripe integration for payments and escrow
5. **Notifications Service** - Push notifications and email
6. **Messaging Service** - Real-time chat between users and agents

## License

Private - Japa Inc.
