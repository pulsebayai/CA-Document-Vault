import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientDscs } from "@/lib/dsc/queries";

// Feature 14 step 10 (pre-PR + security review) — the DSC tab in the browser. Server actions and the router are mocked.
//   Security I-3 / review I-5: the reveal hides 30 s of wall-clock time after it was shown (not 30 timer ticks, which
//   browsers slow down in background tabs), and a copied password is cleared from the clipboard when it hides.
//   Security I-2: password fields carry the attributes that keep password managers from saving a client's PIN.
//   Review I-2 (WCAG 2.5.3): each button's accessible name starts with its visible text.

const revealDscPassword = vi.fn();
vi.mock("@/lib/dsc/actions", () => ({
  revealDscPassword: (i: unknown) => revealDscPassword(i), saveDsc: vi.fn(), changeDscPassword: vi.fn(), logDscCustody: vi.fn(),
  archiveDsc: vi.fn(), unarchiveDsc: vi.fn(), setDscRemindDays: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const { DscView, Reveal } = await import("@/app/(app)/clients/[id]/dsc-view");

const C = "00000000-0000-4000-8000-0000000000c1";
const data = (): ClientDscs => ({
  today: "2026-10-31", remindDays: 30, archived: [],
  live: [{ id: "00000000-0000-4000-8000-0000000000d1", holderName: "Ravi Director", dscClass: "class3", issuer: "eMudhra",
    tokenNote: null, expiresOn: "2027-03-12", passwordSetAt: "2026-10-01T06:00:00Z", archivedAt: null, archiveReason: null, custody: [] }],
});
const perms = { canEdit: true, canReveal: true, canArchive: true, canCustody: true };

// jsdom has no showModal/close on <dialog> (as tests/unit/selection-bar.test.tsx).
HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) { this.setAttribute("open", ""); };
HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) { this.removeAttribute("open"); };

let writeText: ReturnType<typeof vi.fn>;
beforeEach(() => {
  writeText = vi.fn(async () => undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.useRealTimers(); });

async function showPassword() {
  revealDscPassword.mockResolvedValue({ ok: true, password: "pin-4321" });
  await act(async () => { screen.getByRole("button", { name: /^Show password/ }).click(); });
  await act(async () => { await Promise.resolve(); });
}

describe("Reveal: hides by the clock, clears the clipboard (security I-3, review I-5)", () => {
  it("hides once 30 s of real time have passed, even if the timer only fired once (a background tab)", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(new Date("2026-10-31T06:00:00Z"));
    render(<Reveal id="d1" holder="Ravi Director" />);
    await showPassword();
    expect(screen.getByTestId("dsc-password")).toHaveTextContent("pin-4321");
    vi.setSystemTime(new Date("2026-10-31T06:00:31Z")); // the tab slept; no ticks ran
    await act(async () => { vi.advanceTimersByTime(1000); });
    expect(screen.queryByTestId("dsc-password")).toBeNull();
  });

  it("a copied password is overwritten on the clipboard when it hides", async () => {
    render(<Reveal id="d1" holder="Ravi Director" />);
    await showPassword();
    await act(async () => { screen.getByRole("button", { name: /^Copy/ }).click(); });
    expect(writeText).toHaveBeenLastCalledWith("pin-4321");
    await act(async () => { screen.getByRole("button", { name: /^Hide/ }).click(); });
    expect(writeText).toHaveBeenLastCalledWith("");
  });

  it("a password that was never copied leaves the clipboard alone", async () => {
    render(<Reveal id="d1" holder="Ravi Director" />);
    await showPassword();
    await act(async () => { screen.getByRole("button", { name: /^Hide/ }).click(); });
    expect(writeText).not.toHaveBeenCalled();
  });
});

describe("Label in name (review I-2, WCAG 2.5.3)", () => {
  it("every DSC card button's accessible name starts with its visible text", () => {
    render(<DscView clientId={C} data={data()} perms={perms} />);
    const card = screen.getByRole("article", { name: "Ravi Director" });
    for (const b of within(card).getAllByRole("button")) {
      const visible = (b.textContent ?? "").trim();
      const name = b.getAttribute("aria-label") ?? visible;
      expect(name.toLowerCase().startsWith(visible.toLowerCase()), `"${name}" vs "${visible}"`).toBe(true);
    }
  });
});

describe("Password fields stay out of password managers (security I-2)", () => {
  it("Add DSC's password field is marked not to be saved", async () => {
    render(<DscView clientId={C} data={data()} perms={perms} />);
    await act(async () => { screen.getByRole("button", { name: "Add DSC" }).click(); });
    const pw = screen.getByLabelText("Token PIN / password");
    expect(pw).toHaveAttribute("autocomplete", "off");
    expect(pw).toHaveAttribute("data-1p-ignore");
    expect(pw).toHaveAttribute("data-lpignore", "true");
    expect(pw).toHaveAttribute("data-form-type", "other");
    expect(pw).not.toHaveAttribute("type", "password"); // a masked text field, so browsers don't treat the form as a sign-up
  });
});
