"use client";
import { useCallback, useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { usePanel } from "@/lib/panel/context";
import { Alert, Toggle } from "@/components/ui";
import { ChannelBadge } from "@/components/channel-badge";
import { errorMessage } from "@/lib/format";

type Overview = {
  app_ready: boolean; orders_today: number;
  connection: null | {
    id: string; active: boolean; auto_confirm: boolean; external_merchant_id: string | null; display_name: string;
    external_status: { at: string; data: unknown } | null; last_event_at: string | null; last_sync_at: string | null; last_error: string | null;
    authorized: boolean; pending_code: { user_code: string; url: string; expires_at: string } | null;
    merchants: { id: string; name: string; corporate_name: string | null }[] | null;
  };
};
const ago = (iso: string | null) => {
  if (!iso) return "nunca";
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  return s < 90 ? `há ${s}s` : s < 5400 ? `há ${Math.round(s / 60)} min` : new Date(iso).toLocaleString("pt-BR");
};
/** Resumo do status da loja no iFood (estrutura da Merchant API: lista de operações com validações). */
function statusText(d: unknown) {
  const arr = Array.isArray(d) ? d as { operation?: string; available?: boolean; state?: string; message?: { title?: string; subtitle?: string } }[] : [];
  if (!arr.length) return null;
  return arr.map((x) => `${x.operation ?? "Loja"}: ${x.available ? "aberta" : "fechada"}${x.message?.title ? ` · ${x.message.title}` : ""}`).join(" · ");
}

export function IfoodCard() {
  const { unit } = usePanel();
  const sb = supabaseBrowser();
  const [ov, setOv] = useState<Overview | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
    const { data, error } = await sb.rpc("ifood_overview", { p_unit_id: unit.id });
    if (error) setErr(errorMessage(error)); else setOv(data as Overview);
  }, [sb, unit.id]);
  useEffect(() => { void load(); const t = setInterval(load, 30_000); return () => clearInterval(t); }, [load]);

  async function fn(path: string, body: Record<string, unknown> = {}) {
    setBusy(path); setErr(""); setMsg("");
    const { data, error } = await sb.functions.invoke(`ifood/${path}`, { body: { unit_id: unit.id, ...body } });
    setBusy("");
    if (error) {
      let m = errorMessage(error);
      try { const b = await (error as { context?: Response }).context?.json(); if (b?.error) m = b.error; } catch { /* sem corpo */ }
      setErr(m); return null;
    }
    if (data?.error) { setErr(data.error); return null; }
    return data as Record<string, unknown>;
  }
  async function rpc(name: string, args: Record<string, unknown>, ok: string) {
    setErr(""); setMsg("");
    const { error } = await sb.rpc(name, { p_unit_id: unit.id, ...args });
    if (error) setErr(errorMessage(error)); else { setMsg(ok); await load(); }
  }

  if (!ov) return null;
  const c = ov.connection;
  const connected = !!c?.authorized && !!c.external_merchant_id;
  const state = !c || !c.authorized ? { t: "Não conectado", cls: "bg-zinc-100 text-zinc-600" }
    : !c.external_merchant_id ? { t: "Escolha a loja", cls: "bg-amber-100 text-amber-800" }
    : c.last_error ? { t: "Com erro", cls: "bg-red-100 text-red-800" }
    : c.active ? { t: "Recebendo pedidos", cls: "bg-green-100 text-green-800" } : { t: "Pausado", cls: "bg-zinc-100 text-zinc-600" };
  const st = c?.external_status ? statusText(c.external_status.data) : null;

  return (
    <section className="card space-y-4 ring-1 ring-red-100">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <ChannelBadge channel="ifood" size="md" />
          <div>
            <h2 className="font-semibold">iFood</h2>
            <p className="text-sm text-zinc-500">
              {connected ? `${c!.display_name} · ${ov.orders_today} pedido(s) hoje · última consulta ${ago(c!.last_sync_at)}` : "Conexão oficial pela API do iFood (Merchant API)."}
            </p>
          </div>
        </div>
        <span className={`badge ${state.cls}`}>{state.t}</span>
      </div>
      <Alert>{err}</Alert>
      <Alert kind="success">{msg}</Alert>
      {c?.last_error && connected && <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-800">{c.last_error}</p>}

      {!ov.app_ready ? (
        <p className="text-sm text-zinc-600">A integração com o iFood está sendo liberada pela plataforma. Assim que estiver pronta, o botão de conexão aparece aqui.</p>
      ) : !c?.authorized ? (
        <div className="space-y-3">
          {!c?.pending_code ? (
            <>
              <p className="text-sm text-zinc-600">
                Você vai autorizar o Domma Food no <b>Portal do Parceiro iFood</b> com um código. Leva 1 minuto e precisa ser feito por quem
                administra a loja no iFood.
              </p>
              <button className="btn-primary" disabled={!!busy} onClick={async () => { if (await fn("connect/start")) await load(); }}>
                {busy === "connect/start" ? "Gerando código..." : "Conectar iFood"}
              </button>
            </>
          ) : (
            <ol className="space-y-3 text-sm">
              <li><b>1.</b> Abra o Portal do Parceiro e informe o código:
                <div className="mt-2 flex flex-wrap items-center gap-3">
                  <code className="rounded-lg bg-zinc-100 px-3 py-1.5 text-lg font-bold tracking-widest">{c.pending_code.user_code}</code>
                  <a className="btn-secondary" href={c.pending_code.url} target="_blank" rel="noopener noreferrer">Abrir Portal do Parceiro ↗</a>
                </div>
                <p className="mt-1 text-xs text-zinc-500">Válido até {new Date(c.pending_code.expires_at).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}.</p>
              </li>
              <li><b>2.</b> Depois de autorizar, o portal mostra um <b>código de autorização</b>. Cole aqui:
                <div className="mt-2 flex flex-wrap gap-2">
                  <input className="input max-w-xs font-mono" value={code} onChange={(e) => setCode(e.target.value.trim())} placeholder="Código de autorização" />
                  <button className="btn-primary" disabled={!code || !!busy} onClick={async () => {
                    const r = await fn("connect/finish", { authorization_code: code });
                    if (r) { setCode(""); setMsg(r.connected ? "iFood conectado! Os pedidos novos já chegam aqui." : String(r.warning ?? "Autorizado. Escolha a loja do iFood abaixo.")); await load(); }
                  }}>{busy === "connect/finish" ? "Conectando..." : "Concluir"}</button>
                </div>
              </li>
              <li><button className="text-xs text-zinc-500 hover:underline" onClick={async () => { if (await fn("connect/start")) await load(); }}>Gerar outro código</button></li>
            </ol>
          )}
        </div>
      ) : !c.external_merchant_id ? (
        <div className="space-y-2 text-sm">
          <p>A autorização enxerga mais de uma loja no iFood. Qual corresponde a <b>{unit.name}</b>?</p>
          {(c.merchants ?? []).map((m) => (
            <button key={m.id} className="btn-secondary mr-2" disabled={!!busy} onClick={async () => { if (await fn("connect/merchant", { merchant_id: m.id })) { setMsg("Loja vinculada."); await load(); } }}>
              {m.name}{m.corporate_name ? ` · ${m.corporate_name}` : ""}
            </button>
          ))}
        </div>
      ) : (
        <div className="space-y-3 text-sm">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <label className="flex items-center gap-2">Receber pedidos
              <Toggle checked={c.active} label="Receber pedidos do iFood" onChange={(v) => void rpc("ifood_set_options", { p_auto_confirm: c.auto_confirm, p_active: v }, v ? "Recebendo pedidos do iFood." : "Integração pausada.")} />
            </label>
            <label className="flex items-center gap-2">Aceitar automaticamente
              <Toggle checked={c.auto_confirm} label="Aceitar pedidos do iFood automaticamente" onChange={(v) => void rpc("ifood_set_options", { p_auto_confirm: v, p_active: c.active }, "Preferência salva.")} />
            </label>
          </div>
          <p className="text-xs text-zinc-500">
            O Domma consulta o iFood a cada 30 segundos. Ao aceitar, marcar pronto, despachar ou cancelar aqui, o iFood é avisado na hora.
            Pedidos de cancelamento do cliente aparecem no pedido para você aceitar ou recusar.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <button className="btn-secondary" disabled={!!busy} onClick={async () => { if (await fn("status")) await load(); }}>
              {busy === "status" ? "Consultando..." : "Ver status da loja no iFood"}
            </button>
            <button className="text-xs text-red-700 hover:underline" onClick={() => {
              if (confirm("Desconectar o iFood? Os pedidos novos param de chegar aqui; os já recebidos continuam no sistema.")) void rpc("ifood_disconnect", {}, "iFood desconectado.");
            }}>Desconectar</button>
          </div>
          {st && <p className="text-xs text-zinc-600">Status no iFood ({ago(c.external_status!.at)}): {st}</p>}
          <p className="text-xs text-zinc-500">Dica: no cardápio do iFood, use o ID do produto do Domma como “código PDV” para os itens ficarem vinculados aos seus produtos (estoque e relatórios).</p>
        </div>
      )}
    </section>
  );
}
