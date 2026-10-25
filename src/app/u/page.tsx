import { UploadView } from "./upload-view";

// Feature 10 — public upload page (spec AC-6…AC-10). Static shell: the token is in the URL fragment, which the
// browser never sends, so the server learns it only from the page's own POSTs.
export const dynamic = "force-dynamic";

export default function UploadPage() {
  return (
    <main className="mx-auto w-full max-w-[560px] px-4 py-6">
      <UploadView />
    </main>
  );
}
