/** Skeleton while the clients list loads (spec: every screen has a loading state). */
export default function Loading() {
  return (
    <div aria-busy="true" aria-label="Loading clients">
      <div className="mb-5 h-12 w-48 animate-pulse rounded-lg bg-panel" />
      <div className="mb-4 h-10 w-full max-w-[440px] animate-pulse rounded-[10px] bg-panel" />
      <div className="h-64 animate-pulse rounded-xl bg-panel shadow-card" />
    </div>
  );
}
