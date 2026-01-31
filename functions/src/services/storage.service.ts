import { getStorage } from "firebase-admin/storage";
import { v4 as uuidv4 } from "uuid";

const BUCKET_NAME = process.env.FIREBASE_STORAGE_BUCKET || "japa-app.appspot.com";

export class StorageService {
  private bucket = getStorage().bucket(BUCKET_NAME);

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
    const fileId = uuidv4();
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
