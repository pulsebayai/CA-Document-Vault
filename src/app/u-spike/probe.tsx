"use client";
import { useEffect, useState } from "react";

export function FragmentProbe() {
  const [hash, setHash] = useState<string | null>(null);
  const [agent, setAgent] = useState("");
  useEffect(() => { setHash(window.location.hash); setAgent(navigator.userAgent); }, []);
  if (hash === null) return <p>Checking…</p>;
  return (
    <div>
      <p><strong>Fragment received:</strong> {hash ? `YES — "${hash}"` : "NO (empty)"}</p>
      <p style={{ fontSize: 14, color: "#555" }}>{agent}</p>
    </div>
  );
}
