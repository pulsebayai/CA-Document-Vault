import { redirect } from "next/navigation";

// Root sends everyone to Today, the landing page (spec 06 AC-1).
export default function Home() {
  redirect("/today");
}
