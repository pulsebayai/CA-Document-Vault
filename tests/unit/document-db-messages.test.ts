import { describe, expect, it } from "vitest";
import { documentDbError } from "@/lib/documents/db-messages";

// Feature 13 (spec AC-7, S5; pre-PR review I-1): an edit the custody rules refuse gets a plain message on the right
// field, never the generic "Couldn't save". The database side is tests/rls/custody.test.ts (S5).

describe("documentDbError", () => {
  it("CUSTODY_SOFT_COPY: undo Document in office first (on Received as)", () => {
    expect(documentDbError("CUSTODY_SOFT_COPY: undo Document in office first; a document in the office is a hard copy")).toEqual({
      error: "This document is marked in the office. Undo Document in office on the document page before making it a soft copy.",
      fieldErrors: { receivedAs: "This document is marked in the office. Undo Document in office on the document page before making it a soft copy." },
    });
  });

  it("CUSTODY_READY: undo Ready to dispatch first (on Returnable)", () => {
    expect(documentDbError("CUSTODY_READY: undo Ready to dispatch first").fieldErrors).toEqual({
      returnable: "This document is ready to dispatch. Undo Ready to dispatch on the document page before unticking Returnable.",
    });
  });

  it("keeps the earlier mappings and the generic fallback", () => {
    expect(documentDbError("DISPATCHED: …").fieldErrors).toHaveProperty("clientId");
    expect(documentDbError("something else").error).toBe("Couldn't save the document. Please try again.");
  });
});
