import { PageSkeleton } from "@/components/states";

/** Skeleton while the collection figures load (every screen has a loading state). */
export default function Loading() {
  return <PageSkeleton label="Loading the collection figures…" variant="cards" />;
}
