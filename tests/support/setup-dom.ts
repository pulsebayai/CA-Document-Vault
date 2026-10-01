import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";

// Feature 06: Client › Documents / Expected and Today render the Remind and Log call dialogs, whose server actions
// import server-only modules. View tests that don't exercise reminders get these inert stubs; a test that does
// (tests/unit/remind-dialog.test.tsx) declares its own vi.mock, which takes precedence.
vi.mock("@/lib/reminders/actions", () => ({
  remindDialog: vi.fn(async () => ({ ok: false, error: "not stubbed" })),
  reminderPreview: vi.fn(), sendEmailReminder: vi.fn(), recordWhatsApp: vi.fn(), logCall: vi.fn(), clientReminders: vi.fn(),
}));
