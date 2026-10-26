import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClientTypes, DocumentForForm, TypeOption } from "@/lib/documents/queries";

// Feature 11 — the staff warning in the document form (spec AC-19, AC-20, S4; plan step 5).
// Shown when the chosen client + type have a preference that applies and the file isn't in it; never blocks saving.

const allowAnyFormat = vi.fn(async () => ({ ok: true as const }));
vi.mock("@/lib/documents/actions", () => ({
  allowAnyFormat, loadClientTypes: vi.fn(), proposeType: vi.fn(), saveDocument: vi.fn(), startUpload: vi.fn(),
  suggestTypes: vi.fn(), updateDocumentAction: vi.fn(),
}));
vi.mock("@/lib/clients/actions", () => ({ searchClients: vi.fn() }));
vi.mock("@/lib/documents/upload-client", () => ({ putFile: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
const { DocumentForm } = await import("@/app/(app)/documents/new/document-form");

const client = { id: "11111111-1111-4111-8111-111111111111", name: "Formats client", code: "C0001" };
const bank = (over: Partial<TypeOption> = {}): TypeOption => ({
  id: "22222222-2222-4222-8222-222222222222", name: "Bank statement", groupId: "g", groupName: "Banking", periodKind: "month",
  frequency: "monthly", registrationKind: null, proposed: false,
  preferredFormats: ["xlsx", "xls", "csv"], anyFormat: false, planRowId: "33333333-3333-4333-8333-333333333333", ...over,
});
const types = (t: TypeOption): ClientTypes => ({ planTypes: [t], otherTypes: [], registrations: [] });
const existing = (fileName: string | null): DocumentForForm => ({
  id: "44444444-4444-4444-8444-444444444444", docCode: "DOC-FY26-27-00001", client, docTypeId: bank().id, periodId: null,
  registrationId: null, receivedAs: "soft_copy", channel: "email", receivedOn: "2026-10-26", remark: null, fileName,
  versionCount: 1, classified: true, archived: false,
});

let container: HTMLDivElement;
async function render(t: TypeOption, fileName: string | null, canPropose = true) {
  container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => {
    createRoot(container).render(
      <DocumentForm initialClient={client} initialTypes={types(t)} periods={[]} groups={[]} today="2026-10-26"
        canPropose={canPropose} returnTo="/inbox" existing={existing(fileName)} />,
    );
  });
}
const warning = () => [...container.querySelectorAll("div")].find((d) => /preferred as/.test(d.textContent ?? "") && d.id);
const button = (label: string) => [...container.querySelectorAll("button")].find((b) => b.textContent === label);

afterEach(() => { document.body.innerHTML = ""; allowAnyFormat.mockClear(); });

describe("staff format warning (AC-19)", () => {
  it("warns when the file isn't in a preferred format, and saving stays enabled", async () => {
    await render(bank(), "statement.pdf");
    expect(warning()?.textContent).toContain("Bank statement is preferred as Excel or CSV for this client. You can still save this file.");
    expect(button("Save")?.disabled ?? button("Save to vault")?.disabled ?? false).toBe(false);
  });

  it("says nothing for a preferred file, a type with no preference, or a client with an exception", async () => {
    await render(bank(), "statement.CSV");
    expect(warning()).toBeUndefined();
    document.body.innerHTML = "";
    await render(bank({ preferredFormats: null }), "statement.pdf");
    expect(warning()).toBeUndefined();
    document.body.innerHTML = "";
    await render(bank({ anyFormat: true }), "statement.pdf");
    expect(warning()).toBeUndefined();
  });

  it("says nothing for a document with no file", async () => {
    await render(bank(), null);
    expect(warning()).toBeUndefined();
  });

  it("Staff+ can allow any format in two steps; the warning then goes away", async () => {
    await render(bank(), "statement.pdf");
    await act(async () => { button("Allow any format for this client")!.click(); });
    expect(allowAnyFormat).not.toHaveBeenCalled();
    await act(async () => { button("Allow")!.click(); });
    expect(allowAnyFormat).toHaveBeenCalledWith(bank().planRowId);
    expect(warning()).toBeUndefined();
  });

  it("offers no exception link to Limited users, or for a type that isn't on the client's plan", async () => {
    await render(bank(), "statement.pdf", false);
    expect(warning()).toBeDefined();
    expect(button("Allow any format for this client")).toBeUndefined();
    document.body.innerHTML = "";
    await render(bank({ planRowId: null }), "statement.pdf");
    expect(button("Allow any format for this client")).toBeUndefined();
  });
});
