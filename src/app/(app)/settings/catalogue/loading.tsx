/** Skeleton while the catalogue loads (spec: every screen has a loading state). */
export default function Loading() {
  return (
    <div aria-busy="true" aria-label="Loading the catalogue" className="space-y-5">
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-40 animate-pulse rounded-xl bg-panel shadow-card" />
      ))}
    </div>
  );
}
