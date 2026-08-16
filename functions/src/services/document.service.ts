import { getFirestore, Timestamp, FieldValue } from "firebase-admin/firestore";
import {
  Document,
  DocumentStatus,
  DocumentUploaderRole,
  DocumentUploadSource,
} from "../types";
import { storageService } from "./storage.service";
import { noteService } from "./note.service";
import { userService } from "./user.service";

const db = getFirestore();

export interface CreateDocumentInput {
  applicationId: string;
  requirementId: string;
  fileName: string;
  fileType: string;
  fileSizeMb: number;
  storagePath: string;

  // Optional descriptive metadata. Self-serve client uploads send none of this;
  // the agency-side "upload for client" form collects all of it.
  documentType?: string;
  displayName?: string;
  description?: string;
  uploadReason?: string;
  uploadSource?: DocumentUploadSource;
}

/**
 * Who is performing an upload, and whether they've been cleared to do it for
 * someone else.
 *
 * WHY THIS EXISTS: these methods used to authorize by comparing the caller's uid
 * to `application.userId`, which made it structurally impossible for an agent to
 * upload a document for their own client. Authorization now happens in the
 * controller against the shared CASL ability (which already understands assigned
 * agents, agency owners and admins), and the verdict is passed down here as
 * `onBehalfAuthorized`. The service still refuses cross-client uploads from an
 * unauthorized caller, so it is not merely trusting its input.
 */
export interface UploadActor {
  /** The caller's uid. */
  userId: string;
  /** The caller's role, recorded on the document for audit. */
  role: DocumentUploaderRole;
  /** Denormalized display name, recorded on the document for audit. */
  name?: string;
  /**
   * Set by the controller when CASL says this caller may act on the
   * application (assigned agent / agency owner / admin). Without it, a caller
   * who is not the application's client is rejected.
   */
  onBehalfAuthorized?: boolean;
}

export interface UpdateDocumentStatusInput {
  status: DocumentStatus;
  rejectionReason?: string;
  agentComments?: string;
}

export class DocumentService {
  private collection = db.collection("documents");

  /**
   * Load an application and confirm `actor` may attach documents to it.
   *
   * Returns the application's data (notably `userId` — the client who will own
   * the document, and whose storage folder it lands in) so callers don't fetch
   * it twice.
   */
  private async resolveUploadTarget(
    applicationId: string,
    actor: UploadActor
  ): Promise<{ ownerUserId: string; agentId?: string; clientName?: string }> {
    const application = await db.collection("applications").doc(applicationId).get();

    if (!application.exists) {
      throw new Error("Application not found");
    }

    const applicationData = application.data() ?? {};
    const ownerUserId: string = applicationData.userId;

    // The client themselves always passes. Anyone else needs the controller to
    // have cleared them via CASL.
    const isOwner = ownerUserId === actor.userId;
    if (!isOwner && !actor.onBehalfAuthorized) {
      throw new Error("Unauthorized");
    }

    return {
      ownerUserId,
      agentId: applicationData.agentId,
      clientName: applicationData.clientName,
    };
  }

  /**
   * Get upload URL for a new document.
   *
   * The storage path is keyed to the application's CLIENT, never the caller, so
   * an agent-uploaded file lives alongside the client's own documents rather
   * than in a staff folder. For self-uploads the two are the same uid, so this
   * is a no-op change for existing clients.
   */
  async getUploadUrl(
    actor: UploadActor,
    applicationId: string,
    fileName: string,
    contentType: string
  ): Promise<{
    uploadUrl: string;
    storagePath: string;
    expiresAt: Date;
  }> {
    const { ownerUserId } = await this.resolveUploadTarget(applicationId, actor);

    return storageService.getSignedUploadUrl(
      ownerUserId,
      applicationId,
      fileName,
      contentType
    );
  }

  /**
   * Register a document after successful upload.
   *
   * Ownership (`userId`) goes to the client; authorship (`uploadedBy*`) goes to
   * whoever actually uploaded. When those differ the document is flagged
   * `uploadedOnBehalf` and an activity note is recorded on the case, so the
   * audit trail shows both who submitted the file and why.
   */
  async createDocument(
    actor: UploadActor,
    input: CreateDocumentInput
  ): Promise<Document> {
    const {
      applicationId,
      requirementId,
      fileName,
      fileType,
      fileSizeMb,
      storagePath,
      documentType,
      displayName,
      description,
      uploadReason,
      uploadSource,
    } = input;

    const applicationRef = db.collection("applications").doc(applicationId);
    const { ownerUserId } = await this.resolveUploadTarget(applicationId, actor);

    // Verify the file exists in storage
    const fileExists = await storageService.fileExists(storagePath);
    if (!fileExists) {
      throw new Error("File not found in storage");
    }

    // Staff uploading for a client must say why — this is the whole point of the
    // audit trail, so it is enforced here rather than left to the form.
    const uploadedOnBehalf = ownerUserId !== actor.userId;
    if (uploadedOnBehalf && !uploadReason?.trim()) {
      throw new Error("Upload reason required");
    }

    // Create the document record
    const now = Timestamp.now();
    const docRef = this.collection.doc();

    const document: Omit<Document, "id"> = {
      applicationId,
      requirementId,
      // Ownership stays with the client even when staff uploaded the file.
      userId: ownerUserId,
      fileName,
      fileType,
      fileSizeMb,
      storageUrl: storagePath,
      status: "uploaded",
      resubmissionCount: 0,
      uploadedAt: now,
      updatedAt: now,

      // Provenance — always recorded, including for self-uploads, so newer
      // documents never need the "missing means self-upload" fallback.
      uploadedByUserId: actor.userId,
      uploadedByRole: actor.role,
      uploadedOnBehalf,

      // Firestore rejects `undefined`, so optional fields are spread in only
      // when actually supplied.
      ...(actor.name?.trim() ? { uploadedByName: actor.name.trim() } : {}),
      ...(documentType?.trim() ? { documentType: documentType.trim() } : {}),
      ...(displayName?.trim() ? { displayName: displayName.trim() } : {}),
      ...(description?.trim() ? { description: description.trim() } : {}),
      ...(uploadReason?.trim() ? { uploadReason: uploadReason.trim() } : {}),
      ...(uploadSource ? { uploadSource } : {}),
    };

    await docRef.set(document);

    // Update application document counts
    await applicationRef.update({
      documentsUploaded: FieldValue.increment(1),
      updatedAt: now,
      lastUpdated: now,
    });

    // Record the on-behalf upload in the case's activity feed. Best-effort —
    // `addActivityNote` swallows its own errors and must never fail an upload
    // that already succeeded.
    if (uploadedOnBehalf) {
      const label = displayName?.trim() || documentType?.trim() || fileName;
      const by = actor.name?.trim() || "An agent";
      await noteService.addActivityNote(
        applicationId,
        `${by} uploaded document "${label}" on the client's behalf.` +
          (uploadReason?.trim() ? ` Reason: ${uploadReason.trim()}` : "") +
          (uploadSource ? ` Received via: ${uploadSource.replace(/_/g, " ")}.` : ""),
        { id: actor.userId, name: actor.name }
      );
    }

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

    // Record an activity note on the case capturing this review action so the
    // notes feed reflects document approvals/rejections/resubmission requests.
    // Best-effort (never blocks the review).
    const docName = document.fileName || "document";
    // Attribute the review to the reviewing agent.
    const reviewerName = await userService.getDisplayName(reviewerId);
    const by = reviewerName || "An agent";
    const activityByStatus: Partial<Record<DocumentStatus, string>> = {
      verified: `${by} approved document "${docName}".`,
      rejected:
        `${by} rejected document "${docName}".` +
        (input.rejectionReason ? ` Reason: ${input.rejectionReason}` : ""),
      resubmission_required: `${by} requested resubmission of document "${docName}".`,
      under_review: `${by} marked document "${docName}" as under review.`,
    };
    const activityContent = activityByStatus[input.status];
    if (activityContent) {
      await noteService.addActivityNote(document.applicationId, activityContent, {
        id: reviewerId,
        name: reviewerName,
      });
    }

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

    // Deletion is keyed to AUTHORSHIP, not ownership: whoever uploaded the file
    // may remove it. This matters now that staff can upload for a client — a
    // client must not be able to delete evidence an agent filed on their case,
    // and an agent must be able to undo their own mistaken upload. Documents
    // predating the provenance fields have no `uploadedByUserId`, so they fall
    // back to `userId` and behave exactly as before.
    const uploaderId = document.uploadedByUserId || document.userId;
    if (uploaderId !== userId) {
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
   * Get download URL for a document.
   *
   * @param authorizedOverride Set by the controller when CASL has already
   *   cleared the caller for this application. Needed because the local checks
   *   below only know about the document owner and the *assigned* agent — an
   *   agency owner or admin (who can now upload here) would otherwise be denied
   *   access to the very file they just added.
   */
  async getDownloadUrl(
    documentId: string,
    userId: string,
    authorizedOverride = false
  ): Promise<string> {
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

    if (!isOwner && !isAgent && !authorizedOverride) {
      throw new Error("Unauthorized");
    }

    return storageService.getSignedDownloadUrl(document.storageUrl);
  }
}

export const documentService = new DocumentService();
