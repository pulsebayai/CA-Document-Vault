import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClientSearchResult } from "@/lib/clients/queries";

// Feature 12, spec AC-27 (pre-PR review I-1): with "My clients" on, an empty result is about the filter, not an
// empty office — a Staff member with no clients of their own must not read "No clients yet".

const search = vi.fn(async () => ({ ok: true as const, rows: [], matched: 0, total: 300 }));
vi.mock("@/lib/clients/actions", () => ({ searchClients: search }));
afterEach(() => { cleanup(); search.mockClear(); });
const { ClientsBrowser } = await import("@/app/(app)/clients/clients-browser");

describe("My clients empty state (AC-27)", () => {
  it("says none of the user's clients and how to see every client", () => {
    const initial: ClientSearchResult = { rows: [], matched: 0, total: 300 };
    render(<ClientsBrowser initial={initial} staff={[]} canAdd={false} mine={{ on: true, defaultOn: true }} />);
    expect(screen.queryByText("No clients yet")).toBeNull();
    expect(screen.getByText("None of your clients")).toBeInTheDocument();
    expect(screen.getByText(/Switch off My clients to see all 300 clients\./)).toBeInTheDocument();
  });

  it("without My clients, an empty office still says No clients yet", () => {
    render(<ClientsBrowser initial={{ rows: [], matched: 0, total: 0 }} staff={[]} canAdd={false} mine={{ on: false, defaultOn: false }} />);
    expect(screen.getByText("No clients yet")).toBeInTheDocument();
  });
});
