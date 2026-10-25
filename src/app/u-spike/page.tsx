// SPIKE ONLY (feature 10, plan step 0b) — never merged. Shows whether the URL fragment survives a WhatsApp tap.
import { FragmentProbe } from "./probe";

export const dynamic = "force-dynamic";

export default function Page() {
  return (
    <main style={{ padding: 24, fontFamily: "system-ui", fontSize: 20 }}>
      <h1>Link check</h1>
      <FragmentProbe />
    </main>
  );
}
