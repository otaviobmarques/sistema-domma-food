"use client";
import Link from "next/link";
import { use, useCallback, useEffect, useState } from "react";
import QRCode from "qrcode";
import { supabaseBrowser } from "@/lib/supabase/client";
import { brl, onlyDigits, PAYMENT_LABEL, STATUS_LABEL, timeHM } from "@/lib/format";
import { pixPayload } from "@/lib/pix";
import { storeColor } from "@/components/store/brand";
import { StarInput, Stars } from "@/components/store/loyalty";
import { OnlinePayment, PaymentNote, type OrderGateway } from "./online-payment";

type Order = {
  number: number; status: string; type: "delivery" | "pickup" | "dine_in"; customer_name: string;
  created_at: string; scheduled_for: string | null; estimated_ready_at: string | null;
  subtotal_cents: number; discount_cents: number; delivery_fee_cents: number; total_cents: number;
  payment_method: string; payment_status: string; change_for_cents: number | null; cancel_reason: string | null;
  address: { street: string; number: string; neighborhood: string } | null;
  pix: { key: string | null; merchant_name: string | null; merchant_city: string | null; expires_at: string } | null;
  gateway?: OrderGateway | null;
  unit: { name: string; slug: string; whatsapp: string | null; phone: string | null; logo_url: string | null; primary_color: string };
  items: { name: string; quantity: number; total_cents: number; options: { name: string; quantity: number }[]; notes: string | null }[];
  events: { status: string; at: string }[];
};

type Extras = {
  can_review: boolean; review: { rating: number; comment: string | null; reply: string | null } | null;
  cashback_used_cents: number; cashback_earned_cents: number; points_earned: number;
};

const FINAL = ["completed", "cancelled"];

export default function OrderPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [order, setOrder] = useState<Order | null | undefined>(undefined);
  const [qr, setQr] = useState("");
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [extras, setExtras] = useState<Extras | null>(null);
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState("");
  const [sending, setSending] = useState(false);
  const [reviewErr, setReviewErr] = useState("");
  const [thanks, setThanks] = useState(false);

  const loadExtras = useCallback(async () => {
    const { data } = await supabaseBrowser().rpc("order_extras", { p_token: token });
    if (data) setExtras(data as Extras);
  }, [token]);
  const status = order?.status;
  // cashback e avaliação: ao abrir e quando o pedido muda de etapa (ex.: concluído)
  useEffect(() => { if (status) loadExtras(); }, [status, loadExtras]);

  async function sendReview(e: React.FormEvent) {
    e.preventDefault();
    if (!rating) { setReviewErr("Toque nas estrelas para dar sua nota."); return; }
    setSending(true); setReviewErr("");
    const { error } = await supabaseBrowser().rpc("submit_review", { p_token: token, p_rating: rating, p_comment: comment.trim() || null });
    setSending(false);
    if (error) { setReviewErr(error.message); return; }
    setThanks(true);
    loadExtras();
  }

  const load = useCallback(async () => {
    const { data, error } = await supabaseBrowser().rpc("get_order_by_token", { p_token: token });
    if (!error) setOrder((data as Order | null) ?? null);
  }, [token]);

  useEffect(() => { load(); }, [load]);
  const fastPoll = order?.status === "awaiting_payment" && !!order?.gateway?.config;
  useEffect(() => {
    if (!order || FINAL.includes(order.status)) return;
    const id = setInterval(load, fastPoll ? 4000 : 8000);
    return () => clearInterval(id);
  }, [order, load, fastPoll]);
  useEffect(() => {
    if (!order?.pix) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [order?.pix]);

  const pixCode = order?.pix?.key ? pixPayload({
    key: order.pix.key, name: order.pix.merchant_name || order.unit.name,
    city: order.pix.merchant_city || "BRASIL", amountCents: order.total_cents, txid: `DF${order.number}`,
  }) : "";

  useEffect(() => {
    if (!pixCode) { setQr(""); return; }
    QRCode.toDataURL(pixCode, { margin: 1, width: 240 }).then(setQr).catch(() => setQr(""));
  }, [pixCode]);

  if (order === undefined) return <p className="p-8 text-center text-sm text-zinc-500">Carregando pedido...</p>;
  if (order === null) return (
    <main className="mx-auto max-w-lg p-8 text-center">
      <h1 className="text-xl font-bold">Pedido não encontrado</h1>
      <p className="mt-2 text-sm text-zinc-600">Confira o link recebido.</p>
    </main>
  );

  const color = storeColor(order.unit.primary_color);
  const steps = ["awaiting_payment", "pending", "preparing", "ready", order.type === "delivery" ? "dispatched" : "awaiting_pickup", "completed"]
    .filter((s) => s !== "awaiting_payment" || order.payment_method === "pix" || order.payment_method === "online_card");
  const at = (s: string) => order.events.filter((e) => e.status === s).at(-1)?.at;
  const currentIdx = steps.indexOf(order.status);
  const cancelled = order.status === "cancelled";
  const wa = onlyDigits(order.unit.whatsapp || order.unit.phone || "");
  const waLink = wa ? `https://wa.me/${wa.startsWith("55") ? wa : "55" + wa}?text=${encodeURIComponent(`Olá! Sobre o pedido #${order.number}`)}` : "";
  const remaining = order.pix ? Math.max(0, new Date(order.pix.expires_at).getTime() - now) : 0;
  const mm = Math.floor(remaining / 60000), ss = Math.floor((remaining % 60000) / 1000);

  async function copy() {
    try { await navigator.clipboard.writeText(pixCode); setCopied(true); setTimeout(() => setCopied(false), 2500); } catch { /* sem permissão */ }
  }

  return (
    <main className="mx-auto max-w-lg px-4 pb-10">
      <div className="-mx-4 mb-5 rounded-b-[2rem] px-5 pb-6 pt-6 text-white shadow-lift" style={{ background: `linear-gradient(135deg, ${color}, ${color}dd 55%, #320a10)` }}>
      <header className="flex items-center gap-3">
        <div className="grid h-14 w-14 place-items-center overflow-hidden rounded-full border-2 border-white/70 bg-white text-xl font-black" style={{ color }}>
          {order.unit.logo_url
            // eslint-disable-next-line @next/next/no-img-element
            ? <img src={order.unit.logo_url} alt="" className="h-full w-full object-cover" />
            : order.unit.name.slice(0, 1)}
        </div>
        <div>
          <p className="text-sm text-white/80">{order.unit.name}</p>
          <h1 className="text-2xl font-black tracking-tight">Pedido #{order.number}</h1>
        </div>
      </header>

      <p className="mt-5 text-sm text-white/85" aria-live="polite">Olá, {order.customer_name}!</p>
      <p className="text-2xl font-black tracking-tight">{STATUS_LABEL[order.status] ?? order.status}</p>
      {order.scheduled_for && <p className="mt-1 text-sm text-white/85">Agendado para {new Date(order.scheduled_for).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}</p>}
      {!cancelled && order.status !== "completed" && order.estimated_ready_at && (
        <p className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1 text-sm font-semibold">
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
          {order.type === "delivery" ? "Chega" : "Pronto"} por volta de {timeHM(order.estimated_ready_at)}
        </p>
      )}
      </div>

      {order.pix && order.status === "awaiting_payment" && (
        <section className="card mt-4 text-center" aria-labelledby="pix-h">
          <h2 id="pix-h" className="font-extrabold">Pague com Pix para confirmar</h2>
          <p className="text-3xl font-black" style={{ color }}>{brl(order.total_cents)}</p>
          {pixCode ? (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {qr && <img src={qr} alt="QR Code Pix" width={240} height={240} className="mx-auto mt-4 rounded-2xl p-2 ring-1 ring-zinc-200" />}
              <textarea readOnly aria-label="Pix copia e cola" className="input mt-3 h-20 resize-none font-mono text-xs" value={pixCode} />
              <button className="btn mt-3 w-full rounded-2xl py-3.5 text-white shadow-lift" style={{ background: color }} onClick={copy}>
                {copied ? "Código copiado ✓" : "Copiar código Pix"}
              </button>
              <p className="mt-2 text-xs text-zinc-500">
                {remaining > 0 ? `Expira em ${mm}:${ss.toString().padStart(2, "0")}` : "Prazo de pagamento encerrado."} · A loja confirma o recebimento e seu pedido segue para o preparo.
              </p>
            </>
          ) : (
            <p className="mt-2 text-sm text-zinc-600">A loja vai enviar a chave Pix pelo WhatsApp.</p>
          )}
        </section>
      )}

      {order.gateway?.config && order.status === "awaiting_payment" && order.payment_status !== "paid" && (
        <OnlinePayment token={token} method={order.payment_method} totalCents={order.total_cents} gateway={order.gateway} color={color} onChange={load} />
      )}
      {order.gateway && order.status !== "awaiting_payment" && <PaymentNote payment={order.gateway.payment} />}

      {cancelled ? (
        <section className="card mt-4 border-red-200 bg-red-50 text-red-900">
          <h2 className="font-extrabold">Pedido cancelado</h2>
          {order.cancel_reason && <p className="text-sm">Motivo: {order.cancel_reason}</p>}
        </section>
      ) : (
        <ol className="card mt-4 space-y-0" aria-label="Andamento do pedido">
          {steps.map((s, i) => {
            const done = i <= currentIdx;
            return (
              <li key={s} className="relative flex items-center gap-3 py-2.5">
                {i < steps.length - 1 && <span aria-hidden className="absolute left-[13px] top-9 h-[calc(100%-1.5rem)] w-0.5" style={{ background: i < currentIdx ? color : "#e4e4e7" }} />}
                <span className={`relative grid h-7 w-7 shrink-0 place-items-center rounded-full text-xs font-bold ${done ? "text-white" : "bg-zinc-100 text-zinc-400 ring-1 ring-zinc-200"} ${i === currentIdx ? "ring-4" : ""}`}
                  style={done ? { background: color, ["--tw-ring-color" as string]: `${color}33` } : undefined} aria-hidden>{done ? "✓" : i + 1}</span>
                <span className={`flex-1 text-sm ${i === currentIdx ? "font-semibold" : done ? "" : "text-zinc-400"}`}>
                  {STATUS_LABEL[s]}{i === currentIdx && <span className="sr-only"> (etapa atual)</span>}
                </span>
                <span className="text-xs text-zinc-500">{timeHM(at(s))}</span>
              </li>
            );
          })}
        </ol>
      )}

      {extras && (extras.cashback_earned_cents > 0 || extras.points_earned > 0) && (
        <p className="mt-4 rounded-2xl bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-900 ring-1 ring-emerald-200" aria-live="polite">
          Você ganhou{" "}
          {extras.cashback_earned_cents > 0 && <b>{brl(extras.cashback_earned_cents)} de cashback</b>}
          {extras.cashback_earned_cents > 0 && extras.points_earned > 0 && " e "}
          {extras.points_earned > 0 && <b>+{extras.points_earned} pontos</b>}
          {" "}neste pedido. Use no próximo!
        </p>
      )}

      {extras?.review ? (
        <section className="card mt-4 text-sm" aria-labelledby="rev-h">
          <h2 id="rev-h" className="font-extrabold">{thanks ? "Obrigado pela avaliação!" : "Sua avaliação"}</h2>
          <div className="mt-1"><Stars value={extras.review.rating} size="h-5 w-5" /></div>
          {extras.review.comment && <p className="mt-1 text-zinc-700">{extras.review.comment}</p>}
          {extras.review.reply && <p className="mt-2 rounded-xl bg-zinc-50 p-3 text-zinc-700"><b>Resposta da loja:</b> {extras.review.reply}</p>}
        </section>
      ) : extras?.can_review ? (
        <form onSubmit={sendReview} className="card mt-4 text-center" aria-labelledby="rev-h">
          <h2 id="rev-h" className="font-extrabold">Como foi seu pedido?</h2>
          <p className="mb-2 text-xs text-zinc-500">Sua opinião ajuda {order.unit.name} a melhorar.</p>
          <StarInput value={rating} onChange={(n) => { setRating(n); setReviewErr(""); }} disabled={sending} />
          <label className="sr-only" htmlFor="rev-c">Comentário (opcional)</label>
          <textarea id="rev-c" className="input mt-3" rows={3} maxLength={1000} placeholder="Conte como foi (opcional)" value={comment} onChange={(e) => setComment(e.target.value)} />
          {reviewErr && <p role="alert" className="mt-2 text-sm text-red-700">{reviewErr}</p>}
          <button className="btn mt-3 w-full rounded-2xl py-3 text-white" style={{ background: color }} disabled={sending}>
            {sending ? "Enviando..." : "Enviar avaliação"}
          </button>
        </form>
      ) : null}

      <section className="card mt-4 text-sm">
        <h2 className="mb-2 font-extrabold">Itens</h2>
        {order.items.map((i, k) => (
          <div key={k} className="flex justify-between gap-2 py-1">
            <div>
              <p>{i.quantity}x {i.name}</p>
              {i.options?.length > 0 && <p className="text-xs text-zinc-500">{i.options.map((o) => `${o.quantity > 1 ? o.quantity + "x " : ""}${o.name}`).join(", ")}</p>}
              {i.notes && <p className="text-xs italic text-zinc-500">Obs.: {i.notes}</p>}
            </div>
            <span>{brl(i.total_cents)}</span>
          </div>
        ))}
        <div className="mt-2 space-y-1 border-t border-zinc-200 pt-2">
          <div className="flex justify-between"><span>Subtotal</span><span>{brl(order.subtotal_cents)}</span></div>
          {order.type === "delivery" && <div className="flex justify-between"><span>Entrega</span><span>{order.delivery_fee_cents ? brl(order.delivery_fee_cents) : "Grátis"}</span></div>}
          {order.discount_cents > 0 && <div className="flex justify-between text-green-700"><span>Desconto</span><span>− {brl(order.discount_cents)}</span></div>}
          {(extras?.cashback_used_cents ?? 0) > 0 && <div className="flex justify-between text-green-700"><span>Cashback usado</span><span>− {brl(extras!.cashback_used_cents)}</span></div>}
          <div className="flex justify-between pt-1 text-base font-black"><span>Total</span><span style={{ color }}>{brl(order.total_cents)}</span></div>
          <p className="text-xs text-zinc-500">
            {PAYMENT_LABEL[order.payment_method]} · {order.payment_status === "paid" ? "pago" : "a pagar"}
            {order.change_for_cents ? ` · troco para ${brl(order.change_for_cents)}` : ""}
          </p>
          {order.address && <p className="text-xs text-zinc-500">Entrega em {order.address.street}{order.address.number ? `, ${order.address.number}` : ""} – {order.address.neighborhood}</p>}
        </div>
      </section>

      <div className="mt-4 grid gap-2">
        {waLink && <a href={waLink} target="_blank" rel="noopener noreferrer" className="btn-success w-full py-3">Falar com a loja no WhatsApp</a>}
        <Link href={`/loja/${order.unit.slug}`} className="btn-secondary w-full">Voltar ao cardápio</Link>
      </div>
    </main>
  );
}
