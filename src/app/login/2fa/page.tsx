"use client";
import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/client";
import { Alert, Field, Logo } from "@/components/ui";

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
    <main className="flex min-h-screen items-center justify-center bg-brand-50 px-4">
      <form onSubmit={verify} className="card w-full max-w-sm space-y-4 p-6">
        <Logo />
        <h1 className="text-xl font-bold">Verificação em duas etapas</h1>
        <p className="text-sm text-zinc-600">Digite o código de 6 dígitos do seu app autenticador.</p>
        <Field label="Código">
          <input className="input text-center text-lg tracking-[0.5em]" inputMode="numeric" pattern="[0-9]{6}" maxLength={6}
            required autoFocus value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} autoComplete="one-time-code" />
        </Field>
        <Alert>{err}</Alert>
        <button className="btn-primary w-full" disabled={busy}>{busy ? "Verificando..." : "Verificar"}</button>
        <button type="button" className="btn-ghost w-full" onClick={async () => { await supabaseBrowser().auth.signOut(); router.replace("/login"); }}>
          Sair
        </button>
      </form>
    </main>
  );
}

export default function Page() {
  return <Suspense><TwoFactor /></Suspense>;
}
