import { PageSkeleton } from "@/components/states";

/** Skeleton while Settings › Office loads (every screen has a loading state). */
export default function Loading() {
  return <PageSkeleton label="Loading the office details…" variant="cards" />;
}
