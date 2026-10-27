import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClientTypes, DocumentForForm, TypeOption } from "@/lib/documents/queries";

// Chore ci-speed step 3 (found by e2e on a fast local database: inbox.spec.ts AC-8 failed 3 of 4 times).
// Picking a client loads that client's types in the background. A type chosen while that load is in flight
// (it is already listed under "All types") must survive the load when the client's list still contains it.
// Before the fix, pickClient compared against the type selected when the client was clicked (none), so the
// user's choice was silently cleared and "Save to vault" failed validation.

type Loaded = { ok: true } & ClientTypes;
let resolveLoad: (v: Loaded) => void = () => {};
const loadClientTypes = vi.fn(() => new Promise<Loaded>((r) => { resolveLoad = r; }));
const searchClients = vi.fn(async () => ({ ok: true as const, rows: [{ id: client.id, name: client.name, code: client.code }] }));
vi.mock("@/lib/documents/actions", () => ({
  allowAnyFormat: vi.fn(), loadClientTypes, proposeType: vi.fn(), saveDocument: vi.fn(), startUpload: vi.fn(),
  suggestTypes: vi.fn(), updateDocumentAction: vi.fn(),
}));
vi.mock("@/lib/clients/actions", () => ({ searchClients }));
vi.mock("@/lib/documents/upload-client", () => ({ putFile: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
const { DocumentForm } = await import("@/app/(app)/documents/new/document-form");

const client = { id: "11111111-1111-4111-8111-111111111111", name: "Inbox Traders", code: "C0001" };
const form16: TypeOption = {
  id: "22222222-2222-4222-8222-222222222222", name: "Form 16 from employer", groupId: "g", groupName: "Income Tax",
  periodKind: "none", frequency: "as_needed", registrationKind: null, proposed: false,
  preferredFormats: null, anyFormat: false, planRowId: null,
} as TypeOption;
const inboxDoc: DocumentForForm = {
  id: "44444444-4444-4444-8444-444444444444", docCode: "DOC-FY26-27-00001", client: null, docTypeId: null, periodId: null,
  registrationId: null, receivedAs: "hard_copy", channel: "courier", receivedOn: "2026-10-27", remark: null, fileName: null,
  versionCount: 0, classified: false, archived: false,
};

let container: HTMLDivElement;
afterEach(() => { document.body.innerHTML = ""; vi.useRealTimers(); });

function setValue(el: HTMLInputElement | HTMLSelectElement, value: string, event: "input" | "change") {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event(event, { bubbles: true }));
}

describe("document form: client picked, type chosen while the client's types load", () => {
  it("keeps the chosen type when the client's list still contains it", async () => {
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.appendChild(container);
    await act(async () => {
      createRoot(container).render(
        <DocumentForm existing={inboxDoc} initialClient={null} initialTypes={{ planTypes: [], otherTypes: [form16], registrations: [] }}
          periods={[]} groups={[]} today="2026-10-27" canPropose returnTo="/inbox" />,
      );
    });

    // Search and pick the client (search is debounced 250 ms).
    const search = container.querySelector<HTMLInputElement>('input[role="combobox"]')!;
    await act(async () => { setValue(search, "Inbox Tr", "input"); });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    const pick = [...container.querySelectorAll<HTMLButtonElement>('[role="listbox"] button')].find((b) => b.textContent?.includes("Inbox Traders"))!;
    await act(async () => { pick.click(); }); // loadClientTypes is now in flight

    // The user chooses the type from "All types" before the client's list arrives.
    const select = container.querySelector<HTMLSelectElement>("select")!;
    await act(async () => { setValue(select, form16.id, "change"); });
    expect(select.value).toBe(form16.id);

    // The client's list arrives and still contains the type: the choice must stay.
    await act(async () => { resolveLoad({ ok: true, planTypes: [], otherTypes: [form16], registrations: [] }); });
    expect(container.querySelector<HTMLSelectElement>("select")!.value).toBe(form16.id);
  });

  it("still clears the type when the client's list doesn't contain it", async () => {
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.appendChild(container);
    await act(async () => {
      createRoot(container).render(
        <DocumentForm existing={inboxDoc} initialClient={null} initialTypes={{ planTypes: [], otherTypes: [form16], registrations: [] }}
          periods={[]} groups={[]} today="2026-10-27" canPropose returnTo="/inbox" />,
      );
    });
    const search = container.querySelector<HTMLInputElement>('input[role="combobox"]')!;
    await act(async () => { setValue(search, "Inbox Tr", "input"); });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    const pick = [...container.querySelectorAll<HTMLButtonElement>('[role="listbox"] button')].find((b) => b.textContent?.includes("Inbox Traders"))!;
    await act(async () => { pick.click(); });
    const select = container.querySelector<HTMLSelectElement>("select")!;
    await act(async () => { setValue(select, form16.id, "change"); });
    await act(async () => { resolveLoad({ ok: true, planTypes: [], otherTypes: [], registrations: [] }); });
    expect(container.querySelector<HTMLSelectElement>("select")!.value).toBe("");
  });
});
