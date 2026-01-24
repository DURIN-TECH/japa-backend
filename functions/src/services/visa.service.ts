import {
  collections,
  subcollections,
  serverTimestamp,
} from "../utils/firebase";
import {
  Country,
  VisaType,
  VisaRequirement,
  VisaCategory,
  RequiredDocument,
} from "../types";
import { Timestamp } from "firebase-admin/firestore";

export interface CreateCountryInput {
  code: string;
  name: string;
  flagUrl?: string;
  isSupported?: boolean;
}

export interface CreateVisaTypeInput {
  countryCode: string;
  name: string;
  code: string;
  description: string;
  category: VisaCategory;
  processingTime: string;
  processingDaysMin: number;
  processingDaysMax: number;
  baseCostUsd: number;
  validityPeriod: string;
  isExtendable?: boolean;
  maxExtensions?: number;
  eligibilityCriteria: string[];
}

export interface CreateRequirementInput {
  title: string;
  description: string;
  estimatedTime: string;
  orderIndex: number;
  requiredDocuments: RequiredDocument[];
  dependsOn?: string[];
  isOptional?: boolean;
}

class VisaService {
  // ============================================
  // COUNTRY OPERATIONS
  // ============================================

  /**
   * Get all supported countries
   */
  async getCountries(onlySupported = true): Promise<Country[]> {
    let query = collections.countries.orderBy("popularityRank", "asc");

    if (onlySupported) {
      query = collections.countries
        .where("isSupported", "==", true)
        .orderBy("popularityRank", "asc");
    }

    const snapshot = await query.get();
    return snapshot.docs.map((doc) => doc.data() as Country);
  }

  /**
   * Get country by code
   */
  async getCountryByCode(code: string): Promise<Country | null> {
    const doc = await collections.countries.doc(code.toUpperCase()).get();
    return doc.exists ? (doc.data() as Country) : null;
  }

  /**
   * Create a new country (admin only)
   */
  async createCountry(input: CreateCountryInput): Promise<Country> {
    const code = input.code.toUpperCase();
    const countryRef = collections.countries.doc(code);

    const existing = await countryRef.get();
    if (existing.exists) {
      throw new Error("Country already exists");
    }

    const now = Timestamp.now();
    const country: Country = {
      code,
      name: input.name,
      flagUrl: input.flagUrl || `https://flagcdn.com/${code.toLowerCase()}.svg`,
      isSupported: input.isSupported ?? true,
      visaTypesCount: 0,
      minProcessingDays: 0,
      minCostUsd: 0,
      popularityRank: 999, // Default rank for new countries
      createdAt: now,
      updatedAt: now,
    };

    await countryRef.set(country);
    return country;
  }

  /**
   * Update country stats (called after visa type changes)
   */
  async updateCountryStats(countryCode: string): Promise<void> {
    const visaTypes = await this.getVisaTypesByCountry(countryCode);

    if (visaTypes.length === 0) {
      await collections.countries.doc(countryCode).update({
        visaTypesCount: 0,
        minProcessingDays: 0,
        minCostUsd: 0,
        updatedAt: serverTimestamp(),
      });
      return;
    }

    const minProcessingDays = Math.min(
      ...visaTypes.map((v) => v.processingDaysMin)
    );
    const minCostUsd = Math.min(...visaTypes.map((v) => v.baseCostUsd));

    await collections.countries.doc(countryCode).update({
      visaTypesCount: visaTypes.length,
      minProcessingDays,
      minCostUsd,
      updatedAt: serverTimestamp(),
    });
  }

  // ============================================
  // VISA TYPE OPERATIONS
  // ============================================

  /**
   * Get all visa types for a country
   */
  async getVisaTypesByCountry(countryCode: string): Promise<VisaType[]> {
    const snapshot = await subcollections
      .visaTypes(countryCode.toUpperCase())
      .where("isActive", "==", true)
      .orderBy("category")
      .get();

    return snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    })) as VisaType[];
  }

  /**
   * Get visa types by category
   */
  async getVisaTypesByCategory(
    countryCode: string,
    category: VisaCategory
  ): Promise<VisaType[]> {
    const snapshot = await subcollections
      .visaTypes(countryCode.toUpperCase())
      .where("isActive", "==", true)
      .where("category", "==", category)
      .get();

    return snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    })) as VisaType[];
  }

  /**
   * Get a single visa type
   */
  async getVisaType(
    countryCode: string,
    visaTypeId: string
  ): Promise<VisaType | null> {
    const doc = await subcollections
      .visaTypes(countryCode.toUpperCase())
      .doc(visaTypeId)
      .get();

    if (!doc.exists) {
      return null;
    }

    return { id: doc.id, ...doc.data() } as VisaType;
  }

  /**
   * Create a new visa type (admin only)
   */
  async createVisaType(input: CreateVisaTypeInput): Promise<VisaType> {
    const countryCode = input.countryCode.toUpperCase();

    // Verify country exists
    const country = await this.getCountryByCode(countryCode);
    if (!country) {
      throw new Error("Country not found");
    }

    const visaTypesRef = subcollections.visaTypes(countryCode);
    const docRef = visaTypesRef.doc();

    const now = Timestamp.now();
    const visaType: VisaType = {
      id: docRef.id,
      countryCode,
      name: input.name,
      code: input.code.toUpperCase(),
      description: input.description,
      category: input.category,
      processingTime: input.processingTime,
      processingDaysMin: input.processingDaysMin,
      processingDaysMax: input.processingDaysMax,
      baseCostUsd: input.baseCostUsd,
      validityPeriod: input.validityPeriod,
      isExtendable: input.isExtendable ?? false,
      maxExtensions: input.maxExtensions,
      eligibilityCriteria: input.eligibilityCriteria,
      isActive: true,
      agentIds: [],
      createdAt: now,
      updatedAt: now,
    };

    await docRef.set(visaType);

    // Update country stats
    await this.updateCountryStats(countryCode);

    return visaType;
  }

  /**
   * Update visa type (admin only)
   */
  async updateVisaType(
    countryCode: string,
    visaTypeId: string,
    updates: Partial<CreateVisaTypeInput>
  ): Promise<VisaType> {
    const visaTypeRef = subcollections
      .visaTypes(countryCode.toUpperCase())
      .doc(visaTypeId);

    const doc = await visaTypeRef.get();
    if (!doc.exists) {
      throw new Error("Visa type not found");
    }

    await visaTypeRef.update({
      ...updates,
      updatedAt: serverTimestamp(),
    });

    // Update country stats if relevant fields changed
    if (updates.processingDaysMin || updates.baseCostUsd) {
      await this.updateCountryStats(countryCode);
    }

    const updated = await visaTypeRef.get();
    return { id: updated.id, ...updated.data() } as VisaType;
  }

  // ============================================
  // REQUIREMENT OPERATIONS
  // ============================================

  /**
   * Get all requirements for a visa type
   */
  async getRequirements(
    countryCode: string,
    visaTypeId: string
  ): Promise<VisaRequirement[]> {
    const snapshot = await subcollections
      .requirements(countryCode.toUpperCase(), visaTypeId)
      .orderBy("orderIndex")
      .get();

    return snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    })) as VisaRequirement[];
  }

  /**
   * Get a single requirement
   */
  async getRequirement(
    countryCode: string,
    visaTypeId: string,
    requirementId: string
  ): Promise<VisaRequirement | null> {
    const doc = await subcollections
      .requirements(countryCode.toUpperCase(), visaTypeId)
      .doc(requirementId)
      .get();

    if (!doc.exists) {
      return null;
    }

    return { id: doc.id, ...doc.data() } as VisaRequirement;
  }

  /**
   * Create a requirement (admin only)
   */
  async createRequirement(
    countryCode: string,
    visaTypeId: string,
    input: CreateRequirementInput
  ): Promise<VisaRequirement> {
    // Verify visa type exists
    const visaType = await this.getVisaType(countryCode, visaTypeId);
    if (!visaType) {
      throw new Error("Visa type not found");
    }

    const requirementsRef = subcollections.requirements(
      countryCode.toUpperCase(),
      visaTypeId
    );
    const docRef = requirementsRef.doc();

    const now = Timestamp.now();
    const requirement: VisaRequirement = {
      id: docRef.id,
      visaTypeId,
      title: input.title,
      description: input.description,
      estimatedTime: input.estimatedTime,
      orderIndex: input.orderIndex,
      requiredDocuments: input.requiredDocuments,
      dependsOn: input.dependsOn,
      isOptional: input.isOptional ?? false,
      createdAt: now,
      updatedAt: now,
    };

    await docRef.set(requirement);
    return requirement;
  }

  // ============================================
  // SEARCH & FILTER
  // ============================================

  /**
   * Search visa types across all countries
   */
  async searchVisaTypes(query: string): Promise<VisaType[]> {
    // Note: Firestore doesn't support full-text search natively
    // For production, consider Algolia or Elasticsearch
    // This is a simple implementation that searches by name prefix

    const results: VisaType[] = [];
    const countries = await this.getCountries();

    for (const country of countries) {
      const visaTypes = await this.getVisaTypesByCountry(country.code);
      const matches = visaTypes.filter(
        (v) =>
          v.name.toLowerCase().includes(query.toLowerCase()) ||
          v.code.toLowerCase().includes(query.toLowerCase())
      );
      results.push(...matches);
    }

    return results;
  }

  /**
   * Get popular visa types across all countries
   */
  async getPopularVisaTypes(limit = 10): Promise<VisaType[]> {
    const results: VisaType[] = [];
    const countries = await this.getCountries();

    for (const country of countries.slice(0, 5)) {
      const visaTypes = await this.getVisaTypesByCountry(country.code);
      results.push(...visaTypes);
    }

    // Sort by total applications (would need this field populated)
    return results
      .sort((a, b) => (b.totalApplications || 0) - (a.totalApplications || 0))
      .slice(0, limit);
  }

  /**
   * Get all visa types across all countries with optional filtering
   */
  async getAllVisaTypes(options?: {
    category?: VisaCategory;
    limit?: number;
    offset?: number;
  }): Promise<{ visaTypes: VisaType[]; total: number }> {
    const results: VisaType[] = [];
    const countries = await this.getCountries();

    for (const country of countries) {
      let visaTypes: VisaType[];
      if (options?.category) {
        visaTypes = await this.getVisaTypesByCategory(
          country.code,
          options.category
        );
      } else {
        visaTypes = await this.getVisaTypesByCountry(country.code);
      }
      results.push(...visaTypes);
    }

    // Sort by country popularity rank, then by category
    results.sort((a, b) => {
      const countryA = countries.find((c) => c.code === a.countryCode);
      const countryB = countries.find((c) => c.code === b.countryCode);
      const rankDiff =
        (countryA?.popularityRank || 999) - (countryB?.popularityRank || 999);
      if (rankDiff !== 0) return rankDiff;
      return a.category.localeCompare(b.category);
    });

    const total = results.length;
    const limit = options?.limit || 20;
    const offset = options?.offset || 0;

    return {
      visaTypes: results.slice(offset, offset + limit),
      total,
    };
  }

  /**
   * Get visa type with full details including requirements
   */
  async getVisaTypeWithRequirements(
    countryCode: string,
    visaTypeId: string
  ): Promise<{ visaType: VisaType; requirements: VisaRequirement[] } | null> {
    const visaType = await this.getVisaType(countryCode, visaTypeId);
    if (!visaType) {
      return null;
    }

    const requirements = await this.getRequirements(countryCode, visaTypeId);

    return { visaType, requirements };
  }
}

export const visaService = new VisaService();
