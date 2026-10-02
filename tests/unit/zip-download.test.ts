// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

// Feature 08 AC-2 — the browser-side zip: batches of ≤ 10 links, '<DOC-ID> <file>' entries, failed files left out and
// listed, cancel. Real client-zip; the server actions and fetch are fakes. tests/rls/bulk.test.ts covers the server.
vi.mock("@/lib/bulk/actions", () => ({ getZipManifest: vi.fn(), getFileLinks: vi.fn(), markReviewedBulk: vi.fn() }));
const { chunk, runZip, zipFileName } = await import("@/components/zip-download");

/** Entry names from a zip's central directory (enough to check what the zip holds). */
async function zipNames(blob: Blob): Promise<Map<string, number>> {
  const b = Buffer.from(await blob.arrayBuffer());
  const out = new Map<string, number>();
  for (let i = 0; i < b.length - 46; i++) {
    if (b.readUInt32LE(i) !== 0x02014b50) continue;
    const size = b.readUInt32LE(i + 24);
    const len = b.readUInt16LE(i + 28);
    out.set(b.subarray(i + 46, i + 46 + len).toString("utf8"), size);
    i += 45 + len;
  }
  return out;
}

const entry = (n: number) => ({
  documentId: `doc-${n}`, docCode: `DOC-FY26-27-${String(n).padStart(5, "0")}`, versionId: `ver-${n}`,
  fileName: `file ${n}.pdf`, size: n * 10, entryName: `DOC-FY26-27-${String(n).padStart(5, "0")} file ${n}.pdf`,
});

function fakes(count: number, opts: { failFetch?: Set<number>; noLink?: Set<number>; missing?: Array<{ documentId: string; reason: "not_found" | "no_file" }> } = {}) {
  const entries = Array.from({ length: count }, (_, i) => entry(i + 1));
  const batches: string[][] = [];
  const deps = {
    manifest: vi.fn(async () => ({ ok: true as const, entries, missing: opts.missing ?? [], totalBytes: 0 })),
    links: vi.fn(async (versionIds: string[]) => {
      batches.push(versionIds);
      return { ok: true as const, links: versionIds.map((v) => ({ versionId: v, url: opts.noLink?.has(Number(v.slice(4))) ? null : `https://storage.test/${v}` })) };
    }),
    fetchFile: vi.fn(async (url: string) => {
      const n = Number(url.split("ver-")[1]);
      if (opts.failFetch?.has(n)) return new Response("nope", { status: 500 });
      return new Response(new Uint8Array(n * 10).fill(n));
    }),
  };
  return { deps, batches, entries };
}

describe("zip helpers", () => {
  it("chunks and the zip file name (India date, no client names)", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(zipFileName(new Date("2026-10-01T19:00:00Z"))).toBe("vault-documents-2026-10-02.zip");
  });
});

describe("runZip (AC-2)", () => {
  it("asks for links in batches of ≤ 10 and zips every file as '<DOC-ID> <file name>'", async () => {
    const { deps, batches, entries } = fakes(23);
    const progress: number[] = [];
    const r = await runZip(entries.map((e) => ({ id: e.documentId, docCode: e.docCode })), deps, new AbortController().signal, (d) => progress.push(d));
    if ("error" in r) throw new Error(r.error);
    expect(batches.map((b) => b.length)).toEqual([10, 10, 3]);
    expect(r).toMatchObject({ saved: 23, total: 23, failed: [], cancelled: false });
    const names = await zipNames(r.blob!);
    expect(names.size).toBe(23);
    expect(names.get("DOC-FY26-27-00007 file 7.pdf")).toBe(70);
    expect(progress.at(-1)).toBe(23);
  });

  it("leaves failed and unsigned files out, lists them with missing ones, and still saves the rest", async () => {
    const { deps, entries } = fakes(5, {
      failFetch: new Set([2]), noLink: new Set([4]), missing: [{ documentId: "doc-x", reason: "no_file" }],
    });
    const targets = [...entries.map((e) => ({ id: e.documentId, docCode: e.docCode })), { id: "doc-x", docCode: "DOC-FY26-27-00099" }];
    const r = await runZip(targets, deps, new AbortController().signal, () => {});
    if ("error" in r) throw new Error(r.error);
    expect(r.saved).toBe(3);
    expect(r.failed).toEqual([
      { documentId: "doc-x", docCode: "DOC-FY26-27-00099", why: "no_file" },
      { documentId: "doc-2", docCode: "DOC-FY26-27-00002", why: "failed" },
      { documentId: "doc-4", docCode: "DOC-FY26-27-00004", why: "failed" },
    ]);
    expect([...(await zipNames(r.blob!)).keys()]).toEqual(["DOC-FY26-27-00001 file 1.pdf", "DOC-FY26-27-00003 file 3.pdf", "DOC-FY26-27-00005 file 5.pdf"]);
  });

  it("returns the server's message when the selection is over the cap", async () => {
    const deps = { manifest: vi.fn(async () => ({ ok: false as const, error: "Up to 100 files / 300 MB per zip; narrow the filter." })), links: vi.fn(), fetchFile: vi.fn() };
    const r = await runZip([{ id: "a", docCode: "A" }], deps, new AbortController().signal, () => {});
    expect(r).toEqual({ error: "Up to 100 files / 300 MB per zip; narrow the filter." });
    expect(deps.links).not.toHaveBeenCalled();
  });

  it("Cancel stops asking for links and saves nothing", async () => {
    const { deps, batches, entries } = fakes(25);
    const ctrl = new AbortController();
    const r = await runZip(entries.map((e) => ({ id: e.documentId, docCode: e.docCode })), deps, ctrl.signal, (done) => { if (done === 5) ctrl.abort(); });
    if ("error" in r) throw new Error(r.error);
    expect(r).toMatchObject({ blob: null, cancelled: true });
    expect(batches).toHaveLength(1);
  });
});
