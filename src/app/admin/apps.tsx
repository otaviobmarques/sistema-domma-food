"use client";
import { useCallback, useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { Alert, Field, Toggle } from "@/components/ui";
import { errorMessage } from "@/lib/format";
import { BUILTIN, CATEGORIES, EVENT_LABEL, SCOPE_LABEL } from "@/lib/appstore";

type AppRow = {
  id: string; slug: string; name: string; developer: string; tagline: string; description: string | null; category: string;
  icon_url: string | null; website_url: string | null; support_email: string | null; privacy_url: string | null; scopes: string[];
  install_url: string; config_url: string | null; webhook_url: string | null; webhook_events: string[] | null;
  status: "draft" | "published" | "suspended"; featured: boolean; plans: string[] | null; price_note: string | null;
  installs: number; failed: number; last_events: { id: number; event: string; status: string; attempts: number; response_code: number | null; error: string | null; created_at: string }[];
};
type Data = { builtin: Record<string, { enabled: boolean; featured: boolean; plans: string[] | null }>; plans: { id: string; name: string }[]; apps: AppRow[] };

const EMPTY = { slug: "", name: "", developer: "", tagline: "", description: "", category: "outros", icon_url: "", website_url: "", support_email: "",
  privacy_url: "", scopes: [] as string[], install_url: "", config_url: "", webhook_url: "", webhook_events: [] as string[], price_note: "", plans: [] as string[] };
const STATUS = { draft: ["Rascunho", "bg-zinc-200 text-zinc-700"], published: ["Publicado", "bg-green-100 text-green-800"], suspended: ["Suspenso", "bg-red-100 text-red-800"] } as const;

/** App Store: vitrine das integrações da plataforma e apps de parceiros (cadastro, revisão, segredo, suspensão). */
export function AppsAdmin() {
  const sb = supabaseBrowser();
  const [d, setD] = useState<Data | null>(null);
  const [form, setForm] = useState<typeof EMPTY & { id?: string }>({ ...EMPTY });
  const [editing, setEditing] = useState(false);
  const [secret, setSecret] = useState<{ app: string; value: string } | null>(null);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const { data, error } = await sb.rpc("admin_appstore");
    if (error) setErr(errorMessage(error)); else setD(data as Data);
  }, [sb]);
  useEffect(() => { void load(); }, [load]);

  async function saveApp(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(""); setMsg("");
    const p = { ...form, plans: form.plans.length ? form.plans : null, webhook_events: form.webhook_url ? form.webhook_events : [] };
    const { data, error } = await sb.rpc("admin_app_save", { p });
    setBusy(false);
    if (error) { setErr(errorMessage(error)); return; }
    const r = data as { id: string; secret: string | null };
    if (r.secret) setSecret({ app: form.name, value: r.secret });
    setMsg(form.id ? "App atualizado." : "App criado como rascunho. Publique quando estiver revisado.");
    setEditing(false); setForm({ ...EMPTY }); void load();
  }
  async function patch(a: AppRow, p: Record<string, unknown>, ok: string) {
    setErr(""); setMsg("");
    const { data, error } = await sb.rpc("admin_app_save", { p: { id: a.id, ...p } });
    if (error) { setErr(errorMessage(error)); return; }
    const r = data as { secret: string | null };
    if (r.secret) setSecret({ app: a.name, value: r.secret });
    setMsg(ok); void load();
  }
  async function suspend(a: AppRow) {
    if (!confirm(`Suspender ${a.name}? Todas as ${a.installs} instalações são desfeitas e as chaves revogadas.`)) return;
    const { data, error } = await sb.rpc("admin_app_suspend", { p_app_id: a.id });
    if (error) setErr(errorMessage(error)); else { setMsg(`${a.name} suspenso (${data} instalações desfeitas).`); void load(); }
  }
  async function builtin(key: string, p: Record<string, unknown>) {
    const { error } = await sb.rpc("admin_builtin_save", { p_key: key, p });
    if (error) setErr(errorMessage(error)); else void load();
  }
  const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const set = (k: keyof typeof EMPTY) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  if (!d) return <Alert>{err}</Alert>;
  return (
    <section className="card space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="font-semibold">App Store</h2>
          <p className="text-sm text-zinc-600">Vitrine das integrações e apps de parceiros. Um app só aparece para as lojas depois de publicado.</p>
        </div>
        <button className="btn-secondary" onClick={() => { setForm({ ...EMPTY }); setEditing((v) => !v); }}>{editing ? "Fechar" : "+ Novo app de parceiro"}</button>
      </div>
      <Alert>{err}</Alert>
      <Alert kind="success">{msg}</Alert>
      {secret && (
        <div className="rounded-xl bg-amber-50 p-3 text-sm ring-1 ring-amber-200">
          <p className="font-semibold text-amber-900">Segredo de assinatura de {secret.app}: copie agora e envie ao parceiro por um canal seguro. Ele não aparece de novo.</p>
          <code className="mt-1 block break-all rounded bg-white px-2 py-1 text-xs">{secret.value}</code>
          <div className="mt-2 flex gap-2">
            <button className="btn-secondary px-2 py-1 text-xs" onClick={() => void navigator.clipboard.writeText(secret.value)}>Copiar</button>
            <button className="btn-ghost px-2 py-1 text-xs" onClick={() => setSecret(null)}>Já copiei</button>
          </div>
        </div>
      )}

      {editing && (
        <form onSubmit={saveApp} className="grid gap-3 rounded-xl bg-zinc-50 p-4 sm:grid-cols-2">
          <Field label="Nome"><input className="input" required maxLength={60} value={form.name} onChange={set("name")} /></Field>
          <Field label="Identificador" hint="3 a 40 letras minúsculas, números ou hífen."><input className="input" required pattern="[a-z0-9][a-z0-9\-]{2,39}" value={form.slug} onChange={set("slug")} /></Field>
          <Field label="Desenvolvedor"><input className="input" required maxLength={80} value={form.developer} onChange={set("developer")} /></Field>
          <Field label="Categoria"><select className="input" value={form.category} onChange={set("category")}>
            {CATEGORIES.filter((c) => c.key !== "todos").map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}</select></Field>
          <div className="sm:col-span-2"><Field label="Resumo (5 a 140 caracteres)"><input className="input" required minLength={5} maxLength={140} value={form.tagline} onChange={set("tagline")} /></Field></div>
          <div className="sm:col-span-2"><Field label="Descrição"><textarea className="input min-h-[80px]" maxLength={3000} value={form.description} onChange={set("description")} /></Field></div>
          <Field label="Endereço de instalação (https)" hint="Recebe app.installed e app.uninstalled assinados."><input className="input" required type="url" value={form.install_url} onChange={set("install_url")} /></Field>
          <Field label="Página do app (opcional)" hint="Aberta depois de instalar, com ?installation=…"><input className="input" type="url" value={form.config_url} onChange={set("config_url")} /></Field>
          <Field label="Webhook de pedidos (opcional)"><input className="input" type="url" value={form.webhook_url} onChange={set("webhook_url")} /></Field>
          <div className="text-sm"><p className="mb-1 font-medium">Eventos do webhook</p>
            {Object.entries(EVENT_LABEL).map(([k, l]) => (
              <label key={k} className="mr-3 inline-flex items-center gap-1.5"><input type="checkbox" className="accent-brand-600" disabled={!form.webhook_url}
                checked={form.webhook_events.includes(k)} onChange={() => setForm((f) => ({ ...f, webhook_events: toggle(f.webhook_events, k) }))} />{l}</label>
            ))}</div>
          <div className="text-sm sm:col-span-2"><p className="mb-1 font-medium">Permissões que o app pede</p>
            {Object.entries(SCOPE_LABEL).map(([k, l]) => (
              <label key={k} className="flex items-center gap-1.5"><input type="checkbox" className="accent-brand-600" checked={form.scopes.includes(k)}
                onChange={() => setForm((f) => ({ ...f, scopes: toggle(f.scopes, k) }))} /><code className="text-xs">{k}</code> {l}</label>
            ))}</div>
          <Field label="Ícone (https, opcional)"><input className="input" type="url" value={form.icon_url} onChange={set("icon_url")} /></Field>
          <Field label="Preço (texto, opcional)" hint='Ex.: "Grátis" ou "R$ 29/mês, cobrado pelo parceiro".'><input className="input" maxLength={80} value={form.price_note} onChange={set("price_note")} /></Field>
          <Field label="Site (opcional)"><input className="input" type="url" value={form.website_url} onChange={set("website_url")} /></Field>
          <Field label="Política de privacidade (opcional)"><input className="input" type="url" value={form.privacy_url} onChange={set("privacy_url")} /></Field>
          <Field label="E-mail de suporte (opcional)"><input className="input" type="email" value={form.support_email} onChange={set("support_email")} /></Field>
          <div className="text-sm"><p className="mb-1 font-medium">Planos (nenhum marcado = todos)</p>
            {d.plans.map((pl) => (
              <label key={pl.id} className="mr-3 inline-flex items-center gap-1.5"><input type="checkbox" className="accent-brand-600" checked={form.plans.includes(pl.id)}
                onChange={() => setForm((f) => ({ ...f, plans: toggle(f.plans, pl.id) }))} />{pl.name}</label>
            ))}</div>
          <div className="sm:col-span-2"><button className="btn-primary" disabled={busy || !form.scopes.length}>{busy ? "Salvando..." : form.id ? "Salvar app" : "Criar app"}</button></div>
        </form>
      )}

      <div className="space-y-2">
        <p className="font-medium">Apps de parceiros</p>
        {d.apps.length === 0 ? <p className="text-sm text-zinc-500">Nenhum app cadastrado.</p> : d.apps.map((a) => (
          <details key={a.id} className="rounded-xl ring-1 ring-zinc-200">
            <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
              <span><b>{a.name}</b> <span className="text-zinc-500">· {a.developer} · {a.slug}</span> <span className={`badge ml-1 ${STATUS[a.status][1]}`}>{STATUS[a.status][0]}</span></span>
              <span className="text-zinc-600">{a.installs} instalações{a.failed ? ` · ${a.failed} falharam` : ""}</span>
            </summary>
            <div className="space-y-3 border-t border-zinc-200 p-4 text-sm">
              <p className="text-zinc-600">{a.tagline}</p>
              <p className="text-xs text-zinc-500">Permissões: {a.scopes.join(", ")}{a.webhook_events ? ` · webhook: ${a.webhook_events.join(", ")}` : ""} · instalação: {a.install_url}</p>
              <div className="flex flex-wrap gap-2">
                {a.status !== "published" && <button className="btn-primary px-3 py-1.5 text-xs" onClick={() => void patch(a, { status: "published" }, `${a.name} publicado.`)}>Publicar</button>}
                {a.status === "published" && <button className="btn-secondary px-3 py-1.5 text-xs" onClick={() => void patch(a, { status: "draft" }, `${a.name} voltou para rascunho (instalações continuam).`)}>Despublicar</button>}
                {a.status !== "suspended" && <button className="btn-ghost px-3 py-1.5 text-xs text-red-700" onClick={() => void suspend(a)}>Suspender e desinstalar de todos</button>}
                <button className="btn-ghost px-3 py-1.5 text-xs" onClick={() => void patch(a, { featured: !a.featured }, a.featured ? "Destaque removido." : "App em destaque.")}>{a.featured ? "Tirar destaque" : "Destacar"}</button>
                <button className="btn-ghost px-3 py-1.5 text-xs" onClick={() => { if (confirm("Gerar novo segredo? O parceiro precisa trocar o segredo na hora para validar as próximas mensagens.")) void patch(a, { rotate_secret: true }, "Novo segredo gerado."); }}>Gerar novo segredo</button>
                <button className="btn-ghost px-3 py-1.5 text-xs" onClick={() => { setForm({ ...EMPTY, ...a, id: a.id, description: a.description ?? "", icon_url: a.icon_url ?? "", website_url: a.website_url ?? "",
                  support_email: a.support_email ?? "", privacy_url: a.privacy_url ?? "", config_url: a.config_url ?? "", webhook_url: a.webhook_url ?? "",
                  webhook_events: a.webhook_events ?? [], price_note: a.price_note ?? "", plans: a.plans ?? [] }); setEditing(true); window.scrollTo({ top: 0 }); }}>Editar</button>
              </div>
              {a.last_events.length > 0 && (
                <ul className="text-xs text-zinc-600">
                  {a.last_events.map((e) => <li key={e.id}>{new Date(e.created_at).toLocaleString("pt-BR")} · {e.event} · {e.status}{e.response_code ? ` (${e.response_code})` : ""}{e.error ? ` · ${e.error}` : ""}</li>)}
                </ul>
              )}
            </div>
          </details>
        ))}
      </div>

      <div>
        <p className="mb-1 font-medium">Integrações da plataforma na vitrine</p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-zinc-500"><tr><th className="p-2">Integração</th><th className="p-2">Visível</th><th className="p-2">Destaque</th><th className="p-2">Planos (vazio = todos)</th></tr></thead>
            <tbody className="divide-y divide-zinc-100">
              {BUILTIN.map((b) => {
                const c = d.builtin[b.key] ?? { enabled: true, featured: false, plans: null };
                return (
                  <tr key={b.key}>
                    <td className="p-2">{b.icon} {b.name}</td>
                    <td className="p-2"><Toggle checked={c.enabled} label={`Mostrar ${b.name}`} onChange={(v) => void builtin(b.key, { enabled: v })} /></td>
                    <td className="p-2"><Toggle checked={c.featured} label={`Destacar ${b.name}`} onChange={(v) => void builtin(b.key, { featured: v })} /></td>
                    <td className="p-2 text-xs">
                      {d.plans.map((pl) => (
                        <label key={pl.id} className="mr-2 inline-flex items-center gap-1"><input type="checkbox" className="accent-brand-600" checked={!!c.plans?.includes(pl.id)}
                          onChange={() => void builtin(b.key, { plans: toggle(c.plans ?? [], pl.id) })} />{pl.name}</label>
                      ))}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-1 text-xs text-zinc-500">Planos aqui controlam a vitrine (o cartão mostra "disponível nos planos…"). Para apps de parceiros, o plano é exigido na instalação.</p>
      </div>
    </section>
  );
}
