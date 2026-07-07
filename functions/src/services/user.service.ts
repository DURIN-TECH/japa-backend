import { collections, serverTimestamp, auth } from "../utils/firebase";
import { User, Address, Agency } from "../types";
import { Timestamp } from "firebase-admin/firestore";
import { Role, Subscription } from "@durin-tech/authz";
import { StoredPlan } from "../types/billing";

/**
 * Flattened admin view of a user, joining Firebase Auth (identity + role claims +
 * account timestamps) with Firestore (`users` profile, `subscriptions`/`plans`,
 * `agencies`). Dates are ISO strings so the portal can render them directly.
 */
export interface AdminUserRow {
  uid: string;
  email: string | null;
  emailVerified: boolean;
  disabled: boolean;
  firstName: string;
  lastName: string;
  phone: string | null;
  /** RBAC role from custom claims (null if the account has no role claim yet). */
  role: Role | null;
  agencyId: string | null;
  agencyName: string | null;
  onboardingCompleted: boolean;
  isProvisional: boolean;
  planId: string | null;
  planName: string | null;
  subscriptionStatus: string | null;
  /** Account creation time (Firebase Auth metadata), ISO. */
  createdAt: string | null;
  /** Last sign-in time (Firebase Auth metadata), ISO. */
  lastLoginAt: string | null;
}

export interface CreateUserInput {
  email: string;
  firstName: string;
  lastName: string;
  middleName?: string;
  phone?: string;
}

export interface UpdateUserInput {
  firstName?: string;
  lastName?: string;
  middleName?: string;
  phone?: string;
  dateOfBirth?: Date;
  address?: Address;
  residentialCountry?: string;
  profilePhotoUrl?: string;
  hasPassport?: boolean;
  passportNumber?: string;
  passportExpiryDate?: Date;
  passportCountry?: string;
}

export interface CompleteOnboardingInput {
  firstName: string;
  lastName: string;
  email: string;
  residentialCountry: string;
  destinationCountry?: string;
  destinationVisa?: string;
  hasPassport: boolean;
}

class UserService {
  /**
   * Create a new user profile
   */
  async createUser(userId: string, input: CreateUserInput): Promise<User> {
    const userRef = collections.users.doc(userId);
    const existingUser = await userRef.get();

    if (existingUser.exists) {
      throw new Error("User already exists");
    }

    const now = Timestamp.now();
    const userData: User = {
      id: userId,
      email: input.email,
      firstName: input.firstName,
      lastName: input.lastName,
      middleName: input.middleName,
      phone: input.phone,
      onboardingCompleted: false,
      hasPassport: false,
      createdAt: now,
      updatedAt: now,
    };

    await userRef.set(userData);
    return userData;
  }

  /**
   * Get user by ID
   */
  async getUserById(userId: string): Promise<User | null> {
    const userDoc = await collections.users.doc(userId).get();
    
    if (!userDoc.exists) {
      return null;
    }

    return userDoc.data() as User;
  }

  /**
   * Get user by email
   */
  async getUserByEmail(email: string): Promise<User | null> {
    const snapshot = await collections.users
      .where("email", "==", email)
      .limit(1)
      .get();

    if (snapshot.empty) {
      return null;
    }

    return snapshot.docs[0].data() as User;
  }

  /**
   * Resolve a user's display name ("First Last") from their UID. Best-effort —
   * returns "" if the user can't be found or lookup fails. Used to attribute
   * activity/audit notes to the agent who performed an action.
   */
  async getDisplayName(userId: string): Promise<string> {
    try {
      const user = await this.getUserById(userId);
      if (!user) return "";
      return `${user.firstName || ""} ${user.lastName || ""}`.trim();
    } catch {
      return "";
    }
  }

  /**
   * Update user profile
   */
  async updateUser(userId: string, input: UpdateUserInput): Promise<User> {
    const userRef = collections.users.doc(userId);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      throw new Error("User not found");
    }

    const updates: Record<string, unknown> = {
      ...input,
      updatedAt: serverTimestamp(),
    };

    // Convert Date objects to Timestamps
    if (input.dateOfBirth) {
      updates.dateOfBirth = Timestamp.fromDate(input.dateOfBirth);
    }
    if (input.passportExpiryDate) {
      updates.passportExpiryDate = Timestamp.fromDate(input.passportExpiryDate);
    }

    await userRef.update(updates);
    
    const updatedDoc = await userRef.get();
    return updatedDoc.data() as User;
  }

  /**
   * Complete user onboarding
   */
  async completeOnboarding(
    userId: string,
    input: CompleteOnboardingInput
  ): Promise<User> {
    const userRef = collections.users.doc(userId);
    const userDoc = await userRef.get();

    const now = Timestamp.now();
    const updates = {
      firstName: input.firstName,
      lastName: input.lastName,
      email: input.email,
      residentialCountry: input.residentialCountry,
      hasPassport: input.hasPassport,
      onboardingCompleted: true,
      onboardingCompletedAt: now,
      updatedAt: now,
    };

    if (userDoc.exists) {
      await userRef.update(updates);
    } else {
      // Create user if doesn't exist (first-time onboarding)
      const userData: User = {
        id: userId,
        ...updates,
        createdAt: now,
      };
      await userRef.set(userData);
    }

    const updatedDoc = await userRef.get();
    return updatedDoc.data() as User;
  }

  /**
   * Update user's last login timestamp
   */
  async updateLastLogin(userId: string): Promise<void> {
    await collections.users.doc(userId).update({
      lastLoginAt: serverTimestamp(),
    });
  }

  /**
   * Add FCM token for push notifications
   */
  async addFcmToken(userId: string, token: string): Promise<void> {
    const userRef = collections.users.doc(userId);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      throw new Error("User not found");
    }

    const user = userDoc.data() as User;
    const tokens = user.fcmTokens || [];

    // Don't add duplicate tokens
    if (!tokens.includes(token)) {
      await userRef.update({
        fcmTokens: [...tokens, token],
        updatedAt: serverTimestamp(),
      });
    }
  }

  /**
   * Remove FCM token
   */
  async removeFcmToken(userId: string, token: string): Promise<void> {
    const userRef = collections.users.doc(userId);
    const userDoc = await userRef.get();

    if (!userDoc.exists) {
      return;
    }

    const user = userDoc.data() as User;
    const tokens = (user.fcmTokens || []).filter((t) => t !== token);

    await userRef.update({
      fcmTokens: tokens,
      updatedAt: serverTimestamp(),
    });
  }

  /**
   * Delete user (soft delete or hard delete based on requirements)
   */
  async deleteUser(userId: string): Promise<void> {
    // For now, we'll do a hard delete
    // In production, you might want to soft delete or anonymize
    await collections.users.doc(userId).delete();
  }

  /**
   * Check if user has completed onboarding
   */
  async hasCompletedOnboarding(userId: string): Promise<boolean> {
    const user = await this.getUserById(userId);
    return user?.onboardingCompleted ?? false;
  }

  /**
   * List every user for the admin directory. Firebase Auth is the primary source —
   * it's the only place that has the RBAC role (custom claims) and the account
   * creation / last-sign-in timestamps for *all* accounts, including provisional or
   * auth-only ones with no profile doc. Each auth record is then enriched from
   * Firestore.
   *
   * The enrichment collections (`users`, `agencies`, `subscriptions`, `plans`) are
   * each fetched once and indexed in memory, so the whole join costs a handful of
   * reads regardless of user count (no per-user round-trips).
   */
  async listAllUsers(): Promise<AdminUserRow[]> {
    // 1. Page through all Firebase Auth accounts (1000 max per page).
    const authUsers: import("firebase-admin/auth").UserRecord[] = [];
    let pageToken: string | undefined;
    do {
      const page = await auth.listUsers(1000, pageToken);
      authUsers.push(...page.users);
      pageToken = page.pageToken;
    } while (pageToken);

    // 2. Load the enrichment collections once and index them for O(1) lookups.
    const [userSnap, agencySnap, subSnap, planSnap] = await Promise.all([
      collections.users.get(),
      collections.agencies.get(),
      collections.subscriptions.get(),
      collections.plans.get(),
    ]);

    const userDocs = new Map<string, User>();
    userSnap.forEach((d) => userDocs.set(d.id, d.data() as User));

    const agencyNames = new Map<string, string>();
    agencySnap.forEach((d) => agencyNames.set(d.id, (d.data() as Agency).name));

    // Subscriptions are keyed by subscriberId (agency id for owner/agent, uid for
    // agent-without-agency / client).
    const subsBySubscriber = new Map<string, Subscription>();
    subSnap.forEach((d) => subsBySubscriber.set(d.id, d.data() as Subscription));

    const planNames = new Map<string, string>();
    planSnap.forEach((d) => planNames.set(d.id, (d.data() as StoredPlan).name));

    // 3. Join each auth record with its Firestore enrichment.
    return authUsers.map((au) => {
      const claims = (au.customClaims ?? {}) as { role?: Role; agencyId?: string | null };
      const role = claims.role ?? null;
      const agencyId = claims.agencyId ?? null;
      const profile = userDocs.get(au.uid);

      // Resolve the subscriber this user bills under (mirrors
      // entitlementService.resolveSubscriber): agency for owner/agent-with-agency,
      // else the user's own uid.
      const subscriberId =
        (role === "owner" || role === "agent") && agencyId ? agencyId : au.uid;
      const sub = subsBySubscriber.get(subscriberId);

      return {
        uid: au.uid,
        email: au.email ?? profile?.email ?? null,
        emailVerified: au.emailVerified,
        disabled: au.disabled,
        firstName: profile?.firstName ?? "",
        lastName: profile?.lastName ?? "",
        phone: profile?.phone ?? null,
        role,
        agencyId,
        agencyName: agencyId ? agencyNames.get(agencyId) ?? null : null,
        onboardingCompleted: profile?.onboardingCompleted ?? false,
        isProvisional: profile?.isProvisional ?? false,
        planId: sub?.planId ?? null,
        planName: sub?.planId ? planNames.get(sub.planId) ?? null : null,
        subscriptionStatus: sub?.status ?? null,
        // Firebase Auth metadata timestamps are RFC-1123 strings; normalize to ISO.
        createdAt: au.metadata.creationTime
          ? new Date(au.metadata.creationTime).toISOString()
          : null,
        lastLoginAt: au.metadata.lastSignInTime
          ? new Date(au.metadata.lastSignInTime).toISOString()
          : null,
      };
    });
  }
}

export const userService = new UserService();
