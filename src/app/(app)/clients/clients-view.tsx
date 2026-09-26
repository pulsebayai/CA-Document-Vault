import { Card, PageHeader } from "@/components/ui";

/** One row of the clients list (mockup 03). Filled in by step 7 of feature 02. */
export type ClientListItem = {
  id: string;
  code: string;
  name: string;
};

/** Presentational Clients list: data comes in as props, no fetching (keeps it unit-testable). */
export function ClientsView({ clients, total }: { clients: ClientListItem[]; total: number }) {
  return (
    <>
      <PageHeader title="Clients" subtitle={`${total} ${total === 1 ? "client" : "clients"}`} />
      {clients.length === 0 ? (
        <Card className="px-6 py-12 text-center">
          <p className="font-medium">No clients yet</p>
          <p className="mt-1 text-ink-2">Add a client or import a CSV to get started.</p>
        </Card>
      ) : null}
    </>
  );
}
