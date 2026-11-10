"use client";
import Link from "next/link";
import { use, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/client";
import { brl, formatPhone, onlyDigits, parseBRL, PAYMENT_LABEL } from "@/lib/format";
import { Alert, Field } from "@/components/ui";
import { useCart } from "@/components/store/cart";
import type { Store } from "@/components/store/types";
import { storeColor } from "@/components/store/brand";

type Quote = { subtotal_cents: number; delivery_fee_cents: number; discount_cents: number; total_cents: number; eta_min: number; coupon_code: string | null };
type Address = { street: string; number: string; complement: string; neighborhood: string; city: string; reference: string };
const EMPTY_ADDR: Address = { street: "", number: "", complement: "", neighborhood: "", city: "", reference: "" };
const PROFILE_KEY = "df_customer";

function loadProfile(): { name?: string; phone?: string; address?: Address } {
  try { return JSON.parse(localStorage.getItem(PROFILE_KEY) ?? "{}") ?? {}; } catch { return {}; }
}

export default function CheckoutPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const router = useRouter();
  const cart = useCart(slug);
  const [store, setStore] = useState<Store | null | undefined>(undefined);
  const [type, setType] = useState<"delivery" | "pickup">("delivery");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [addr, setAddr] = useState<Address>(EMPTY_ADDR);
  const [geo, setGeo] = useState<{ lat: number; lng: number } | null>(null);
  const [geoMsg, setGeoMsg] = useState("");
  const [schedule, setSchedule] = useState(false);
  const [when, setWhen] = useState("");
  const [payment, setPayment] = useState("");
  const [changeFor, setChangeFor] = useState("");
  const [coupon, setCoupon] = useState("");
  const [notes, setNotes] = useState("");
  const [optIn, setOptIn] = useState(false);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteErr, setQuoteErr] = useState("");
  const [quoting, setQuoting] = useState(false);
  const [submitErr, setSubmitErr] = useState("");
  const [busy, setBusy] = useState(false);
  const reqId = useRef(0);

  useEffect(() => {
    supabaseBrowser().rpc("get_store", { p_slug: slug }).then(({ data }: { data: Store | null }) => {
      setStore(data ?? null);
      if (data) {
        const u = data.unit;
        setType(u.accepts_delivery ? "delivery" : "pickup");
        setPayment(u.accepted_payments[0] ?? "");
        if (!u.is_open && u.accepts_scheduling) setSchedule(true);
      }
    });
    const p = loadProfile();
    if (p.name) setName(p.name);
    if (p.phone) setPhone(formatPhone(p.phone));
    if (p.address) setAddr({ ...EMPTY_ADDR, ...p.address });
  }, [slug]);

  const neighborhoods = useMemo(() => [...new Set((store?.zones ?? []).filter((z) => z.kind === "neighborhood").flatMap((z) => z.neighborhoods))].sort(), [store]);

  const payload = useMemo(() => ({
    slug, type, payment_method: payment,
    customer: { name: name.trim(), phone: onlyDigits(phone), opt_in: optIn },
    address: type === "delivery" ? { ...addr, lat: geo?.lat ?? null, lng: geo?.lng ?? null } : null,
    coupon_code: coupon.trim() || null,
    change_for_cents: payment === "cash" && changeFor ? parseBRL(changeFor) : null,
    notes: notes.trim() || null,
    scheduled_for: schedule && when ? new Date(when).toISOString() : null,
    items: cart.items.map((i) => ({ product_id: i.product_id, quantity: i.quantity, notes: i.notes || null,
      options: i.options.map((o) => ({ option_id: o.option_id, quantity: o.quantity })) })),
  }), [slug, type, payment, name, phone, optIn, addr, geo, coupon, changeFor, notes, schedule, when, cart.items]);

  // Cotação ao vivo (servidor recalcula tudo)
  useEffect(() => {
    if (!store || !cart.ready || cart.items.length === 0 || !payment) return;
    if (schedule && !when) { setQuote(null); setQuoteErr("Escolha o horário do agendamento."); return; }
    const id = ++reqId.current;
    setQuoting(true);
    const t = setTimeout(async () => {
      const { data, error } = await supabaseBrowser().rpc("quote_order", { p: payload });
      if (id !== reqId.current) return;
      setQuoting(false);
      if (error) { setQuote(null); setQuoteErr(error.message); } else { setQuote(data as Quote); setQuoteErr(""); }
    }, 500);
    return () => clearTimeout(t);
  }, [payload, store, cart.ready, cart.items.length, payment, schedule, when]);

  function requestLocation() {
    if (!navigator.geolocation) { setGeoMsg("Seu navegador não permite localização."); return; }
    setGeoMsg("Obtendo localização...");
    navigator.geolocation.getCurrentPosition(
      (p) => { setGeo({ lat: p.coords.latitude, lng: p.coords.longitude }); setGeoMsg("Localização obtida ✓"); },
      () => setGeoMsg("Não foi possível obter a localização. Preencha o bairro."),
      { enableHighAccuracy: true, timeout: 10000 },
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitErr("");
    if (onlyDigits(phone).length < 10) { setSubmitErr("Informe um WhatsApp válido com DDD."); return; }
    setBusy(true);
    const { data, error } = await supabaseBrowser().rpc("place_order", { p: payload });
    if (error) { setBusy(false); setSubmitErr(error.message); return; }
    try {
      localStorage.setItem(PROFILE_KEY, JSON.stringify({ name: name.trim(), phone: onlyDigits(phone), address: addr }));
    } catch { /* ignora */ }
    cart.clear();
    router.replace(`/pedido/${(data as { token: string }).token}`);
  }

  if (store === undefined || !cart.ready) return <p className="p-8 text-center text-sm text-zinc-500">Carregando...</p>;
  if (store === null) return <p className="p-8 text-center">Loja não encontrada. <Link className="text-brand-700 underline" href="/">Voltar</Link></p>;

  const u = store.unit;
  const color = storeColor(u.primary_color);
  if (cart.items.length === 0) {
    return (
      <main className="mx-auto max-w-lg p-6 text-center">
        <p className="text-zinc-600">Sua sacola está vazia.</p>
        <Link href={`/loja/${slug}`} className="btn mt-4 text-white" style={{ background: color }}>Ver cardápio</Link>
      </main>
    );
  }
  const set = (k: keyof Address) => (e: React.ChangeEvent<HTMLInputElement>) => setAddr({ ...addr, [k]: e.target.value });
  const minDate = new Date(Date.now() + 30 * 60000);
  const localISO = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

  return (
    <main className="mx-auto max-w-lg px-4 pb-36 pt-4">
      <Link href={`/loja/${slug}`} className="inline-flex items-center gap-1.5 rounded-full bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 shadow-sm ring-1 ring-zinc-200 hover:text-zinc-900">← Voltar ao cardápio</Link>
      <h1 className="mt-4 text-3xl font-black tracking-tight">Finalizar pedido</h1>
      <p className="text-sm text-zinc-500">{u.name}</p>

      <form onSubmit={submit} className="mt-4 space-y-4">
        {u.accepts_delivery && u.accepts_pickup && (
          <div className="grid grid-cols-2 gap-1 rounded-2xl bg-zinc-200/60 p-1" role="radiogroup" aria-label="Tipo de pedido">
            {(["delivery", "pickup"] as const).map((t) => (
              <button key={t} type="button" role="radio" aria-checked={type === t} onClick={() => setType(t)}
                className={`btn rounded-xl py-3 ${type === t ? "text-white shadow-md" : "text-zinc-600 hover:text-zinc-900"}`} style={type === t ? { background: color } : undefined}>
                {t === "delivery" ? "Entrega" : "Retirada"}
              </button>
            ))}
          </div>
        )}

        <section className="card space-y-3">
          <h2 className="text-base font-extrabold">Seus dados</h2>
          <Field label="Nome"><input className="input" required maxLength={120} autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="WhatsApp" hint="Enviaremos as atualizações do pedido.">
            <input className="input" required inputMode="tel" autoComplete="tel" placeholder="(31) 99999-9999" value={phone} onChange={(e) => setPhone(formatPhone(e.target.value))} />
          </Field>
        </section>

        {type === "delivery" && (
          <section className="card space-y-3">
            <h2 className="text-base font-extrabold">Endereço de entrega</h2>
            {u.has_location && store.zones.some((z) => z.kind === "radius") && (
              <div>
                <button type="button" className="btn-secondary w-full" onClick={requestLocation}>
                  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true"><path d="M12 21s-7-6.2-7-11a7 7 0 1 1 14 0c0 4.8-7 11-7 11Z" /><circle cx="12" cy="10" r="2.5" /></svg>
                  Usar minha localização
                </button>
                {geoMsg && <p className="mt-1 text-xs text-zinc-600" aria-live="polite">{geoMsg}</p>}
              </div>
            )}
            <div className="grid grid-cols-3 gap-2">
              <div className="col-span-2"><Field label="Rua"><input className="input" required autoComplete="address-line1" value={addr.street} onChange={set("street")} /></Field></div>
              <Field label="Número"><input className="input" value={addr.number} onChange={set("number")} /></Field>
            </div>
            <Field label="Complemento"><input className="input" autoComplete="address-line2" value={addr.complement} onChange={set("complement")} /></Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Bairro">
                <input className="input" required={!geo} list="bairros" value={addr.neighborhood} onChange={set("neighborhood")} />
                <datalist id="bairros">{neighborhoods.map((n) => <option key={n} value={n} />)}</datalist>
              </Field>
              <Field label="Cidade"><input className="input" autoComplete="address-level2" value={addr.city} onChange={set("city")} /></Field>
            </div>
            <Field label="Ponto de referência"><input className="input" value={addr.reference} onChange={set("reference")} /></Field>
          </section>
        )}

        {u.accepts_scheduling && (
          <section className="card space-y-3">
            <label className="flex items-center gap-2 text-sm font-medium">
              <input type="checkbox" className="h-4 w-4 accent-brand-600" checked={schedule} disabled={!u.is_open}
                onChange={(e) => setSchedule(e.target.checked)} />
              Agendar para outro horário {!u.is_open && "(a loja está fechada agora)"}
            </label>
            {schedule && (
              <Field label="Data e horário">
                <input className="input" type="datetime-local" required min={localISO(minDate)} value={when} onChange={(e) => setWhen(e.target.value)} />
              </Field>
            )}
          </section>
        )}

        <section className="card space-y-3">
          <h2 className="text-base font-extrabold">Pagamento</h2>
          <div className="grid gap-2" role="radiogroup" aria-label="Forma de pagamento">
            {u.accepted_payments.map((m) => (
              <label key={m} className={`flex cursor-pointer items-center gap-3 rounded-xl border p-3.5 text-sm font-medium transition ${payment === m ? "ring-2" : "border-zinc-200 hover:border-zinc-300"}`} style={payment === m ? { borderColor: color, ["--tw-ring-color" as string]: `${color}33`, background: `${color}08` } : undefined}>
                <input type="radio" name="pay" className="accent-brand-600" checked={payment === m} onChange={() => setPayment(m)} />
                {PAYMENT_LABEL[m] ?? m}
                {m === "pix" && <span className="text-xs text-zinc-500">· QR Code na próxima tela</span>}
              </label>
            ))}
          </div>
          {payment === "cash" && (
            <Field label="Troco para quanto?" hint="Deixe vazio se não precisar de troco.">
              <input className="input" inputMode="decimal" placeholder="Ex.: 100,00" value={changeFor} onChange={(e) => setChangeFor(e.target.value)} />
            </Field>
          )}
        </section>

        <section className="card space-y-3">
          <Field label="Cupom de desconto"><input className="input uppercase" maxLength={30} value={coupon} onChange={(e) => setCoupon(e.target.value.toUpperCase())} /></Field>
          <Field label="Observações do pedido"><textarea className="input" rows={2} maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
          <label className="flex items-start gap-2 text-xs text-zinc-600">
            <input type="checkbox" className="mt-0.5 h-4 w-4 accent-brand-600" checked={optIn} onChange={(e) => setOptIn(e.target.checked)} />
            Quero receber ofertas e novidades de {u.name} pelo WhatsApp. Posso cancelar quando quiser. Seus dados são usados apenas para o pedido e, se autorizado, para comunicações da loja (LGPD).
          </label>
        </section>

        <section className="card space-y-1 text-sm" aria-live="polite">
          <h2 className="mb-2 text-base font-extrabold">Resumo</h2>
          {cart.items.map((i) => (
            <div key={i.key} className="flex justify-between gap-2 text-zinc-700">
              <span>{i.quantity}x {i.name}</span><span>{brl(i.unit_price_cents * i.quantity)}</span>
            </div>
          ))}
          <div className="my-2 border-t border-zinc-200" />
          {quote ? (
            <>
              <div className="flex justify-between"><span>Subtotal</span><span>{brl(quote.subtotal_cents)}</span></div>
              {type === "delivery" && <div className="flex justify-between"><span>Entrega</span><span>{quote.delivery_fee_cents ? brl(quote.delivery_fee_cents) : "Grátis"}</span></div>}
              {quote.discount_cents > 0 && <div className="flex justify-between text-green-700"><span>Desconto {quote.coupon_code ? `(${quote.coupon_code})` : ""}</span><span>− {brl(quote.discount_cents)}</span></div>}
              <div className="flex justify-between pt-2 text-lg font-black"><span>Total</span><span style={{ color }}>{brl(quote.total_cents)}</span></div>
              {quote.eta_min > 0 && <p className="pt-1 text-xs text-zinc-500">Tempo estimado: {quote.eta_min} min</p>}
            </>
          ) : (
            <p className="text-zinc-500">{quoting ? "Calculando..." : "Preencha os dados para ver o total."}</p>
          )}
          {quoteErr && !quoting && <p className="mt-2 rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-800 ring-1 ring-amber-200">{quoteErr}</p>}
        </section>

        <Alert>{submitErr}</Alert>

        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-zinc-200/70 bg-white/90 p-3 backdrop-blur-md sm:p-4">
          <button className="btn mx-auto flex w-full max-w-lg rounded-2xl py-3.5 text-base text-white shadow-lift" style={{ background: color }}
            disabled={busy || !quote || !!quoteErr || quoting}>
            {busy ? "Enviando..." : quote ? `Fazer pedido · ${brl(quote.total_cents)}` : "Fazer pedido"}
          </button>
        </div>
      </form>
    </main>
  );
}
