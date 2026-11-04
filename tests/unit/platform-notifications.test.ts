import { describe, expect, it, vi } from "vitest";
import { ACTIVITY_CATALOGUE, describeActivity, type ActivityRowView } from "@/lib/activity-feed/catalogue";
import { lastActivityLine } from "@/lib/activity-feed/last-activity";

// Feature 19 (spec AC-8, AC-13; plan step 7): what a firm sees of support access — its Activity sentences and the
// bell for its Admins. Rows hold IDs and the view name only; names come from 08's feed under the viewer's RLS.

const h = vi.hoisted(() => ({ rows: [] as unknown[], types: [] as unknown[] }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (table: string) => {
      const chain = {
        select: (_cols: string, opts?: { head?: boolean }) => (opts?.head ? { is: async () => ({ count: 1, error: null }) } : chain),
        order: () => chain, in: async () => ({ data: h.types, error: null }),
        limit: async () => ({ data: table === "notification" ? h.rows : [], error: null }),
      };
      return chain;
    },
  }),
}));

const row = (action: string, data: Record<string, unknown>, extra: Partial<ActivityRowView> = {}): ActivityRowView =>
  ({ action, actor_name: null, client_name: null, doc_code: null, doc_type_name: null, doc_group_name: null, data, ...extra });

describe("Activity sentences (AC-13)", () => {
  it("support's reads name what was read, as Pulsebay support", () => {
    const s = (r: ActivityRowView) => describeActivity(r).sentence;
    expect(s(row("platform.access_opened", { access_id: "a" }))).toBe("Pulsebay support opened read-only access to the firm's data for 60 minutes");
    expect(s(row("platform.viewed", { view: "client", client_id: "c" }, { client_name: "Sharma Traders" }))).toBe("Pulsebay support viewed Sharma Traders");
    expect(s(row("platform.viewed", { view: "document", document_id: "d" }, { doc_code: "DOC-FY26-27-00004" }))).toBe("Pulsebay support viewed DOC-FY26-27-00004");
    expect(s(row("platform.viewed", { view: "expected", client_id: "c" }, { client_name: "Sharma Traders" }))).toBe("Pulsebay support viewed the expected documents of Sharma Traders");
    expect(s(row("platform.viewed", { view: "documents", client_id: "c" }, { client_name: "Sharma Traders" }))).toBe("Pulsebay support viewed the documents of Sharma Traders");
    expect(s(row("platform.viewed", { view: "documents" }))).toBe("Pulsebay support viewed the document list");
    expect(s(row("platform.viewed", { view: "clients" }))).toBe("Pulsebay support viewed the client list");
    expect(s(row("platform.viewed", { view: "activity" }))).toBe("Pulsebay support viewed the firm's activity");
  });

  it("a name the viewer can't see falls back instead of going blank (08's rule)", () => {
    expect(describeActivity(row("platform.viewed", { view: "client", client_id: "c" })).sentence).toBe("Pulsebay support viewed a client");
    expect(describeActivity(row("platform.viewed", { view: "document", document_id: "d" })).sentence).toBe("Pulsebay support viewed a document");
  });

  it("suspension, reactivation and the first Admin's invite from the console", () => {
    expect(describeActivity(row("office.suspended", {})).sentence).toBe("Pulsebay support paused the firm's access to the vault");
    expect(describeActivity(row("office.reactivated", {})).sentence).toBe("Pulsebay support restored the firm's access to the vault");
    expect(describeActivity(row("staff.invited", { role: "admin", via: "platform" })).sentence).toBe("Pulsebay support invited a user");
  });

  it("other system rows stay \"Vault\", and staff rows keep the staff member's first name", () => {
    expect(describeActivity(row("staff.invited", { role: "admin", via: "bootstrap" })).sentence).toBe("Vault invited a user");
    expect(describeActivity(row("expected.generated", {})).sentence).toMatch(/^Vault /);
    expect(describeActivity(row("staff.invited", { role: "staff" }, { actor_name: "Ravi Kumar" })).sentence).toBe("Ravi invited a user");
  });

  it("15's Last activity line uses the same actor", () => {
    const line = lastActivityLine({ id: 1, at: new Date().toISOString(), action: "platform.viewed", entity_type: "platform_access",
      data: { view: "document" }, actor_id: null, actor_name: null, doc_type_name: null, doc_group_name: null });
    expect(line).toMatch(/^Pulsebay support · viewed a document · /);
  });

  it("every platform action is in the catalogue", () => {
    for (const a of ["platform.access_opened", "platform.viewed", "office.suspended", "office.reactivated"]) expect(ACTIVITY_CATALOGUE[a], a).toBeDefined();
  });
});

describe("the bell (AC-8)", () => {
  it("a platform_access notification reads as support access, with no reason, name or ID in the text", async () => {
    h.rows = [{ id: "n1", kind: "platform_access", created_at: "2026-11-04T10:00:00Z", read_at: null, data: { access_id: "a1" } }];
    const { loadNotifications } = await import("@/lib/notifications/queries");
    const list = await loadNotifications();
    expect(list.items).toEqual([{ id: "n1", createdAt: "2026-11-04T10:00:00Z", unread: true,
      text: "Pulsebay support opened read-only access to your firm's data for 60 minutes. Everything they view is listed in Activity." }]);
  });

  it("type decisions still read as before (the type lookup is only for them)", async () => {
    h.rows = [{ id: "n2", kind: "type_decision", created_at: "2026-11-04T10:00:00Z", read_at: "2026-11-04T10:05:00Z", data: { decision: "approved", doc_type_id: "t1" } }];
    h.types = [{ id: "t1", name: "Rent receipts", decision_comment: null, doc_group: { name: "Income Tax" } }];
    const { loadNotifications } = await import("@/lib/notifications/queries");
    const list = await loadNotifications();
    expect(list.items[0]).toMatchObject({ id: "n2", unread: false, text: expect.stringContaining("Rent receipts") });
  });
});
