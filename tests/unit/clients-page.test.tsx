import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ClientsView } from "@/app/(app)/clients/clients-view";

// Retargeted in 02 (plan D1, approved 2026-09-26): the page now fetches data, so the
// behaviour it guards is tested on the presentational view. Same assertions as 01, plus the empty-state text.
describe("Clients page (empty state)", () => {
  it("shows the page heading and zero count", () => {
    render(<ClientsView clients={[]} total={0} />);
    expect(screen.getByRole("heading", { name: "Clients" })).toBeInTheDocument();
    expect(screen.getByText("0 clients")).toBeInTheDocument();
    expect(screen.getByText("No clients yet")).toBeInTheDocument();
  });
});
