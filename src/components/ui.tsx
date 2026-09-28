import type { ButtonHTMLAttributes, ReactNode } from "react";

// Buttons and cards per references/ui-reference.md.
type Variant = "primary" | "secondary" | "danger";
const base = "inline-flex items-center justify-center gap-1.5 font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50";
const variants: Record<Variant, string> = {
  primary: "bg-accent text-white hover:bg-[#264d8f]",
  secondary: "border border-line-2 bg-panel text-ink hover:bg-canvas",
  danger: "border border-line-2 bg-panel text-bad hover:bg-bad-soft",
};

export function Button({ variant = "primary", size = "md", className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "md" | "sm" }) {
  const sizing = size === "sm" ? "h-[30px] rounded-[7px] px-2.5 text-[13px]" : "rounded-[9px] px-3.5 py-2";
  return <button className={`${base} ${variants[variant]} ${sizing} ${className}`} {...props} />;
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-xl bg-panel shadow-card ${className}`}>{children}</div>;
}

export function Badge({ tone, children }: { tone: "ok" | "warn" | "bad" | "muted" | "accent"; children: ReactNode }) {
  const tones = {
    ok: "bg-ok-soft text-ok", warn: "bg-warn-soft text-warn", bad: "bg-bad-soft text-bad",
    muted: "bg-canvas text-ink-2", accent: "bg-accent-soft text-accent",
  };
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${tones[tone]}`}>{children}</span>;
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-[22px] font-semibold leading-tight">{title}</h1>
        {subtitle && <p className="mt-1 text-ink-3">{subtitle}</p>}
      </div>
      {actions}
    </div>
  );
}

export function BrandMark() {
  return (
    <span aria-hidden className="grid h-7 w-7 place-items-center rounded-[7px] bg-ink text-white">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" />
      </svg>
    </span>
  );
}

/**
 * Toggle (mockup 05 "Enabled for new clients", reminders). A real switch for assistive tech:
 * role="switch" + aria-checked, and it always needs an accessible label.
 */
export function Switch({ checked, label, onChange, disabled, id }: {
  checked: boolean; label: string; onChange?: (next: boolean) => void; disabled?: boolean; id?: string;
}) {
  return (
    <button type="button" role="switch" id={id} aria-checked={checked} aria-label={label} disabled={disabled}
      onClick={() => onChange?.(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-60 ${checked ? "bg-accent" : "bg-line-2"}`}>
      <span aria-hidden className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${checked ? "translate-x-[18px]" : "translate-x-0.5"}`} />
    </button>
  );
}
