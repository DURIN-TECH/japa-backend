/**
 * Checklist service (issue #114): the I/O half around the pure builder in
 * `checklist-builder.ts`.
 *
 * CONTRACT FOR LATER ISSUES (#115 per-upload check, #122 refusal letters):
 *
 *   import { checklistService } from "./ai/checklist.service";
 *   const view = await checklistService.getChecklist(application);          // read-only
 *   const view = await checklistService.refreshChecklist(application);      // builds + stores
 *
 *   view = { state, emptyReason?, rubricVersion, items: ChecklistItemView[] }
 *   ChecklistItemView = ChecklistItem (checklistItemId, title, holder, required,
 *     reason, criterionRef?, citation{quote,url,ruleRef?}) plus
 *     { documentRequestId: string|null, status: pending|fulfilled|waived|cancelled|null,
 *       fulfilledDocumentId?: string, current: boolean }
 *   `current: false` = a stored item the current answers no longer ask for but
 *   which the applicant already fulfilled (kept visible).
 *   The pure function `buildChecklist(input)` (checklist-builder.ts) can be
 *   called directly with a rubric + answers when no Firestore is wanted.
 *
 * NO authorisation here: callers (controller) have already run
 * `checkApplicationAccess`. NO model call anywhere in this file.
 */
import { isAnswerType, rubricStore } from "../../scrapers";
import { defaultRulebookStack, rulebookFor } from "./application-rulebook";
import { visaService } from "../visa.service";
import { documentRequestService } from "../document-request.service";
import { buildChecklist, ChecklistItem, ChecklistState } from "./checklist-builder";
import { applicantContextOf } from "./rule-applicability";
import type { Application, DocumentRequest, DocumentRequestStatus } from "../../types";

/** A checklist item joined with its stored DocumentRequest (if any). */
export interface ChecklistItemView extends ChecklistItem {
  documentRequestId: string | null;
  status: DocumentRequestStatus | null;
  fulfilledDocumentId?: string;
  /** False for a fulfilled item the current answers no longer ask for. */
  current: boolean;
}

export interface ChecklistView {
  state: ChecklistState;
  emptyReason?: string;
  rubricVersion: number | null;
  items: ChecklistItemView[];
}

/** Rebuild a ChecklistItem from a stored request (for items no longer on the list). */
function itemFromRequest(r: DocumentRequest): ChecklistItem | null {
  // A stored item with no citation cannot be shown (every item is cited).
  if (!r.checklistItemId || !r.citation) return null;
  return {
    checklistItemId: r.checklistItemId,
    title: r.documentType,
    holder: r.holder ?? "applicant",
    required: r.required === true,
    // Issue #187: stored kind/need, defaulting to document + (required|optional).
    kind: r.kind ?? "document",
    ...(r.kindReview ? { kindReview: true as const } : {}),
    ...(r.kindQuote ? { kindQuote: r.kindQuote } : {}),
    // A stored information request keeps its type; one saved before the regroom reads as text.
    ...(r.kind === "information"
      ? { answerType: isAnswerType(r.answerType) ? r.answerType : ("text" as const) }
      : {}),
    ...(r.answerTypeQuote ? { answerTypeQuote: r.answerTypeQuote } : {}),
    need: r.need ?? (r.required === true ? "required" : "optional"),
    ...(r.appliesWhen ? { appliesWhen: r.appliesWhen } : {}),
    reason: r.reason ?? "",
    criterionRef: r.criterionRef,
    citation: r.citation,
  };
}

class ChecklistService {
  /** Compute the list for an application from approved data. Read-only. */
  private async compute(application: Application) {
    // Approved rubrics only, and only through the store (never a pending one).
    // (#233) The application's rulebook STACK: every approved layer's document
    // items (shared layer(s) and its own), each with its own citation. For a
    // route without inheritance, exactly the own layer's approved rubric.
    const rubric = await rulebookFor(
      { ...application, countryCode: application.countryCode.toUpperCase() },
      { getApprovedRubric: (cc, vt) => rubricStore.getApprovedRubric(cc, vt), getRulebookStack: (app) => defaultRulebookStack(app) }
    );
    const visaType = await visaService.getVisaType(application.countryCode, application.visaTypeId);
    // Integration: #113 (`Application.intake`) and #129 (`VisaType.requiredDocuments`,
    // `scrapeMeta.citations`) are both on this branch, so the real types are used
    // here instead of the local casts #114 shipped with.
    const intake = application.intake;
    return buildChecklist({
      rubric,
      visaRecord: visaType,
      intakeAnswers: intake?.answers ?? null,
      // (#234) Rules triggered by what the applicant holds read the application's copy (today).
      applicantContext: applicantContextOf(application, new Date().toISOString().slice(0, 10)),
    });
  }

  /** Join built items with stored requests; keep fulfilled leftovers visible. */
  private join(built: Awaited<ReturnType<ChecklistService["compute"]>>, stored: DocumentRequest[]): ChecklistView {
    const byItemId = new Map(stored.map((r) => [r.checklistItemId, r]));
    const items: ChecklistItemView[] = built.items.map((it) => {
      const r = byItemId.get(it.checklistItemId);
      return {
        ...it,
        documentRequestId: r?.id ?? null,
        status: r?.status ?? null,
        ...(r?.fulfilledDocumentId ? { fulfilledDocumentId: r.fulfilledDocumentId } : {}),
        current: true,
      };
    });
    // Fulfilled (or waived) items stay visible after the answers change.
    const listed = new Set(built.items.map((i) => i.checklistItemId));
    for (const r of stored) {
      if (!r.checklistItemId || listed.has(r.checklistItemId)) continue;
      if (r.status !== "fulfilled" && r.status !== "waived") continue;
      const base = itemFromRequest(r);
      if (!base) continue;
      items.push({
        ...base,
        documentRequestId: r.id,
        status: r.status,
        ...(r.fulfilledDocumentId ? { fulfilledDocumentId: r.fulfilledDocumentId } : {}),
        current: false,
      });
    }
    const hasItems = items.length > 0;
    return {
      // Leftover fulfilled items make the list non-empty even if nothing is asked now.
      state: hasItems && built.state !== "ready" ? "ready" : built.state,
      ...(hasItems ? {} : built.emptyReason ? { emptyReason: built.emptyReason } : {}),
      rubricVersion: built.rubricVersion,
      items,
    };
  }

  /** Read the checklist without writing anything. */
  async getChecklist(application: Application): Promise<ChecklistView> {
    const [built, stored] = await Promise.all([
      this.compute(application),
      documentRequestService.listChecklistForApplication(application.id),
    ]);
    // Items not stored yet read as `documentRequestId: null` (not yet generated).
    return this.join(built, stored);
  }

  /** Build, store (idempotent) and return the checklist. */
  async refreshChecklist(application: Application): Promise<ChecklistView> {
    const built = await this.compute(application);
    // intake_needed: do not touch stored items (the applicant has not answered).
    if (built.state !== "intake_needed") {
      await documentRequestService.syncChecklist(application, built.items);
    }
    const stored = await documentRequestService.listChecklistForApplication(application.id);
    return this.join(built, stored);
  }
}

export const checklistService = new ChecklistService();
