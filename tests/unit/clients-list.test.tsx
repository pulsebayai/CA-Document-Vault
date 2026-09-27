import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ClientsView, type ClientListItem } from "@/app/(app)/clients/clients-view";
import { PAGE_SIZE, parseClientSearch } from "@/lib/validation/client-search";

afterEach(cleanup);

// Spec 02 AC-7: list, search, filters. Search state never goes in the URL, so it is validated as a POST body.
describe("parseClientSearch", () => {
  it("fills defaults for an empty request", () => {
    expect(parseClientSearch({})).toEqual({ query: "", clientType: null, inchargeId: null, includeArchived: false, page: 1 });
  });
  it("trims the query and caps it at 100 characters", () => {
    expect(parseClientSearch({ query: "  alpha  " }).query).toBe("alpha");
    expect(parseClientSearch({ query: "x".repeat(150) }).query).toHaveLength(100);
  });
  it("drops unknown client types and malformed ids instead of failing", () => {
    expect(parseClientSearch({ clientType: "robot", inchargeId: "not-a-uuid" })).toMatchObject({ clientType: null, inchargeId: null });
    expect(parseClientSearch({ clientType: "llp", inchargeId: "00000000-0000-4000-8000-000000000001" }))
      .toMatchObject({ clientType: "llp", inchargeId: "00000000-0000-4000-8000-000000000001" });
  });
  it("keeps page within 1…1000", () => {
    expect(parseClientSearch({ page: 0 }).page).toBe(1);
    expect(parseClientSearch({ page: 3 }).page).toBe(3);
    expect(parseClientSearch({ page: 1e9 }).page).toBe(1000);
    expect(parseClientSearch({ page: "2" as unknown as number }).page).toBe(1);
  });
  it("pages are 50 clients", () => expect(PAGE_SIZE).toBe(50));
});

const row = (over: Partial<ClientListItem>): ClientListItem => ({
  id: crypto.randomUUID(), code: "C0001", name: "Alpha Traders", clientType: "proprietorship", pan: "ZZZPZ4101Z",
  inchargeName: "Priya", groups: ["GST", "Banking"], pausedGroups: ["TDS/TCS"], archived: false, ...over,
});

describe("ClientsView with clients (mockup 03)", () => {
  it("shows name, then type · PAN · incharge · enabled groups, paused groups and archived badges", () => {
    render(<ClientsView clients={[row({}), row({ name: "Old Co", code: "C0002", pan: null, groups: [], pausedGroups: [], archived: true })]} total={2} matched={2} />);
    const alpha = screen.getByRole("listitem", { name: "Alpha Traders" });
    expect(alpha).toHaveTextContent("Proprietorship · ZZZPZ4101Z · Incharge Priya · GST, Banking");
    expect(within(alpha).getByText("TDS/TCS paused")).toBeInTheDocument();
    expect(within(alpha).getByRole("link", { name: "Alpha Traders" })).toHaveAttribute("href", expect.stringMatching(/^\/clients\/[0-9a-f-]{36}$/));
    const old = screen.getByRole("listitem", { name: "Old Co" });
    expect(old).toHaveTextContent("Proprietorship · Incharge Priya");
    expect(within(old).getByText("Archived")).toBeInTheDocument();
    expect(screen.getByText("2 clients")).toBeInTheDocument();
  });

  it("says when a search finds nothing (not the first-run empty state)", () => {
    render(<ClientsView clients={[]} total={12} matched={0} filtered />);
    expect(screen.getByText("12 clients")).toBeInTheDocument();
    expect(screen.getByText("No clients match")).toBeInTheDocument();
    expect(screen.queryByText("No clients yet")).toBeNull();
  });

  it("shows the range when results are filtered or paged", () => {
    render(<ClientsView clients={[row({})]} total={120} matched={51} filtered firstIndex={50} />);
    expect(screen.getByText("Showing 51–51 of 51")).toBeInTheDocument();
  });
});
