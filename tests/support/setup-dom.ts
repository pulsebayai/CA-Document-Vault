import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";

// Feature 06: Client › Documents / Expected and Today render the Remind and Log call dialogs, whose server actions
// import server-only modules. View tests that don't exercise reminders get these inert stubs; a test that does
// (tests/unit/remind-dialog.test.tsx) declares its own vi.mock, which takes precedence.
vi.mock("@/lib/reminders/actions", () => ({
  remindDialog: vi.fn(async () => ({ ok: false, error: "not stubbed" })),
  reminderPreview: vi.fn(), sendEmailReminder: vi.fn(), recordWhatsApp: vi.fn(), logCall: vi.fn(), clientReminders: vi.fn(),
}));

// Feature 05: Settings › Catalogue renders the decision dialogs, whose server actions import server-only modules.
// Inert stubs here; tests/unit/proposal-queue.test.tsx declares its own.
vi.mock("@/lib/catalogue/governance", () => ({
  previewDecision: vi.fn(async () => ({ ok: false, error: "not stubbed", stale: false })),
  approveProposedType: vi.fn(), editAndApproveType: vi.fn(), mergeProposedType: vi.fn(), rejectProposedType: vi.fn(),
  searchMergeTargets: vi.fn(async () => []),
}));

// Feature 08: /documents and Client › Documents render the selection bar, whose dialogs call bulk server actions
// (server-only imports). Inert stubs here; tests/unit/selection-bar.test.tsx declares its own vi.mock.
vi.mock("@/lib/bulk/actions", () => ({
  getZipManifest: vi.fn(async () => ({ ok: false, error: "not stubbed" })),
  getFileLinks: vi.fn(async () => ({ ok: false, error: "not stubbed" })),
  markReviewedBulk: vi.fn(async () => ({ ok: false, error: "not stubbed" })),
}));
