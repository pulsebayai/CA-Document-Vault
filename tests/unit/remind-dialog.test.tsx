import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { RemindDialogData } from "@/lib/reminders/queries";

// Feature 06 step 6 — the Remind and Log call dialogs (AC-7…AC-11). The database rules behind the buttons are
// proven in tests/rls/follow-up.test.ts; this checks ticks, the preview, disabled reasons and what each button calls.

const remindDialog = vi.fn();
const sendEmailReminder = vi.fn();
const recordWhatsApp = vi.fn(async () => ({ ok: true as const }));
const logCall = vi.fn(async () => ({ ok: true as const }));
vi.mock("@/lib/reminders/actions", () => ({
  remindDialog: (...a: unknown[]) => remindDialog(...a), sendEmailReminder: (...a: unknown[]) => sendEmailReminder(...a),
  recordWhatsApp: (...a: unknown[]) => recordWhatsApp(...(a as [])), logCall: (...a: unknown[]) => logCall(...(a as [])),
  reminderPreview: vi.fn(), clientReminders: vi.fn(),
}));
const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }));

beforeAll(() => {
  // jsdom has no showModal/close on <dialog>.
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) { this.removeAttribute("open"); };
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const { RemindButton, LogCallButton } = await import("@/app/(app)/clients/remind-dialog");

const C = "11111111-1111-4111-8111-111111111111";
const data = (over: Partial<RemindDialogData> = {}): RemindDialogData => ({
  today: "2026-10-01",
  client: { id: C, name: "Meena Exports", emailMasked: "m…@…", mobile: "9876500001" },
  items: [
    { id: "a", group: "GST", type: "Sales invoices / sales register", period: "Aug 2026", regKind: "gstin", stateCode: "33",
      overdueFrom: "2026-09-05", stateText: "Overdue · 27 days late", kind: "overdue", reminders: true, ticked: true, history: "reminded twice · last 30 Sep by Priya (email)" },
    { id: "b", group: "Banking", type: "Bank statement", period: "Sep 2026", regKind: null, stateCode: null,
      overdueFrom: "2026-10-08", stateText: "Due 7 Oct", kind: "due", reminders: false, ticked: false, history: "not reminded yet" },
  ],
  emailedToday: null, dailyLimitReached: false, sender: { name: "Priya Raman", firm: "Kushal Associates" }, ...over,
});

async function open(over: Partial<RemindDialogData> = {}) {
  remindDialog.mockResolvedValue({ ok: true, data: data(over) });
  render(<RemindButton clientId={C} clientName="Meena Exports" />);
  await userEvent.click(screen.getByRole("button", { name: "Remind Meena Exports" }));
  return screen.findByRole("dialog", { name: "Remind Meena Exports" });
}

describe("Remind dialog (AC-7…AC-10)", () => {
  it("lists every open item; reminders-off items are shown and unticked; the preview is the message", async () => {
    const d = await open();
    expect(remindDialog).toHaveBeenCalledWith(C);
    const boxes = within(d).getAllByRole("checkbox");
    expect(boxes.map((b) => (b as HTMLInputElement).checked)).toEqual([true, false]);
    expect(d).toHaveTextContent("reminded twice · last 30 Sep by Priya (email)");
    expect(d).toHaveTextContent("reminders off");
    const preview = within(d).getByRole("region", { name: "Message preview" });
    expect(preview).toHaveTextContent("Dear Meena Exports,");
    expect(preview).toHaveTextContent("GST · Sales invoices / sales register (Tamil Nadu GSTIN) · August 2026 — overdue since 5 Sep");
    expect(preview).not.toHaveTextContent("Bank statement");
    await userEvent.click(boxes[1]);
    expect(preview).toHaveTextContent("Banking · Bank statement · September 2026 — due by 7 Oct");
  });

  it("Send email sends the ticked items and shows the masked recipient", async () => {
    sendEmailReminder.mockResolvedValue({ ok: true, status: "sent", at: "2026-10-01T05:50:00Z", to: "m…@…" });
    const d = await open();
    await userEvent.click(within(d).getByRole("button", { name: "Send email" }));
    expect(sendEmailReminder).toHaveBeenCalledWith(C, ["a"]);
    expect(await within(d).findByText(/Sent to m…@…, 11:20/)).toBeInTheDocument();
    expect(within(d).getByRole("button", { name: "Send email" })).toBeDisabled(); // the day's email is used
    expect(refresh).toHaveBeenCalled();
  });

  it("a failed send offers Retry", async () => {
    sendEmailReminder.mockResolvedValueOnce({ ok: true, status: "failed", at: "2026-10-01T05:50:00Z", to: "m…@…", error: "Not sent (TIMEOUT). You can retry." })
      .mockResolvedValueOnce({ ok: true, status: "sent", at: "2026-10-01T05:51:00Z", to: "m…@…" });
    const d = await open();
    await userEvent.click(within(d).getByRole("button", { name: "Send email" }));
    await userEvent.click(await within(d).findByRole("button", { name: "Retry" }));
    expect(sendEmailReminder).toHaveBeenCalledTimes(2);
  });

  it("explains why Send email is disabled: no email, already emailed today, daily limit", async () => {
    let d = await open({ client: { id: C, name: "Meena Exports", emailMasked: null, mobile: "9876500001" } });
    expect(within(d).getByRole("button", { name: "Send email" })).toBeDisabled();
    expect(d).toHaveTextContent("No email on file — add one in Settings.");
    cleanup();
    d = await open({ emailedToday: { at: "2026-10-01T05:50:00Z", by: "Ravi", status: "sent" } });
    expect(d).toHaveTextContent("Emailed today at 11:20 by Ravi. One email per client per day.");
    cleanup();
    d = await open({ dailyLimitReached: true });
    expect(d).toHaveTextContent("Daily email limit reached — use WhatsApp or try tomorrow.");
  });

  it("Open WhatsApp opens wa.me from the click, then records the follow-up; disabled without a mobile", async () => {
    const win = vi.spyOn(window, "open").mockImplementation(() => null);
    const d = await open();
    await userEvent.click(within(d).getByRole("button", { name: "Open WhatsApp" }));
    expect(win).toHaveBeenCalledWith(expect.stringMatching(/^https:\/\/wa\.me\/919876500001\?text=Dear%20Meena%20Exports/), "_blank", "noopener,noreferrer");
    await waitFor(() => expect(recordWhatsApp).toHaveBeenCalledWith(C, ["a"]));
    cleanup();
    const d2 = await open({ client: { id: C, name: "Meena Exports", emailMasked: "m…@…", mobile: null } });
    expect(within(d2).getByRole("button", { name: "Open WhatsApp" })).toBeDisabled();
    expect(d2).toHaveTextContent("No mobile number on file");
    win.mockRestore();
  });

  it("with nothing ticked, both buttons say why they are disabled", async () => {
    const d = await open();
    await userEvent.click(within(d).getAllByRole("checkbox")[0]);
    expect(within(d).getByRole("button", { name: "Send email" })).toBeDisabled();
    expect(within(d).getByRole("button", { name: "Open WhatsApp" })).toBeDisabled();
    expect(within(d).getAllByText("Choose at least one document.")).toHaveLength(2);
  });
});

describe("Log call dialog (AC-11)", () => {
  it("saves the ticked items with the date (default today, max today) and a note", async () => {
    remindDialog.mockResolvedValue({ ok: true, data: data() });
    render(<LogCallButton clientId={C} clientName="Meena Exports" />);
    await userEvent.click(screen.getByRole("button", { name: "Log call with Meena Exports" }));
    const d = await screen.findByRole("dialog", { name: "Log a call with Meena Exports" });
    const date = within(d).getByLabelText("Date of call");
    expect(date).toHaveValue("2026-10-01");
    expect(date).toHaveAttribute("max", "2026-10-01");
    expect(within(d).getByLabelText("Note (optional)")).toHaveAttribute("maxLength", "300");
    await userEvent.type(within(d).getByLabelText("Note (optional)"), "Will send Friday");
    await userEvent.click(within(d).getByRole("button", { name: "Save call" }));
    await waitFor(() => expect(logCall).toHaveBeenCalledWith({ clientId: C, itemIds: ["a"], on: "2026-10-01", note: "Will send Friday" }));
  });
});
