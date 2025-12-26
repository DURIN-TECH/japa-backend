import { collections, serverTimestamp } from "../utils/firebase";
import { User, Address } from "../types";
import { Timestamp } from "firebase-admin/firestore";

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
}

export const userService = new UserService();
