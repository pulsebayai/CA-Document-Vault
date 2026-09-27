import { PageSkeleton } from "@/components/states";

/** Add client form skeleton (loads staff and groups). */
export default function Loading() {
  return <PageSkeleton label="Loading the form…" variant="form" />;
}
