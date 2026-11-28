"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { canManage, usePanel } from "@/lib/panel/context";
import { Alert, Empty, Modal } from "@/components/ui";
import { errorMessage } from "@/lib/format";
import { BUILTIN, CATEGORIES, EVENT_LABEL, SCOPE_LABEL, type Category } from "@/lib/appstore";

type Installation = { id: string; status: "pending" | "active" | "failed" | "uninstalled"; unit_id: string | null; installed_at: string;
  activated_at: string | null; last_error: string | null };
type PartnerApp = {
  id: string; slug: string; name: string; developer: string; tagline: string; description: string | null; category: Category;
  icon_url: string | null; website_url: string | null; support_email: string | null; privacy_url: string | null; scopes: string[];
  webhook_events: string[] | null; config_url: string | null; featured: boolean; price_note: string | null; plans: string[] | null;
  in_plan: boolean; installation: Installation | null;
};
type Overview = {
  plan_id: string; can_install: boolean; connected: Record<string, boolean>;
  builtin: Record<string, { enabled: boolean; featured: boolean; plans: string[] | null }>; apps: PartnerApp[];
};

const live = (i: Installation | null) => !!i && (i.status === "pending" || i.status === "active");

function Icon({ src, emoji, name }: { src?: string | null; emoji?: string; name: string }) {
  // eslint-disable-next-line @next/next/no-img-element
  if (src) return <img src={src} alt="" className="h-11 w-11 shrink-0 rounded-xl object-cover ring-1 ring-zinc-200" />;
  return <span aria-hidden className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-zinc-100 text-xl">{emoji ?? name.slice(0, 1)}</span>;
}

export default function AppStore() {
  const { tenantId, role, units } = usePanel();
  const sb = supabaseBrowser();
  const [d, setD] = useState<Overview | null>(null);
  const [cat, setCat] = useState<Category | "todos">("todos");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<PartnerApp | null>(null);
  const [unit, setUnit] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
    const { data, error } = await sb.rpc("appstore_overview", { p_tenant_id: tenantId });
    if (error) { setErr(errorMessage(error)); return; }
    const v = data as Overview;
    setD(v);
    setOpen((cur) => (cur ? v.apps.find((a) => a.id === cur.id) ?? null : null));
  }, [sb, tenantId]);
  useEffect(() => { void load(); }, [load]);
  // instalação pendente: acompanha até o parceiro confirmar
  useEffect(() => {
    if (!d?.apps.some((a) => a.installation?.status === "pending")) return;
    const t = setInterval(() => void load(), 4000);
    return () => clearInterval(t);
  }, [d, load]);

  const match = (name: string, tagline: string, c: string) => {
    const t = q.trim().toLowerCase();
    return (cat === "todos" || c === cat) && (!t || name.toLowerCase().includes(t) || tagline.toLowerCase().includes(t));
  };
  const builtin = useMemo(() => !d ? [] : BUILTIN
    .filter((b) => d.builtin[b.key]?.enabled !== false && match(b.name, b.tagline, b.category))
    .sort((a, b) => Number(!!d.builtin[b.key]?.featured) - Number(!!d.builtin[a.key]?.featured)),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [d, cat, q]);
  const partners = useMemo(() => (d?.apps ?? []).filter((a) => match(a.name, `${a.tagline} ${a.developer}`, a.category)),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [d, cat, q]);

  async function install(a: PartnerApp) {
    setBusy(true); setErr(""); setMsg("");
    const { error } = await sb.rpc("app_install", { p_app_id: a.id, p_tenant_id: tenantId, p_unit_id: unit || null });
    setBusy(false);
    if (error) { setErr(errorMessage(error)); return; }
    setMsg(`Instalando ${a.name}: aguardando o app confirmar.`); void load();
  }
  async function uninstall(a: PartnerApp) {
    if (!a.installation || !confirm(`Desinstalar ${a.name}? O acesso do app aos dados da sua loja é cortado na hora.`)) return;
    setBusy(true); setErr(""); setMsg("");
    const { error } = await sb.rpc("app_uninstall", { p_installation_id: a.installation.id });
    setBusy(false);
    if (error) { setErr(errorMessage(error)); return; }
    setMsg(`${a.name} desinstalado.`); void load();
  }

  if (!canManage(role)) return <Empty>A App Store é usada pela gerência e pelo dono da conta.</Empty>;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="h1">App Store</h1>
        <p className="mt-1 max-w-3xl text-sm text-zinc-600">Tudo que conecta à sua loja: as integrações da plataforma e apps de parceiros. Os apps de parceiros usam a API com as permissões que você aprovar e podem ser desinstalados a qualquer momento.</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input className="input max-w-xs" placeholder="Buscar app" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Buscar app" />
        <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Categorias">
          {CATEGORIES.map((c) => (
            <button key={c.key} role="tab" aria-selected={cat === c.key} onClick={() => setCat(c.key)}
              className={`rounded-full px-3 py-1 text-xs font-medium ${cat === c.key ? "bg-brand-600 text-white" : "bg-zinc-100 text-zinc-700 hover:bg-zinc-200"}`}>{c.label}</button>
          ))}
        </div>
      </div>
      <Alert>{err}</Alert>
      <Alert kind="success">{msg}</Alert>
      {!d ? <p className="text-sm text-zinc-500">Carregando...</p> : (
        <>
          {partners.length > 0 && (
            <section>
              <h2 className="mb-2 font-semibold">Apps de parceiros</h2>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {partners.map((a) => (
                  <button key={a.id} onClick={() => { setUnit(""); setOpen(a); }} className="card flex gap-3 text-left transition hover:shadow-md">
                    <Icon src={a.icon_url} name={a.name} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2"><span className="truncate font-semibold">{a.name}</span>
                        {a.featured && <span className="badge bg-amber-100 text-amber-800">Destaque</span>}</span>
                      <span className="block text-xs text-zinc-500">{a.developer}{a.price_note ? ` · ${a.price_note}` : ""}</span>
                      <span className="mt-1 line-clamp-2 block text-sm text-zinc-600">{a.tagline}</span>
                      <span className="mt-2 block text-xs">
                        {a.installation?.status === "active" ? <span className="badge bg-green-100 text-green-800">Instalado</span>
                          : a.installation?.status === "pending" ? <span className="badge bg-sky-100 text-sky-800">Instalando...</span>
                          : a.installation?.status === "failed" ? <span className="badge bg-red-100 text-red-800">Instalação falhou</span>
                          : !a.in_plan ? <span className="badge bg-zinc-200 text-zinc-700">Fora do seu plano</span> : <span className="text-brand-700">Ver detalhes</span>}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            </section>
          )}
          <section>
            <h2 className="mb-2 font-semibold">Integrações da plataforma</h2>
            {builtin.length === 0 ? <p className="text-sm text-zinc-500">Nada encontrado.</p> : (
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {builtin.map((b) => {
                  const cfg = d.builtin[b.key];
                  const inPlan = !cfg?.plans || cfg.plans.includes(d.plan_id);
                  const on = b.status !== false && d.connected[b.key];
                  return (
                    <div key={b.key} className="card flex gap-3">
                      <Icon emoji={b.icon} name={b.name} />
                      <div className="min-w-0 flex-1">
                        <p className="flex flex-wrap items-center gap-2"><span className="font-semibold">{b.name}</span>
                          {cfg?.featured && <span className="badge bg-amber-100 text-amber-800">Destaque</span>}
                          {on && <span className="badge bg-green-100 text-green-800">Conectado</span>}
                          {b.status === false && <span className="badge bg-zinc-100 text-zinc-700">Incluído</span>}</p>
                        <p className="mt-1 text-sm text-zinc-600">{b.tagline}</p>
                        <p className="mt-2 text-sm">
                          {inPlan ? <Link className="font-medium text-brand-700 hover:underline" href={b.href}>{on ? "Gerenciar" : "Configurar"}</Link>
                            : <span className="text-zinc-500">Disponível nos planos {cfg!.plans!.join(", ")} · <Link className="text-brand-700 hover:underline" href="/painel/assinatura">ver planos</Link></span>}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
          <p className="text-xs text-zinc-500">Desenvolve um app para restaurantes? Veja a documentação em <a className="text-brand-700 hover:underline" href="/desenvolvedores#apps" target="_blank" rel="noopener">/desenvolvedores</a>.</p>
        </>
      )}

      {open && d && (
        <Modal open onClose={() => setOpen(null)} title={open.name}>
          <div className="space-y-4 text-sm">
            <div className="flex gap-3">
              <Icon src={open.icon_url} name={open.name} />
              <div>
                <p className="text-zinc-500">por {open.developer}{open.price_note ? ` · ${open.price_note}` : ""}</p>
                <p className="mt-1">{open.tagline}</p>
              </div>
            </div>
            {open.description && <p className="whitespace-pre-wrap text-zinc-700">{open.description}</p>}
            <div className="rounded-xl bg-zinc-50 p-3">
              <p className="font-medium">Ao instalar, {open.name} poderá:</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-zinc-700">
                {open.scopes.map((s) => <li key={s}>{SCOPE_LABEL[s] ?? s}</li>)}
                {open.webhook_events?.length ? <li>Receber avisos de {open.webhook_events.map((e) => EVENT_LABEL[e] ?? e).join(", ")}</li> : null}
              </ul>
              <p className="mt-2 text-xs text-zinc-500">O app não vê sua senha, sua equipe nem seus dados de pagamento. Desinstalar corta o acesso na hora.</p>
            </div>
            <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
              {open.website_url && <a className="text-brand-700 hover:underline" href={open.website_url} target="_blank" rel="noopener noreferrer">Site do app</a>}
              {open.privacy_url && <a className="text-brand-700 hover:underline" href={open.privacy_url} target="_blank" rel="noopener noreferrer">Política de privacidade</a>}
              {open.support_email && <a className="text-brand-700 hover:underline" href={`mailto:${open.support_email}`}>Suporte: {open.support_email}</a>}
            </p>
            {open.installation?.status === "failed" && <Alert>A instalação anterior falhou: {open.installation.last_error ?? "o app não confirmou."} Tente de novo ou fale com o suporte do app.</Alert>}
            {!d.can_install ? <p className="text-xs text-amber-800">Só o dono da conta instala e desinstala apps.</p>
              : live(open.installation) ? (
                <div className="flex flex-wrap items-center gap-2">
                  {open.installation!.status === "pending"
                    ? <span className="text-sky-800">Instalando: aguardando {open.name} confirmar...</span>
                    : <span className="text-green-800">Instalado em {new Date(open.installation!.activated_at ?? open.installation!.installed_at).toLocaleDateString("pt-BR")}
                        {open.installation!.unit_id ? ` · ${units.find((u) => u.id === open.installation!.unit_id)?.name ?? "uma loja"}` : " · todas as lojas"}</span>}
                  {open.installation!.status === "active" && open.config_url && (
                    <a className="btn-primary" href={`${open.config_url}${open.config_url.includes("?") ? "&" : "?"}installation=${open.installation!.id}`} target="_blank" rel="noopener noreferrer">Abrir o app</a>
                  )}
                  <button className="btn-ghost text-red-700" disabled={busy} onClick={() => void uninstall(open)}>Desinstalar</button>
                </div>
              ) : !open.in_plan ? (
                <p className="text-zinc-600">Este app não está incluído no seu plano. <Link className="text-brand-700 hover:underline" href="/painel/assinatura">Ver planos</Link></p>
              ) : (
                <div className="flex flex-wrap items-end gap-2">
                  {units.length > 1 && (
                    <label className="text-xs">
                      <span className="mb-1 block font-medium">Acesso a</span>
                      <select className="input" value={unit} onChange={(e) => setUnit(e.target.value)}>
                        <option value="">Todas as lojas</option>
                        {units.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                      </select>
                    </label>
                  )}
                  <button className="btn-primary" disabled={busy} onClick={() => void install(open)}>{busy ? "Instalando..." : "Permitir e instalar"}</button>
                </div>
              )}
          </div>
        </Modal>
      )}
    </div>
  );
}
