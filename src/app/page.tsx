import { redirect } from "next/navigation";

// Root sends everyone to the Clients screen; auth redirects are added in step 6.
export default function Home() {
  redirect("/clients");
}
