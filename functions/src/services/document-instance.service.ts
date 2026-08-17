/**
 * Document instance service — editable documents cloned from templates.
 *
 * Responsibilities:
 *   - clone a template into a new editable instance (+ its first version snapshot)
 *   - list instances by scope (agent / agency / application / all)
 *   - save with OPTIMISTIC CONCURRENCY: the client sends the version it holds;
 *     a stale version yields a conflict instead of silently clobbering a peer's
 *     edit. Each successful save also writes an immutable version snapshot.
 *   - link/unlink to an application, toggle share-with-client, delete
 *   - list version history
 *
 * Like the template service, list queries use a SINGLE equality filter and sort
 * in memory, so no composite Firestore indexes are required.
 */
import { collections, subcollections, db } from "../utils/firebase";
import {
  DocumentInstance,
  DocumentInstanceStatus,
  DocumentShareStatus,
  DocumentTemplate,
  DocumentVersion,
  ProseMirrorDoc,
} from "../types";
import { Timestamp } from "firebase-admin/firestore";

// Inputs for cloning a template into a new instance.
export interface CloneInput {
  template: DocumentTemplate; // the resolved source template (content required)
  title: string;
  createdBy: string; // authoring agent's userId
  createdByName?: string; // denormalized display name
  agencyId?: string | null; // owning agency (null for independent agents)
  applicationId?: string | null; // optional link at creation time
}

// Inputs for a save (PUT). `expectedVersion` is the version the editor last
// loaded — the optimistic-concurrency token.
export interface SaveInput {
  content: ProseMirrorDoc;
  expectedVersion: number;
  title?: string;
  editorName?: string; // denormalized name of who is saving
}

// Discriminated result of a save so the controller can map to 200 / 409 / 404
// without leaking Firestore details.
export type SaveResult =
  | { status: "ok"; instance: DocumentInstance }
  | { status: "conflict"; current: DocumentInstance }
  | { status: "notFound" };

class DocumentInstanceService {
  // ============================================
  // READS
  // ============================================

  /** Get a single instance by id (includes content). */
  async getById(id: string): Promise<DocumentInstance | null> {
    const doc = await collections.documentInstances.doc(id).get();
    if (!doc.exists) return null;
    return doc.data() as DocumentInstance;
  }

  /** Instances authored by a specific agent (their "My Documents"). */
  async listForAgent(agentUserId: string): Promise<DocumentInstance[]> {
    const snap = await collections.documentInstances
      .where("createdBy", "==", agentUserId)
      .get();
    return this.sortStripped(snap);
  }

  /** Every instance owned by an agency (owner view). */
  async listForAgency(agencyId: string): Promise<DocumentInstance[]> {
    const snap = await collections.documentInstances
      .where("agencyId", "==", agencyId)
      .get();
    return this.sortStripped(snap);
  }

  /** Instances linked to a specific application (case-detail view). */
  async listForApplication(applicationId: string): Promise<DocumentInstance[]> {
    const snap = await collections.documentInstances
      .where("applicationId", "==", applicationId)
      .get();
    return this.sortStripped(snap);
  }

  /**
   * Instances linked to an application AND actually shared with its client.
   *
   * The client-facing counterpart of `listForApplication`. Sharing is a per-
   * document decision an agent makes (`PATCH /:id/share`), so a draft an agent is
   * still working on must never appear here — `shareStatus` is filtered in memory
   * to keep the query to the single equality filter this service standardises on.
   */
  async listSharedForApplication(
    applicationId: string
  ): Promise<DocumentInstance[]> {
    const snap = await collections.documentInstances
      .where("applicationId", "==", applicationId)
      .get();
    return this.sortStripped(snap).filter((i) => i.shareStatus === "shared");
  }

  /** All instances (admin only). */
  async listAll(): Promise<DocumentInstance[]> {
    const snap = await collections.documentInstances.get();
    return this.sortStripped(snap);
  }

  /**
   * Version history for an instance, newest first. Content is returned so the
   * editor can preview/restore a prior version.
   */
  async listVersions(instanceId: string): Promise<DocumentVersion[]> {
    const snap = await subcollections.documentVersions(instanceId).get();
    return snap.docs
      .map((d) => d.data() as DocumentVersion)
      .sort((a, b) => b.version - a.version);
  }

  // ============================================
  // WRITES
  // ============================================

  /**
   * Clone a template into a new editable instance. Copies the template's content
   * and schemaVersion, starts at version 1, and writes the first version
   * snapshot so history is complete from creation.
   */
  async clone(input: CloneInput): Promise<DocumentInstance> {
    const now = Timestamp.now();
    const ref = collections.documentInstances.doc();

    const instance: DocumentInstance = {
      id: ref.id,
      title: input.title,
      templateId: input.template.id,
      // Only set agencyId when the agent belongs to one (independent agents
      // rely on the `createdBy`/agentId ownership rule instead).
      agencyId: input.agencyId ?? undefined,
      createdBy: input.createdBy,
      applicationId: input.applicationId ?? null,
      status: "draft",
      shareStatus: "private",
      version: 1,
      schemaVersion: input.template.schemaVersion,
      // A cloned doc starts as a copy of the template body (fallback to an empty
      // ProseMirror doc if the template somehow has none).
      content: input.template.content ?? { type: "doc" },
      createdByName: input.createdByName,
      updatedByName: input.createdByName,
      createdAt: now,
      updatedAt: now,
    };

    // Write the instance and its first version snapshot together.
    const batch = db.batch();
    batch.set(ref, instance);
    const versionRef = subcollections.documentVersions(ref.id).doc();
    batch.set(
      versionRef,
      this.buildVersion(versionRef.id, ref.id, 1, instance.content, input.createdByName, now)
    );
    await batch.commit();

    return instance;
  }

  /**
   * Save new content with optimistic concurrency. Runs in a transaction so the
   * version check and the write are atomic against concurrent saves. On success
   * increments the version and appends a version snapshot.
   */
  async save(id: string, input: SaveInput): Promise<SaveResult> {
    const ref = collections.documentInstances.doc(id);

    return db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return { status: "notFound" as const };

      const current = snap.data() as DocumentInstance;

      // Stale write — the doc moved on since the editor loaded it. Return the
      // current state so the caller can surface "edited by X (version N)".
      if (current.version !== input.expectedVersion) {
        return { status: "conflict" as const, current };
      }

      const now = Timestamp.now();
      const nextVersion = current.version + 1;

      const updated: DocumentInstance = {
        ...current,
        content: input.content,
        // Title is optional on save; only overwrite when provided.
        title: input.title ?? current.title,
        version: nextVersion,
        updatedByName: input.editorName ?? current.updatedByName,
        updatedAt: now,
      };

      tx.set(ref, updated);
      // Immutable snapshot of the newly-saved content.
      const versionRef = subcollections.documentVersions(id).doc();
      tx.set(
        versionRef,
        this.buildVersion(versionRef.id, id, nextVersion, input.content, input.editorName, now)
      );

      return { status: "ok" as const, instance: updated };
    });
  }

  /**
   * Link (or unlink, when `applicationId` is null) an instance to an application.
   * Access to the target application is validated by the controller before this
   * is called.
   */
  async setApplication(
    id: string,
    applicationId: string | null
  ): Promise<DocumentInstance | null> {
    const ref = collections.documentInstances.doc(id);
    const doc = await ref.get();
    if (!doc.exists) return null;

    await ref.update({ applicationId, updatedAt: Timestamp.now() });
    const updated = await ref.get();
    return updated.data() as DocumentInstance;
  }

  /** Toggle whether the linked mobile client can see the instance. */
  async setShareStatus(
    id: string,
    shareStatus: DocumentShareStatus
  ): Promise<DocumentInstance | null> {
    const ref = collections.documentInstances.doc(id);
    const doc = await ref.get();
    if (!doc.exists) return null;

    await ref.update({ shareStatus, updatedAt: Timestamp.now() });
    const updated = await ref.get();
    return updated.data() as DocumentInstance;
  }

  /** Update the draft/final lifecycle status. */
  async setStatus(
    id: string,
    status: DocumentInstanceStatus
  ): Promise<DocumentInstance | null> {
    const ref = collections.documentInstances.doc(id);
    const doc = await ref.get();
    if (!doc.exists) return null;

    await ref.update({ status, updatedAt: Timestamp.now() });
    const updated = await ref.get();
    return updated.data() as DocumentInstance;
  }

  /**
   * Delete an instance and all its version snapshots. Firestore doesn't cascade
   * subcollection deletes, so we remove versions explicitly.
   */
  async delete(id: string): Promise<boolean> {
    const ref = collections.documentInstances.doc(id);
    const doc = await ref.get();
    if (!doc.exists) return false;

    const versions = await subcollections.documentVersions(id).get();
    const batch = db.batch();
    versions.docs.forEach((v) => batch.delete(v.ref));
    batch.delete(ref);
    await batch.commit();
    return true;
  }

  // ============================================
  // HELPERS
  // ============================================

  /** Sort a snapshot newest-first and strip content for list responses. */
  private sortStripped(
    snap: FirebaseFirestore.QuerySnapshot
  ): DocumentInstance[] {
    return snap.docs
      .map((d) => d.data() as DocumentInstance)
      .sort((a, b) => b.updatedAt.toMillis() - a.updatedAt.toMillis())
      .map(({ content: _content, ...rest }) => rest);
  }

  /**
   * Build a version snapshot document for the versions subcollection. `versionId`
   * is the caller-allocated Firestore doc id so the stored `id` matches its path.
   */
  private buildVersion(
    versionId: string,
    instanceId: string,
    version: number,
    content: ProseMirrorDoc | undefined,
    updatedByName: string | undefined,
    createdAt: Timestamp
  ): DocumentVersion {
    return {
      id: versionId,
      instanceId,
      version,
      updatedByName,
      content,
      createdAt,
    };
  }
}

export const documentInstanceService = new DocumentInstanceService();
