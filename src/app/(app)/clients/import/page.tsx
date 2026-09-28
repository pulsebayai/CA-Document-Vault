import Link from "next/link";
import { notFound } from "next/navigation";
import { requireStaff } from "@/lib/auth/staff";
import { PageHeader } from "@/components/ui";
import { ImportView } from "./import-view";

/** Clients › Import CSV (spec AC-13 … AC-16). Staff+; Limited users get Not Found. */
export default async function ImportClientsPage() {
  const me = await requireStaff();
  if (me.role === "limited") notFound();
  return (
    <div className="mx-auto max-w-[960px]">
      <p className="mb-2 text-[13.5px]"><Link href="/clients" className="text-accent hover:underline">← Clients</Link></p>
      <PageHeader title="Import clients" subtitle="Upload a CSV, check the preview, then import. Codes are assigned in file order." />
      <ImportView />
    </div>
  );
}
