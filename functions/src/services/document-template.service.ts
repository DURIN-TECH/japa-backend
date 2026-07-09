/**
 * Document template service — read access to the clonable template catalog.
 *
 * Templates come in two scopes:
 *   - "global": authored by Seli, visible to everyone.
 *   - "agency": authored by an agency, visible only within that agency.
 *
 * There is no write path yet (the portal only clones templates, it doesn't
 * author them), so this service is read-only. Queries deliberately use a SINGLE
 * equality filter each (no composite `where` + `orderBy`) so Firestore's
 * automatic single-field indexes suffice — sorting/searching happens in memory,
 * which is fine for the modest catalog size the portal assumes.
 */
import { collections } from "../utils/firebase";
import {
  DocumentTemplate,
  ProseMirrorDoc,
  TemplateCategory,
  TemplateScope,
} from "../types";
import { Timestamp } from "firebase-admin/firestore";

// Filters accepted by the catalog listing. Both are optional and applied in
// memory after the scope-based fetch.
export interface TemplateFilters {
  category?: TemplateCategory;
  search?: string;
}

// Fields accepted when authoring a template. Any agent-side user can create one
// (added to the shared global catalog); `createdBy` records who so they can later
// edit/delete their own.
export interface CreateTemplateInput {
  title: string;
  description?: string;
  category: TemplateCategory;
  content: ProseMirrorDoc;
  scope?: TemplateScope; // defaults to "global"
  agencyId?: string; // only meaningful when scope === "agency"
  createdBy?: string; // authoring user's uid
  createdByName?: string; // denormalized display name
}

// Editable fields on an existing template (all optional — patch semantics).
export interface UpdateTemplateInput {
  title?: string;
  description?: string;
  category?: TemplateCategory;
  content?: ProseMirrorDoc;
}

// Current content/schema version stamped on authored templates.
const SCHEMA_VERSION = 1;

class DocumentTemplateService {
  /**
   * List templates visible to a principal: every global template plus the
   * caller's own agency templates (when they belong to an agency). Content is
   * stripped from list results — it's only returned by `getById(includeContent)`.
   */
  async listVisibleTemplates(
    agencyId: string | null | undefined,
    filters?: TemplateFilters
  ): Promise<DocumentTemplate[]> {
    // Global templates — single equality filter (no composite index needed).
    const globalSnap = await collections.documentTemplates
      .where("scope", "==", "global")
      .get();

    // Agency-scoped templates for this caller's agency (when applicable). Fetched
    // by `agencyId` equality alone so it also needs no composite index.
    let agencyDocs: FirebaseFirestore.QueryDocumentSnapshot[] = [];
    if (agencyId) {
      const agencySnap = await collections.documentTemplates
        .where("agencyId", "==", agencyId)
        .get();
      agencyDocs = agencySnap.docs;
    }

    // Merge + dedupe by id (an agency template can't also be global, but guard
    // anyway), then strip content and apply in-memory filters + sort.
    const byId = new Map<string, DocumentTemplate>();
    for (const doc of [...globalSnap.docs, ...agencyDocs]) {
      const t = doc.data() as DocumentTemplate;
      byId.set(t.id, t);
    }

    let templates = Array.from(byId.values()).map(stripContent);

    if (filters?.category) {
      templates = templates.filter((t) => t.category === filters.category);
    }
    if (filters?.search) {
      const q = filters.search.toLowerCase();
      templates = templates.filter(
        (t) =>
          t.title.toLowerCase().includes(q) ||
          (t.description ?? "").toLowerCase().includes(q)
      );
    }

    // Most-recently-updated first (matches the portal's "Updated" column).
    templates.sort((a, b) => b.updatedAt.toMillis() - a.updatedAt.toMillis());
    return templates;
  }

  /**
   * Fetch a single template by id. `includeContent` controls whether the
   * (potentially large) ProseMirror body is returned — the clone modal needs it
   * for the preview; the catalog list does not.
   */
  async getById(
    id: string,
    includeContent: boolean
  ): Promise<DocumentTemplate | null> {
    const doc = await collections.documentTemplates.doc(id).get();
    if (!doc.exists) return null;
    const template = doc.data() as DocumentTemplate;
    return includeContent ? template : stripContent(template);
  }

  // ============================================
  // AUTHORING (admin-managed catalog)
  // ============================================

  /**
   * Create a new template. Defaults to "global" scope (Seli-authored, visible to
   * everyone); pass scope/agencyId to author an agency-scoped one.
   */
  async create(input: CreateTemplateInput): Promise<DocumentTemplate> {
    const now = Timestamp.now();
    const ref = collections.documentTemplates.doc();
    const template: DocumentTemplate = {
      id: ref.id,
      title: input.title,
      description: input.description,
      category: input.category,
      scope: input.scope ?? "global",
      // Only set agencyId for agency-scoped templates (undefined is stripped by
      // Firestore's ignoreUndefinedProperties).
      agencyId: input.scope === "agency" ? input.agencyId : undefined,
      schemaVersion: SCHEMA_VERSION,
      content: input.content,
      createdBy: input.createdBy,
      createdByName: input.createdByName,
      createdAt: now,
      updatedAt: now,
    };
    await ref.set(template);
    return template;
  }

  /**
   * Patch an existing template's editable fields. Returns null if it doesn't
   * exist. id/scope/schemaVersion/createdAt are never mutated here.
   */
  async update(
    id: string,
    input: UpdateTemplateInput
  ): Promise<DocumentTemplate | null> {
    const ref = collections.documentTemplates.doc(id);
    const doc = await ref.get();
    if (!doc.exists) return null;

    // Only copy provided fields so absent ones are left untouched.
    const updates: Record<string, unknown> = { updatedAt: Timestamp.now() };
    if (input.title !== undefined) updates.title = input.title;
    if (input.description !== undefined) updates.description = input.description;
    if (input.category !== undefined) updates.category = input.category;
    if (input.content !== undefined) updates.content = input.content;

    await ref.update(updates);
    const updated = await ref.get();
    return updated.data() as DocumentTemplate;
  }

  /** Delete a template. Existing cloned instances keep their own content copy. */
  async delete(id: string): Promise<boolean> {
    const ref = collections.documentTemplates.doc(id);
    const doc = await ref.get();
    if (!doc.exists) return false;
    await ref.delete();
    return true;
  }
}

/** Return a copy of the template without its content payload. */
function stripContent(t: DocumentTemplate): DocumentTemplate {
  // Copy then drop `content` (optional field) so list/summary responses stay light
  // without mutating the cached Firestore object.
  const copy = { ...t };
  delete copy.content;
  return copy;
}

export const documentTemplateService = new DocumentTemplateService();
