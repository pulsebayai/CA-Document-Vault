import { PageSkeleton } from "@/components/states";

export default function Loading() {
  return <div className="mx-auto max-w-[1100px]"><PageSkeleton label="Loading documents" variant="list" /></div>;
}
