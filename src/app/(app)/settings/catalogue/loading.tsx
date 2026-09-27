import { PageSkeleton } from "@/components/states";

/** Skeleton while the catalogue loads (spec: every screen has a loading state). */
export default function Loading() {
  return <PageSkeleton label="Loading the catalogue…" variant="cards" />;
}
