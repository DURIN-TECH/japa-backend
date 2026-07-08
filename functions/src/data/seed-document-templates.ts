/**
 * Seeder for the global document-template catalog.
 *
 * Creates the starter set of Seli-authored ("global") rich-text templates that
 * every agency can clone. Content is stored as TipTap/ProseMirror JSON — the
 * exact shape the portal editor round-trips (StarterKit nodes: heading,
 * paragraph, text, with bold marks for the fill-in placeholders).
 *
 * Idempotent: each template uses a deterministic doc id so re-running the seed
 * overwrites rather than duplicating. Like the other data seeders, this module
 * calls getFirestore() at import time, so it must only be imported AFTER
 * Firebase Admin is initialized (guaranteed by scripts/seed-all.ts).
 */
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import {
  DocumentTemplate,
  ProseMirrorDoc,
  TemplateCategory,
} from "../types";

const db = getFirestore();

// Current editor/content schema version. Bump when the ProseMirror schema changes
// in a way that requires migrating stored content.
const SCHEMA_VERSION = 1;

// Shape of a single seed entry (id is deterministic for idempotency).
interface TemplateSeed {
  id: string;
  title: string;
  description: string;
  category: TemplateCategory;
  content: ProseMirrorDoc;
}

// --- Small ProseMirror builders (keep the seed data readable) ---

/** A heading node at the given level. */
function heading(level: number, text: string) {
  return {
    type: "heading",
    attrs: { level },
    content: [{ type: "text", text }],
  };
}

/** A plain paragraph. */
function paragraph(text: string) {
  return { type: "paragraph", content: [{ type: "text", text }] };
}

/** A bold "[Placeholder]" run inline in a sentence, e.g. "Dear [Officer]," */
function paragraphWithPlaceholder(prefix: string, placeholder: string, suffix = "") {
  return {
    type: "paragraph",
    content: [
      ...(prefix ? [{ type: "text", text: prefix }] : []),
      { type: "text", text: placeholder, marks: [{ type: "bold" }] },
      ...(suffix ? [{ type: "text", text: suffix }] : []),
    ],
  };
}

/** An empty paragraph (spacer). */
function spacer() {
  return { type: "paragraph" };
}

/** Wrap top-level nodes in a ProseMirror doc. */
function doc(...nodes: unknown[]): ProseMirrorDoc {
  return { type: "doc", content: nodes };
}

// --- The starter catalog ---

const TEMPLATE_SEEDS: TemplateSeed[] = [
  // Cover letter — a general visa application cover letter.
  {
    id: "global-cover-letter",
    title: "Visa Application Cover Letter",
    description:
      "A professional cover letter introducing the applicant and summarizing the purpose of the visa application.",
    category: "cover_letter",
    content: doc(
      heading(1, "Visa Application Cover Letter"),
      spacer(),
      paragraphWithPlaceholder("", "[Date]"),
      paragraphWithPlaceholder("", "[Visa Officer / Embassy Name]"),
      paragraphWithPlaceholder("", "[Embassy Address]"),
      spacer(),
      paragraphWithPlaceholder("Dear ", "[Visa Officer]", ","),
      spacer(),
      paragraphWithPlaceholder(
        "I am writing to formally apply for a ",
        "[Visa Type]",
        " visa. My name is [Full Name], a citizen of [Country], and I intend to travel to [Destination Country] for the purpose of [Purpose of Travel]."
      ),
      paragraph(
        "Please find enclosed all supporting documents required for my application, including my passport, financial statements, and supporting evidence for the purpose of my trip."
      ),
      paragraph(
        "I confirm that I will comply with all visa conditions and return to my home country upon completion of my visit. I would be grateful for your favorable consideration of my application."
      ),
      spacer(),
      paragraph("Yours faithfully,"),
      paragraphWithPlaceholder("", "[Full Name]"),
      paragraphWithPlaceholder("", "[Contact Details]")
    ),
  },

  // Statement of Purpose — study-focused SOP.
  {
    id: "global-sop",
    title: "Statement of Purpose (Study)",
    description:
      "A statement of purpose outlining the applicant's academic background, chosen program, and study intentions.",
    category: "sop",
    content: doc(
      heading(1, "Statement of Purpose"),
      spacer(),
      paragraphWithPlaceholder(
        "My name is ",
        "[Full Name]",
        ", and I am applying to study [Program Name] at [Institution Name] in [Destination Country]."
      ),
      heading(2, "Academic Background"),
      paragraph(
        "Describe your previous education, relevant qualifications, and any academic achievements that have prepared you for this program."
      ),
      heading(2, "Why This Program"),
      paragraph(
        "Explain why you have chosen this specific program and institution, and how it aligns with your academic and career goals."
      ),
      heading(2, "Career Goals"),
      paragraph(
        "Outline your short- and long-term career objectives, and how completing this program will help you achieve them in your home country."
      ),
      heading(2, "Ties to Home Country"),
      paragraph(
        "Explain your intention to return home after completing your studies, including family, career, or other commitments."
      ),
      spacer(),
      paragraph("Sincerely,"),
      paragraphWithPlaceholder("", "[Full Name]")
    ),
  },

  // Affidavit of support — sponsor declaration.
  {
    id: "global-affidavit-support",
    title: "Affidavit of Support",
    description:
      "A sponsor's sworn declaration of financial support for the applicant's travel and stay.",
    category: "affidavit",
    content: doc(
      heading(1, "Affidavit of Support"),
      spacer(),
      paragraphWithPlaceholder(
        "I, ",
        "[Sponsor Full Name]",
        ", of [Sponsor Address], do hereby solemnly declare and affirm as follows:"
      ),
      paragraph(
        "1. That I am the [Relationship to Applicant] of [Applicant Full Name], the applicant."
      ),
      paragraph(
        "2. That I am gainfully employed as [Occupation] and earn a monthly/annual income of [Income Amount]."
      ),
      paragraph(
        "3. That I undertake to be fully responsible for the financial support, accommodation, and general welfare of the applicant during their stay in [Destination Country]."
      ),
      paragraph(
        "4. That I make this declaration conscientiously believing the contents to be true and correct."
      ),
      spacer(),
      paragraphWithPlaceholder("Sworn at ", "[Location]", " this [Day] day of [Month], [Year]."),
      spacer(),
      paragraph("Deponent"),
      paragraphWithPlaceholder("", "[Sponsor Full Name]"),
      spacer(),
      paragraph("Before me,"),
      paragraph("Commissioner for Oaths / Notary Public")
    ),
  },
];

/**
 * Seed the global template catalog. Returns the number of templates written.
 */
export async function seedDocumentTemplates(): Promise<number> {
  const batch = db.batch();
  const now = Timestamp.now();
  const collection = db.collection("documentTemplates");

  for (const seed of TEMPLATE_SEEDS) {
    const ref = collection.doc(seed.id);
    const template: DocumentTemplate = {
      id: seed.id,
      title: seed.title,
      description: seed.description,
      category: seed.category,
      scope: "global",
      schemaVersion: SCHEMA_VERSION,
      content: seed.content,
      createdAt: now,
      updatedAt: now,
    };
    // merge:true keeps createdAt stable across re-seeds while refreshing content.
    batch.set(ref, template, { merge: true });
  }

  await batch.commit();
  return TEMPLATE_SEEDS.length;
}
