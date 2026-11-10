"use client";
import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/client";
import { Alert, Field } from "@/components/ui";
import { AuthShell } from "@/components/auth-shell";

function TwoFactor() {
  const router = useRouter();
  const params = useSearchParams();
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const n = params.get("next");
  const next = n && n.startsWith("/") && !n.startsWith("//") ? n : "/painel";

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    setErr(""); setBusy(true);
    const sb = supabaseBrowser();
    const { data: f } = await sb.auth.mfa.listFactors();
    const factor = f?.totp?.find((x: { status: string }) => x.status === "verified");
    if (!factor) { router.replace(next); return; }
    const { error } = await sb.auth.mfa.challengeAndVerify({ factorId: factor.id, code: code.trim() });
    setBusy(false);
    if (error) { setErr("Código inválido ou expirado."); return; }
    router.replace(next);
    router.refresh();
  }

  return (
    <AuthShell>
      <form onSubmit={verify} className="space-y-4">
        <span className="grid h-12 w-12 place-items-center rounded-2xl bg-brand-50 text-brand-600" aria-hidden="true">
          <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>
        </span>
        <h1 className="text-3xl font-black tracking-tight">Verificação em duas etapas</h1>
        <p className="text-sm text-zinc-600">Digite o código de 6 dígitos do seu app autenticador.</p>
        <Field label="Código">
          <input className="input text-center text-lg tracking-[0.5em]" inputMode="numeric" pattern="[0-9]{6}" maxLength={6}
            required autoFocus value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} autoComplete="one-time-code" />
        </Field>
        <Alert>{err}</Alert>
        <button className="btn-primary w-full py-3" disabled={busy}>{busy ? "Verificando..." : "Verificar"}</button>
        <button type="button" className="btn-ghost w-full" onClick={async () => { await supabaseBrowser().auth.signOut(); router.replace("/login"); }}>
          Sair
        </button>
      </form>
    </AuthShell>
  );
}

export default function Page() {
  return <Suspense><TwoFactor /></Suspense>;
}
