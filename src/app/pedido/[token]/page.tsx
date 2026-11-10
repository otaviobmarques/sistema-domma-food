"use client";
import Link from "next/link";
import { use, useCallback, useEffect, useState } from "react";
import QRCode from "qrcode";
import { supabaseBrowser } from "@/lib/supabase/client";
import { brl, onlyDigits, PAYMENT_LABEL, STATUS_LABEL, timeHM } from "@/lib/format";
import { pixPayload } from "@/lib/pix";

type Order = {
  number: number; status: string; type: "delivery" | "pickup" | "dine_in"; customer_name: string;
  created_at: string; scheduled_for: string | null; estimated_ready_at: string | null;
  subtotal_cents: number; discount_cents: number; delivery_fee_cents: number; total_cents: number;
  payment_method: string; payment_status: string; change_for_cents: number | null; cancel_reason: string | null;
  address: { street: string; number: string; neighborhood: string } | null;
  pix: { key: string | null; merchant_name: string | null; merchant_city: string | null; expires_at: string } | null;
  unit: { name: string; slug: string; whatsapp: string | null; phone: string | null; logo_url: string | null; primary_color: string };
  items: { name: string; quantity: number; total_cents: number; options: { name: string; quantity: number }[]; notes: string | null }[];
  events: { status: string; at: string }[];
};

const FINAL = ["completed", "cancelled"];

export default function OrderPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [order, setOrder] = useState<Order | null | undefined>(undefined);
  const [qr, setQr] = useState("");
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    const { data, error } = await supabaseBrowser().rpc("get_order_by_token", { p_token: token });
    if (!error) setOrder((data as Order | null) ?? null);
  }, [token]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!order || FINAL.includes(order.status)) return;
    const id = setInterval(load, 8000);
    return () => clearInterval(id);
  }, [order, load]);
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

  const color = order.unit.primary_color || "#6d28d9";
  const steps = ["awaiting_payment", "pending", "preparing", "ready", order.type === "delivery" ? "dispatched" : "awaiting_pickup", "completed"]
    .filter((s) => s !== "awaiting_payment" || order.payment_method === "pix");
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
    <main className="mx-auto max-w-lg px-4 py-6">
      <header className="flex items-center gap-3">
        <div className="grid h-12 w-12 place-items-center overflow-hidden rounded-xl text-lg font-bold text-white" style={{ background: color }}>
          {order.unit.logo_url
            // eslint-disable-next-line @next/next/no-img-element
            ? <img src={order.unit.logo_url} alt="" className="h-full w-full object-cover" />
            : order.unit.name.slice(0, 1)}
        </div>
        <div>
          <p className="text-sm text-zinc-500">{order.unit.name}</p>
          <h1 className="text-2xl font-bold">Pedido #{order.number}</h1>
        </div>
      </header>

      <p className="mt-3 text-sm text-zinc-700" aria-live="polite">
        Olá, {order.customer_name}! Status: <strong>{STATUS_LABEL[order.status] ?? order.status}</strong>
      </p>
      {order.scheduled_for && <p className="text-sm text-zinc-600">Agendado para {new Date(order.scheduled_for).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}</p>}
      {!cancelled && order.status !== "completed" && order.estimated_ready_at && (
        <p className="text-sm text-zinc-600">Previsão: {order.type === "delivery" ? "chega" : "pronto"} por volta de {timeHM(order.estimated_ready_at)}</p>
      )}

      {order.pix && order.status === "awaiting_payment" && (
        <section className="card mt-4 text-center" aria-labelledby="pix-h">
          <h2 id="pix-h" className="font-semibold">Pague com Pix para confirmar</h2>
          <p className="text-2xl font-bold" style={{ color }}>{brl(order.total_cents)}</p>
          {pixCode ? (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {qr && <img src={qr} alt="QR Code Pix" width={240} height={240} className="mx-auto mt-3" />}
              <textarea readOnly aria-label="Pix copia e cola" className="input mt-3 h-20 resize-none font-mono text-xs" value={pixCode} />
              <button className="btn mt-2 w-full text-white" style={{ background: color }} onClick={copy}>
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

      {cancelled ? (
        <section className="card mt-4 border-red-200 bg-red-50 text-red-900">
          <h2 className="font-semibold">Pedido cancelado</h2>
          {order.cancel_reason && <p className="text-sm">Motivo: {order.cancel_reason}</p>}
        </section>
      ) : (
        <ol className="card mt-4 space-y-3" aria-label="Andamento do pedido">
          {steps.map((s, i) => {
            const done = i <= currentIdx;
            return (
              <li key={s} className="flex items-center gap-3">
                <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-xs font-bold ${done ? "text-white" : "bg-zinc-200 text-zinc-500"}`}
                  style={done ? { background: color } : undefined} aria-hidden>{done ? "✓" : i + 1}</span>
                <span className={`flex-1 text-sm ${i === currentIdx ? "font-semibold" : done ? "" : "text-zinc-400"}`}>
                  {STATUS_LABEL[s]}{i === currentIdx && <span className="sr-only"> (etapa atual)</span>}
                </span>
                <span className="text-xs text-zinc-500">{timeHM(at(s))}</span>
              </li>
            );
          })}
        </ol>
      )}

      <section className="card mt-4 text-sm">
        <h2 className="mb-2 font-semibold">Itens</h2>
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
          <div className="flex justify-between font-bold"><span>Total</span><span>{brl(order.total_cents)}</span></div>
          <p className="text-xs text-zinc-500">
            {PAYMENT_LABEL[order.payment_method]} · {order.payment_status === "paid" ? "pago" : "a pagar"}
            {order.change_for_cents ? ` · troco para ${brl(order.change_for_cents)}` : ""}
          </p>
          {order.address && <p className="text-xs text-zinc-500">Entrega em {order.address.street}{order.address.number ? `, ${order.address.number}` : ""} – {order.address.neighborhood}</p>}
        </div>
      </section>

      <div className="mt-4 grid gap-2">
        {waLink && <a href={waLink} target="_blank" rel="noopener noreferrer" className="btn-success w-full">💬 Falar com a loja no WhatsApp</a>}
        <Link href={`/loja/${order.unit.slug}`} className="btn-secondary w-full">Voltar ao cardápio</Link>
      </div>
    </main>
  );
}
