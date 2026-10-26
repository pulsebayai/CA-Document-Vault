import { describe, expect, it } from "vitest";
import { PERMISSIONS, cellText } from "@/lib/auth/permissions";
import { ROLES } from "@/lib/auth/roles";

// Feature 08 AC-12 — the matrix shown on Settings › Users, as approved (spec AC-12 + D4 rows, Raja 2026-10-02).
// tests/rls/role-matrix.test.ts proves each cell against the database.

describe("permissions matrix (AC-12)", () => {
  it("row IDs are unique and every row has a cell for every role", () => {
    expect(new Set(PERMISSIONS.map((r) => r.id)).size).toBe(PERMISSIONS.length);
    for (const r of PERMISSIONS) expect(Object.keys(r.values).sort()).toEqual([...ROLES].sort());
  });

  it("reads exactly as approved", () => {
    expect(PERMISSIONS.map((r) => [r.label, ...ROLES.map((role) => cellText(r, role))])).toEqual([
      ["See clients and their documents", "All", "All", "All", "Assigned"],
      ["Add, edit and import clients", "Yes", "Yes", "Yes", "No"],
      ["Add documents and file the Inbox", "Yes", "Yes", "Yes", "Assigned + own Inbox"],
      ["Propose a new type while filing", "Yes", "Yes", "Yes", "No"],
      ["Review, mark needs correction, dispatch originals", "Yes", "Yes", "Yes", "Assigned"],
      ["Undo a review or a dispatch", "Yes", "Yes", "No", "No"],
      ["Archive or unarchive documents and clients", "Yes", "Yes", "No", "No"],
      ["Waive an expected document", "Yes", "Yes", "Yes", "No"],
      ["Reopen an expected document", "Yes", "Yes", "Yes", "Assigned"],
      ["Undo a waive", "Yes", "Yes", "No", "No"],
      ["Remind clients (email, WhatsApp) and log calls", "Yes", "Yes", "Yes", "Assigned"],
      // 10 spec AC-5 (approved Raja 2026-10-25): two rows added; no existing row changed.
      ["Send upload links to clients", "Yes", "Yes", "Yes", "Assigned"],
      ["Revoke an upload link someone else sent", "Yes", "Yes", "No", "No"],
      ["Change collection plans (add, remove types/groups)", "Yes", "Yes", "Yes", "No"],
      ["Assign incharge and group staff, pause and resume", "Yes", "Yes", "No", "No"],
      ["Manage catalogue, approve proposed types, Settings › Collection", "Yes", "Yes", "No", "No"],
      ["Add a financial year", "Yes", "No", "No", "No"],
      ["See Activity", "All", "All", "All", "Own + assigned clients"],
      ["Manage users and roles", "Yes", "No", "No", "No"],
    ]);
  });
});
