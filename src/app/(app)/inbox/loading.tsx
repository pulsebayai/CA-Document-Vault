import { PageSkeleton } from "@/components/states";

export default function Loading() {
  return <div className="mx-auto max-w-[815px]"><PageSkeleton label="Loading untagged documents" variant="list" /></div>;
}
