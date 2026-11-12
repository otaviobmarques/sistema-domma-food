"use client";
import { useCallback, useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { usePanel } from "@/lib/panel/context";
import { brl, errorMessage } from "@/lib/format";
import type { Order } from "./types";

type Delivery = { id: string; provider: "foody" | "ifood"; status: string; fee_cents: number | null; eta_at: string | null;
  courier: { name?: string; phone?: string; vehicle?: string } | null; tracking_url: string | null; drop_code: string | null; error: string | null; created_at: string };
type Quote = { provider: "foody" | "ifood"; price_cents: number | null; delivery_min: number | null; delivery_max?: number | null; pickup_min?: number | null; quote_id?: string; expires_at?: string | null };
type Providers = { foody: boolean; ifood: boolean };

const NAME = { foody: "Foody Delivery", ifood: "Entrega iFood" } as const;
const FN = { foody: "logistics", ifood: "ifood/shipping" } as const;
export const DELIVERY_STATUS: Record<string, string> = {
  pending: "Procurando entregador", accepted: "Entregador a caminho da loja", to_pickup: "Entregador a caminho da loja", at_merchant: "Entregador na loja",
  picked: "Pedido coletado", in_transit: "Em rota de entrega", at_customer: "Entregador no cliente", delivered: "Entregue", returning: "Voltando à loja",
  rejected: "Recusado", cancel_requested: "Cancelamento solicitado", cancelled: "Cancelado", failed: "Não encontrou entregador",
};
const ACTIVE = (s: string) => !["rejected", "cancelled", "failed", "delivered", "returning"].includes(s);
const time = (iso: string) => new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });

let cache: { unit: string; at: number; p: Providers } | null = null;
function useProviders() {
  const { unit } = usePanel();
  const [p, setP] = useState<Providers | null>(cache?.unit === unit.id && Date.now() - cache.at < 60_000 ? cache.p : null);
  useEffect(() => {
    if (p) return;
    supabaseBrowser().rpc("logistics_overview", { p_unit_id: unit.id }).then(({ data }: { data: { foody: { enabled: boolean }; ifood: { enabled: boolean; connected: boolean } } | null }) => {
      const v = { foody: !!data?.foody.enabled, ifood: !!data?.ifood.enabled && !!data?.ifood.connected };
      cache = { unit: unit.id, at: Date.now(), p: v }; setP(v);
    });
  }, [unit.id, p]);
  return p;
}

/** Chamar entregador externo (Foody / Entrega iFood) para um pedido de entrega. */
export function CallCourier({ o }: { o: Order }) {
  const sb = supabaseBrowser();
  const providers = useProviders();
  const [list, setList] = useState<Delivery[]>([]);
  const [open, setOpen] = useState(false);
  const [quotes, setQuotes] = useState<Partial<Record<"foody" | "ifood", Quote | { error: string }>>>({});
  const [cep, setCep] = useState("");
  const [geo, setGeo] = useState("");
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    const { data } = await sb.from("external_deliveries").select("id, provider, status, fee_cents, eta_at, courier, tracking_url, drop_code, error, created_at")
      .eq("order_id", o.id).order("created_at", { ascending: false });
    setList((data ?? []) as Delivery[]);
  }, [sb, o.id]);
  useEffect(() => {
    void load();
    const ch = sb.channel(`ext-del-${o.id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "external_deliveries", filter: `order_id=eq.${o.id}` }, () => void load()).subscribe();
    return () => { void sb.removeChannel(ch); };
  }, [sb, o.id, load]);

  const enabled = providers ? (["foody", "ifood"] as const).filter((k) => providers[k]) : [];
  const active = list.find((d) => ACTIVE(d.status));
  const canCall = !active && !["cancelled", "completed", "awaiting_payment"].includes(o.status);
  if (!providers || (!enabled.length && !list.length)) return null;

  function address() {
    const out: Record<string, unknown> = {};
    if (cep.replace(/\D/g, "").length === 8) out.postal_code = cep.replace(/\D/g, "");
    const m = geo.match(/(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)/);
    if (m) { out.lat = Number(m[1]); out.lng = Number(m[2]); }
    return out;
  }
  async function invoke(path: string, body: Record<string, unknown>) {
    const { data, error } = await sb.functions.invoke(path, { body: { order_id: o.id, address: address(), ...body } });
    if (error) {
      let m = errorMessage(error);
      try { const b = await (error as { context?: Response }).context?.json(); if (b?.error) m = b.error; } catch { /* sem corpo */ }
      return { error: m };
    }
    return (data ?? {}) as Record<string, unknown>;
  }
  async function quoteAll() {
    setBusy("quote"); setErr(""); setQuotes({});
    const res = await Promise.all(enabled.map(async (k) => [k, await invoke(`${FN[k]}/quote`, {})] as const));
    setQuotes(Object.fromEntries(res.map(([k, r]) => [k, r.error ? { error: String(r.error) } : (r as unknown as Quote)])));
    setBusy("");
  }
  async function request(k: "foody" | "ifood") {
    const q = quotes[k] as Quote | undefined;
    setBusy(k); setErr("");
    const r = await invoke(`${FN[k]}/request`, k === "ifood" ? { quote_id: q?.quote_id } : {});
    setBusy("");
    if (r.error) { setErr(String(r.error)); return; }
    setOpen(false); setQuotes({}); await load();
  }
  async function cancel(d: Delivery) {
    if (!confirm(`Cancelar a entrega da ${NAME[d.provider]}? Pode haver cobrança se o entregador já estiver a caminho.`)) return;
    setBusy("cancel"); setErr("");
    const r = await invoke(`${FN[d.provider]}/cancel`, {});
    setBusy("");
    if (r.error) setErr(String(r.error)); else await load();
  }

  return (
    <div className="mt-3 space-y-2 rounded-lg border border-zinc-200 p-3 text-sm">
      {active ? (
        <div className="space-y-1">
          <div className="flex items-center justify-between gap-2">
            <p className="font-semibold">{NAME[active.provider]}</p>
            <span className="badge bg-sky-50 text-sky-800">{DELIVERY_STATUS[active.status] ?? active.status}</span>
          </div>
          {active.courier?.name && <p className="text-zinc-700">Entregador: <b>{active.courier.name}</b>{active.courier.phone ? ` · ${active.courier.phone}` : ""}</p>}
          {active.eta_at && <p className="text-xs text-zinc-500">Previsão de entrega: {time(active.eta_at)}</p>}
          {active.fee_cents != null && <p className="text-xs text-zinc-500">Custo da entrega: {brl(active.fee_cents)}</p>}
          {active.drop_code && <p className="text-xs text-zinc-700">Código de entrega: <b>{active.drop_code}</b></p>}
          <div className="flex flex-wrap gap-2 pt-1">
            {active.tracking_url && <a className="btn-ghost px-2 py-1 text-xs" href={active.tracking_url} target="_blank" rel="noopener noreferrer">Rastrear ↗</a>}
            {!["cancel_requested", "at_customer"].includes(active.status) && (
              <button className="btn-ghost px-2 py-1 text-xs text-red-700" disabled={busy !== ""} onClick={() => void cancel(active)}>Cancelar entrega</button>)}
          </div>
        </div>
      ) : canCall && enabled.length > 0 && !open ? (
        <button className="btn-secondary w-full" onClick={() => { setOpen(true); void quoteAll(); }}>🛵 Chamar entregador ({enabled.map((k) => NAME[k]).join(" ou ")})</button>
      ) : null}

      {open && !active && (
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <label className="text-xs text-zinc-600">CEP do cliente
              <input className="input mt-1" inputMode="numeric" placeholder="00000-000" value={cep} onChange={(e) => setCep(e.target.value)} /></label>
            <label className="text-xs text-zinc-600">Localização (lat, lng)
              <input className="input mt-1" placeholder="-19.93, -43.94" value={geo} onChange={(e) => setGeo(e.target.value)} /></label>
          </div>
          <p className="text-[11px] text-zinc-500">Preencha só se o pedido não tiver: a Entrega iFood exige CEP e localização. Dá para copiar as coordenadas do pin enviado pelo cliente.</p>
          <div className="flex gap-2"><button className="btn-ghost px-2 py-1 text-xs" disabled={busy === "quote"} onClick={() => void quoteAll()}>{busy === "quote" ? "Cotando..." : "Cotar de novo"}</button>
            <button className="btn-ghost px-2 py-1 text-xs" onClick={() => setOpen(false)}>Fechar</button></div>
          {enabled.map((k) => {
            const q = quotes[k];
            return (
              <div key={k} className="flex items-center justify-between gap-2 rounded-lg bg-zinc-50 p-2">
                <div className="min-w-0">
                  <p className="font-medium">{NAME[k]}</p>
                  {!q ? <p className="text-xs text-zinc-500">{busy === "quote" ? "Cotando..." : "—"}</p>
                    : "error" in q ? <p className="text-xs text-red-700">{q.error}</p>
                    : <p className="text-xs text-zinc-600">{q.price_cents != null ? brl(q.price_cents) : "Preço na fatura"}
                        {q.delivery_min != null ? ` · ${q.delivery_min}${q.delivery_max ? `–${q.delivery_max}` : ""} min` : ""}</p>}
                </div>
                <button className="btn-primary px-3 py-1.5 text-xs" disabled={!q || "error" in q || busy !== ""} onClick={() => void request(k)}>
                  {busy === k ? "Chamando..." : "Chamar"}</button>
              </div>
            );
          })}
        </div>
      )}
      {err && <p className="text-xs text-red-700">{err}</p>}
      {list.filter((d) => d !== active).slice(0, 3).map((d) => (
        <p key={d.id} className="text-[11px] text-zinc-500">{time(d.created_at)} · {NAME[d.provider]}: {DELIVERY_STATUS[d.status] ?? d.status}{d.error ? ` (${d.error})` : ""}</p>
      ))}
    </div>
  );
}
