"use client";
import Link from "next/link";
import { useMemo, useState } from "react";
import { brl } from "@/lib/format";
import { Modal } from "@/components/ui";
import { effectivePrice, useCart } from "./cart";
import { ProductModal, Stepper } from "./product-modal";
import type { Store, StoreProduct } from "./types";

const TAG_LABEL: Record<string, string> = { novo: "Novo", vegano: "Vegano", picante: "Picante", vegetariano: "Vegetariano", "sem-gluten": "Sem glúten" };

export function StoreMenu({ store }: { store: Store }) {
  const { unit, menu } = store;
  const color = unit.primary_color || "#6d28d9";
  const cart = useCart(unit.slug);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<StoreProduct | null>(null);
  const [cartOpen, setCartOpen] = useState(false);
  const [toast, setToast] = useState("");

  const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const filtered = useMemo(() => {
    if (!q.trim()) return menu;
    const n = norm(q);
    return menu.map((c) => ({ ...c, products: c.products.filter((p) => norm(p.name + " " + (p.description ?? "")).includes(n)) }))
      .filter((c) => c.products.length);
  }, [menu, q]);
  const featured = useMemo(() => menu.flatMap((c) => c.available_now ? c.products.filter((p) => p.featured && p.available) : []).slice(0, 8), [menu]);
  const availableIn = (catAvail: boolean, p: StoreProduct) => catAvail && p.available;

  const minFee = store.zones.length ? Math.min(...store.zones.map((z) => z.fee_cents)) : null;
  const minEta = store.zones.length ? Math.min(...store.zones.map((z) => z.eta_min)) : null;

  function pick(p: StoreProduct, catAvail: boolean) {
    if (!availableIn(catAvail, p)) return;
    setOpen(p);
  }

  return (
    <div className="min-h-screen bg-zinc-50 pb-28">
      <header>
        <div className="h-36 w-full bg-cover bg-center sm:h-48" style={{ background: unit.cover_url ? `center/cover url(${JSON.stringify(unit.cover_url)})` : color }} />
        <div className="mx-auto max-w-3xl px-4">
          <div className="-mt-10 flex items-end gap-3">
            <div className="grid h-20 w-20 shrink-0 place-items-center overflow-hidden rounded-2xl border-4 border-white bg-white text-3xl font-bold shadow" style={{ color }}>
              {unit.logo_url
                // eslint-disable-next-line @next/next/no-img-element
                ? <img src={unit.logo_url} alt={`Logo ${unit.name}`} className="h-full w-full object-cover" />
                : unit.name.slice(0, 1)}
            </div>
          </div>
          <h1 className="mt-2 text-2xl font-bold">{unit.name}</h1>
          {unit.description && <p className="text-sm text-zinc-600">{unit.description}</p>}
          <div className="mt-2 flex flex-wrap gap-2 text-xs">
            <span className={`badge ${unit.is_open ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800"}`}>
              {unit.is_open ? "● Aberto agora" : "● Fechado"}
            </span>
            {unit.accepts_delivery && minEta != null && <span className="badge bg-zinc-200 text-zinc-800">🛵 {minEta} min · a partir de {minFee ? brl(minFee) : "grátis"}</span>}
            {unit.accepts_pickup && <span className="badge bg-zinc-200 text-zinc-800">🏪 Retirada em {unit.pickup_time_min} min</span>}
            {unit.min_order_cents > 0 && <span className="badge bg-zinc-200 text-zinc-800">Pedido mínimo {brl(unit.min_order_cents)}</span>}
            {(unit.neighborhood || unit.city) && <span className="badge bg-zinc-200 text-zinc-800">{[unit.neighborhood, unit.city].filter(Boolean).join(" · ")}</span>}
          </div>
          {!unit.is_open && (
            <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
              A loja está fechada agora.{unit.accepts_scheduling ? " Você pode montar seu pedido e agendar para mais tarde." : " Volte no horário de funcionamento."}
            </p>
          )}
        </div>
      </header>

      <div className="sticky top-0 z-20 mt-4 border-b border-zinc-200 bg-zinc-50/95 backdrop-blur">
        <div className="mx-auto max-w-3xl px-4 pt-2">
          <label className="sr-only" htmlFor="busca">Buscar no cardápio</label>
          <input id="busca" className="input" placeholder="🔍 Buscar no cardápio" value={q} onChange={(e) => setQ(e.target.value)} />
          <nav className="-mx-4 mt-2 flex gap-2 overflow-x-auto px-4 pb-2" aria-label="Categorias">
            {filtered.map((c) => (
              <a key={c.id} href={`#cat-${c.id}`} className="shrink-0 rounded-full border border-zinc-300 bg-white px-3 py-1 text-sm font-medium hover:border-zinc-400">{c.name}</a>
            ))}
          </nav>
        </div>
      </div>

      <main className="mx-auto max-w-3xl px-4">
        {!q && featured.length > 0 && (
          <section className="mt-5" aria-labelledby="destaques">
            <h2 id="destaques" className="mb-2 text-lg font-bold">⭐ Destaques</h2>
            <div className="-mx-4 flex gap-3 overflow-x-auto px-4 pb-1">
              {featured.map((p) => (
                <button key={p.id} onClick={() => pick(p, true)} className="w-40 shrink-0 overflow-hidden rounded-xl border border-zinc-200 bg-white text-left shadow-sm">
                  <div className="h-24 bg-zinc-100 bg-cover bg-center" style={p.image_url ? { backgroundImage: `url(${JSON.stringify(p.image_url)})` } : { background: `${color}22` }} />
                  <div className="p-2">
                    <p className="line-clamp-2 text-sm font-semibold">{p.name}</p>
                    <p className="text-sm font-bold" style={{ color }}>{brl(effectivePrice(p))}</p>
                  </div>
                </button>
              ))}
            </div>
          </section>
        )}

        {filtered.length === 0 && <p className="mt-10 text-center text-sm text-zinc-500">Nada encontrado para “{q}”.</p>}

        {filtered.map((c) => (
          <section key={c.id} id={`cat-${c.id}`} className="scroll-mt-32 pt-6" aria-labelledby={`h-${c.id}`}>
            <h2 id={`h-${c.id}`} className="text-lg font-bold">{c.name}</h2>
            {c.description && <p className="text-sm text-zinc-500">{c.description}</p>}
            {!c.available_now && <p className="mt-1 text-xs text-amber-700">Disponível apenas em horários específicos.</p>}
            <div className="mt-2 divide-y divide-zinc-200 overflow-hidden rounded-xl border border-zinc-200 bg-white">
              {c.products.map((p) => {
                const ok = availableIn(c.available_now, p);
                return (
                  <button key={p.id} onClick={() => pick(p, c.available_now)} disabled={!ok} aria-disabled={!ok}
                    className="flex w-full gap-3 p-3 text-left hover:bg-zinc-50 disabled:cursor-not-allowed">
                    <div className={`min-w-0 flex-1 ${ok ? "" : "opacity-60"}`}>
                      <p className="font-semibold">{p.name}</p>
                      {p.description && <p className="line-clamp-2 text-sm text-zinc-600">{p.description}</p>}
                      <div className="mt-1 flex flex-wrap items-center gap-2">
                        {p.promo_price_cents != null && p.promo_price_cents < p.price_cents && (
                          <span className="text-xs text-zinc-500 line-through">{brl(p.price_cents)}</span>
                        )}
                        <span className="text-sm font-bold" style={{ color: ok ? color : undefined }}>
                          {p.option_groups.some((g) => g.min > 0) && effectivePrice(p) === 0 ? "A partir das opções" : brl(effectivePrice(p))}
                        </span>
                        {!ok && <span className="badge bg-zinc-200 text-zinc-700">Esgotado</span>}
                        {p.tags.map((t) => <span key={t} className="badge bg-brand-50 text-brand-800">{TAG_LABEL[t] ?? t}</span>)}
                      </div>
                    </div>
                    {p.image_url && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={p.image_url} alt="" loading="lazy" className={`h-20 w-20 shrink-0 rounded-lg object-cover ${ok ? "" : "grayscale"}`} />
                    )}
                  </button>
                );
              })}
            </div>
          </section>
        ))}
      </main>

      {open && (
        <ProductModal product={open} color={color} onClose={() => setOpen(null)}
          onAdd={(i) => { cart.add(i); setOpen(null); setToast(`${i.name} adicionado à sacola`); setTimeout(() => setToast(""), 2000); }} />
      )}

      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-24 flex justify-center">
        {toast && <span className="rounded-full bg-zinc-900 px-4 py-2 text-sm text-white shadow-lg">{toast}</span>}
      </div>

      {cart.ready && cart.count > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-zinc-200 bg-white p-3">
          <button className="btn mx-auto flex w-full max-w-3xl justify-between py-3 text-white" style={{ background: color }} onClick={() => setCartOpen(true)}>
            <span>🛍 {cart.count} {cart.count === 1 ? "item" : "itens"}</span>
            <span>Ver sacola · {brl(cart.total)}</span>
          </button>
        </div>
      )}

      <Modal open={cartOpen} onClose={() => setCartOpen(false)} title="Sua sacola">
        {cart.items.length === 0 ? <p className="text-sm text-zinc-500">Sua sacola está vazia.</p> : (
          <>
            <ul className="divide-y divide-zinc-100">
              {cart.items.map((i) => (
                <li key={i.key} className="flex items-start justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <p className="font-medium">{i.name}</p>
                    {i.options.length > 0 && <p className="text-xs text-zinc-500">{i.options.map((o) => `${o.quantity > 1 ? o.quantity + "x " : ""}${o.name}`).join(", ")}</p>}
                    {i.notes && <p className="text-xs italic text-zinc-500">Obs.: {i.notes}</p>}
                    <p className="mt-1 text-sm font-semibold">{brl(i.unit_price_cents * i.quantity)}</p>
                  </div>
                  <Stepper value={i.quantity} label={i.name} onChange={(v) => cart.setQty(i.key, v)} canInc={i.quantity < 99} />
                </li>
              ))}
            </ul>
            <div className="mt-3 flex justify-between border-t border-zinc-200 pt-3 font-bold">
              <span>Subtotal</span><span>{brl(cart.total)}</span>
            </div>
            {unit.min_order_cents > cart.total && (
              <p className="mt-2 text-sm text-amber-700">Faltam {brl(unit.min_order_cents - cart.total)} para o pedido mínimo.</p>
            )}
            <Link href={`/loja/${unit.slug}/checkout`} className="btn mt-4 w-full py-3 text-white" style={{ background: color }}>
              Continuar
            </Link>
            <button className="btn-ghost mt-2 w-full" onClick={() => { cart.clear(); setCartOpen(false); }}>Esvaziar sacola</button>
          </>
        )}
      </Modal>
    </div>
  );
}
