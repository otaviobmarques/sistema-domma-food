"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { usePanel } from "@/lib/panel/context";
import { Alert, Field, Modal } from "@/components/ui";
import { brl, errorMessage, formatPhone, onlyDigits, parseBRL, PAYMENT_LABEL } from "@/lib/format";
import { ProductModal } from "@/components/store/product-modal";
import { effectivePrice } from "@/components/store/cart";
import { storeColor } from "@/components/store/brand";
import type { CartItem, Store, StoreProduct } from "@/components/store/types";

type Quote = { subtotal_cents: number; delivery_fee_cents: number; discount_cents: number; total_cents: number; eta_min: number };
type Address = { street: string; number: string; complement: string; neighborhood: string; city: string; reference: string };
const EMPTY_ADDR: Address = { street: "", number: "", complement: "", neighborhood: "", city: "", reference: "" };
export type Placed = { order_id: string; token: string; number: number; total_cents: number; status: string; summary: string; wa: string };

export type Prefill = { conversationId: string | null; name: string; phone: string; address: Partial<Address> | null };

/** Telefone do WhatsApp (5531…) → telefone do cadastro (31…). */
export function localPhone(wa: string) {
  const d = onlyDigits(wa);
  return d.length >= 12 && d.startsWith("55") ? d.slice(2) : d;
}

function buildSummary(p: { number: number; items: CartItem[]; quote: Quote; type: string; payment: string; changeFor: number | null; link: string; storeName: string; eta: number }) {
  const lines = [
    `*${p.storeName}* · Pedido #${p.number} confirmado ✅`,
    "",
    ...p.items.map((i) => `${i.quantity}x ${i.name}${i.options.length ? ` (${i.options.map((o) => (o.quantity > 1 ? `${o.quantity}x ` : "") + o.name).join(", ")})` : ""} · ${brl(i.unit_price_cents * i.quantity)}`),
    "",
    `Subtotal: ${brl(p.quote.subtotal_cents)}`,
    ...(p.quote.delivery_fee_cents ? [`Entrega: ${brl(p.quote.delivery_fee_cents)}`] : []),
    ...(p.quote.discount_cents ? [`Desconto: -${brl(p.quote.discount_cents)}`] : []),
    `*Total: ${brl(p.quote.total_cents)}*`,
    `Pagamento: ${PAYMENT_LABEL[p.payment] ?? p.payment}${p.payment === "cash" && p.changeFor ? ` (troco para ${brl(p.changeFor)})` : ""}`,
    p.type === "delivery" ? `Previsão de entrega: cerca de ${p.eta} min` : `Retirada em cerca de ${p.eta} min`,
    "",
    `${p.payment === "pix" ? "Pague o Pix e acompanhe" : "Acompanhe seu pedido"}: ${p.link}`,
  ];
  return lines.join("\n");
}

export function WaOrder({ prefill, onClose, onPlaced }: { prefill: Prefill; onClose: () => void; onPlaced: (p: Placed) => void }) {
  const { unit } = usePanel();
  const sb = supabaseBrowser();
  const [store, setStore] = useState<Store | null>(null);
  const [loadErr, setLoadErr] = useState("");
  const [name, setName] = useState(prefill.name);
  const [phone, setPhone] = useState(formatPhone(localPhone(prefill.phone)));
  const [type, setType] = useState<"delivery" | "pickup">("delivery");
  const [addr, setAddr] = useState<Address>({ ...EMPTY_ADDR, ...(prefill.address ?? {}) });
  const [items, setItems] = useState<CartItem[]>([]);
  const [search, setSearch] = useState("");
  const [pick, setPick] = useState<StoreProduct | null>(null);
  const [payment, setPayment] = useState("");
  const [changeFor, setChangeFor] = useState("");
  const [coupon, setCoupon] = useState("");
  const [notes, setNotes] = useState("");
  const [notifyWa, setNotifyWa] = useState(false);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteErr, setQuoteErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const req = useRef(0);

  useEffect(() => {
    sb.rpc("get_store", { p_slug: unit.slug }).then(({ data, error }: { data: unknown; error: { message: string } | null }) => {
      if (error || !data) { setLoadErr(error ? errorMessage(error) : "Loja indisponível no momento."); return; }
      const s = data as Store;
      setStore(s);
      setType(s.unit.accepts_delivery ? "delivery" : "pickup");
      setPayment(s.unit.accepted_payments.find((m) => m !== "online_card") ?? "");
    });
  }, [sb, unit.slug]);

  const payments = (store?.unit.accepted_payments ?? []).filter((m) => m !== "online_card");
  const neighborhoods = useMemo(() => [...new Set((store?.zones ?? []).filter((z) => z.kind === "neighborhood").flatMap((z) => z.neighborhoods))].sort(), [store]);
  const products = useMemo(() => {
    const n = search.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
    return (store?.menu ?? []).flatMap((c) => c.products.filter((p) => p.available && c.available_now).map((p) => ({ ...p, cat: c.name })))
      .filter((p) => !n || (p.name + " " + p.cat).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().includes(n)).slice(0, 60);
  }, [store, search]);

  const payload = useMemo(() => ({
    slug: unit.slug, unit_id: unit.id, conversation_id: prefill.conversationId, type, payment_method: payment,
    customer: { name: name.trim(), phone: onlyDigits(phone) },
    address: type === "delivery" ? { ...addr, lat: null, lng: null } : null,
    coupon_code: coupon.trim() || null, notes: notes.trim() || null,
    change_for_cents: payment === "cash" && changeFor ? parseBRL(changeFor) : null,
    notify_whatsapp: notifyWa && !!store?.unit.wa_status,
    items: items.map((i) => ({ product_id: i.product_id, quantity: i.quantity, notes: i.notes || null,
      options: i.options.map((o) => ({ option_id: o.option_id, quantity: o.quantity })) })),
  }), [unit, prefill.conversationId, type, payment, name, phone, addr, coupon, notes, changeFor, notifyWa, items, store]);

  useEffect(() => {
    if (!store || !items.length || !payment) { setQuote(null); return; }
    if (type === "delivery" && !addr.neighborhood) { setQuote(null); setQuoteErr("Informe o bairro para calcular a entrega."); return; }
    const id = ++req.current;
    const t = setTimeout(async () => {
      const { data, error } = await sb.rpc("quote_order", { p: payload });
      if (id !== req.current) return;
      if (error) { setQuote(null); setQuoteErr(error.message); } else { setQuote(data as Quote); setQuoteErr(""); }
    }, 400);
    return () => clearTimeout(t);
  }, [payload, store, items.length, payment, type, addr.neighborhood, sb]);

  function setQty(key: string, q: number) {
    setItems((prev) => q <= 0 ? prev.filter((i) => i.key !== key) : prev.map((i) => i.key === key ? { ...i, quantity: Math.min(99, q) } : i));
  }
  function add(i: CartItem) {
    setItems((prev) => prev.some((p) => p.key === i.key) ? prev.map((p) => p.key === i.key ? { ...p, quantity: Math.min(99, p.quantity + i.quantity) } : p) : [...prev, i]);
    setPick(null);
  }
  const setA = (k: keyof Address) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setAddr({ ...addr, [k]: e.target.value });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr("");
    if (!name.trim()) { setErr("Informe o nome do cliente."); return; }
    if (onlyDigits(phone).length < 10) { setErr("Informe o WhatsApp do cliente com DDD."); return; }
    if (!items.length) { setErr("Adicione pelo menos um item."); return; }
    if (!quote) { setErr(quoteErr || "Aguarde o cálculo do total."); return; }
    setBusy(true);
    const { data, error } = await sb.rpc("wa_order", { p: payload });
    setBusy(false);
    if (error) { setErr(errorMessage(error)); return; }
    const r = data as { order_id: string; token: string; number: number; total_cents: number; status: string };
    const link = `${window.location.origin}/pedido/${r.token}`;
    onPlaced({ ...r, wa: "55" + onlyDigits(phone), summary: buildSummary({ number: r.number, items, quote, type, payment, changeFor: payload.change_for_cents, link,
      storeName: store!.unit.name, eta: quote.eta_min }) });
  }

  const color = storeColor(store?.unit.primary_color ?? "#dc2626");
  return (
    <Modal open onClose={onClose} title="Novo pedido pelo WhatsApp" wide>
      {loadErr ? <Alert>{loadErr}</Alert> : !store ? <p className="text-sm text-zinc-500">Carregando cardápio...</p> : (
        <form onSubmit={submit} className="grid gap-5 lg:grid-cols-[1.1fr_1fr]">
          <div className="space-y-3">
            <input className="input" placeholder="Buscar produto ou categoria" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Buscar produto" />
            <ul className="max-h-[52vh] divide-y divide-zinc-100 overflow-y-auto rounded-xl ring-1 ring-zinc-200">
              {products.map((p) => (
                <li key={p.id}>
                  <button type="button" onClick={() => setPick(p)} className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left text-sm hover:bg-zinc-50">
                    <span className="min-w-0"><span className="block truncate font-medium text-zinc-900">{p.name}</span><span className="text-xs text-zinc-500">{p.cat}</span></span>
                    <span className="shrink-0 tabular-nums text-zinc-700">{brl(effectivePrice(p))}</span>
                  </button>
                </li>
              ))}
              {!products.length && <li className="px-3 py-6 text-center text-sm text-zinc-500">Nenhum produto disponível agora.</li>}
            </ul>
            {!store.unit.is_open && <Alert kind="info">A loja está fechada agora: o pedido só entra se houver agendamento ou quando abrir.</Alert>}
          </div>

          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <Field label="Cliente"><input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required /></Field>
              <Field label="WhatsApp"><input className="input" inputMode="tel" value={phone} onChange={(e) => setPhone(formatPhone(e.target.value))} required /></Field>
            </div>
            <div className="grid grid-cols-2 gap-1 rounded-xl bg-zinc-100 p-1" role="radiogroup" aria-label="Tipo de pedido">
              {(["delivery", "pickup"] as const).filter((t) => t === "delivery" ? store.unit.accepts_delivery : store.unit.accepts_pickup).map((t) => (
                <button key={t} type="button" role="radio" aria-checked={type === t} onClick={() => setType(t)}
                  className={`rounded-lg py-1.5 text-sm font-medium ${type === t ? "bg-white shadow-sm" : "text-zinc-600"}`}>{t === "delivery" ? "Entrega" : "Retirada"}</button>
              ))}
            </div>
            {type === "delivery" && (
              <div className="grid grid-cols-3 gap-2">
                <div className="col-span-2"><Field label="Rua"><input className="input" value={addr.street} onChange={setA("street")} required /></Field></div>
                <Field label="Número"><input className="input" value={addr.number} onChange={setA("number")} /></Field>
                <div className="col-span-2">
                  <Field label="Bairro">
                    {neighborhoods.length ? (
                      <select className="input" value={addr.neighborhood} onChange={setA("neighborhood")} required>
                        <option value="">Selecione</option>
                        {neighborhoods.map((n) => <option key={n}>{n}</option>)}
                      </select>
                    ) : <input className="input" value={addr.neighborhood} onChange={setA("neighborhood")} required />}
                  </Field>
                </div>
                <Field label="Compl."><input className="input" value={addr.complement} onChange={setA("complement")} /></Field>
                <div className="col-span-3"><Field label="Referência"><input className="input" value={addr.reference} onChange={setA("reference")} /></Field></div>
              </div>
            )}

            <div className="rounded-xl ring-1 ring-zinc-200">
              {items.length === 0 ? <p className="px-3 py-4 text-center text-sm text-zinc-500">Escolha os itens na lista.</p> : (
                <ul className="divide-y divide-zinc-100 text-sm">
                  {items.map((i) => (
                    <li key={i.key} className="flex items-center gap-2 px-3 py-2">
                      <div className="flex items-center rounded-lg ring-1 ring-zinc-200">
                        <button type="button" className="px-2 py-0.5" onClick={() => setQty(i.key, i.quantity - 1)} aria-label={`Diminuir ${i.name}`}>−</button>
                        <span className="w-6 text-center tabular-nums">{i.quantity}</span>
                        <button type="button" className="px-2 py-0.5" onClick={() => setQty(i.key, i.quantity + 1)} aria-label={`Aumentar ${i.name}`}>+</button>
                      </div>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{i.name}</span>
                        {i.options.length > 0 && <span className="block truncate text-xs text-zinc-500">{i.options.map((o) => o.name).join(", ")}</span>}
                      </span>
                      <span className="tabular-nums">{brl(i.unit_price_cents * i.quantity)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="grid grid-cols-2 gap-2">
              <Field label="Pagamento">
                <select className="input" value={payment} onChange={(e) => setPayment(e.target.value)}>
                  {payments.map((m) => <option key={m} value={m}>{PAYMENT_LABEL[m] ?? m}</option>)}
                </select>
              </Field>
              {payment === "cash"
                ? <Field label="Troco para"><input className="input" inputMode="decimal" placeholder="Ex.: 100,00" value={changeFor} onChange={(e) => setChangeFor(e.target.value)} /></Field>
                : <Field label="Cupom"><input className="input uppercase" maxLength={30} value={coupon} onChange={(e) => setCoupon(e.target.value.toUpperCase())} /></Field>}
            </div>
            <Field label="Observações"><input className="input" maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
            {store.unit.wa_status && (
              <label className="flex items-center gap-2 text-sm text-zinc-700">
                <input type="checkbox" checked={notifyWa} onChange={(e) => setNotifyWa(e.target.checked)} /> Avisar o cliente das mudanças de status
              </label>
            )}
            {payment === "pix" && <p className="text-xs text-zinc-500">{store.unit.gateway?.pix ? "O cliente paga o Pix pelo link do pedido; a cozinha recebe quando o pagamento for confirmado." : "Pix pela chave da loja: confirme o pagamento no painel de pedidos."}</p>}

            <div className="rounded-xl bg-zinc-50 p-3 text-sm">
              {quote ? (
                <div className="space-y-0.5 tabular-nums">
                  <div className="flex justify-between"><span>Subtotal</span><span>{brl(quote.subtotal_cents)}</span></div>
                  {quote.delivery_fee_cents > 0 && <div className="flex justify-between"><span>Entrega</span><span>{brl(quote.delivery_fee_cents)}</span></div>}
                  {quote.discount_cents > 0 && <div className="flex justify-between text-emerald-700"><span>Desconto</span><span>-{brl(quote.discount_cents)}</span></div>}
                  <div className="flex justify-between pt-1 text-base font-bold"><span>Total</span><span>{brl(quote.total_cents)}</span></div>
                </div>
              ) : <p className="text-zinc-500">{quoteErr || "Adicione itens para ver o total."}</p>}
            </div>
            <Alert>{err}</Alert>
            <button className="btn w-full rounded-xl py-3 text-white" style={{ background: color }} disabled={busy || !quote}>
              {busy ? "Lançando..." : quote ? `Lançar pedido · ${brl(quote.total_cents)}` : "Lançar pedido"}
            </button>
          </div>
        </form>
      )}
      {pick && <ProductModal product={pick} color={color} onClose={() => setPick(null)} onAdd={add} />}
    </Modal>
  );
}
