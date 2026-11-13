"use client";
import { useCallback, useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { canManage, usePanel } from "@/lib/panel/context";
import { Alert, Field, Modal, Toggle } from "@/components/ui";
import { ChannelBadge } from "@/components/channel-badge";
import { errorMessage } from "@/lib/format";
import { IfoodCard } from "./ifood";
import { LogisticsCard } from "./logistics";
import { ErpCard } from "./erp";
import { ApiCard } from "./api";

type Conn = {
  id: string; provider: string; display_name: string; merchant_id: string; app_id: string | null; client_id: string | null;
  client_secret_id: string | null; auth_base_url: string | null; api_base_url: string | null; polling_enabled: boolean;
  auto_confirm: boolean; active: boolean; last_event_at: string | null; last_sync_at: string | null; last_error: string | null;
};
type Ev = { id: number; event_type: string; external_order_id: string | null; source: string; processed_at: string | null; error: string | null; created_at: string };

const FN = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/opendelivery`;
const PROVIDERS = [
  { id: "99food", name: "99Food", channel: "99food", portal: "https://developer-food.99app.com/pt-BR/openapi",
    hint: "Cadastre-se no portal de desenvolvedores da 99Food para receber as credenciais Open Delivery da sua loja." },
  { id: "keeta", name: "Keeta", channel: "keeta", portal: "https://www.keeta-global.com/BR/pt-BR",
    hint: "No portal de parceiros da Keeta, solicite a integração via API (Open Delivery) para a sua loja." },
  { id: "aiqfome", name: "aiqfome", channel: "aiqfome", portal: "https://developer.aiqfome.com/docs/category/api-open-delivery",
    hint: "No portal de desenvolvedores do aiqfome (API Open Delivery), autorize a loja e gere as credenciais." },
  { id: "other", name: "Outro (Open Delivery)", channel: "marketplace", portal: "https://abrasel-nacional.github.io/opendelivery/",
    hint: "Qualquer aplicativo aderente ao padrão Open Delivery da Abrasel." },
] as const;

const blank = { display_name: "", app_id: "", client_id: "", client_secret: "", auth_base_url: "", api_base_url: "",
  polling: true, auto_confirm: false, active: false };

function Copy({ label, value, secret }: { label: string; value: string; secret?: boolean }) {
  const [ok, setOk] = useState(false);
  return (
    <div>
      <p className="text-xs font-semibold text-zinc-500">{label}</p>
      <div className="mt-1 flex items-center gap-2">
        <code className={`min-w-0 flex-1 break-all rounded-lg bg-zinc-100 px-2 py-1.5 text-xs ${secret ? "font-bold text-brand-800" : ""}`}>{value}</code>
        <button type="button" className="btn-secondary px-2 py-1 text-xs" onClick={async () => {
          await navigator.clipboard.writeText(value); setOk(true); setTimeout(() => setOk(false), 1500);
        }}>{ok ? "Copiado" : "Copiar"}</button>
      </div>
    </div>
  );
}

export default function Integracoes() {
  const { unit, role } = usePanel();
  const sb = supabaseBrowser();
  const [conns, setConns] = useState<Conn[]>([]);
  const [events, setEvents] = useState<Ev[]>([]);
  const [edit, setEdit] = useState<{ provider: string; conn?: Conn; f: typeof blank } | null>(null);
  const [newKey, setNewKey] = useState<{ merchant_id: string; key: string } | null>(null);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const { data, error } = await sb.from("marketplace_connections").select("*").eq("unit_id", unit.id);
    if (error) { setErr(error.message); return; }
    setConns((data ?? []) as Conn[]);
    const ids = (data ?? []).map((c: { id: string }) => c.id);
    if (ids.length) {
      const { data: ev } = await sb.from("marketplace_events").select("id, event_type, external_order_id, source, processed_at, error, created_at")
        .in("connection_id", ids).order("created_at", { ascending: false }).limit(20);
      setEvents((ev ?? []) as Ev[]);
    } else setEvents([]);
  }, [sb, unit.id]);
  useEffect(() => { load(); const t = setInterval(load, 30_000); return () => clearInterval(t); }, [load]);

  if (!canManage(role)) return <p className="card">Apenas o dono ou o gerente configuram integrações.</p>;

  const set = (k: keyof typeof blank, v: string | boolean) => setEdit((s) => s && { ...s, f: { ...s.f, [k]: v } });

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!edit) return;
    setBusy(true); setErr("");
    const f = edit.f;
    const { data, error } = await sb.rpc("save_marketplace_connection", {
      p_unit_id: unit.id, p_provider: edit.provider, p_display_name: f.display_name, p_app_id: f.app_id,
      p_client_id: f.client_id, p_client_secret: f.client_secret, p_auth_base_url: f.auth_base_url,
      p_api_base_url: f.api_base_url, p_polling: f.polling, p_auto_confirm: f.auto_confirm, p_active: f.active,
    });
    setBusy(false);
    if (error) { setErr(error.message.includes("check constraint") ? "As URLs precisam começar com https://" : errorMessage(error)); return; }
    if (data?.api_key) setNewKey({ merchant_id: data.merchant_id, key: data.api_key });
    setEdit(null); setMsg("Integração salva."); load();
  }

  async function test(c: Conn) {
    setMsg(""); setErr("");
    const { data: { session } } = await sb.auth.getSession();
    const res = await fetch(`${FN}/test`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}` },
      body: JSON.stringify({ connection_id: c.id }),
    }).then((r) => r.json()).catch(() => ({ ok: false, error: "Não foi possível falar com o servidor de integração." }));
    if (res.ok) setMsg("Conexão OK: o marketplace aceitou as credenciais."); else setErr(`Falhou: ${res.error}`);
    load();
  }

  async function rotate(c: Conn) {
    if (!confirm("Gerar uma nova chave? A chave atual para de funcionar e você precisará informar a nova ao marketplace.")) return;
    const { data, error } = await sb.rpc("rotate_marketplace_api_key", { p_connection_id: c.id });
    if (error) setErr(error.message); else setNewKey({ merchant_id: c.merchant_id, key: data as string });
  }

  async function remove(c: Conn) {
    if (!confirm("Remover esta integração? Os pedidos já recebidos continuam no sistema.")) return;
    const { error } = await sb.rpc("delete_marketplace_connection", { p_connection_id: c.id });
    if (error) setErr(error.message); else load();
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="h1">Integrações</h1>
        <p className="mt-1 max-w-3xl text-sm text-zinc-600">
          Receba os pedidos do iFood e dos outros marketplaces direto no gestor de pedidos, com o selo de cada um. As mudanças de status
          (aceito, pronto, saiu, cancelado) voltam automaticamente para o marketplace. O iFood usa a API oficial dele; 99Food, Keeta e aiqfome usam o padrão aberto
          <b> Open Delivery</b> (Abrasel).
        </p>
      </div>
      <Alert>{err && !edit ? err : ""}</Alert>
      <Alert kind="success">{msg}</Alert>

      <IfoodCard />
      <LogisticsCard />
      <ErpCard />
      <ApiCard />

      <div className="grid gap-4 lg:grid-cols-2">
        {PROVIDERS.map((p) => {
          const c = conns.find((x) => x.provider === p.id);
          const state = !c ? { t: "Não conectado", cls: "bg-zinc-100 text-zinc-600" }
            : c.last_error ? { t: "Com erro", cls: "bg-red-100 text-red-800" }
            : c.active ? { t: "Ativa", cls: "bg-green-100 text-green-800" } : { t: "Desativada", cls: "bg-amber-100 text-amber-800" };
          return (
            <section key={p.id} className="card space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-2">
                  <ChannelBadge channel={p.channel} size="md" />
                  {c?.display_name && <span className="text-sm text-zinc-500">{c.display_name}</span>}
                </div>
                <span className={`badge ${state.cls}`}>{state.t}</span>
              </div>
              {!c ? (
                <>
                  <p className="text-sm text-zinc-600">{p.hint}</p>
                  <div className="flex flex-wrap gap-2">
                    <button className="btn-primary" onClick={() => setEdit({ provider: p.id, f: { ...blank, display_name: p.name } })}>Conectar</button>
                    <a className="btn-ghost" href={p.portal} target="_blank" rel="noopener noreferrer">Portal do parceiro ↗</a>
                  </div>
                </>
              ) : (
                <>
                  {c.last_error && <p className="rounded-lg bg-red-50 p-2 text-xs text-red-800">{c.last_error}</p>}
                  <div className="space-y-2">
                    <Copy label="Merchant ID (informe ao marketplace)" value={c.merchant_id} />
                    <Copy label="URL do GET /merchant (cardápio e dados da loja)" value={`${FN}/m/${c.merchant_id}/v1/merchant`} />
                    <Copy label="URL do webhook de pedidos (newEvent)" value={`${FN}/m/${c.merchant_id}/v1/newEvent`} />
                  </div>
                  <p className="text-xs text-zinc-500">
                    {c.last_event_at ? `Último pedido/evento: ${new Date(c.last_event_at).toLocaleString("pt-BR")}` : "Nenhum evento recebido ainda."}
                    {c.polling_enabled ? " · Consulta automática a cada minuto ligada." : ""}
                    {c.auto_confirm ? " · Aceite automático." : ""}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <button className="btn-secondary" onClick={() => setEdit({ provider: p.id, conn: c, f: {
                      display_name: c.display_name, app_id: c.app_id ?? "", client_id: c.client_id ?? "", client_secret: "",
                      auth_base_url: c.auth_base_url ?? "", api_base_url: c.api_base_url ?? "", polling: c.polling_enabled,
                      auto_confirm: c.auto_confirm, active: c.active } })}>Editar</button>
                    <button className="btn-secondary" disabled={!c.client_id || !c.api_base_url} onClick={() => test(c)}>Testar conexão</button>
                    <button className="btn-ghost" onClick={() => rotate(c)}>Nova chave da API</button>
                    <button className="btn-ghost text-red-600" onClick={() => remove(c)}>Remover</button>
                  </div>
                </>
              )}
            </section>
          );
        })}
      </div>

      <section className="card">
        <h2 className="mb-2 font-semibold">Últimos eventos recebidos</h2>
        {events.length === 0 ? <p className="text-sm text-zinc-500">Nada por aqui ainda.</p> : (
          <ul className="divide-y divide-zinc-100 text-sm">
            {events.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span><b>{e.event_type}</b> · pedido {e.external_order_id} · via {e.source === "webhook" ? "webhook" : "consulta"}</span>
                <span className={`text-xs ${e.error ? "text-red-700" : e.processed_at ? "text-green-700" : "text-zinc-500"}`}>
                  {new Date(e.created_at).toLocaleTimeString("pt-BR")} · {e.error ? `erro: ${e.error}` : e.processed_at ? "processado" : "pendente"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Modal open={!!edit} onClose={() => { setEdit(null); setErr(""); }} title={edit?.conn ? "Editar integração" : "Conectar marketplace"} wide>
        {edit && (
          <form onSubmit={save} className="space-y-3">
            <p className="text-sm text-zinc-600">Estes dados são fornecidos pelo marketplace (credenciais Open Delivery da sua loja).</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Nome desta conexão"><input className="input" value={edit.f.display_name} onChange={(e) => set("display_name", e.target.value)} /></Field>
              <Field label="App ID do marketplace" hint="Opcional. Usado para conferir quem envia o webhook.">
                <input className="input" value={edit.f.app_id} onChange={(e) => set("app_id", e.target.value)} />
              </Field>
              <Field label="Client ID"><input className="input" autoComplete="off" value={edit.f.client_id} onChange={(e) => set("client_id", e.target.value)} /></Field>
              <Field label="Client Secret" hint={edit.conn?.client_secret_id ? "Deixe em branco para manter o atual." : "Guardado criptografado no cofre (Vault)."}>
                <input className="input" type="password" autoComplete="new-password" value={edit.f.client_secret} onChange={(e) => set("client_secret", e.target.value)} />
              </Field>
              <Field label="URL da API do marketplace" hint="Ex.: https://api.exemplo.com (sem /v1)">
                <input className="input" inputMode="url" placeholder="https://" value={edit.f.api_base_url} onChange={(e) => set("api_base_url", e.target.value)} />
              </Field>
              <Field label="URL de autenticação (opcional)" hint="Só se for diferente da URL da API.">
                <input className="input" inputMode="url" placeholder="https://" value={edit.f.auth_base_url} onChange={(e) => set("auth_base_url", e.target.value)} />
              </Field>
            </div>
            <div className="grid gap-2 sm:grid-cols-3">
              {([["polling", "Consultar pedidos a cada minuto", "Reserva caso o webhook falhe."],
                 ["auto_confirm", "Aceitar automaticamente", "O pedido já entra em preparo."],
                 ["active", "Integração ativa", "Liga o recebimento de pedidos."]] as const).map(([k, l, h]) => (
                <label key={k} className="flex items-start justify-between gap-3 rounded-lg border border-zinc-200 p-3 text-sm">
                  <span>{l}<span className="block text-xs text-zinc-500">{h}</span></span>
                  <Toggle checked={edit.f[k]} onChange={(v) => set(k, v)} label={l} />
                </label>
              ))}
            </div>
            <Alert>{err}</Alert>
            <button className="btn-primary w-full" disabled={busy}>{busy ? "Salvando..." : "Salvar"}</button>
          </form>
        )}
      </Modal>

      <Modal open={!!newKey} onClose={() => setNewKey(null)} title="Chave da API gerada">
        {newKey && (
          <div className="space-y-3">
            <Alert kind="info">Copie agora: por segurança, esta chave não será mostrada de novo (guardamos só uma versão criptografada).</Alert>
            <Copy label="X-API-KEY (para o marketplace ler o seu cardápio)" value={newKey.key} secret />
            <Copy label="Merchant ID" value={newKey.merchant_id} />
            <p className="text-xs text-zinc-500">Informe ao marketplace: Merchant ID, a URL do GET /merchant, a URL do webhook e esta chave.</p>
            <button className="btn-primary w-full" onClick={() => setNewKey(null)}>Já copiei</button>
          </div>
        )}
      </Modal>
    </div>
  );
}
