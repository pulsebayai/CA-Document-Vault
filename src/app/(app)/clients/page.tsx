import { Card, PageHeader } from "@/components/ui";

/** Mockup 03-clients.jpg header; real list arrives in feature 02. */
export default function ClientsPage() {
  return (
    <>
      <PageHeader title="Clients" subtitle="0 clients" />
      <Card className="px-6 py-12 text-center">
        <p className="font-medium">No clients yet</p>
        <p className="mt-1 text-ink-2">Clients are added in the next release.</p>
      </Card>
    </>
  );
}
