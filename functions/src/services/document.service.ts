import { getFirestore, Timestamp, FieldValue } from "firebase-admin/firestore";
import { Document, DocumentStatus } from "../types";
import { storageService } from "./storage.service";

const db = getFirestore();

export interface CreateDocumentInput {
  applicationId: string;
  requirementId: string;
  fileName: string;
  fileType: string;
  fileSizeMb: number;
  storagePath: string;
}

export interface UpdateDocumentStatusInput {
  status: DocumentStatus;
  rejectionReason?: string;
  agentComments?: string;
}

export class DocumentService {
  private collection = db.collection("documents");

  /**
   * Get upload URL for a new document
   */
  async getUploadUrl(
    userId: string,
    applicationId: string,
    fileName: string,
    contentType: string
  ): Promise<{
    uploadUrl: string;
    storagePath: string;
    expiresAt: Date;
  }> {
    // Verify the application belongs to the user
    const applicationRef = db.collection("applications").doc(applicationId);
    const application = await applicationRef.get();

    if (!application.exists) {
      throw new Error("Application not found");
    }

    const applicationData = application.data();
    if (applicationData?.userId !== userId) {
      throw new Error("Unauthorized");
    }

    return storageService.getSignedUploadUrl(
      userId,
      applicationId,
      fileName,
      contentType
    );
  }

  /**
   * Register a document after successful upload
   */
  async createDocument(
    userId: string,
    input: CreateDocumentInput
  ): Promise<Document> {
    const { applicationId, requirementId, fileName, fileType, fileSizeMb, storagePath } = input;

    // Verify the application belongs to the user
    const applicationRef = db.collection("applications").doc(applicationId);
    const application = await applicationRef.get();

    if (!application.exists) {
      throw new Error("Application not found");
    }

    const applicationData = application.data();
    if (applicationData?.userId !== userId) {
      throw new Error("Unauthorized");
    }

    // Verify the file exists in storage
    const fileExists = await storageService.fileExists(storagePath);
    if (!fileExists) {
      throw new Error("File not found in storage");
    }

    // Create the document record
    const now = Timestamp.now();
    const docRef = this.collection.doc();

    const document: Omit<Document, "id"> = {
      applicationId,
      requirementId,
      userId,
      fileName,
      fileType,
      fileSizeMb,
      storageUrl: storagePath,
      status: "uploaded",
      resubmissionCount: 0,
      uploadedAt: now,
      updatedAt: now,
    };

    await docRef.set(document);

    // Update application document counts
    await applicationRef.update({
      documentsUploaded: FieldValue.increment(1),
      updatedAt: now,
      lastUpdated: now,
    });

    return {
      id: docRef.id,
      ...document,
    } as Document;
  }

  /**
   * Get a document by ID
   */
  async getDocumentById(documentId: string): Promise<Document | null> {
    const docSnap = await this.collection.doc(documentId).get();

    if (!docSnap.exists) {
      return null;
    }

    return {
      id: docSnap.id,
      ...docSnap.data(),
    } as Document;
  }

  /**
   * Get all documents for an application
   */
  async getApplicationDocuments(applicationId: string): Promise<Document[]> {
    const snapshot = await this.collection
      .where("applicationId", "==", applicationId)
      .orderBy("uploadedAt", "desc")
      .get();

    return snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    })) as Document[];
  }

  /**
   * Get documents for a specific requirement
   */
  async getRequirementDocuments(
    applicationId: string,
    requirementId: string
  ): Promise<Document[]> {
    const snapshot = await this.collection
      .where("applicationId", "==", applicationId)
      .where("requirementId", "==", requirementId)
      .orderBy("uploadedAt", "desc")
      .get();

    return snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    })) as Document[];
  }

  /**
   * Update document status (for agents/admins)
   */
  async updateDocumentStatus(
    documentId: string,
    reviewerId: string,
    input: UpdateDocumentStatusInput
  ): Promise<Document> {
    const docRef = this.collection.doc(documentId);
    const docSnap = await docRef.get();

    if (!docSnap.exists) {
      throw new Error("Document not found");
    }

    const document = docSnap.data() as Document;
    const now = Timestamp.now();

    const updateData: Partial<Document> = {
      status: input.status,
      reviewedBy: reviewerId,
      reviewedAt: now,
      updatedAt: now,
    };

    if (input.rejectionReason) {
      updateData.rejectionReason = input.rejectionReason;
    }

    if (input.agentComments) {
      updateData.agentComments = input.agentComments;
    }

    // If rejected, increment resubmission count
    if (input.status === "rejected" || input.status === "resubmission_required") {
      updateData.resubmissionCount = (document.resubmissionCount || 0) + 1;
    }

    await docRef.update(updateData);

    // Update application document counts based on new status
    const applicationRef = db.collection("applications").doc(document.applicationId);
    const countUpdates: Record<string, FieldValue> = {
      updatedAt: now as unknown as FieldValue,
      lastUpdated: now as unknown as FieldValue,
    };

    if (input.status === "verified") {
      countUpdates.documentsVerified = FieldValue.increment(1);
    } else if (input.status === "rejected" || input.status === "resubmission_required") {
      countUpdates.documentsRejected = FieldValue.increment(1);
    }

    await applicationRef.update(countUpdates);

    return {
      ...document,
      ...updateData,
      id: documentId,
    } as Document;
  }

  /**
   * Delete a document
   */
  async deleteDocument(documentId: string, userId: string): Promise<void> {
    const docRef = this.collection.doc(documentId);
    const docSnap = await docRef.get();

    if (!docSnap.exists) {
      throw new Error("Document not found");
    }

    const document = docSnap.data() as Document;

    // Verify ownership
    if (document.userId !== userId) {
      throw new Error("Unauthorized");
    }

    // Only allow deletion of pending/uploaded documents
    if (!["pending_upload", "uploaded", "rejected", "resubmission_required"].includes(document.status)) {
      throw new Error("Cannot delete document in current status");
    }

    // Delete from storage
    await storageService.deleteFile(document.storageUrl);

    // Delete the document record
    await docRef.delete();

    // Update application document counts
    const applicationRef = db.collection("applications").doc(document.applicationId);
    const countUpdates: Record<string, FieldValue | Timestamp> = {
      documentsUploaded: FieldValue.increment(-1),
      updatedAt: Timestamp.now(),
      lastUpdated: Timestamp.now(),
    };

    if (document.status === "rejected" || document.status === "resubmission_required") {
      countUpdates.documentsRejected = FieldValue.increment(-1);
    }

    await applicationRef.update(countUpdates);
  }

  /**
   * Get download URL for a document
   */
  async getDownloadUrl(documentId: string, userId: string): Promise<string> {
    const docSnap = await this.collection.doc(documentId).get();

    if (!docSnap.exists) {
      throw new Error("Document not found");
    }

    const document = docSnap.data() as Document;

    // Verify user has access (owner or agent of the application)
    const applicationRef = db.collection("applications").doc(document.applicationId);
    const application = await applicationRef.get();
    const applicationData = application.data();

    const isOwner = document.userId === userId;
    const isAgent = applicationData?.agentId === userId;

    if (!isOwner && !isAgent) {
      throw new Error("Unauthorized");
    }

    return storageService.getSignedDownloadUrl(document.storageUrl);
  }
}

export const documentService = new DocumentService();
