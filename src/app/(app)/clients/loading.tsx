import { PageSkeleton } from "@/components/states";

/** Skeleton while the clients list loads (spec: every screen has a loading state). */
export default function Loading() {
  return <PageSkeleton label="Loading clients…" variant="list" />;
}
