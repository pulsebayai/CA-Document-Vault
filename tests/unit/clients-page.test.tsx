import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import ClientsPage from "@/app/(app)/clients/page";

describe("Clients page (skeleton)", () => {
  it("shows the page heading and zero count", () => {
    render(<ClientsPage />);
    expect(screen.getByRole("heading", { name: "Clients" })).toBeInTheDocument();
    expect(screen.getByText("0 clients")).toBeInTheDocument();
  });
});
