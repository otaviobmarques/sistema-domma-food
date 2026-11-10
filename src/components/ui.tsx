"use client";
import { useEffect } from "react";

export function LogoMark({ className = "h-8 w-8", inverted = false }: { className?: string; inverted?: boolean }) {
  // Marca própria: prato visto de cima formando um "d" + ponto de tempero.
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      <rect width="32" height="32" rx="9" fill={inverted ? "#fff" : "#d9262b"} />
      <circle cx="14" cy="18" r="7.5" fill="none" stroke={inverted ? "#d9262b" : "#fff"} strokeWidth="3" />
      <path d="M21.5 6.5v19" stroke={inverted ? "#d9262b" : "#fff"} strokeWidth="3" strokeLinecap="round" />
      <circle cx="14" cy="18" r="2.2" fill="#fbbf24" />
    </svg>
  );
}

export function Logo({ dark = false }: { dark?: boolean }) {
  return (
    <span className={`inline-flex items-center gap-2 text-lg font-extrabold tracking-tight ${dark ? "text-white" : "text-zinc-900"}`}>
      <LogoMark inverted={dark} />
      <span>domma <span className={dark ? "text-brand-200" : "text-brand-600"}>food</span></span>
    </span>
  );
}

export function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-zinc-500">{hint}</span>}
    </label>
  );
}

export function Alert({ kind = "error", children }: { kind?: "error" | "success" | "info"; children: React.ReactNode }) {
  if (!children) return null;
  const cls = { error: "border-red-200 bg-red-50 text-red-800", success: "border-green-200 bg-green-50 text-green-800", info: "border-amber-200 bg-amber-50 text-amber-900" }[kind];
  return <div role={kind === "error" ? "alert" : "status"} className={`rounded-xl border px-3.5 py-2.5 text-sm ${cls}`}>{children}</div>;
}

export function Modal({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: string; children: React.ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-zinc-950/50 backdrop-blur-[2px] sm:items-center sm:p-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label={title}
        className={`max-h-[92vh] w-full overflow-y-auto rounded-t-3xl bg-white p-5 shadow-lift sm:rounded-3xl ${wide ? "sm:max-w-3xl" : "sm:max-w-lg"}`}
        onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-extrabold tracking-tight">{title}</h2>
          <button className="grid h-9 w-9 place-items-center rounded-full bg-zinc-100 text-zinc-600 transition hover:bg-zinc-200" onClick={onClose} aria-label="Fechar">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition ${checked ? "bg-brand-600" : "bg-zinc-300"}`}>
      <span className={`inline-block h-5 w-5 rounded-full bg-white shadow transition ${checked ? "translate-x-5" : "translate-x-0.5"}`} />
    </button>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="rounded-2xl border border-dashed border-zinc-300 bg-white/60 p-10 text-center text-sm text-zinc-500">{children}</div>;
}
