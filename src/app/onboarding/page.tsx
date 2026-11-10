"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/client";
import { Alert, Field, Logo } from "@/components/ui";
import { slugify } from "@/lib/format";

export default function Onboarding() {
  const router = useRouter();
  const [company, setCompany] = useState("");
  const [store, setStore] = useState("");
  const [slug, setSlug] = useState("");
  const [touched, setTouched] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(""); setBusy(true);
    const { error } = await supabaseBrowser().rpc("create_tenant", {
      p_company: company || store, p_unit_name: store, p_slug: slug, p_seed: true,
    });
    setBusy(false);
    if (error) { setErr(error.message.includes("slug") ? "Endereço inválido ou reservado." : error.message); return; }
    router.replace("/painel");
    router.refresh();
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-brand-50 px-4">
      <form onSubmit={submit} className="card w-full max-w-md space-y-4 p-6">
        <Logo />
        <h1 className="text-xl font-bold">Vamos criar sua loja</h1>
        <Field label="Nome da loja">
          <input className="input" required minLength={2} maxLength={120} value={store} placeholder="Bella Massa Pizzaria"
            onChange={(e) => { setStore(e.target.value); if (!touched) setSlug(slugify(e.target.value)); }} />
        </Field>
        <Field label="Razão social / nome da empresa" hint="Opcional. Se tiver várias lojas, todas ficam nesta empresa.">
          <input className="input" maxLength={120} value={company} onChange={(e) => setCompany(e.target.value)} />
        </Field>
        <Field label="Endereço do seu cardápio" hint="Só letras minúsculas, números e hífen.">
          <div className="flex items-center rounded-lg border border-zinc-300 bg-zinc-50 text-sm">
            <span className="pl-3 text-zinc-500">/loja/</span>
            <input className="w-full bg-transparent px-1 py-2 outline-none" required pattern="[a-z0-9][a-z0-9\-]{1,48}[a-z0-9]"
              value={slug} onChange={(e) => { setTouched(true); setSlug(slugify(e.target.value)); }} />
          </div>
        </Field>
        <Alert>{err}</Alert>
        <button className="btn-primary w-full" disabled={busy}>{busy ? "Criando..." : "Criar loja"}</button>
        <p className="text-xs text-zinc-500">Criamos um item e uma área de entrega de exemplo para você testar. Pode apagar depois.</p>
      </form>
    </main>
  );
}
