"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { Alert, Modal } from "@/components/ui";
import { brl, errorMessage, STATUS_LABEL, timeHM } from "@/lib/format";
import { effectivePrice } from "@/components/store/cart";
import { ProductModal, Stepper } from "@/components/store/product-modal";
import { storeColor } from "@/components/store/brand";
import type { CartItem, Store, StoreProduct } from "@/components/store/types";

type TabOrder = {
  number: number; status: string; created_at: string; via_qr: boolean; subtotal_cents: number;
  items: { name: string; quantity: number; total_cents: number; options: { name: string; quantity?: number }[] | null; notes: string | null }[];
};
export type TableInfo = {
  slug: string; unit_name: string; table: string; area: string; enabled: boolean; is_open: boolean; auto_accept: boolean;
  service_fee_pct: number;
  tab: null | { opened_at: string; bill_requested_at: string | null; waiter_called_at: string | null; service_fee_pct: number; subtotal_cents: number; orders: TabOrder[] };
};

const ORDER_LABEL: Record<string, string> = {
  pending: "Aguardando confirmação", preparing: "Em preparo", ready: "Pronto", completed: "Entregue", cancelled: "Cancelado",
};
const ORDER_CLASS: Record<string, string> = {
  pending: "bg-amber-50 text-amber-800", preparing: "bg-orange-50 text-orange-800", ready: "bg-emerald-50 text-emerald-700",
  completed: "bg-zinc-100 text-zinc-600", cancelled: "bg-red-50 text-red-700",
};

function useTableCart(token: string) {
  const key = `df_table_cart_${token}`;
  const [items, setItems] = useState<CartItem[]>([]);
  useEffect(() => {
    try { const v = JSON.parse(localStorage.getItem(key) ?? "[]"); setItems(Array.isArray(v) ? v : []); } catch { setItems([]); }
  }, [key]);
  const update = useCallback((fn: (p: CartItem[]) => CartItem[]) => setItems((prev) => {
    const next = fn(prev);
    try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* sem armazenamento */ }
    return next;
  }), [key]);
  return {
    items,
    add: (i: CartItem) => update((p) => p.some((x) => x.key === i.key)
      ? p.map((x) => (x.key === i.key ? { ...x, quantity: Math.min(99, x.quantity + i.quantity) } : x)) : [...p, i]),
    setQty: (k: string, q: number) => update((p) => (q <= 0 ? p.filter((x) => x.key !== k) : p.map((x) => (x.key === k ? { ...x, quantity: Math.min(99, q) } : x)))),
    clear: () => update(() => []),
    total: items.reduce((s, i) => s + i.unit_price_cents * i.quantity, 0),
    count: items.reduce((s, i) => s + i.quantity, 0),
  };
}

export function TableMenu({ token, initialInfo, store }: { token: string; initialInfo: TableInfo; store: Store }) {
  const sb = supabaseBrowser();
  const { unit, menu } = store;
  const color = storeColor(unit.primary_color);
  const cart = useTableCart(token);
  const [info, setInfo] = useState(initialInfo);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<StoreProduct | null>(null);
  const [panel, setPanel] = useState<null | "cart" | "bill">(null);
  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [sent, setSent] = useState<{ number: number; status: string } | null>(null);
  const [toast, setToast] = useState("");
  const [waiterUntil, setWaiterUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  const canOrder = info.enabled && info.is_open;

  useEffect(() => { try { setName(localStorage.getItem("df_table_name") ?? ""); } catch { /* */ } }, []);
  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(""), 2500); };

  const refresh = useCallback(async () => {
    const { data } = await sb.rpc("table_info", { p_token: token });
    if (data) setInfo(data as TableInfo);
  }, [sb, token]);

  useEffect(() => {
    const id = setInterval(() => { setNow(Date.now()); if (document.visibilityState === "visible") refresh(); }, 15000);
    const onVis = () => { if (document.visibilityState === "visible") refresh(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { clearInterval(id); document.removeEventListener("visibilitychange", onVis); };
  }, [refresh]);
  useEffect(() => {
    if (waiterUntil <= Date.now()) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [waiterUntil]);

  const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const filtered = useMemo(() => {
    if (!q.trim()) return menu;
    const n = norm(q);
    return menu.map((c) => ({ ...c, products: c.products.filter((p) => norm(p.name + " " + (p.description ?? "")).includes(n)) }))
      .filter((c) => c.products.length);
  }, [menu, q]);

  async function sendOrder() {
    if (!cart.items.length || !canOrder) return;
    setBusy(true); setErr("");
    try { localStorage.setItem("df_table_name", name.trim()); } catch { /* */ }
    const { data, error } = await sb.rpc("table_order", {
      p_token: token,
      p_items: cart.items.map((i) => ({ product_id: i.product_id, quantity: i.quantity, notes: i.notes || null,
        options: i.options.map((o) => ({ option_id: o.option_id, quantity: o.quantity })) })),
      p_name: name.trim() || null, p_notes: notes.trim() || null,
    });
    setBusy(false);
    if (error) { setErr(errorMessage(error)); return; }
    setSent({ number: data.number, status: data.status });
    cart.clear(); setNotes("");
    refresh();
  }

  async function call(kind: "waiter" | "bill") {
    setErr("");
    const { error } = await sb.rpc("table_call", { p_token: token, p_kind: kind });
    if (error) { const m = errorMessage(error); if (kind === "waiter") flash(m); else setErr(m); return; }
    if (kind === "waiter") { setWaiterUntil(Date.now() + 60000); setNow(Date.now()); flash("Garçom chamado. Já estamos indo!"); }
    refresh();
  }

  const tab = info.tab;
  const live = tab ? tab.orders.filter((o) => o.status !== "cancelled") : [];
  const sub = tab?.subtotal_cents ?? 0;
  const pct = Number(tab?.service_fee_pct ?? info.service_fee_pct ?? 0);
  const fee = Math.round((sub * pct) / 100);
  const waiterWait = Math.max(0, Math.ceil((waiterUntil - now) / 1000));

  return (
    <div className="min-h-screen bg-cream pb-40">
      <header className="bg-white px-4 pb-4 pt-5 shadow-[0_1px_0_rgb(0_0_0/0.04)]">
        <div className="mx-auto flex max-w-3xl items-center gap-3">
          <div className="grid h-14 w-14 shrink-0 place-items-center overflow-hidden rounded-full bg-white text-2xl font-black ring-1 ring-zinc-200" style={{ color }}>
            {unit.logo_url
              // eslint-disable-next-line @next/next/no-img-element
              ? <img src={unit.logo_url} alt={`Logo ${unit.name}`} className="h-full w-full object-cover" />
              : unit.name.slice(0, 1)}
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-lg font-black tracking-tight">{unit.name}</h1>
            <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-sm">
              <span className="rounded-full px-2.5 py-0.5 text-xs font-bold text-white" style={{ background: color }}>Mesa {info.table}</span>
              {info.area && <span className="text-xs text-zinc-500">{info.area}</span>}
            </p>
          </div>
        </div>
        <div className="mx-auto max-w-3xl">
          {!info.enabled ? (
            <p className="mt-3 rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-amber-200">Os pedidos pelo QR Code estão desativados. Chame o garçom.</p>
          ) : !info.is_open ? (
            <p className="mt-3 rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-amber-200">A loja não está recebendo pedidos agora. Você pode ver o cardápio.</p>
          ) : (
            <p className="mt-3 text-sm text-zinc-600">Escolha, envie o pedido direto para a cozinha e pague com a equipe no final.</p>
          )}
        </div>
      </header>

      <div className="sticky top-0 z-20 border-b border-zinc-200/70 bg-cream/90 backdrop-blur-md">
        <div className="mx-auto max-w-3xl px-4 pt-3">
          <label className="sr-only" htmlFor="busca">Buscar no cardápio</label>
          <input id="busca" className="input rounded-full" placeholder="Buscar no cardápio" value={q} onChange={(e) => setQ(e.target.value)} />
          <nav className="no-scrollbar -mx-4 mt-3 flex gap-2 overflow-x-auto px-4 pb-3" aria-label="Categorias">
            {filtered.map((c) => (
              <a key={c.id} href={`#cat-${c.id}`} className="shrink-0 rounded-full bg-white px-4 py-1.5 text-sm font-semibold text-zinc-700 shadow-sm ring-1 ring-zinc-200">{c.name}</a>
            ))}
          </nav>
        </div>
      </div>

      <main className="mx-auto max-w-3xl px-4">
        {filtered.length === 0 && <p className="mt-12 text-center text-sm text-zinc-500">Nada encontrado para “{q}”.</p>}
        {filtered.map((c) => (
          <section key={c.id} id={`cat-${c.id}`} className="scroll-mt-32 pt-7" aria-labelledby={`h-${c.id}`}>
            <h2 id={`h-${c.id}`} className="text-xl font-extrabold tracking-tight">{c.name}</h2>
            {c.description && <p className="text-sm text-zinc-500">{c.description}</p>}
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {c.products.map((p) => {
                const ok = c.available_now && p.available;
                return (
                  <button key={p.id} disabled={!ok} onClick={() => ok && setOpen(p)}
                    className="group flex w-full gap-3 rounded-2xl bg-white p-3.5 text-left shadow-soft ring-1 ring-zinc-200/70 transition hover:ring-zinc-300 disabled:cursor-not-allowed">
                    <div className={`flex min-w-0 flex-1 flex-col ${ok ? "" : "opacity-55"}`}>
                      <p className="font-bold leading-snug">{p.name}</p>
                      {p.description && <p className="mt-1 line-clamp-2 text-sm leading-snug text-zinc-500">{p.description}</p>}
                      <div className="mt-auto flex items-center gap-2 pt-2">
                        <span className="font-extrabold" style={{ color: ok ? color : undefined }}>{brl(effectivePrice(p))}</span>
                        {!ok && <span className="badge bg-zinc-100 text-zinc-600">Indisponível</span>}
                      </div>
                    </div>
                    {p.image_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={p.image_url} alt="" loading="lazy" className={`h-20 w-20 shrink-0 rounded-xl object-cover ${ok ? "" : "grayscale"}`} />
                    ) : (
                      <div className="grid h-20 w-20 shrink-0 place-items-center rounded-xl text-2xl font-black" style={{ background: `${color}14`, color }}>{p.name.slice(0, 1)}</div>
                    )}
                  </button>
                );
              })}
            </div>
          </section>
        ))}
        <p className="mt-12 text-center text-xs text-zinc-400">Cardápio digital por <span className="font-semibold text-zinc-500">domma food</span></p>
      </main>

      {open && (
        <ProductModal product={open} color={color} onClose={() => setOpen(null)}
          onAdd={(i) => { cart.add(i); setOpen(null); setSent(null); flash(`${i.name} adicionado ao pedido`); }} />
      )}

      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-36 z-40 flex justify-center px-4">
        {toast && <span className="rounded-full bg-zinc-900 px-4 py-2.5 text-sm font-medium text-white shadow-lift">{toast}</span>}
      </div>

      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-zinc-200 bg-white/95 p-3 backdrop-blur">
        <div className="mx-auto max-w-3xl space-y-2">
          {cart.count > 0 && (
            <button className="btn flex w-full justify-between rounded-2xl py-3.5 pl-3 pr-5 text-base text-white shadow-lift" style={{ background: color }}
              onClick={() => { setErr(""); setSent(null); setPanel("cart"); }}>
              <span className="flex items-center gap-2.5">
                <span className="grid h-8 min-w-8 place-items-center rounded-full bg-white/20 px-2 text-sm font-extrabold">{cart.count}</span>
                Ver pedido
              </span>
              <span className="font-extrabold">{brl(cart.total)}</span>
            </button>
          )}
          <div className="grid grid-cols-2 gap-2">
            <button className="btn-secondary rounded-xl py-3" disabled={!info.enabled || waiterWait > 0} onClick={() => call("waiter")}>
              {waiterWait > 0 ? `Garçom chamado (${waiterWait}s)` : "Chamar garçom"}
            </button>
            <button className="btn-secondary rounded-xl py-3" onClick={() => { setErr(""); setPanel("bill"); refresh(); }}>
              Minha conta{live.length ? ` · ${brl(sub)}` : ""}
            </button>
          </div>
        </div>
      </div>

      <Modal open={panel === "cart"} onClose={() => setPanel(null)} title={sent ? "Pedido enviado" : `Pedido · Mesa ${info.table}`}>
        {sent ? (
          <div className="space-y-3 text-center">
            <div className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-emerald-100 text-2xl text-emerald-700">✓</div>
            <p className="text-xl font-extrabold">Pedido #{sent.number} enviado</p>
            <p className="text-sm text-zinc-600">{sent.status === "pending" ? "A equipe vai confirmar em instantes." : "Já está sendo preparado."}</p>
            <button className="btn w-full rounded-2xl py-3 text-white" style={{ background: color }} onClick={() => { setSent(null); setPanel(null); }}>Voltar ao cardápio</button>
            <button className="btn-ghost w-full" onClick={() => { setSent(null); setPanel("bill"); }}>Ver minha conta</button>
          </div>
        ) : cart.items.length === 0 ? <p className="text-sm text-zinc-500">Seu pedido está vazio.</p> : (
          <div className="space-y-3">
            <ul className="divide-y divide-zinc-100">
              {cart.items.map((i) => (
                <li key={i.key} className="flex items-start justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <p className="font-medium">{i.name}</p>
                    {i.options.length > 0 && <p className="text-xs text-zinc-500">{i.options.map((o) => `${o.quantity > 1 ? o.quantity + "x " : ""}${o.name}`).join(", ")}</p>}
                    {i.notes && <p className="text-xs italic text-zinc-500">Obs.: {i.notes}</p>}
                    <p className="mt-1 text-sm font-extrabold" style={{ color }}>{brl(i.unit_price_cents * i.quantity)}</p>
                  </div>
                  <Stepper value={i.quantity} label={i.name} onChange={(v) => cart.setQty(i.key, v)} canInc={i.quantity < 99} />
                </li>
              ))}
            </ul>
            <div className="flex justify-between border-t border-zinc-200 pt-3 text-lg font-extrabold"><span>Total do pedido</span><span>{brl(cart.total)}</span></div>
            <label className="block text-sm font-medium">Seu nome (opcional)
              <input className="input mt-1" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} placeholder="Para a equipe saber de quem é" />
            </label>
            <label className="block text-sm font-medium">Observação (opcional)
              <input className="input mt-1" maxLength={300} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Ex.: trazer tudo junto" />
            </label>
            <Alert>{err}</Alert>
            {!canOrder && <Alert kind="info">{info.enabled ? "A loja não está recebendo pedidos agora." : "Os pedidos pelo QR Code estão desativados. Chame o garçom."}</Alert>}
            <button className="btn w-full rounded-2xl py-3.5 text-base text-white shadow-lift" style={{ background: color }} disabled={busy || !canOrder} onClick={sendOrder}>
              {busy ? "Enviando..." : "Enviar pedido para a cozinha"}
            </button>
            <p className="text-center text-xs text-zinc-500">O pagamento é feito com a equipe ao fechar a conta.</p>
          </div>
        )}
      </Modal>

      <Modal open={panel === "bill"} onClose={() => setPanel(null)} title={`Minha conta · Mesa ${info.table}`}>
        {!tab || tab.orders.length === 0 ? <p className="text-sm text-zinc-500">Ainda não há pedidos nesta mesa.</p> : (
          <div className="space-y-3">
            {tab.orders.map((o) => (
              <div key={o.number} className={`rounded-xl border border-zinc-200 p-3 ${o.status === "cancelled" ? "opacity-60" : ""}`}>
                <p className="flex items-center justify-between text-xs text-zinc-500">
                  <span>Pedido #{o.number} · {timeHM(o.created_at)}</span>
                  <span className={`badge ${ORDER_CLASS[o.status] ?? "bg-zinc-100 text-zinc-600"}`}>{ORDER_LABEL[o.status] ?? STATUS_LABEL[o.status] ?? o.status}</span>
                </p>
                <ul className="mt-1.5 space-y-1 text-sm">
                  {o.items.map((i, k) => (
                    <li key={k}>
                      <span className="flex justify-between gap-2"><span>{i.quantity}x {i.name}</span><span className="tabular-nums">{brl(i.total_cents)}</span></span>
                      {(i.options ?? []).length > 0 && <span className="block pl-4 text-xs text-zinc-500">{(i.options ?? []).map((op) => `${(op.quantity ?? 1) > 1 ? op.quantity + "x " : ""}${op.name}`).join(", ")}</span>}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            <dl className="rounded-xl bg-zinc-50 p-3 text-sm">
              <div className="flex justify-between"><dt>Subtotal</dt><dd className="tabular-nums">{brl(sub)}</dd></div>
              {pct > 0 && <div className="flex justify-between text-zinc-500"><dt>Taxa de serviço ({pct}%, opcional)</dt><dd className="tabular-nums">{brl(fee)}</dd></div>}
              <div className="mt-1 flex justify-between text-base font-extrabold"><dt>Total</dt><dd className="tabular-nums">{brl(sub + fee)}</dd></div>
            </dl>
            <Alert>{err}</Alert>
            {tab.bill_requested_at ? (
              <p className="rounded-xl bg-emerald-50 p-3 text-center text-sm font-semibold text-emerald-800">Conta solicitada, o garçom já vem.</p>
            ) : (
              <button className="btn w-full rounded-2xl py-3.5 text-base text-white" style={{ background: color }} disabled={!info.enabled || live.length === 0} onClick={() => call("bill")}>Pedir a conta</button>
            )}
            <p className="text-center text-xs text-zinc-500">O pagamento é feito com a equipe: Pix, cartão ou dinheiro.</p>
          </div>
        )}
      </Modal>
    </div>
  );
}
