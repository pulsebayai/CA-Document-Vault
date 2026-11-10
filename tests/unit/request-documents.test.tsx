import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { RemindDialogData } from "@/lib/reminders/queries";
import type { LinkOptions, LinkTypeOption } from "@/lib/upload-links/queries";

// R1 staging finding F3 (owner 2026-11-10): Client › Requested has its own "Request documents" button. It opens the
// Remind dialog with the upload link on, one empty "other document" row and no open item ticked, so a request for a
// document that isn't on the plan needs no detour through Remind — and works for a client with nothing due.

const remindDialog = vi.fn();
vi.mock("@/lib/reminders/actions", () => ({
  remindDialog: (...a: unknown[]) => remindDialog(...a), sendEmailReminder: vi.fn(), recordWhatsApp: vi.fn(), logCall: vi.fn(),
  reminderPreview: vi.fn(), clientReminders: vi.fn(),
}));
const sendLinkEmail = vi.fn();
const linkOptions = vi.fn();
vi.mock("@/lib/upload-links/actions", () => ({
  sendLinkEmail: (...a: unknown[]) => sendLinkEmail(...a), linkOptions: (...a: unknown[]) => linkOptions(...a),
  recordLinkWhatsApp: vi.fn(), retryLinkEmail: vi.fn(), revokeLink: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) { this.removeAttribute("open"); };
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const { RequestDocumentsButton } = await import("@/app/(app)/clients/remind-dialog");

const C = "11111111-1111-4111-8111-111111111111";
const item = { id: "a", group: "GST", type: "Sales invoices / sales register", period: "Aug 2026", regKind: null, stateCode: null,
  overdueFrom: "2026-09-05", stateText: "Overdue · 27 days late", kind: "overdue" as const, reminders: true, ticked: true, history: "not reminded yet" };
const data = (items: RemindDialogData["items"]): RemindDialogData => ({
  today: "2026-11-10", client: { id: C, name: "Meena Exports", emailMasked: "m…@…", mobile: "9876500001" }, items,
  emailedToday: null, dailyLimitReached: false, sender: { name: "Priya Raman", firm: "Kushal Associates" },
});
const notice: LinkTypeOption = { id: "t-notice", name: "GST notice / order received", group: "GST", groupId: "g-gst", groupSort: 1,
  periodKind: "none", registrationKind: null, proposed: false, frequency: "as_needed", aliases: [], inPlan: false };
const options: LinkOptions = { enabled: true, base: "https://vault.example.in", periods: [], registrations: [], types: [notice] };

async function open(items: RemindDialogData["items"]) {
  remindDialog.mockResolvedValue({ ok: true, data: data(items) });
  linkOptions.mockResolvedValue({ ok: true, data: options });
  render(<RequestDocumentsButton clientId={C} clientName="Meena Exports" />);
  await userEvent.click(screen.getByRole("button", { name: "Request documents from Meena Exports" }));
  const d = await screen.findByRole("dialog", { name: "Request documents from Meena Exports" });
  await within(d).findByRole("combobox", { name: "Document type" });
  return d;
}

describe("Request documents (F3)", () => {
  it("opens with the link on (locked), one empty row and no open item ticked", async () => {
    const d = await open([item]);
    expect(within(d).getByRole("switch", { name: "Include upload link" })).toBeChecked();
    expect(within(d).getByRole("switch", { name: "Include upload link" })).toBeDisabled();
    expect(within(d).getAllByRole("combobox", { name: "Document type" })).toHaveLength(1);
    expect(within(d).getByRole("checkbox")).not.toBeChecked();
  });

  it("sends a link with only the other document when the client has nothing open", async () => {
    sendLinkEmail.mockResolvedValue({ ok: true, status: "sent", to: "m…@…", openUntil: "2026-11-24", requestId: "r1" });
    const d = await open([]);
    expect(d).not.toHaveTextContent("This client has no open documents.");
    await userEvent.type(within(d).getByRole("combobox", { name: "Document type" }), "notice");
    await userEvent.click(within(screen.getByRole("listbox", { name: "Matching types" })).getByRole("option", { name: /^GST notice/ }));
    const send = within(d).getByRole("button", { name: "Send email" });
    await waitFor(() => expect(send).toBeEnabled());
    await userEvent.click(send);
    expect(sendLinkEmail).toHaveBeenCalledWith(expect.objectContaining({
      clientId: C, itemIds: [], adHoc: [expect.objectContaining({ docTypeId: "t-notice" })],
    }));
    expect(await within(d).findByText(/Link sent to m…@…/)).toBeInTheDocument();
  });
});
