"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { canManage, usePanel } from "@/lib/panel/context";
import { Alert, Empty, Modal } from "@/components/ui";
import { ChannelBadge, channelLabel } from "@/components/channel-badge";
import { brl, formatPhone, PAYMENT_LABEL, STATUS_LABEL, timeHM, TYPE_LABEL } from "@/lib/format";

type Item = {
  id: string; name: string; quantity: number; total_cents: number; notes: string | null;
  options: { group?: string; name: string; price_cents?: number; quantity?: number }[] | null;
};
type Order = {
  id: string; number: number; status: string; type: string; channel: string; customer_name: string; customer_phone: string;
  address: { street?: string; number?: string; complement?: string; neighborhood?: string; city?: string; reference?: string } | null;
  subtotal_cents: number; discount_cents: number; delivery_fee_cents: number; total_cents: number;
  payment_method: string; payment_status: string; change_for_cents: number | null; coupon_code: string | null;
  notes: string | null; cancel_reason: string | null; created_at: string; external_display_id: string | null;
  order_items?: Item[];
};
type Ev = { id: number; to_status: string; note: string | null; created_at: string };

const PAGE = 50;
const MAX_EXPORT = 5000;
const CHANNELS = ["web", "whatsapp", "99food", "keeta", "aiqfome", "ifood", "marketplace", "counter", "table", "totem", "phone"];
const STATUS_CLS: Record<string, string> = {
  completed: "bg-green-100 text-green-800", cancelled: "bg-red-100 text-red-800", pending: "bg-amber-100 text-amber-800",
  awaiting_payment: "bg-amber-100 text-amber-800", preparing: "bg-orange-100 text-orange-800", ready: "bg-sky-100 text-sky-800",
  dispatched: "bg-violet-100 text-violet-800", awaiting_pickup: "bg-violet-100 text-violet-800",
};

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
function preset(days: number) {
  const to = new Date(); const from = new Date();
  if (days > 1) from.setDate(from.getDate() - (days - 1));
  return { from: ymd(from), to: ymd(to) };
}

type Filters = { from: string; to: string; status: string; channel: string; type: string; payment: string; q: string };

export default function Historico() {
  const { unit, role } = usePanel();
  const sb = supabaseBrowser();
  const [f, setF] = useState<Filters>({ ...preset(7), status: "", channel: "", type: "", payment: "", q: "" });
  const [applied, setApplied] = useState(f);
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<Order[]>([]);
  const [count, setCount] = useState(0);
  const [totals, setTotals] = useState<{ n: number; revenue: number; cancelled: number; capped: boolean } | null>(null);
  const [open, setOpen] = useState<Order | null>(null);
  const [events, setEvents] = useState<Ev[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  // Aplica os mesmos filtros a qualquer consulta (lista, totais e exportação)
  const withFilters = useCallback((query: any, a: Filters) => {
    let q = query.eq("unit_id", unit.id)
      .gte("created_at", new Date(`${a.from}T00:00:00`).toISOString())
      .lte("created_at", new Date(`${a.to}T23:59:59.999`).toISOString());
    if (a.status) q = q.eq("status", a.status);
    if (a.channel) q = q.eq("channel", a.channel);
    if (a.type) q = q.eq("type", a.type);
    if (a.payment) q = q.eq("payment_method", a.payment);
    const t = a.q.trim().replace(/[,()%*\\]/g, " ").trim();
    if (t) {
      const digits = t.replace(/\D/g, "");
      const parts = [`customer_name.ilike.%${t}%`];
      if (digits && digits === t.replace(/[\s#().+-]/g, "")) {
        if (digits.length <= 7) parts.push(`number.eq.${Number(digits)}`);
        if (digits.length >= 4) parts.push(`customer_phone.ilike.%${digits}%`);
        parts.push(`external_display_id.eq.${digits}`);
      }
      q = q.or(parts.join(","));
    }
    return q;
  }, [unit.id]);

  const load = useCallback(async () => {
    if (!applied.from || !applied.to) return;
    setLoading(true); setErr("");
    const { data, error, count: c } = await withFilters(sb.from("orders").select("*", { count: "exact" }), applied)
      .order("created_at", { ascending: false }).range(page * PAGE, page * PAGE + PAGE - 1);
    setLoading(false);
    if (error) { setErr(error.message); return; }
    setRows((data ?? []) as Order[]); setCount(c ?? 0);
  }, [sb, withFilters, applied, page]);
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    let alive = true;
    (async () => {
      const { data } = await withFilters(sb.from("orders").select("total_cents, status"), applied).limit(MAX_EXPORT);
      if (!alive || !data) return;
      const ok = (data as { total_cents: number; status: string }[]).filter((o) => o.status !== "cancelled");
      setTotals({ n: ok.length, revenue: ok.reduce((s, o) => s + o.total_cents, 0), cancelled: data.length - ok.length, capped: data.length >= MAX_EXPORT });
    })();
    return () => { alive = false; };
  }, [sb, withFilters, applied]);

  async function openOrder(o: Order) {
    setOpen(o); setEvents([]);
    const [{ data: items }, { data: ev }] = await Promise.all([
      sb.from("order_items").select("id, name, quantity, total_cents, notes, options").eq("order_id", o.id),
      sb.from("order_events").select("id, to_status, note, created_at").eq("order_id", o.id).order("created_at"),
    ]);
    setOpen((cur) => (cur && cur.id === o.id ? { ...o, order_items: (items ?? []) as Item[] } : cur));
    setEvents((ev ?? []) as Ev[]);
  }

  async function exportCsv() {
    setErr("");
    const { data, error } = await withFilters(sb.from("orders").select("*"), applied).order("created_at", { ascending: false }).limit(MAX_EXPORT);
    if (error) { setErr(error.message); return; }
    const head = ["numero", "data", "hora", "origem", "numero_externo", "cliente", "telefone", "tipo", "pagamento", "situacao_pagamento",
      "status", "subtotal", "desconto", "taxa_entrega", "total", "cupom", "bairro", "motivo_cancelamento"];
    const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const money = (c: number) => (c / 100).toFixed(2).replace(".", ",");
    const lines = ((data ?? []) as Order[]).map((o) => {
      const d = new Date(o.created_at);
      return [o.number, d.toLocaleDateString("pt-BR"), timeHM(o.created_at), channelLabel(o.channel), o.external_display_id, o.customer_name,
        o.customer_phone === "00000000000" ? "" : o.customer_phone, TYPE_LABEL[o.type] ?? o.type, PAYMENT_LABEL[o.payment_method] ?? o.payment_method,
        o.payment_status === "paid" ? "pago" : o.payment_status, STATUS_LABEL[o.status] ?? o.status, money(o.subtotal_cents), money(o.discount_cents),
        money(o.delivery_fee_cents), money(o.total_cents), o.coupon_code, o.address?.neighborhood, o.cancel_reason].map(esc).join(";");
    });
    const blob = new Blob(["﻿" + [head.join(";"), ...lines].join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `pedidos-${applied.from}-a-${applied.to}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const pages = Math.max(1, Math.ceil(count / PAGE));
  const activePreset = useMemo(() => [1, 7, 30].find((d) => { const p = preset(d); return p.from === f.from && p.to === f.to; }), [f.from, f.to]);

  if (!canManage(role)) return <p className="card">Apenas o dono ou o gerente acessam o histórico de pedidos.</p>;

  const apply = (next: Filters) => { setF(next); setApplied(next); setPage(0); };
  const sel = (k: keyof Filters, v: string) => apply({ ...f, [k]: v });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="h1">Histórico de pedidos</h1>
        <button className="btn-secondary" onClick={exportCsv} disabled={!count}>Exportar CSV</button>
      </div>

      <form className="card space-y-3" onSubmit={(e) => { e.preventDefault(); apply(f); }}>
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex rounded-lg border border-zinc-200 bg-white p-1" role="group" aria-label="Período">
            {([[1, "Hoje"], [7, "7 dias"], [30, "30 dias"]] as const).map(([d, l]) => (
              <button type="button" key={d} aria-pressed={activePreset === d} onClick={() => apply({ ...f, ...preset(d) })}
                className={`rounded-md px-3 py-1.5 text-sm ${activePreset === d ? "bg-brand-700 font-semibold text-white" : "text-zinc-600"}`}>{l}</button>
            ))}
          </div>
          <label className="text-xs text-zinc-600">De
            <input type="date" className="input mt-0.5 w-auto" value={f.from} max={f.to} onChange={(e) => e.target.value && apply({ ...f, from: e.target.value })} />
          </label>
          <label className="text-xs text-zinc-600">Até
            <input type="date" className="input mt-0.5 w-auto" value={f.to} min={f.from} onChange={(e) => e.target.value && apply({ ...f, to: e.target.value })} />
          </label>
          <div className="flex min-w-48 flex-1 gap-2">
            <input className="input" placeholder="Nº, cliente ou telefone" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} aria-label="Buscar" />
            <button className="btn-primary">Buscar</button>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          <select className="input" value={f.status} onChange={(e) => sel("status", e.target.value)} aria-label="Status">
            <option value="">Todos os status</option>
            {Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <select className="input" value={f.channel} onChange={(e) => sel("channel", e.target.value)} aria-label="Origem">
            <option value="">Todas as origens</option>
            {CHANNELS.map((c) => <option key={c} value={c}>{channelLabel(c)}</option>)}
          </select>
          <select className="input" value={f.type} onChange={(e) => sel("type", e.target.value)} aria-label="Tipo">
            <option value="">Todos os tipos</option>
            {Object.entries(TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <select className="input" value={f.payment} onChange={(e) => sel("payment", e.target.value)} aria-label="Pagamento">
            <option value="">Todos os pagamentos</option>
            {Object.entries(PAYMENT_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
      </form>

      <Alert>{err}</Alert>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {[["Pedidos", totals ? String(totals.n) : "…"], ["Faturamento", totals ? brl(totals.revenue) : "…"],
          ["Ticket médio", totals ? (totals.n ? brl(Math.round(totals.revenue / totals.n)) : "—") : "…"],
          ["Cancelados", totals ? String(totals.cancelled) : "…"]].map(([k, v]) => (
          <div key={k} className="card"><p className="text-xs font-medium text-zinc-500">{k}</p><p className="mt-1 text-xl font-bold tabular-nums">{v}</p></div>
        ))}
      </div>
      {totals?.capped && <p className="text-xs text-amber-700">Totais calculados sobre os {MAX_EXPORT} primeiros pedidos do filtro. Reduza o período para o valor exato.</p>}

      {rows.length === 0 ? <Empty>{loading ? "Carregando…" : "Nenhum pedido encontrado com estes filtros."}</Empty> : (
        <div className={`overflow-x-auto rounded-xl border border-zinc-200 bg-white ${loading ? "opacity-60" : ""}`}>
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 text-left text-xs uppercase text-zinc-500">
              <tr><th className="p-3">#</th><th className="p-3">Data</th><th className="p-3">Origem</th><th className="p-3">Cliente</th><th className="p-3">Tipo</th>
                <th className="p-3">Pagamento</th><th className="p-3">Status</th><th className="p-3 text-right">Total</th></tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {rows.map((o) => (
                <tr key={o.id} tabIndex={0} role="button" aria-label={`Abrir pedido ${o.number}`} className="cursor-pointer hover:bg-zinc-50 focus:bg-zinc-50 focus:outline-none"
                  onClick={() => openOrder(o)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openOrder(o); } }}>
                  <td className="p-3 font-bold tabular-nums">#{o.number}</td>
                  <td className="whitespace-nowrap p-3 text-xs text-zinc-600">{new Date(o.created_at).toLocaleDateString("pt-BR")} {timeHM(o.created_at)}</td>
                  <td className="p-3">{o.channel === "web" ? <span className="text-xs text-zinc-600">Cardápio próprio</span> : <ChannelBadge channel={o.channel} />}</td>
                  <td className="p-3">{o.customer_name}</td>
                  <td className="p-3">{TYPE_LABEL[o.type] ?? o.type}</td>
                  <td className="p-3">{PAYMENT_LABEL[o.payment_method] ?? o.payment_method}</td>
                  <td className="p-3"><span className={`badge ${STATUS_CLS[o.status] ?? "bg-zinc-100 text-zinc-700"}`}>{STATUS_LABEL[o.status] ?? o.status}</span></td>
                  <td className="p-3 text-right font-semibold tabular-nums">{brl(o.total_cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {count > PAGE && (
        <div className="flex items-center justify-between text-sm">
          <span className="text-zinc-500">{page * PAGE + 1}–{Math.min(count, (page + 1) * PAGE)} de {count}</span>
          <div className="flex gap-2">
            <button className="btn-secondary" disabled={page === 0} onClick={() => setPage(page - 1)}>Anterior</button>
            <span className="self-center tabular-nums text-zinc-600">{page + 1} / {pages}</span>
            <button className="btn-secondary" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>Próxima</button>
          </div>
        </div>
      )}

      <Modal open={!!open} onClose={() => setOpen(null)} title={open ? `Pedido #${open.number} · ${STATUS_LABEL[open.status] ?? open.status}` : ""} wide>
        {open && (
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-3 text-sm">
              <div>
                <p className="font-semibold">{open.customer_name}</p>
                {open.customer_phone !== "00000000000" && <p className="text-zinc-600">{formatPhone(open.customer_phone)}</p>}
              </div>
              <p className="flex flex-wrap items-center gap-2"><span className="text-zinc-500">Origem:</span>
                {open.channel === "web" ? "Cardápio próprio" : <ChannelBadge channel={open.channel} size="md" />}
                {open.external_display_id && <span className="text-zinc-600">nº {open.external_display_id}</span>}
                <span className="text-zinc-500">· {TYPE_LABEL[open.type] ?? open.type}</span></p>
              <p className="text-zinc-600">{new Date(open.created_at).toLocaleString("pt-BR")}</p>
              {open.address?.street && (
                <div className="rounded-lg bg-zinc-50 p-2">
                  <p className="font-medium">{open.address.street}, {open.address.number}{open.address.complement ? ` – ${open.address.complement}` : ""}</p>
                  <p className="text-zinc-600">{open.address.neighborhood}{open.address.city ? ` · ${open.address.city}` : ""}</p>
                  {open.address.reference && <p className="text-zinc-600">Ref.: {open.address.reference}</p>}
                </div>
              )}
              <p><span className="text-zinc-500">Pagamento:</span> {PAYMENT_LABEL[open.payment_method] ?? open.payment_method}{" "}
                <span className={open.payment_status === "paid" ? "text-green-700" : "text-amber-700"}>({open.payment_status === "paid" ? "pago" : open.payment_status === "refunded" ? "estornado" : "pendente"})</span></p>
              {open.coupon_code && <p><span className="text-zinc-500">Cupom:</span> {open.coupon_code}</p>}
              {open.notes && <p className="rounded-lg border border-amber-300 bg-amber-50 p-2 font-medium text-amber-900">Obs.: {open.notes}</p>}
              {open.cancel_reason && <p className="text-red-700">Cancelado: {open.cancel_reason}</p>}
              <div>
                <h3 className="mb-1 font-semibold">Linha do tempo</h3>
                <ol className="space-y-1 text-xs text-zinc-600">
                  {events.map((e) => <li key={e.id}>{timeHM(e.created_at)} · {STATUS_LABEL[e.to_status] ?? e.to_status}{e.note ? ` — ${e.note}` : ""}</li>)}
                  {events.length === 0 && <li>—</li>}
                </ol>
              </div>
            </div>
            <div>
              <h3 className="mb-2 font-semibold">Itens</h3>
              {!open.order_items ? <p className="text-sm text-zinc-500">Carregando…</p> : (
                <ul className="divide-y divide-zinc-100 text-sm">
                  {open.order_items.map((i) => (
                    <li key={i.id} className="py-2">
                      <div className="flex justify-between gap-2"><span className="font-medium">{i.quantity}x {i.name}</span><span className="tabular-nums">{brl(i.total_cents)}</span></div>
                      {(i.options ?? []).map((op, k) => (
                        <p key={k} className="text-xs text-zinc-600">+ {op.quantity && op.quantity > 1 ? `${op.quantity}x ` : ""}{op.name}</p>
                      ))}
                      {i.notes && <p className="mt-0.5 text-xs font-medium text-amber-800">Obs.: {i.notes}</p>}
                    </li>
                  ))}
                </ul>
              )}
              <dl className="mt-3 space-y-1 border-t border-zinc-200 pt-3 text-sm">
                <div className="flex justify-between"><dt className="text-zinc-500">Subtotal</dt><dd className="tabular-nums">{brl(open.subtotal_cents)}</dd></div>
                {open.delivery_fee_cents > 0 && <div className="flex justify-between"><dt className="text-zinc-500">Entrega</dt><dd className="tabular-nums">{brl(open.delivery_fee_cents)}</dd></div>}
                {open.discount_cents > 0 && <div className="flex justify-between text-green-700"><dt>Desconto</dt><dd className="tabular-nums">− {brl(open.discount_cents)}</dd></div>}
                <div className="flex justify-between text-base font-bold"><dt>Total</dt><dd className="tabular-nums">{brl(open.total_cents)}</dd></div>
                {open.change_for_cents != null && <p className="text-xs text-zinc-600">Troco para {brl(open.change_for_cents)}</p>}
              </dl>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
