import { act } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

// Spec 03 AC-1/AC-2, principle "nothing is lost". On a deployed site the Add document page is visible ~1 s before
// React attaches its handlers; a file chosen in that window fired `change` with no listener and was silently
// dropped (regression runs 36463952638, 36502490351: no upload request at all). The form must pick up a file that
// is already in the input when it hydrates.

const startUpload = vi.fn(async () => ({ ok: false as const, error: "stop here" }));
vi.mock("@/lib/documents/actions", () => ({
  loadClientTypes: vi.fn(), proposeType: vi.fn(), saveDocument: vi.fn(), startUpload,
  suggestTypes: vi.fn(), updateDocumentAction: vi.fn(),
}));
vi.mock("@/lib/clients/actions", () => ({ searchClients: vi.fn() }));
vi.mock("@/lib/documents/upload-client", () => ({ putFile: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
const { DocumentForm } = await import("@/app/(app)/documents/new/document-form");

const props = {
  initialClient: null, initialTypes: { planTypes: [], otherTypes: [], registrations: [] },
  periods: [], groups: [], today: "2026-09-29", canPropose: false, returnTo: "/inbox",
};

afterEach(() => { document.body.innerHTML = ""; startUpload.mockClear(); });

describe("Add document — a file chosen before the page is interactive", () => {
  it("is uploaded once the form hydrates, not dropped", async () => {
    const container = document.createElement("div");
    container.innerHTML = renderToString(<DocumentForm {...props} />);
    document.body.appendChild(container);

    // The staff member picks a file while only the server HTML is on screen.
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = new File([new Uint8Array([37, 80, 68, 70])], "Aug-2026-invoices.pdf", { type: "application/pdf" });
    Object.defineProperty(input, "files", { value: [file], configurable: true });

    await act(async () => { hydrateRoot(container, <DocumentForm {...props} />, { onRecoverableError: () => {} }); });

    expect(startUpload).toHaveBeenCalledTimes(1);
    expect(startUpload).toHaveBeenCalledWith({ name: "Aug-2026-invoices.pdf", size: 4, type: "application/pdf" });
  });

  it("keeps Save disabled until the form is interactive (a native submit would put field values in the URL)", async () => {
    const container = document.createElement("div");
    container.innerHTML = renderToString(<DocumentForm {...props} />);
    document.body.appendChild(container);
    const save = (label: string) => [...container.querySelectorAll("button")].find((b) => b.textContent === label)!;
    expect(save("Save to vault").disabled).toBe(true);
    expect(save("Save to inbox").disabled).toBe(true);
    await act(async () => { hydrateRoot(container, <DocumentForm {...props} />, { onRecoverableError: () => {} }); });
    expect(save("Save to vault").disabled).toBe(false);
    expect(save("Save to inbox").disabled).toBe(false);
  });

  it("does nothing when no file was chosen", async () => {
    const container = document.createElement("div");
    container.innerHTML = renderToString(<DocumentForm {...props} />);
    document.body.appendChild(container);
    await act(async () => { hydrateRoot(container, <DocumentForm {...props} />, { onRecoverableError: () => {} }); });
    expect(startUpload).not.toHaveBeenCalled();
  });
});
