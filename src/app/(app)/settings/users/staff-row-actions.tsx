"use client";

import { useState, useTransition } from "react";
import { changeRole, deactivateStaff, reactivateStaff, type ActionResult } from "@/lib/staff/actions";
import { ROLES, ROLE_LABEL, type Role } from "@/lib/auth/roles";
import { Button } from "@/components/ui";

type Props = { id: string; name: string; role: Role; status: "invited" | "active" | "deactivated"; lastAdmin: boolean };

export function StaffRowActions({ id, name, role, status, lastAdmin }: Props) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);
  const run = (fn: () => Promise<ActionResult>) => start(async () => setResult(await fn()));

  return (
    <div className="flex items-center justify-end gap-2">
      {status !== "deactivated" && (
        <label className="sr-only" htmlFor={`role-${id}`}>Role for {name}</label>
      )}
      {status !== "deactivated" && (
        <select id={`role-${id}`} defaultValue={role} disabled={pending || lastAdmin}
          title={lastAdmin ? "The office must keep at least one active Admin" : undefined}
          onChange={(e) => run(() => changeRole(id, e.target.value as Role))}
          className="h-[30px] rounded-[7px] border border-line-2 bg-panel px-2 text-[13px]">
          {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
        </select>
      )}
      {status === "deactivated" ? (
        <Button size="sm" variant="secondary" disabled={pending} onClick={() => run(() => reactivateStaff(id))}>Reactivate</Button>
      ) : (
        <Button size="sm" variant="danger" disabled={pending || lastAdmin}
          title={lastAdmin ? "The office must keep at least one active Admin" : undefined}
          onClick={() => { if (window.confirm(`Remove ${name}'s access? They are signed out immediately.`)) run(() => deactivateStaff(id)); }}>
          Deactivate
        </Button>
      )}
      {result && !result.ok && <span role="alert" className="text-[13px] text-bad">{result.error}</span>}
    </div>
  );
}
