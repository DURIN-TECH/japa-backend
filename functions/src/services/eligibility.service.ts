import { getFirestore, Timestamp } from "firebase-admin/firestore";
import {
  EligibilityQuestion,
  EligibilityCheck,
  EligibilityCheckInput,
  EligibilityResult,
  EligibilityAnswer,
} from "../types/eligibility";
import { VisaCategory } from "../types";

const db = getFirestore();

export class EligibilityService {
  private questionsCollection = db.collection("eligibilityQuestions");
  private checksCollection = db.collection("eligibilityChecks");

  /**
   * Get eligibility questions for a visa type
   * Combines: common + category-specific + visa-specific questions
   */
  async getQuestions(visaTypeId: string): Promise<EligibilityQuestion[]> {
    // Get the visa type to know its category
    const visaDoc = await db.collection("visaTypes").doc(visaTypeId).get();
    const visaData = visaDoc.data();
    const category = visaData?.category as VisaCategory | undefined;

    // Fetch all applicable questions in parallel
    const [commonQuestions, categoryQuestions, visaQuestions] = await Promise.all([
      this.getQuestionsByScope("common"),
      category ? this.getQuestionsByScope(`category:${category}`) : Promise.resolve([]),
      this.getQuestionsByScope(`visa:${visaTypeId}`),
    ]);

    // Merge and sort by orderIndex
    const allQuestions = [...commonQuestions, ...categoryQuestions, ...visaQuestions];

    // If no questions found at all, return defaults
    if (allQuestions.length === 0) {
      return this.getDefaultQuestions(visaTypeId, category);
    }

    // Sort by orderIndex and return
    return allQuestions.sort((a, b) => a.orderIndex - b.orderIndex);
  }

  /**
   * Get questions by scope (common, category:work, visa:xyz)
   */
  private async getQuestionsByScope(scope: string): Promise<EligibilityQuestion[]> {
    const snapshot = await this.questionsCollection
      .where("scope", "==", scope)
      .where("isActive", "==", true)
      .orderBy("orderIndex", "asc")
      .get();

    return snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    })) as EligibilityQuestion[];
  }

  /**
   * Default questions based on visa category
   */
  private getDefaultQuestions(
    visaTypeId: string,
    category?: VisaCategory
  ): EligibilityQuestion[] {
    const now = Timestamp.now();
    const questions: EligibilityQuestion[] = [];

    // Common questions for all visas
    questions.push(
      {
        id: "passport",
        visaTypeId,
        scope: "common",
        question: "Do you have a valid passport?",
        description: "Your passport should be valid for at least 6 months beyond your intended stay.",
        type: "boolean",
        weight: 15,
        correctAnswers: ["true"],
        orderIndex: 1,
        isRequired: true,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "passport_validity",
        visaTypeId,
        scope: "common",
        question: "How many months until your passport expires?",
        type: "number",
        weight: 10,
        minValue: 0,
        maxValue: 120,
        idealMin: 6,
        idealMax: 120,
        orderIndex: 2,
        isRequired: true,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "visa_denial",
        visaTypeId,
        scope: "common",
        question: "Have you ever been denied a visa to any country?",
        type: "boolean",
        weight: 15,
        correctAnswers: ["false"],
        orderIndex: 3,
        isRequired: true,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "criminal_record",
        visaTypeId,
        scope: "common",
        question: "Do you have any criminal convictions?",
        type: "boolean",
        weight: 15,
        correctAnswers: ["false"],
        orderIndex: 4,
        isRequired: true,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      }
    );

    // Category-specific questions
    switch (category) {
      case "work":
        questions.push(
          {
            id: "job_offer",
            visaTypeId,
            scope: `category:${category}`,
            question: "Do you have a job offer from an employer in the destination country?",
            type: "boolean",
            weight: 20,
            correctAnswers: ["true"],
            orderIndex: 10,
            isRequired: true,
            isActive: true,
            createdAt: now,
            updatedAt: now,
          },
          {
            id: "work_experience",
            visaTypeId,
            scope: `category:${category}`,
            question: "How many years of relevant work experience do you have?",
            type: "number",
            weight: 10,
            minValue: 0,
            maxValue: 50,
            idealMin: 2,
            idealMax: 50,
            orderIndex: 11,
            isRequired: true,
            isActive: true,
            createdAt: now,
            updatedAt: now,
          },
          {
            id: "qualifications",
            visaTypeId,
            scope: `category:${category}`,
            question: "What is your highest level of education?",
            type: "single",
            options: ["High School", "Bachelor's Degree", "Master's Degree", "PhD", "Professional Certification"],
            weight: 10,
            correctAnswers: ["Bachelor's Degree", "Master's Degree", "PhD", "Professional Certification"],
            orderIndex: 12,
            isRequired: true,
            isActive: true,
            createdAt: now,
            updatedAt: now,
          }
        );
        break;

      case "student":
        questions.push(
          {
            id: "admission",
            visaTypeId,
            scope: `category:${category}`,
            question: "Do you have an admission letter from a recognized institution?",
            type: "boolean",
            weight: 25,
            correctAnswers: ["true"],
            orderIndex: 10,
            isRequired: true,
            isActive: true,
            createdAt: now,
            updatedAt: now,
          },
          {
            id: "tuition_funds",
            visaTypeId,
            scope: `category:${category}`,
            question: "Can you prove you have funds to cover tuition fees?",
            type: "boolean",
            weight: 15,
            correctAnswers: ["true"],
            orderIndex: 11,
            isRequired: true,
            isActive: true,
            createdAt: now,
            updatedAt: now,
          },
          {
            id: "english_proficiency",
            visaTypeId,
            scope: `category:${category}`,
            question: "Do you have English language proficiency certification (IELTS/TOEFL)?",
            description: "Required for English-speaking countries.",
            type: "boolean",
            weight: 10,
            correctAnswers: ["true"],
            orderIndex: 12,
            isRequired: false,
            isActive: true,
            createdAt: now,
            updatedAt: now,
          }
        );
        break;

      case "tourist":
        questions.push(
          {
            id: "return_ticket",
            visaTypeId,
            scope: `category:${category}`,
            question: "Do you have proof of return or onward travel?",
            type: "boolean",
            weight: 15,
            correctAnswers: ["true"],
            orderIndex: 10,
            isRequired: true,
            isActive: true,
            createdAt: now,
            updatedAt: now,
          },
          {
            id: "accommodation",
            visaTypeId,
            scope: `category:${category}`,
            question: "Do you have accommodation bookings for your stay?",
            type: "boolean",
            weight: 10,
            correctAnswers: ["true"],
            orderIndex: 11,
            isRequired: true,
            isActive: true,
            createdAt: now,
            updatedAt: now,
          },
          {
            id: "travel_insurance",
            visaTypeId,
            scope: `category:${category}`,
            question: "Do you have travel insurance covering your trip?",
            type: "boolean",
            weight: 10,
            correctAnswers: ["true"],
            orderIndex: 12,
            isRequired: true,
            isActive: true,
            createdAt: now,
            updatedAt: now,
          },
          {
            id: "ties_to_home",
            visaTypeId,
            scope: `category:${category}`,
            question: "Can you demonstrate strong ties to your home country?",
            description: "Employment, property, family, or business ties that show you will return.",
            type: "boolean",
            weight: 15,
            correctAnswers: ["true"],
            orderIndex: 13,
            isRequired: true,
            isActive: true,
            createdAt: now,
            updatedAt: now,
          }
        );
        break;

      case "business":
        questions.push(
          {
            id: "business_invitation",
            visaTypeId,
            scope: `category:${category}`,
            question: "Do you have an invitation letter from a business in the destination country?",
            type: "boolean",
            weight: 20,
            correctAnswers: ["true"],
            orderIndex: 10,
            isRequired: true,
            isActive: true,
            createdAt: now,
            updatedAt: now,
          },
          {
            id: "business_ownership",
            visaTypeId,
            scope: `category:${category}`,
            question: "Do you own or represent a registered business?",
            type: "boolean",
            weight: 15,
            correctAnswers: ["true"],
            orderIndex: 11,
            isRequired: true,
            isActive: true,
            createdAt: now,
            updatedAt: now,
          }
        );
        break;

      case "family":
        questions.push(
          {
            id: "sponsor_status",
            visaTypeId,
            scope: `category:${category}`,
            question: "Does your sponsor have legal residency/citizenship in the destination country?",
            type: "boolean",
            weight: 25,
            correctAnswers: ["true"],
            orderIndex: 10,
            isRequired: true,
            isActive: true,
            createdAt: now,
            updatedAt: now,
          },
          {
            id: "relationship_proof",
            visaTypeId,
            scope: `category:${category}`,
            question: "Can you provide proof of your relationship to the sponsor?",
            description: "Marriage certificate, birth certificate, etc.",
            type: "boolean",
            weight: 20,
            correctAnswers: ["true"],
            orderIndex: 11,
            isRequired: true,
            isActive: true,
            createdAt: now,
            updatedAt: now,
          }
        );
        break;

      default:
        // General financial question for other categories
        questions.push({
          id: "financial_proof",
          visaTypeId,
          scope: "common",
          question: "Can you provide proof of sufficient funds for your stay?",
          description: "Bank statements, employment letter, or sponsor letter.",
          type: "boolean",
          weight: 15,
          correctAnswers: ["true"],
          orderIndex: 10,
          isRequired: true,
          isActive: true,
          createdAt: now,
          updatedAt: now,
        });
    }

    return questions.sort((a, b) => a.orderIndex - b.orderIndex);
  }

  /**
   * Create visa-specific questions (admin function)
   */
  async createQuestion(
    question: Omit<EligibilityQuestion, "id" | "createdAt" | "updatedAt">
  ): Promise<EligibilityQuestion> {
    const now = Timestamp.now();
    const docRef = this.questionsCollection.doc();

    const data = {
      ...question,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    };

    await docRef.set(data);

    return {
      id: docRef.id,
      ...data,
    } as EligibilityQuestion;
  }

  /**
   * Seed questions for a specific visa (e.g., Irish Short Stay C)
   */
  async seedVisaQuestions(
    visaTypeId: string,
    questions: Array<{
      question: string;
      description?: string;
      type: EligibilityQuestion["type"];
      options?: string[];
      weight: number;
      correctAnswers?: string[];
      idealMin?: number;
      idealMax?: number;
      orderIndex: number;
      isRequired: boolean;
    }>
  ): Promise<void> {
    const batch = db.batch();
    const now = Timestamp.now();

    for (const q of questions) {
      const docRef = this.questionsCollection.doc();
      batch.set(docRef, {
        ...q,
        visaTypeId,
        scope: `visa:${visaTypeId}`,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      });
    }

    await batch.commit();
  }

  /**
   * Submit eligibility check and calculate score
   */
  async submitCheck(
    userId: string,
    input: EligibilityCheckInput
  ): Promise<EligibilityCheck> {
    const { visaTypeId, countryCode, answers } = input;

    // Get questions for this visa type
    const questions = await this.getQuestions(visaTypeId);

    // Calculate score and build breakdown
    const result = this.calculateScore(questions, answers);

    // Save the check
    const now = Timestamp.now();
    const checkRef = this.checksCollection.doc();

    const check: Omit<EligibilityCheck, "id"> = {
      userId,
      visaTypeId,
      countryCode,
      score: result.score,
      eligibilityLevel: result.eligibilityLevel,
      answers,
      breakdown: result.breakdown,
      recommendations: result.recommendations,
      missingRequirements: result.missingRequirements,
      createdAt: now,
    };

    await checkRef.set(check);

    return {
      id: checkRef.id,
      ...check,
    };
  }

  /**
   * Calculate eligibility score from answers
   */
  private calculateScore(
    questions: EligibilityQuestion[],
    answers: EligibilityAnswer[]
  ): EligibilityResult {
    const breakdown: EligibilityResult["breakdown"] = [];
    const recommendations: string[] = [];
    const missingRequirements: string[] = [];

    let totalPoints = 0;
    let maxPoints = 0;

    for (const question of questions) {
      const answer = answers.find((a) => a.questionId === question.id);
      const answerValue = answer?.answer;
      const answerString = this.formatAnswer(answerValue);

      let points = 0;
      let passed = false;
      let recommendation: string | undefined;

      maxPoints += question.weight;

      if (answerValue === undefined || answerValue === null) {
        if (question.isRequired) {
          missingRequirements.push(question.question);
        }
      } else {
        // Evaluate the answer
        switch (question.type) {
          case "boolean":
            passed = question.correctAnswers?.includes(String(answerValue)) ?? false;
            if (passed) {
              points = question.weight;
            } else {
              recommendation = this.getRecommendation(question, answerValue);
            }
            break;

          case "number":
            const numValue = Number(answerValue);
            if (
              question.idealMin !== undefined &&
              question.idealMax !== undefined
            ) {
              if (numValue >= question.idealMin && numValue <= question.idealMax) {
                passed = true;
                points = question.weight;
              } else if (numValue < question.idealMin) {
                const ratio = numValue / question.idealMin;
                points = Math.floor(question.weight * Math.min(ratio, 0.5));
                recommendation = this.getRecommendation(question, answerValue);
              }
            } else {
              // No ideal range, give full points if answered
              passed = true;
              points = question.weight;
            }
            break;

          case "single":
            passed = question.correctAnswers?.includes(String(answerValue)) ?? false;
            if (passed) {
              points = question.weight;
            } else {
              // Partial credit for answering
              points = Math.floor(question.weight * 0.3);
            }
            break;

          case "multiple":
            const selectedOptions = answerValue as string[];
            const correctCount = selectedOptions.filter(
              (opt) => question.correctAnswers?.includes(opt)
            ).length;
            const totalCorrect = question.correctAnswers?.length ?? 1;
            points = Math.floor(question.weight * (correctCount / totalCorrect));
            passed = correctCount === totalCorrect;
            break;

          case "date":
            // For date questions, give full points if answered
            points = question.weight;
            passed = true;
            break;
        }
      }

      totalPoints += points;

      breakdown.push({
        questionId: question.id,
        question: question.question,
        answer: answerString,
        passed,
        points,
        maxPoints: question.weight,
        recommendation,
      });

      if (recommendation) {
        recommendations.push(recommendation);
      }
    }

    // Calculate final score as percentage
    const score = maxPoints > 0 ? Math.round((totalPoints / maxPoints) * 100) : 0;

    // Determine eligibility level
    let eligibilityLevel: "high" | "medium" | "low";
    if (score >= 75) {
      eligibilityLevel = "high";
    } else if (score >= 50) {
      eligibilityLevel = "medium";
    } else {
      eligibilityLevel = "low";
    }

    // Add summary recommendations based on level
    if (eligibilityLevel === "low") {
      recommendations.unshift(
        "Your eligibility score is low. We recommend consulting with an immigration agent before applying."
      );
    } else if (eligibilityLevel === "medium") {
      recommendations.unshift(
        "You may be eligible, but address the items below to strengthen your application."
      );
    } else {
      recommendations.unshift(
        "You have a strong eligibility profile for this visa!"
      );
    }

    return {
      score,
      eligibilityLevel,
      breakdown,
      recommendations,
      missingRequirements,
    };
  }

  private formatAnswer(value: unknown): string {
    if (value === undefined || value === null) return "Not answered";
    if (typeof value === "boolean") return value ? "Yes" : "No";
    if (Array.isArray(value)) return value.join(", ");
    return String(value);
  }

  private getRecommendation(
    question: EligibilityQuestion,
    answer: unknown
  ): string {
    // Check for custom recommendation in question description
    if (question.description) {
      return question.description;
    }

    // Generate based on question ID patterns
    const id = question.id.toLowerCase();

    if (id.includes("passport")) {
      if (id.includes("validity")) {
        return `Passport validity of ${answer} months may not be sufficient. Most countries require at least 6 months validity.`;
      }
      return "A valid passport is required for all visa applications.";
    }

    if (id.includes("denial") || id.includes("denied")) {
      return "Previous visa denials may affect your application. Be prepared to explain the circumstances and provide additional documentation.";
    }

    if (id.includes("criminal")) {
      return "Criminal history may affect eligibility. Consider consulting an immigration lawyer for guidance.";
    }

    if (id.includes("job") || id.includes("offer")) {
      return "A valid job offer is typically required for work visas. Consider securing employment before applying.";
    }

    if (id.includes("admission") || id.includes("enrollment")) {
      return "An admission letter from a recognized institution is required for student visas.";
    }

    if (id.includes("fund") || id.includes("financial")) {
      return "Prepare bank statements or sponsorship documents to demonstrate financial capability.";
    }

    if (id.includes("ties")) {
      return "Strong ties to your home country (employment, property, family) help demonstrate intent to return.";
    }

    return "This requirement may need additional attention before applying.";
  }

  /**
   * Get user's eligibility check history
   */
  async getUserChecks(userId: string): Promise<EligibilityCheck[]> {
    const snapshot = await this.checksCollection
      .where("userId", "==", userId)
      .orderBy("createdAt", "desc")
      .limit(20)
      .get();

    return snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    })) as EligibilityCheck[];
  }

  /**
   * Get a specific eligibility check
   */
  async getCheckById(checkId: string): Promise<EligibilityCheck | null> {
    const doc = await this.checksCollection.doc(checkId).get();
    if (!doc.exists) return null;

    return {
      id: doc.id,
      ...doc.data(),
    } as EligibilityCheck;
  }

  /**
   * Get latest check for a user and visa type
   */
  async getLatestCheck(
    userId: string,
    visaTypeId: string
  ): Promise<EligibilityCheck | null> {
    const snapshot = await this.checksCollection
      .where("userId", "==", userId)
      .where("visaTypeId", "==", visaTypeId)
      .orderBy("createdAt", "desc")
      .limit(1)
      .get();

    if (snapshot.empty) return null;

    const doc = snapshot.docs[0];
    return {
      id: doc.id,
      ...doc.data(),
    } as EligibilityCheck;
  }
}

export const eligibilityService = new EligibilityService();
