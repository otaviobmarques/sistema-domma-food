"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/client";
import { Alert, Field } from "@/components/ui";
import { AuthShell } from "@/components/auth-shell";
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
    <AuthShell>
      <form onSubmit={submit} className="space-y-4">
        <div className="mb-2">
          <p className="text-xs font-bold uppercase tracking-widest text-brand-600">Passo final</p>
          <h1 className="mt-1 text-3xl font-black tracking-tight">Vamos criar sua loja</h1>
          <p className="mt-1 text-sm text-zinc-500">Leva menos de um minuto. Tudo pode ser alterado depois.</p>
        </div>
        <Field label="Nome da loja">
          <input className="input" required minLength={2} maxLength={120} value={store} placeholder="Bella Massa Pizzaria"
            onChange={(e) => { setStore(e.target.value); if (!touched) setSlug(slugify(e.target.value)); }} />
        </Field>
        <Field label="Razão social / nome da empresa" hint="Opcional. Se tiver várias lojas, todas ficam nesta empresa.">
          <input className="input" maxLength={120} value={company} onChange={(e) => setCompany(e.target.value)} />
        </Field>
        <Field label="Endereço do seu cardápio" hint="Só letras minúsculas, números e hífen.">
          <div className="flex items-center rounded-xl border border-zinc-200 bg-white text-sm shadow-[0_1px_2px_rgb(0_0_0/0.03)] focus-within:border-brand-500 focus-within:ring-4 focus-within:ring-brand-100">
            <span className="pl-3.5 text-zinc-400">/loja/</span>
            <input className="w-full bg-transparent px-1 py-2.5 outline-none" required pattern="[a-z0-9][a-z0-9\-]{1,48}[a-z0-9]"
              value={slug} onChange={(e) => { setTouched(true); setSlug(slugify(e.target.value)); }} />
          </div>
        </Field>
        <Alert>{err}</Alert>
        <button className="btn-primary w-full py-3" disabled={busy}>{busy ? "Criando..." : "Criar loja"}</button>
        <p className="text-xs text-zinc-500">Criamos um item e uma área de entrega de exemplo para você testar. Pode apagar depois.</p>
      </form>
    </AuthShell>
  );
}
