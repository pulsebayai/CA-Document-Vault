import { describe, expect, it } from "vitest";
import { lastActivityLine, whenText } from "@/lib/activity-feed/last-activity";

// Feature 15 (spec AC-5) — the Last activity column: "<who> · <sentence> · <when>". The sentence is 08's catalogue
// sentence for the action; who = the actor's name, or "Vault" for rows the system wrote; when = relative within 7 days
// ("just now", "5 min ago", "3 h ago", "yesterday", "4 days ago"), then the date ("12 Oct" this year, "12 Oct 2025"
// before). No event → "—".

const NOW = new Date("2026-11-01T10:00:00Z");
const row = (over: Record<string, unknown> = {}) => ({
  id: 1, at: "2026-11-01T09:55:00Z", action: "document.ready", entity_type: "document", data: {}, actor_id: "a",
  actor_name: "Priya", doc_type_name: "Bank statement", doc_group_name: "Banking", ...over,
});

describe("lastActivityLine (AC-5)", () => {
  it("who · sentence · when, from 08's catalogue", () => {
    expect(lastActivityLine(row(), NOW)).toBe("Priya · marked Bank statement ready to dispatch · 5 min ago");
  });

  it("a system row says Vault; a missing event is a dash; an unknown action still says something", () => {
    expect(lastActivityLine(row({ actor_id: null, actor_name: null, action: "document.link_upload" }), NOW))
      .toBe("Vault · received Bank statement through the client's upload link · 5 min ago");
    expect(lastActivityLine(null, NOW)).toBe("—");
    expect(lastActivityLine(row({ action: "something.new" }), NOW)).toMatch(/^Priya · .+ · 5 min ago$/);
  });
});

describe("whenText (AC-5)", () => {
  it("relative within 7 days, then the date", () => {
    expect(whenText("2026-11-01T09:59:40Z", NOW)).toBe("just now");
    expect(whenText("2026-11-01T07:00:00Z", NOW)).toBe("3 h ago");
    expect(whenText("2026-10-31T09:00:00Z", NOW)).toBe("yesterday");
    expect(whenText("2026-10-28T09:00:00Z", NOW)).toBe("4 days ago");
    expect(whenText("2026-10-12T09:00:00Z", NOW)).toBe("12 Oct");
    expect(whenText("2025-10-12T09:00:00Z", NOW)).toBe("12 Oct 2025");
  });
});
