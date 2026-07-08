import { getStorage } from "firebase-admin/storage";
import { randomUUID } from "crypto";

// Service that brokers all Cloud Storage access for the backend.
// File uploads are NOT proxied through Cloud Functions; instead, this service
// mints short-lived v4 signed URLs that clients use to PUT/GET objects directly.
export class StorageService {
  // Resolve the default bucket for the active Firebase project.
  //
  // Passing no name to `.bucket()` makes firebase-admin use the `storageBucket`
  // option that was supplied to `initializeApp()` — which, in turn, is auto-populated
  // from the `FIREBASE_CONFIG` env var that the Cloud Functions runtime and the
  // Firebase emulator both set for us. That means the bucket id is always derived
  // from `.firebaserc` / the project the function was deployed to, instead of being
  // hardcoded in source. This avoids the previous bug where a stale hardcoded
  // fallback (`japa-app.appspot.com`) silently pointed at a non-existent bucket.
  //
  // To override for a non-default bucket (e.g. a staging-only bucket), pass
  // `storageBucket` explicitly to `admin.initializeApp()` in utils/firebase.ts.
  private bucket = getStorage().bucket();

  /**
   * Generate a signed upload URL for direct client upload
   */
  async getSignedUploadUrl(
    userId: string,
    applicationId: string,
    fileName: string,
    contentType: string
  ): Promise<{
    uploadUrl: string;
    storagePath: string;
    expiresAt: Date;
  }> {
    const fileId = randomUUID();
    const sanitizedFileName = fileName.replace(/[^a-zA-Z0-9.-]/g, "_");
    const storagePath = `documents/${userId}/${applicationId}/${fileId}_${sanitizedFileName}`;

    const file = this.bucket.file(storagePath);

    // Generate signed URL valid for 15 minutes
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

    const [uploadUrl] = await file.getSignedUrl({
      version: "v4",
      action: "write",
      expires: expiresAt,
      contentType,
    });

    return {
      uploadUrl,
      storagePath,
      expiresAt,
    };
  }

  /**
   * Generate a signed upload URL for agent verification documents
   */
  async getSignedVerificationUploadUrl(
    userId: string,
    fileName: string,
    contentType: string
  ): Promise<{
    uploadUrl: string;
    storagePath: string;
    expiresAt: Date;
  }> {
    const fileId = randomUUID();
    const sanitizedFileName = fileName.replace(/[^a-zA-Z0-9.-]/g, "_");
    const storagePath = `verification/${userId}/${fileId}_${sanitizedFileName}`;

    const file = this.bucket.file(storagePath);

    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

    const [uploadUrl] = await file.getSignedUrl({
      version: "v4",
      action: "write",
      expires: expiresAt,
      contentType,
    });

    return {
      uploadUrl,
      storagePath,
      expiresAt,
    };
  }

  /**
   * Generate a signed upload URL for an agency compliance document (KYC/KYB).
   *
   * Objects are namespaced per-agency AND per-slot (e.g. "idDocument",
   * "cacDocument") so each required document lives at a predictable, isolated
   * path and re-uploading a slot doesn't collide with other slots. Mirrors the
   * verification-document flow: client PUTs directly to this short-lived URL,
   * then calls the register endpoint which records the path against the slot.
   */
  async getSignedComplianceUploadUrl(
    agencyId: string,
    slot: string,
    fileName: string,
    contentType: string
  ): Promise<{
    uploadUrl: string;
    storagePath: string;
    expiresAt: Date;
  }> {
    const fileId = randomUUID();
    const sanitizedSlot = slot.replace(/[^a-zA-Z0-9_-]/g, "_");
    const sanitizedFileName = fileName.replace(/[^a-zA-Z0-9.-]/g, "_");
    const storagePath = `compliance/${agencyId}/${sanitizedSlot}/${fileId}_${sanitizedFileName}`;

    const file = this.bucket.file(storagePath);

    // Short-lived (15 min) write URL — only enough time to complete the upload.
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

    const [uploadUrl] = await file.getSignedUrl({
      version: "v4",
      action: "write",
      expires: expiresAt,
      contentType,
    });

    return {
      uploadUrl,
      storagePath,
      expiresAt,
    };
  }

  /**
   * Generate a signed upload URL for an agency's white-label logo.
   *
   * Stored under a per-agency prefix so logos are easy to scope/clean up and
   * never collide across agencies. Mirrors the verification-document flow:
   * the client PUTs the file directly to this short-lived URL, then calls the
   * register endpoint which makes the object public and persists the URL.
   */
  async getSignedAgencyLogoUploadUrl(
    agencyId: string,
    fileName: string,
    contentType: string
  ): Promise<{
    uploadUrl: string;
    storagePath: string;
    expiresAt: Date;
  }> {
    const fileId = randomUUID();
    const sanitizedFileName = fileName.replace(/[^a-zA-Z0-9.-]/g, "_");
    const storagePath = `agency-logos/${agencyId}/${fileId}_${sanitizedFileName}`;

    const file = this.bucket.file(storagePath);

    // Short-lived (15 min) write URL — only enough time to complete the upload.
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

    const [uploadUrl] = await file.getSignedUrl({
      version: "v4",
      action: "write",
      expires: expiresAt,
      contentType,
    });

    return {
      uploadUrl,
      storagePath,
      expiresAt,
    };
  }

  /**
   * Generate a signed upload URL for a user's profile photo (avatar).
   *
   * Mirrors the agency-logo flow: the client PUTs the image directly to this
   * short-lived URL, then calls the register endpoint which makes the object
   * public and persists the durable URL onto the user's profile.
   *
   * Stored under `users/{userId}/profile/…` — the location the storage.rules
   * already scope to the owner (public read), keeping the object path consistent
   * with the rest of the project.
   */
  async getSignedProfilePhotoUploadUrl(
    userId: string,
    fileName: string,
    contentType: string
  ): Promise<{
    uploadUrl: string;
    storagePath: string;
    expiresAt: Date;
  }> {
    const fileId = randomUUID();
    const sanitizedFileName = fileName.replace(/[^a-zA-Z0-9.-]/g, "_");
    const storagePath = `users/${userId}/profile/${fileId}_${sanitizedFileName}`;

    const file = this.bucket.file(storagePath);

    // Short-lived (15 min) write URL — only enough time to complete the upload.
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

    const [uploadUrl] = await file.getSignedUrl({
      version: "v4",
      action: "write",
      expires: expiresAt,
      contentType,
    });

    return {
      uploadUrl,
      storagePath,
      expiresAt,
    };
  }

  /**
   * Mint a durable, publicly-fetchable download URL for an uploaded object.
   *
   * Agency logos are rendered persistently in the portal chrome (sidebar) on
   * every page load, so a short-lived signed download URL is unsuitable — it
   * would expire (v4 signed URLs cap at 7 days).
   *
   * We deliberately do NOT use `file.makePublic()`: that sets per-object ACLs,
   * which throw on buckets with uniform bucket-level access (UBLA) enabled —
   * the default for newer Firebase Storage buckets. Instead we attach a
   * `firebaseStorageDownloadTokens` value to the object's metadata and return
   * the canonical Firebase download URL. This token-based URL works regardless
   * of UBLA, never expires, and is the standard Firebase download mechanism.
   */
  async makeFilePublic(storagePath: string): Promise<string> {
    const file = this.bucket.file(storagePath);

    // A random token gates access; anyone with the URL can read the object,
    // which is exactly what we want for a public logo.
    const token = randomUUID();
    await file.setMetadata({
      metadata: { firebaseStorageDownloadTokens: token },
    });

    // Firebase download URL: the object path is percent-encoded as a single
    // path segment (slashes become %2F).
    const encodedPath = encodeURIComponent(storagePath);
    return `https://firebasestorage.googleapis.com/v0/b/${this.bucket.name}/o/${encodedPath}?alt=media&token=${token}`;
  }

  /**
   * Generate a signed download URL for a file
   */
  async getSignedDownloadUrl(
    storagePath: string,
    expirationMinutes = 60
  ): Promise<string> {
    const file = this.bucket.file(storagePath);

    const [downloadUrl] = await file.getSignedUrl({
      version: "v4",
      action: "read",
      expires: Date.now() + expirationMinutes * 60 * 1000,
    });

    return downloadUrl;
  }

  /**
   * Delete a file from storage
   */
  async deleteFile(storagePath: string): Promise<void> {
    const file = this.bucket.file(storagePath);
    await file.delete({ ignoreNotFound: true });
  }

  /**
   * Check if a file exists
   */
  async fileExists(storagePath: string): Promise<boolean> {
    const file = this.bucket.file(storagePath);
    const [exists] = await file.exists();
    return exists;
  }

  /**
   * Get file metadata
   */
  async getFileMetadata(storagePath: string): Promise<{
    size: number;
    contentType: string;
    created: Date;
  } | null> {
    const file = this.bucket.file(storagePath);
    const [exists] = await file.exists();

    if (!exists) {
      return null;
    }

    const [metadata] = await file.getMetadata();

    return {
      size: parseInt(metadata.size as string, 10),
      contentType: metadata.contentType as string,
      created: new Date(metadata.timeCreated as string),
    };
  }
}

export const storageService = new StorageService();
