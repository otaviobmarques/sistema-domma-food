"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { brl, errorMessage } from "@/lib/format";
import { effectivePrice } from "@/components/store/cart";
import { ProductModal, Stepper } from "@/components/store/product-modal";
import { storeColor } from "@/components/store/brand";
import type { CartItem, Store, StoreProduct } from "@/components/store/types";
import { OnlinePayment, type OrderGateway } from "@/app/pedido/[token]/online-payment";

export type TotemInfo = {
  slug: string; unit_name: string; totem: string; is_open: boolean;
  allow_dine_in: boolean; allow_takeout: boolean; allow_counter: boolean; allow_pix: boolean;
};
type Step = "welcome" | "mode" | "menu" | "review" | "done";
type Mode = "dine_in" | "pickup";
type Placed = { number: number; token: string; status: string; total_cents: number; pay: "pix" | "counter" };
type OrderView = { status: string; payment_status: string; payment_method: string; total_cents: number; gateway?: OrderGateway | null };

const IDLE_MS = 75_000;      // sem toque: pergunta se ainda está aí
const CONFIRM_S = 15;        // segundos para responder antes de recomeçar
const DONE_MS = 30_000;      // tela final volta ao início

export function Kiosk({ token, info: initial, store }: { token: string; info: TotemInfo; store: Store }) {
  const sb = supabaseBrowser();
  const { unit, menu } = store;
  const color = storeColor(unit.primary_color);
  const [info, setInfo] = useState(initial);
  const [step, setStep] = useState<Step>("welcome");
  const [mode, setMode] = useState<Mode | null>(null);
  const [items, setItems] = useState<CartItem[]>([]);
  const [cat, setCat] = useState<string>("");
  const [open, setOpen] = useState<StoreProduct | null>(null);
  const [name, setName] = useState("");
  const [pay, setPay] = useState<"pix" | "counter" | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [placed, setPlaced] = useState<Placed | null>(null);
  const [order, setOrder] = useState<OrderView | null>(null);
  const [idleAsk, setIdleAsk] = useState(0);
  const lastTouch = useRef(Date.now());

  const cats = useMemo(() => menu.filter((c) => c.available_now && c.products.some((p) => p.available)), [menu]);
  useEffect(() => { if (!cat && cats[0]) setCat(cats[0].id); }, [cat, cats]);
  const total = items.reduce((s, i) => s + i.unit_price_cents * i.quantity, 0);
  const count = items.reduce((s, i) => s + i.quantity, 0);
  const modes: Mode[] = [...(info.allow_dine_in ? ["dine_in" as const] : []), ...(info.allow_takeout ? ["pickup" as const] : [])];
  const pays = [...(info.allow_pix ? ["pix" as const] : []), ...(info.allow_counter ? ["counter" as const] : [])];

  const reset = useCallback(() => {
    setStep("welcome"); setMode(null); setItems([]); setOpen(null); setName(""); setPay(null);
    setErr(""); setPlaced(null); setOrder(null); setIdleAsk(0); setCat(cats[0]?.id ?? "");
    // aparelho compartilhado: não guardar dados do cliente anterior (e-mail do Pix etc.)
    try { localStorage.removeItem("df_payer_email"); sessionStorage.clear(); } catch { /* sem armazenamento */ }
    window.scrollTo(0, 0);
  }, [cats]);

  // atividade do cliente + aviso de inatividade
  useEffect(() => {
    const touch = () => { lastTouch.current = Date.now(); setIdleAsk(0); };
    window.addEventListener("pointerdown", touch);
    window.addEventListener("keydown", touch);
    const t = setInterval(() => {
      if (step !== "menu" && step !== "review" && step !== "mode") return;
      const idle = Date.now() - lastTouch.current;
      if (idle > IDLE_MS + CONFIRM_S * 1000) reset();
      else if (idle > IDLE_MS) setIdleAsk(Math.ceil((IDLE_MS + CONFIRM_S * 1000 - idle) / 1000));
    }, 1000);
    return () => { window.removeEventListener("pointerdown", touch); window.removeEventListener("keydown", touch); clearInterval(t); };
  }, [step, reset]);

  // sinal de vida do totem + estado da loja (aberta/fechada, Pix)
  useEffect(() => {
    const beat = async () => {
      void sb.rpc("totem_ping", { p_token: token });
      const { data } = await sb.rpc("totem_info", { p_token: token });
      if (data) setInfo(data as TotemInfo);
    };
    void beat();
    const t = setInterval(beat, 60_000);
    return () => clearInterval(t);
  }, [sb, token]);

  // pedido feito: acompanha o pagamento e volta ao início depois
  const loadOrder = useCallback(async () => {
    if (!placed) return;
    const { data } = await sb.rpc("get_order_by_token", { p_token: placed.token });
    if (data) setOrder(data as OrderView);
  }, [sb, placed]);
  useEffect(() => {
    if (step !== "done" || !placed) return;
    void loadOrder();
    const poll = placed.pay === "pix" ? setInterval(loadOrder, 5000) : undefined;
    return () => { if (poll) clearInterval(poll); };
  }, [step, placed, loadOrder]);
  const waitingPix = placed?.pay === "pix" && order?.payment_status !== "paid" && order?.status !== "cancelled";
  useEffect(() => {
    if (step !== "done" || waitingPix) return;
    const t = setTimeout(reset, DONE_MS);
    return () => clearTimeout(t);
  }, [step, waitingPix, reset]);
  // Pix sem resposta por muito tempo: recomeça (o pedido expira sozinho)
  useEffect(() => {
    if (step !== "done" || !waitingPix) return;
    const t = setTimeout(reset, 6 * 60_000);
    return () => clearTimeout(t);
  }, [step, waitingPix, reset]);

  function start() {
    lastTouch.current = Date.now();
    if (modes.length === 1) { setMode(modes[0]); setStep("menu"); } else setStep("mode");
    try { if (!document.fullscreenElement) void document.documentElement.requestFullscreen?.(); } catch { /* sem tela cheia */ }
  }
  function add(i: CartItem) {
    setItems((p) => p.some((x) => x.key === i.key) ? p.map((x) => (x.key === i.key ? { ...x, quantity: Math.min(99, x.quantity + i.quantity) } : x)) : [...p, i]);
    setOpen(null);
  }
  const setQty = (k: string, q: number) => setItems((p) => (q <= 0 ? p.filter((x) => x.key !== k) : p.map((x) => (x.key === k ? { ...x, quantity: Math.min(99, q) } : x))));

  async function confirm() {
    if (!mode || !pay || !name.trim()) return;
    setBusy(true); setErr("");
    const payload = items.map((i) => ({ product_id: i.product_id, quantity: i.quantity, notes: i.notes || null,
      options: i.options.map((o) => ({ option_id: o.option_id, quantity: o.quantity })) }));
    const { data, error } = await sb.rpc("totem_order", { p_token: token, p_items: payload, p_mode: mode, p_name: name.trim(), p_pay: pay });
    setBusy(false);
    if (error) { setErr(errorMessage(error)); return; }
    setPlaced(data as Placed); setStep("done"); window.scrollTo(0, 0);
  }

  const shell = (children: React.ReactNode) => (
    <div className="min-h-screen select-none bg-zinc-50 text-zinc-900" style={{ ["--store" as string]: color }}>{children}</div>
  );
  const Header = () => (
    <header className="sticky top-0 z-30 flex items-center justify-between gap-4 border-b border-zinc-200 bg-white/95 px-6 py-4 backdrop-blur">
      <div className="flex min-w-0 items-center gap-3">
        {unit.logo_url && /* eslint-disable-next-line @next/next/no-img-element */ <img src={unit.logo_url} alt="" className="h-12 w-12 rounded-xl object-cover" />}
        <div className="min-w-0"><p className="truncate text-xl font-extrabold">{unit.name}</p>
          {mode && <p className="text-sm text-zinc-500">{mode === "dine_in" ? "Para comer aqui" : "Para levar"}</p>}</div>
      </div>
      <button className="rounded-2xl border border-zinc-300 px-5 py-3 text-lg font-semibold text-zinc-700 active:bg-zinc-100" onClick={reset}>Recomeçar</button>
    </header>
  );

  if (!info.is_open && step !== "done") return shell(
    <div className="grid min-h-screen place-items-center p-10 text-center">
      <div><p className="text-4xl font-extrabold">{unit.name}</p><p className="mt-4 text-2xl text-zinc-600">No momento não estamos recebendo pedidos por aqui.</p>
        <p className="mt-2 text-lg text-zinc-500">Fale com um atendente no balcão.</p></div>
    </div>);

  if (step === "welcome") return shell(
    <button className="relative grid min-h-screen w-full place-items-center overflow-hidden p-10 text-center" onClick={start}>
      {unit.cover_url && /* eslint-disable-next-line @next/next/no-img-element */ <img src={unit.cover_url} alt="" className="absolute inset-0 h-full w-full object-cover opacity-30" />}
      <div className="relative">
        {unit.logo_url && /* eslint-disable-next-line @next/next/no-img-element */ <img src={unit.logo_url} alt="" className="mx-auto mb-6 h-28 w-28 rounded-3xl object-cover shadow-lg" />}
        <p className="text-5xl font-extrabold">{unit.name}</p>
        <p className="mt-6 text-2xl text-zinc-700">Faça seu pedido aqui, sem fila</p>
        <span className="mt-12 inline-block animate-pulse rounded-3xl px-12 py-6 text-3xl font-extrabold text-white shadow-xl" style={{ background: color }}>Toque para começar</span>
      </div>
    </button>);

  if (step === "mode") return shell(<>
    <Header />
    <div className="mx-auto max-w-4xl p-8 text-center">
      <p className="mt-6 text-4xl font-extrabold">Onde você vai comer?</p>
      <div className="mt-10 grid gap-6 sm:grid-cols-2">
        {modes.map((m) => (
          <button key={m} className="rounded-3xl border-2 border-zinc-200 bg-white p-10 text-3xl font-extrabold shadow-sm active:scale-[0.98]"
            style={{ borderColor: color }} onClick={() => { setMode(m); setStep("menu"); }}>
            <span className="block text-6xl" aria-hidden="true">{m === "dine_in" ? "🍽️" : "🛍️"}</span>
            <span className="mt-4 block">{m === "dine_in" ? "Comer aqui" : "Para levar"}</span>
          </button>
        ))}
      </div>
    </div>
    {idleAsk > 0 && <IdleAsk seconds={idleAsk} color={color} onStay={() => setIdleAsk(0)} />}
  </>);

  if (step === "done" && placed) return shell(
    <div className="mx-auto grid min-h-screen max-w-2xl place-items-center p-8 text-center">
      <div className="w-full">
        <p className="text-2xl font-semibold text-zinc-600">{name.trim().split(" ")[0]}, seu pedido é o número</p>
        <p className="my-4 text-[7rem] font-black leading-none" style={{ color }}>#{placed.number}</p>
        {placed.pay === "counter" && (
          <p className="text-2xl text-zinc-700">Vá ao <b>caixa</b> para pagar <b>{brl(placed.total_cents)}</b> e informe o número.
            {mode === "dine_in" ? " Chamaremos quando estiver pronto." : " Retire no balcão quando chamarmos."}</p>
        )}
        {placed.pay === "pix" && waitingPix && (
          <div className="mt-4 rounded-3xl bg-white p-6 text-left shadow-sm">
            <p className="mb-3 text-center text-xl font-semibold">Pague {brl(placed.total_cents)} com Pix pelo celular</p>
            {order?.gateway?.config ? (
              <OnlinePayment token={placed.token} method="pix" totalCents={placed.total_cents} gateway={order.gateway} color={color} onChange={loadOrder} />
            ) : <p className="text-center text-zinc-500">Gerando o Pix...</p>}
            <p className="mt-4 text-center text-sm text-zinc-500">Prefere pagar no caixa? Informe o número #{placed.number} ao atendente.</p>
          </div>
        )}
        {placed.pay === "pix" && order?.payment_status === "paid" && (
          <p className="text-2xl font-semibold text-emerald-700">Pagamento aprovado! {mode === "dine_in" ? "Chamaremos quando estiver pronto." : "Retire no balcão quando chamarmos."}</p>
        )}
        {placed.pay === "pix" && order?.status === "cancelled" && <p className="text-2xl text-red-700">O Pix expirou. Faça o pedido de novo ou pague no caixa.</p>}
        {!waitingPix && <button className="mt-10 rounded-3xl px-10 py-5 text-2xl font-bold text-white" style={{ background: color }} onClick={reset}>Novo pedido</button>}
      </div>
    </div>);

  if (step === "review") return shell(<>
    <Header />
    <div className="mx-auto max-w-3xl space-y-6 p-6 pb-40">
      <p className="text-3xl font-extrabold">Seu pedido</p>
      <div className="divide-y divide-zinc-100 rounded-3xl bg-white p-2 shadow-sm">
        {items.map((i) => (
          <div key={i.key} className="flex items-center justify-between gap-4 p-4">
            <div className="min-w-0">
              <p className="text-xl font-semibold">{i.name}</p>
              {i.options.length > 0 && <p className="text-sm text-zinc-500">{i.options.map((o) => (o.quantity > 1 ? `${o.quantity}x ` : "") + o.name).join(", ")}</p>}
              {i.notes && <p className="text-sm text-zinc-500">Obs.: {i.notes}</p>}
              <p className="mt-1 text-lg font-bold">{brl(i.unit_price_cents * i.quantity)}</p>
            </div>
            <div className="scale-125"><Stepper value={i.quantity} onChange={(q) => setQty(i.key, q)} label={i.name} /></div>
          </div>
        ))}
        {items.length === 0 && <p className="p-6 text-center text-lg text-zinc-500">Nenhum item. Volte ao cardápio.</p>}
      </div>
      <label className="block">
        <span className="text-xl font-semibold">Seu nome (para chamarmos)</span>
        <input className="mt-2 w-full rounded-2xl border-2 border-zinc-300 px-5 py-4 text-2xl outline-none focus:border-zinc-500"
          value={name} maxLength={40} autoComplete="off" onChange={(e) => setName(e.target.value)} placeholder="Ex.: Maria" />
      </label>
      <div>
        <p className="text-xl font-semibold">Como vai pagar?</p>
        <div className="mt-2 grid gap-4 sm:grid-cols-2">
          {pays.map((p) => (
            <button key={p} className={`rounded-2xl border-2 p-5 text-left text-xl font-bold ${pay === p ? "bg-zinc-900 text-white" : "bg-white"}`}
              style={{ borderColor: pay === p ? color : undefined }} onClick={() => setPay(p)} aria-pressed={pay === p}>
              {p === "pix" ? "Pix aqui na tela" : "Pagar no caixa"}
              <span className={`mt-1 block text-sm font-normal ${pay === p ? "text-zinc-200" : "text-zinc-500"}`}>
                {p === "pix" ? "Leia o QR Code com o app do banco" : "Dinheiro ou cartão, no balcão"}</span>
            </button>
          ))}
        </div>
      </div>
      {err && <p role="alert" className="rounded-2xl bg-red-50 p-4 text-lg text-red-800">{err}</p>}
    </div>
    <div className="fixed inset-x-0 bottom-0 z-30 flex items-center gap-4 border-t border-zinc-200 bg-white p-5">
      <button className="rounded-2xl border-2 border-zinc-300 px-6 py-4 text-xl font-semibold" onClick={() => setStep("menu")}>Voltar</button>
      <button className="flex-1 rounded-2xl px-6 py-4 text-2xl font-extrabold text-white disabled:opacity-40" style={{ background: color }}
        disabled={busy || !items.length || !name.trim() || !pay} onClick={() => void confirm()}>
        {busy ? "Enviando..." : `Confirmar pedido · ${brl(total)}`}
      </button>
    </div>
    {idleAsk > 0 && <IdleAsk seconds={idleAsk} color={color} onStay={() => setIdleAsk(0)} />}
  </>);

  const current = cats.find((c) => c.id === cat) ?? cats[0];
  return shell(<>
    <Header />
    <div className="flex">
      <nav className="sticky top-[81px] hidden h-[calc(100vh-81px)] w-64 shrink-0 overflow-y-auto border-r border-zinc-200 bg-white p-3 md:block" aria-label="Categorias">
        {cats.map((c) => (
          <button key={c.id} className={`mb-1 w-full rounded-2xl px-4 py-4 text-left text-lg font-semibold ${c.id === current?.id ? "text-white" : "text-zinc-700"}`}
            style={c.id === current?.id ? { background: color } : undefined} onClick={() => { setCat(c.id); window.scrollTo(0, 0); }}>{c.name}</button>
        ))}
      </nav>
      <main className="min-w-0 flex-1 p-5 pb-36">
        <div className="mb-4 flex gap-2 overflow-x-auto md:hidden">
          {cats.map((c) => (
            <button key={c.id} className={`shrink-0 rounded-full px-5 py-3 text-lg font-semibold ${c.id === current?.id ? "text-white" : "bg-white text-zinc-700"}`}
              style={c.id === current?.id ? { background: color } : undefined} onClick={() => setCat(c.id)}>{c.name}</button>
          ))}
        </div>
        {current && <p className="mb-4 text-3xl font-extrabold">{current.name}</p>}
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
          {current?.products.filter((p) => p.available).map((p) => (
            <button key={p.id} className="overflow-hidden rounded-3xl bg-white text-left shadow-sm active:scale-[0.98]" onClick={() => setOpen(p)}>
              {p.image_url ? /* eslint-disable-next-line @next/next/no-img-element */ <img src={p.image_url} alt="" className="aspect-[4/3] w-full object-cover" />
                : <div className="grid aspect-[4/3] w-full place-items-center bg-zinc-100 text-5xl" aria-hidden="true">🍴</div>}
              <div className="p-4">
                <p className="text-lg font-bold leading-tight">{p.name}</p>
                {p.description && <p className="mt-1 line-clamp-2 text-sm text-zinc-500">{p.description}</p>}
                <p className="mt-2 text-xl font-extrabold" style={{ color }}>
                  {brl(effectivePrice(p))}
                  {p.promo_price_cents != null && <span className="ml-2 text-sm font-normal text-zinc-400 line-through">{brl(p.price_cents)}</span>}
                </p>
              </div>
            </button>
          ))}
        </div>
      </main>
    </div>
    {count > 0 && (
      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-zinc-200 bg-white p-5">
        <button className="flex w-full items-center justify-between rounded-2xl px-6 py-5 text-2xl font-extrabold text-white" style={{ background: color }}
          onClick={() => { setStep("review"); window.scrollTo(0, 0); }}>
          <span>Ver pedido ({count} {count === 1 ? "item" : "itens"})</span><span>{brl(total)}</span>
        </button>
      </div>
    )}
    {open && <ProductModal product={open} color={color} onClose={() => setOpen(null)} onAdd={add} />}
    {idleAsk > 0 && <IdleAsk seconds={idleAsk} color={color} onStay={() => setIdleAsk(0)} />}
  </>);
}

function IdleAsk({ seconds, color, onStay }: { seconds: number; color: string; onStay: () => void }) {
  return (
    <div className="fixed inset-0 z-[60] grid place-items-center bg-zinc-950/60 p-6" role="alertdialog" aria-label="Ainda está aí?">
      <div className="w-full max-w-md rounded-3xl bg-white p-8 text-center">
        <p className="text-3xl font-extrabold">Ainda está aí?</p>
        <p className="mt-3 text-lg text-zinc-600">O pedido será apagado em {seconds} s.</p>
        <button className="mt-6 w-full rounded-2xl px-6 py-4 text-2xl font-bold text-white" style={{ background: color }} onClick={onStay}>Continuar pedido</button>
      </div>
    </div>
  );
}
