"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { usePanel } from "@/lib/panel/context";
import { Alert, Empty, Modal, Toggle } from "@/components/ui";
import { EmitButton } from "@/components/fiscal/emit-button";
import { GatewayBlock, useOrderGateway } from "../pagamentos/shared";
import {
  brl, errorMessage, formatPhone, onlyDigits, parseBRL, PAYMENT_LABEL, STATUS_LABEL, timeHM, TYPE_LABEL,
} from "@/lib/format";
import { printTicket } from "./ticket";
import { courierOf, statusMessage, type Order } from "./types";
import { ChannelBadge, channelLabel, isMarketplace } from "@/components/channel-badge";


const COLUMNS: { key: string; title: string; statuses: string[]; color: string }[] = [
  { key: "pix", title: "Aguardando pagamento", statuses: ["awaiting_payment"], color: "bg-amber-500" },
  { key: "new", title: "Novos", statuses: ["pending"], color: "bg-red-500" },
  { key: "prep", title: "Em preparo", statuses: ["preparing"], color: "bg-orange-500" },
  { key: "ready", title: "Pronto", statuses: ["ready"], color: "bg-sky-500" },
  { key: "out", title: "Em rota / Retirada", statuses: ["dispatched", "awaiting_pickup"], color: "bg-violet-500" },
  { key: "done", title: "Concluídos hoje", statuses: ["completed"], color: "bg-emerald-500" },
];

function nextAction(o: Order): { status: string; label: string } | null {
  switch (o.status) {
    case "pending": return { status: "preparing", label: "Aceitar" };
    case "preparing": return { status: "ready", label: "Pronto" };
    case "ready": return o.type === "delivery"
      ? { status: "dispatched", label: "Despachar" }
      : { status: "awaiting_pickup", label: "Avisar retirada" };
    case "dispatched":
    case "awaiting_pickup": return { status: "completed", label: "Concluir" };
    default: return null;
  }
}

const SELECT = "*, order_items(*), deliveries(status, couriers(name))";

function startOfToday() {
  const d = new Date(); d.setHours(0, 0, 0, 0); return d;
}

// ---------- Alerta sonoro (Web Audio) ----------
function useAlarm(active: boolean, muted: boolean) {
  const ctxRef = useRef<AudioContext | null>(null);
  useEffect(() => {
    if (!active || muted) return;
    const beep = () => {
      try {
        ctxRef.current ??= new AudioContext();
        const ctx = ctxRef.current;
        if (ctx.state === "suspended") void ctx.resume();
        [0, 0.25].forEach((delay) => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = "sine";
          osc.frequency.value = 880;
          gain.gain.setValueAtTime(0.0001, ctx.currentTime + delay);
          gain.gain.exponentialRampToValueAtTime(0.4, ctx.currentTime + delay + 0.02);
          gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + delay + 0.2);
          osc.connect(gain).connect(ctx.destination);
          osc.start(ctx.currentTime + delay);
          osc.stop(ctx.currentTime + delay + 0.22);
        });
      } catch { /* navegador bloqueou o áudio até a primeira interação */ }
    };
    beep();
    const id = setInterval(beep, 2500);
    return () => clearInterval(id);
  }, [active, muted]);
}

function useNow(intervalMs = 15000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export default function PedidosPage() {
  const { unit } = usePanel();
  const sb = supabaseBrowser();
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [search, setSearch] = useState("");
  const [showCancelled, setShowCancelled] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [acked, setAcked] = useState<Set<string>>(new Set());
  const [notifPerm, setNotifPerm] = useState<string>("default");
  const knownIds = useRef<Set<string>>(new Set());
  const firstLoad = useRef(true);
  const now = useNow();

  useEffect(() => {
    try { setMuted(localStorage.getItem("df_mute") === "1"); } catch { /* sem storage */ }
    if (typeof Notification !== "undefined") setNotifPerm(Notification.permission);
  }, []);

  const notify = useCallback((o: Order) => {
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    try {
      new Notification(`Novo pedido #${o.number}`, { body: `${o.customer_name} · ${brl(o.total_cents)}`, tag: o.id });
    } catch { /* alguns navegadores móveis não suportam */ }
  }, []);

  const track = useCallback((list: Order[]) => {
    for (const o of list) {
      if (!knownIds.current.has(o.id)) {
        knownIds.current.add(o.id);
        if (!firstLoad.current && (o.status === "pending" || o.status === "awaiting_payment")) notify(o);
      }
    }
  }, [notify]);

  const load = useCallback(async () => {
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const [recent, open] = await Promise.all([
      sb.from("orders").select(SELECT).eq("unit_id", unit.id).gte("created_at", since)
        .order("created_at", { ascending: false }).limit(300),
      sb.from("orders").select(SELECT).eq("unit_id", unit.id)
        .not("status", "in", "(completed,cancelled)").lt("created_at", since).limit(200),
    ]);
    if (recent.error || open.error) { setErr(errorMessage(recent.error ?? open.error)); setLoading(false); return; }
    const map = new Map<string, Order>();
    for (const o of [...(recent.data ?? []), ...(open.data ?? [])] as Order[]) map.set(o.id, o);
    const list = [...map.values()];
    track(list);
    firstLoad.current = false;
    setOrders(list);
    setLoading(false);
  }, [sb, unit.id, track]);

  const refetchOne = useCallback(async (id: string) => {
    const { data } = await sb.from("orders").select(SELECT).eq("id", id).maybeSingle();
    if (!data) { setOrders((cur) => cur.filter((o) => o.id !== id)); return; }
    track([data as Order]);
    setOrders((cur) => {
      const rest = cur.filter((o) => o.id !== id);
      return [data as Order, ...rest];
    });
  }, [sb, track]);

  useEffect(() => {
    void load();
    const channel = sb.channel(`orders-${unit.id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "orders", filter: `unit_id=eq.${unit.id}` },
        (payload: { new?: { id?: string }; old?: { id?: string } }) => {
          const id = payload.new?.id ?? payload.old?.id;
          if (id) void refetchOne(id);
        })
      .subscribe();
    const poll = setInterval(() => void load(), 60000);
    return () => { clearInterval(poll); void sb.removeChannel(channel); };
  }, [sb, unit.id, load, refetchOne]);

  const unacked = orders.some((o) => (o.status === "pending" || o.status === "awaiting_payment") && !acked.has(o.id));
  useAlarm(unacked, muted);

  function ackAll() {
    setAcked(new Set(orders.filter((o) => o.status === "pending" || o.status === "awaiting_payment").map((o) => o.id)));
  }

  function toggleMute() {
    const v = !muted;
    setMuted(v);
    try { localStorage.setItem("df_mute", v ? "1" : "0"); } catch { /* ignora */ }
  }

  async function enableNotifications() {
    if (typeof Notification === "undefined") return;
    setNotifPerm(await Notification.requestPermission());
  }

  async function changeStatus(o: Order, status: string, reason?: string) {
    setBusy(o.id); setErr("");
    const { error } = await sb.rpc("set_order_status", { p_order_id: o.id, p_status: status, p_reason: reason ?? null });
    setBusy(null);
    if (error) { setErr(errorMessage(error)); return false; }
    setAcked((s) => new Set(s).add(o.id));
    await refetchOne(o.id);
    return true;
  }

  async function confirmPix(o: Order) {
    setBusy(o.id); setErr("");
    const { error } = await sb.rpc("confirm_payment", { p_order_id: o.id });
    setBusy(null);
    if (error) { setErr(errorMessage(error)); return; }
    setAcked((s) => new Set(s).add(o.id));
    await refetchOne(o.id);
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const qd = onlyDigits(q);
    if (!q) return orders;
    return orders.filter((o) =>
      String(o.number) === q.replace("#", "") ||
      o.customer_name.toLowerCase().includes(q) ||
      (qd.length >= 3 && o.customer_phone.includes(qd)));
  }, [orders, search]);

  const today = startOfToday().getTime();
  const columns = COLUMNS.map((c) => {
    let list = filtered.filter((o) => c.statuses.includes(o.status));
    if (c.key === "done") {
      list = list.filter((o) => new Date(o.completed_at ?? o.created_at).getTime() >= today)
        .sort((a, b) => (b.completed_at ?? "").localeCompare(a.completed_at ?? "")).slice(0, 30);
    } else {
      list = list.sort((a, b) => a.created_at.localeCompare(b.created_at));
    }
    return { ...c, list };
  });
  const cancelled = filtered.filter((o) => o.status === "cancelled" && new Date(o.cancelled_at ?? o.created_at).getTime() >= today);
  if (showCancelled) columns.push({ key: "cancel", title: "Cancelados hoje", statuses: ["cancelled"], color: "bg-zinc-500", list: cancelled });

  const current = orders.find((o) => o.id === selected) ?? null;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="h1 mr-auto">Gestor de pedidos</h1>
        <input className="input max-w-xs" type="search" placeholder="Nº, nome ou telefone" aria-label="Buscar pedido"
          value={search} onChange={(e) => setSearch(e.target.value)} />
        <label className="flex items-center gap-2 text-sm">
          <Toggle checked={showCancelled} onChange={setShowCancelled} label="Mostrar cancelados" /> Cancelados
        </label>
        <button className="btn-secondary" onClick={toggleMute} aria-pressed={muted}>
          {muted ? "Som desligado" : "Som ligado"}
        </button>
        {notifPerm === "default" && (
          <button className="btn-secondary" onClick={enableNotifications}>Ativar notificações</button>
        )}
      </div>

      {unacked && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-gradient-to-r from-brand-600 to-brand-700 px-4 py-3 text-white shadow-sm" role="alert">
          <span className="flex items-center gap-2 font-semibold"><span className="h-2.5 w-2.5 animate-ping rounded-full bg-white" />Você tem pedidos novos aguardando!</span>
          <button className="btn bg-white text-red-700 hover:bg-red-50" onClick={ackAll}>Silenciar alerta</button>
        </div>
      )}
      <div className="mb-4"><Alert>{err}</Alert></div>

      {loading ? (
        <p className="text-sm text-zinc-500">Carregando pedidos...</p>
      ) : (
        <div className="flex gap-3 overflow-x-auto pb-4">
          {columns.map((col) => (
            <section key={col.key} className="relative flex w-72 shrink-0 flex-col overflow-hidden rounded-lg bg-zinc-200/45 p-2.5 pt-3.5 ring-1 ring-zinc-200/70" aria-label={col.title}>
              <span aria-hidden className={`absolute inset-x-0 top-0 h-1 ${col.color}`} />
              <header className="mb-2 flex items-center justify-between px-1">
                <h2 className="flex items-center gap-2 text-sm font-bold">
                  <span className={`h-2.5 w-2.5 rounded-full ${col.color}`} />{col.title}
                </h2>
                <span className="badge bg-white text-zinc-700 shadow-sm">{col.list.length}</span>
              </header>
              <div className="space-y-2">
                {col.list.length === 0 && <p className="px-1 py-4 text-center text-xs text-zinc-400">Nenhum pedido</p>}
                {col.list.map((o) => (
                  <OrderCard key={o.id} o={o} now={now} busy={busy === o.id}
                    isNew={(o.status === "pending" || o.status === "awaiting_payment") && !acked.has(o.id)}
                    onOpen={() => { setSelected(o.id); setAcked((s) => new Set(s).add(o.id)); }}
                    onAction={(s) => void changeStatus(o, s)} onConfirmPix={() => void confirmPix(o)} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {!loading && orders.length === 0 && (
        <Empty>Nenhum pedido nas últimas 24 horas. Compartilhe o link do seu cardápio: /loja/{unit.slug}</Empty>
      )}

      <OrderDetail order={current} unitName={unit.name} onClose={() => setSelected(null)}
        busy={!!current && busy === current.id}
        onAction={(s, reason) => current ? changeStatus(current, s, reason) : Promise.resolve(false)}
        onConfirmPix={() => current && void confirmPix(current)} />
    </div>
  );
}

function elapsedInfo(o: Order, now: number) {
  const from = new Date(o.accepted_at ?? o.created_at).getTime();
  const min = Math.max(0, Math.floor((now - from) / 60000));
  const color = min < 15 ? "bg-green-100 text-green-800" : min < 30 ? "bg-yellow-100 text-yellow-800" : "bg-red-100 text-red-800";
  return { min, color };
}

function OrderCard({ o, now, busy, isNew, onOpen, onAction, onConfirmPix }: {
  o: Order; now: number; busy: boolean; isNew: boolean;
  onOpen: () => void; onAction: (status: string) => void; onConfirmPix: () => void;
}) {
  const action = nextAction(o);
  const finished = o.status === "completed" || o.status === "cancelled";
  const { min, color } = elapsedInfo(o, now);
  return (
    <article className={`rounded-xl border bg-white p-3.5 shadow-soft transition ${isNew ? "border-brand-400 ring-4 ring-brand-100" : "border-zinc-200/80"}`}>
      <button type="button" onClick={onOpen} className="block w-full text-left" aria-label={`Abrir pedido ${o.number}`}>
        <div className="flex items-start justify-between gap-2">
          <span className="flex min-w-0 items-center gap-1.5">
            <ChannelBadge channel={o.channel} />
            <span className="truncate font-semibold">#{o.number} · {o.customer_name.split(" ")[0]}</span>
          </span>
          <span className="font-semibold text-zinc-900">{brl(o.total_cents)}</span>
        </div>
        <p className="mt-1 text-xs text-zinc-500">
          {TYPE_LABEL[o.type] ?? o.type}{isMarketplace(o.channel) && o.external_display_id ? ` · nº ${o.external_display_id} no ${channelLabel(o.channel)}` : ""} · {timeHM(o.created_at)}
          {courierOf(o) && <> · <b className="text-zinc-700">Entregador: {courierOf(o)!.split(" ")[0]}</b></>}
          {o.scheduled_for && <> · <b className="text-brand-700">Agendado {new Date(o.scheduled_for).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</b></>}
        </p>
        <p className="mt-1 text-xs text-zinc-600">
          {PAYMENT_LABEL[o.payment_method] ?? o.payment_method}
          {o.payment_method === "pix" && o.payment_status !== "paid" && <span className="ml-1 font-semibold text-amber-700">· Pix pendente</span>}
          {o.payment_status === "paid" && <span className="ml-1 text-green-700">· Pago</span>}
        </p>
        <ul className="mt-2 space-y-0.5 text-xs text-zinc-700">
          {o.order_items.slice(0, 4).map((i) => <li key={i.id}>{i.quantity}x {i.name}</li>)}
          {o.order_items.length > 4 && <li className="text-zinc-400">+ {o.order_items.length - 4} itens</li>}
        </ul>
        {!finished && <span className={`badge mt-2 tabular-nums ${color}`}>{min} min</span>}
        {o.status === "cancelled" && o.cancel_reason && <p className="mt-2 text-xs text-red-700">Motivo: {o.cancel_reason}</p>}
        {o.marketplace_cancel_requested && (
          <p className="mt-2 rounded-lg bg-red-50 px-2 py-1 text-xs font-bold text-red-800 ring-1 ring-red-200">
            {channelLabel(o.channel)} pediu o cancelamento. Abra o pedido para responder.
          </p>
        )}
      </button>
      {o.status === "awaiting_payment" && (
        <button className="btn-success mt-2 w-full" disabled={busy} onClick={onConfirmPix}>Confirmar Pix</button>
      )}
      {action && (
        <button className="btn-primary mt-2 w-full" disabled={busy} onClick={() => onAction(action.status)}>
          {busy ? "..." : action.label}
        </button>
      )}
    </article>
  );
}

type OrderEvent = { id: number; from_status: string | null; to_status: string; note: string | null; created_at: string };

function OrderDetail({ order, unitName, onClose, busy, onAction, onConfirmPix }: {
  order: Order | null; unitName: string; onClose: () => void; busy: boolean;
  onAction: (status: string, reason?: string) => Promise<boolean>; onConfirmPix: () => void;
}) {
  const sb = supabaseBrowser();
  const [events, setEvents] = useState<OrderEvent[]>([]);
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState("");
  const orderId = order?.id;
  const orderStatus = order?.status;
  const online = order?.payment_method === "pix" || order?.payment_method === "online_card";
  const gp = useOrderGateway(online ? orderId : undefined, `${orderStatus}-${order?.payment_status}`);

  useEffect(() => {
    setCancelling(false); setReason("");
  }, [orderId]);

  useEffect(() => {
    if (!orderId) return;
    let alive = true;
    void sb.from("order_events").select("id, from_status, to_status, note, created_at")
      .eq("order_id", orderId).order("created_at").then(({ data }: { data: OrderEvent[] | null }) => {
        if (alive) setEvents(data ?? []);
      });
    return () => { alive = false; };
  }, [sb, orderId, orderStatus]);

  if (!order) return null;
  const o = order;
  const action = nextAction(o);
  const canCancel = o.status !== "completed" && o.status !== "cancelled";
  const phone = onlyDigits(o.customer_phone);
  const wa = `https://wa.me/${phone.length <= 11 ? "55" + phone : phone}`;
  const waStatus = `${wa}?text=${encodeURIComponent(statusMessage(o, unitName))}`;
  const marketplace = ["ifood", "keeta", "99food", "aiqfome", "marketplace"].includes(o.channel);
  const a = o.address;

  async function doCancel() {
    if (!reason.trim()) return;
    const ok = await onAction("cancelled", reason.trim());
    if (ok) { setCancelling(false); setReason(""); }
  }

  return (
    <Modal open onClose={onClose} title={`Pedido #${o.number} · ${STATUS_LABEL[o.status] ?? o.status}`} wide>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-3 text-sm">
          <div>
            <p className="font-semibold">{o.customer_name}</p>
            <p className="text-zinc-600">
              {formatPhone(o.customer_phone)} · <a className="text-green-700 hover:underline" href={wa} target="_blank" rel="noopener noreferrer">WhatsApp ↗</a>
              {!marketplace && phone.length >= 10 && <> · <a className="text-green-700 hover:underline" href={waStatus} target="_blank" rel="noopener noreferrer"
                title="Abre o WhatsApp com a mensagem do status atual">Avisar status ↗</a></>}
            </p>
          </div>
          <p className="flex flex-wrap items-center gap-2"><span className="text-zinc-500">Origem:</span> <ChannelBadge channel={o.channel} size="md" />
            {o.channel === "web" && <span>Cardápio próprio</span>}
            {o.external_display_id && <span className="text-zinc-600">nº {o.external_display_id}</span>}
            <span className="text-zinc-500">· {TYPE_LABEL[o.type] ?? o.type}</span>
            {courierOf(o) && <span className="text-zinc-600">· Entregador: <b>{courierOf(o)}</b></span>}</p>
          {o.marketplace_cancel_requested && <MarketplaceCancel o={o} />}
          {o.scheduled_for && <p className="font-semibold text-brand-700">Agendado para {new Date(o.scheduled_for).toLocaleString("pt-BR")}</p>}
          {a && (
            <div className="rounded-lg bg-zinc-50 p-2">
              <p className="font-medium">{a.street}, {a.number}{a.complement ? ` – ${a.complement}` : ""}</p>
              <p className="text-zinc-600">{a.neighborhood}{a.city ? ` · ${a.city}` : ""}</p>
              {a.reference && <p className="text-zinc-600">Ref.: {a.reference}</p>}
            </div>
          )}
          <div>
            <p><span className="text-zinc-500">Pagamento:</span> {PAYMENT_LABEL[o.payment_method] ?? o.payment_method}
              {" "}<span className={o.payment_status === "paid" ? "text-green-700" : "text-amber-700"}>({o.payment_status === "paid" ? "pago" : "pendente"})</span></p>
            <GatewayBlock gp={gp} />
            {o.change_for_cents != null && <p className="font-semibold">Troco para {brl(o.change_for_cents)} (levar {brl(o.change_for_cents - o.total_cents)})</p>}
            {o.coupon_code && <p><span className="text-zinc-500">Cupom:</span> {o.coupon_code}</p>}
          </div>
          {o.notes && <p className="rounded-lg border border-amber-300 bg-amber-50 p-2 font-medium text-amber-900">Obs.: {o.notes}</p>}
          {o.cancel_reason && <p className="text-red-700">Cancelado: {o.cancel_reason}</p>}
          <div>
            <h3 className="mb-1 font-semibold">Linha do tempo</h3>
            <ol className="space-y-1 text-xs text-zinc-600">
              {events.map((e) => (
                <li key={e.id}>{timeHM(e.created_at)} · {STATUS_LABEL[e.to_status] ?? e.to_status}{e.note ? ` — ${e.note}` : ""}</li>
              ))}
            </ol>
          </div>
        </div>
        <div>
          <h3 className="mb-2 font-semibold">Itens</h3>
          <ul className="divide-y divide-zinc-100 text-sm">
            {o.order_items.map((i) => (
              <li key={i.id} className="py-2">
                <div className="flex justify-between gap-2"><span className="font-medium">{i.quantity}x {i.name}</span><span>{brl(i.total_cents)}</span></div>
                {i.options?.length > 0 && (
                  <ul className="ml-4 text-xs text-zinc-600">
                    {i.options.map((op, k) => <li key={k}>{op.quantity > 1 ? `${op.quantity}x ` : ""}{op.name} <span className="text-zinc-400">({op.group})</span></li>)}
                  </ul>
                )}
                {i.notes && <p className="ml-4 mt-1 rounded bg-amber-50 px-1 text-xs font-semibold text-amber-900">⚠ {i.notes}</p>}
              </li>
            ))}
          </ul>
          <dl className="mt-3 space-y-1 border-t border-zinc-200 pt-2 text-sm">
            <div className="flex justify-between"><dt>Subtotal</dt><dd>{brl(o.subtotal_cents)}</dd></div>
            {o.delivery_fee_cents > 0 && <div className="flex justify-between"><dt>Entrega</dt><dd>{brl(o.delivery_fee_cents)}</dd></div>}
            {o.discount_cents > 0 && <div className="flex justify-between text-green-700"><dt>Desconto</dt><dd>- {brl(o.discount_cents)}</dd></div>}
            <div className="flex justify-between text-base font-bold"><dt>Total</dt><dd>{brl(o.total_cents)}</dd></div>
          </dl>
          {o.payment_status === "paid" && !o.tab_id && o.status !== "cancelled" && <div className="mt-3"><EmitButton orderId={o.id} compact /></div>}
          <ReprintButton orderId={o.id} />
          {o.payment_status !== "paid" && o.type !== "delivery" && !o.tab_id && !isMarketplace(o.channel)
            && !["cancelled", "awaiting_payment"].includes(o.status) && o.payment_method !== "online_card" && <ReceiveAtCounter o={o} />}
        </div>
      </div>

      {cancelling ? (
        <div className="mt-4 space-y-2 rounded-lg border border-red-200 bg-red-50 p-3">
          <label className="label" htmlFor="cancel-reason">Motivo do cancelamento</label>
          <input id="cancel-reason" className="input" autoFocus maxLength={300} value={reason}
            onChange={(e) => setReason(e.target.value)} placeholder="Ex.: cliente desistiu, item em falta..."
            onKeyDown={(e) => { if (e.key === "Enter") void doCancel(); }} />
          {o.payment_status === "paid" && (gp?.status === "approved"
            ? <p className="text-xs text-red-800">O valor será estornado automaticamente no Mercado Pago.</p>
            : <p className="text-xs text-red-800">Este pedido já foi pago: faça o estorno ao cliente.</p>)}
          <div className="flex gap-2">
            <button className="btn-danger" disabled={busy || !reason.trim()} onClick={() => void doCancel()}>Confirmar cancelamento</button>
            <button className="btn-ghost" onClick={() => setCancelling(false)}>Voltar</button>
          </div>
        </div>
      ) : (
        <div className="mt-4 flex flex-wrap gap-2 border-t border-zinc-200 pt-4">
          {o.status === "awaiting_payment" && o.payment_method === "pix" && <button className="btn-success" disabled={busy} onClick={onConfirmPix}>Confirmar Pix</button>}
          {action && <button className="btn-primary" disabled={busy} onClick={() => void onAction(action.status)}>{action.label}</button>}
          <button className="btn-secondary" onClick={() => printTicket(o, unitName)}>🖨 Imprimir</button>
          {canCancel && <button className="btn-ghost ml-auto text-red-700" onClick={() => setCancelling(true)}>Cancelar pedido</button>}
        </div>
      )}
    </Modal>
  );
}

/** Recebe no caixa um pedido ainda não pago (totem "pagar no caixa", retirada). */
function ReceiveAtCounter({ o }: { o: Order }) {
  const sb = supabaseBrowser();
  const [open, setOpen] = useState(false);
  const [method, setMethod] = useState("cash");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [done, setDone] = useState("");
  const cents = method === "cash" && amount ? parseBRL(amount) : o.total_cents;
  async function receive() {
    setBusy(true); setErr("");
    const { data, error } = await sb.rpc("order_receive", { p_order_id: o.id, p_payments: [{ method, amount_cents: cents }] });
    setBusy(false);
    if (error) { setErr(errorMessage(error)); return; }
    const change = (data as { change_cents: number }).change_cents;
    setDone(change > 0 ? `Recebido. Troco: ${brl(change)}` : "Recebido.");
  }
  if (done) return <p className="mt-3 rounded-lg bg-green-50 px-3 py-2 text-sm font-medium text-green-800">{done}</p>;
  if (!open) return <button className="btn-success mt-3 w-full" onClick={() => setOpen(true)}>Receber {brl(o.total_cents)} no caixa</button>;
  return (
    <div className="mt-3 space-y-2 rounded-lg border border-zinc-200 p-3">
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Forma de pagamento">
        {([["cash", "Dinheiro"], ["pix", "Pix"], ["debit_card", "Débito"], ["credit_card", "Crédito"], ["voucher", "Vale"]] as const).map(([k, l]) => (
          <button key={k} type="button" role="radio" aria-checked={method === k} className={method === k ? "btn-primary px-3 py-1.5 text-sm" : "btn-secondary px-3 py-1.5 text-sm"}
            onClick={() => setMethod(k)}>{l}</button>
        ))}
      </div>
      {method === "cash" && (
        <label className="block text-sm"><span className="label">Valor recebido (para o troco)</span>
          <input className="input" inputMode="decimal" placeholder={brl(o.total_cents)} value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
      )}
      {err && <p className="text-sm text-red-700">{err}</p>}
      <div className="flex gap-2">
        <button className="btn-success" disabled={busy || cents < o.total_cents} onClick={() => void receive()}>{busy ? "Recebendo..." : "Confirmar recebimento"}</button>
        <button className="btn-ghost" onClick={() => setOpen(false)}>Voltar</button>
      </div>
    </div>
  );
}

function MarketplaceCancel({ o }: { o: Order }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  async function respond(accept: boolean) {
    setBusy(true); setErr("");
    const { error } = await supabaseBrowser().rpc("respond_marketplace_cancellation", { p_order_id: o.id, p_accept: accept });
    setBusy(false);
    if (error) setErr(errorMessage(error));
  }
  return (
    <div className="rounded-lg border border-red-200 bg-red-50 p-3">
      <p className="font-semibold text-red-900">{channelLabel(o.channel)} pediu o cancelamento deste pedido.</p>
      <p className="mt-0.5 text-xs text-red-800">Se o pedido ainda não foi preparado, aceite. Se já está pronto ou saiu, recuse.</p>
      <div className="mt-2 flex gap-2">
        <button className="btn-danger" disabled={busy} onClick={() => respond(true)}>Aceitar cancelamento</button>
        <button className="btn-secondary" disabled={busy} onClick={() => respond(false)}>Recusar</button>
      </div>
      {err && <p className="mt-2 text-xs text-red-700">{err}</p>}
    </div>
  );
}

function ReprintButton({ orderId }: { orderId: string }) {
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  async function run() {
    setBusy(true); setMsg("");
    const { data, error } = await supabaseBrowser().rpc("print_reprint", { p_order_id: orderId });
    setBusy(false);
    setMsg(error ? errorMessage(error) : Number(data) > 0 ? `${data} impressão(ões) enviada(s) para a fila.` : "Nenhuma impressora configurada para este pedido.");
  }
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <button type="button" className="btn-secondary" disabled={busy} onClick={run}>{busy ? "Enviando..." : "Reimprimir"}</button>
      {msg && <span className="text-xs text-zinc-600" role="status">{msg}</span>}
    </div>
  );
}
