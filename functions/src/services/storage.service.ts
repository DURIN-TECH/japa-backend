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
