"use client";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { brl } from "@/lib/format";
import { Modal } from "@/components/ui";
import { effectivePrice, useCart } from "./cart";
import { ProductModal, Stepper } from "./product-modal";
import type { Store, StoreProduct } from "./types";
import { storeColor } from "./brand";
import { LoyaltyBanner, RatingChip, useStoreExtras } from "./loyalty";
import { ConsentBanner } from "./consent";
import { funnel, trackEvent } from "@/lib/tracking";

const TAG_LABEL: Record<string, string> = { novo: "Novo", vegano: "Vegano", picante: "Picante", vegetariano: "Vegetariano", "sem-gluten": "Sem glúten" };

export function StoreMenu({ store }: { store: Store }) {
  const { unit, menu } = store;
  const color = storeColor(unit.primary_color);
  const cart = useCart(unit.slug);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<StoreProduct | null>(null);
  const [cartOpen, setCartOpen] = useState(false);
  const [toast, setToast] = useState("");
  const { loyalty, reviews } = useStoreExtras(unit.slug);
  useEffect(() => { funnel(unit.slug, "visit"); }, [unit.slug]);

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
    funnel(unit.slug, "view_item");
    trackEvent(unit.tracking, { name: "view_item", items: [{ id: p.id, name: p.name, price_cents: p.promo_price_cents ?? p.price_cents, quantity: 1 }] });
  }

  return (
    <div className="min-h-screen bg-cream pb-32">
      <header className="bg-white pb-5 shadow-[0_1px_0_rgb(0_0_0/0.04)]">
        <div className="relative h-40 w-full overflow-hidden sm:h-56"
          style={{ background: unit.cover_url ? `center/cover url(${JSON.stringify(unit.cover_url)})` : `linear-gradient(135deg, #fbbf24 0%, #f97316 40%, ${color} 100%)` }}>
          {!unit.cover_url && (
            <svg aria-hidden="true" viewBox="0 0 400 160" preserveAspectRatio="xMidYMid slice" className="absolute inset-0 h-full w-full opacity-20">
              <g fill="none" stroke="#fff" strokeWidth="2">
                <circle cx="60" cy="40" r="22" /><circle cx="340" cy="120" r="30" /><circle cx="250" cy="30" r="12" />
                <path d="M120 120c10-20 30-20 40 0M290 60l20 20M30 120l15-15" strokeLinecap="round" />
              </g>
            </svg>
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-black/35 to-transparent" />
        </div>
        <div className="mx-auto max-w-3xl px-4">
          <div className="-mt-12 flex items-end gap-4">
            <div className="relative grid h-24 w-24 shrink-0 place-items-center overflow-hidden rounded-full border-4 border-white bg-white text-4xl font-black shadow-lift" style={{ color }}>
              {unit.logo_url
                // eslint-disable-next-line @next/next/no-img-element
                ? <img src={unit.logo_url} alt={`Logo ${unit.name}`} className="h-full w-full object-cover" />
                : unit.name.slice(0, 1)}
            </div>
            <span className={`badge mb-2 px-3 py-1 ${unit.is_open ? "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200" : "bg-zinc-100 text-zinc-600 ring-1 ring-zinc-200"}`}>
              <span className={`h-2 w-2 rounded-full ${unit.is_open ? "animate-pulse bg-emerald-500" : "bg-zinc-400"}`} />
              {unit.is_open ? "Aberto agora" : "Fechado"}
            </span>
          </div>
          <h1 className="mt-3 text-2xl font-black tracking-tight sm:text-3xl">{unit.name}</h1>
          {unit.description && <p className="mt-1 text-sm leading-relaxed text-zinc-600">{unit.description}</p>}
          <div className="mt-3 flex flex-wrap gap-2 text-xs">
            <RatingChip reviews={reviews} storeName={unit.name} />
            {unit.accepts_delivery && minEta != null && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-zinc-100 px-3 py-1.5 font-semibold text-zinc-700">
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
                {minEta} min
              </span>
            )}
            {unit.accepts_delivery && minEta != null && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-zinc-100 px-3 py-1.5 font-semibold text-zinc-700">
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true"><circle cx="6" cy="17" r="3" /><circle cx="18" cy="17" r="3" /><path d="M9 17h6l-3-8H8M15 9h3l3 5" /></svg>
                Entrega {minFee ? `a partir de ${brl(minFee)}` : "grátis"}
              </span>
            )}
            {unit.accepts_pickup && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-zinc-100 px-3 py-1.5 font-semibold text-zinc-700">
                <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true"><path d="M4 10h16l-1-5H5l-1 5Zm1 0v9h14v-9M9 19v-5h6v5" /></svg>
                Retirada em {unit.pickup_time_min} min
              </span>
            )}
            {unit.min_order_cents > 0 && <span className="rounded-full bg-zinc-100 px-3 py-1.5 font-semibold text-zinc-700">Mínimo {brl(unit.min_order_cents)}</span>}
            {(unit.neighborhood || unit.city) && <span className="rounded-full bg-zinc-100 px-3 py-1.5 font-semibold text-zinc-700">{[unit.neighborhood, unit.city].filter(Boolean).join(" · ")}</span>}
          </div>
          <LoyaltyBanner loyalty={loyalty} color={color} />
          {!unit.is_open && (
            <p className="mt-4 rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-amber-200">
              A loja está fechada agora.{unit.accepts_scheduling ? " Você pode montar seu pedido e agendar para mais tarde." : " Volte no horário de funcionamento."}
            </p>
          )}
        </div>
      </header>

      <div className="sticky top-0 z-20 border-b border-zinc-200/70 bg-cream/90 backdrop-blur-md">
        <div className="mx-auto max-w-3xl px-4 pt-3">
          <label className="sr-only" htmlFor="busca">Buscar no cardápio</label>
          <div className="relative">
            <svg viewBox="0 0 24 24" className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></svg>
            <input id="busca" className="input rounded-full pl-10" placeholder="Buscar no cardápio" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <nav className="no-scrollbar -mx-4 mt-3 flex gap-2 overflow-x-auto px-4 pb-3" aria-label="Categorias">
            {filtered.map((c) => (
              <a key={c.id} href={`#cat-${c.id}`} className="shrink-0 rounded-full bg-white px-4 py-1.5 text-sm font-semibold text-zinc-700 shadow-sm ring-1 ring-zinc-200 transition hover:text-zinc-900 hover:ring-zinc-300">{c.name}</a>
            ))}
          </nav>
        </div>
      </div>

      <main className="mx-auto max-w-3xl px-4">
        {!q && featured.length > 0 && (
          <section className="mt-6" aria-labelledby="destaques">
            <h2 id="destaques" className="mb-3 flex items-center gap-2 text-lg font-extrabold tracking-tight">
              <span className="grid h-7 w-7 place-items-center rounded-full text-sm text-white" style={{ background: color }}>★</span>
              Os mais pedidos
            </h2>
            <div className="no-scrollbar -mx-4 flex snap-x gap-3 overflow-x-auto px-4 pb-2">
              {featured.map((p) => (
                <button key={p.id} onClick={() => pick(p, true)} className="w-44 shrink-0 snap-start overflow-hidden rounded-2xl bg-white text-left shadow-soft ring-1 ring-zinc-200/70 transition hover:-translate-y-0.5 hover:shadow-lift">
                  <div className="h-28 bg-cover bg-center" style={p.image_url ? { backgroundImage: `url(${JSON.stringify(p.image_url)})` } : { background: `linear-gradient(135deg, ${color}26, ${color}55)` }}>
                    {!p.image_url && <span className="grid h-full place-items-center text-3xl font-black" style={{ color }}>{p.name.slice(0, 1)}</span>}
                  </div>
                  <div className="p-3">
                    <p className="line-clamp-2 text-sm font-bold leading-snug">{p.name}</p>
                    <p className="mt-1 text-sm font-extrabold" style={{ color }}>{brl(effectivePrice(p))}</p>
                  </div>
                </button>
              ))}
            </div>
          </section>
        )}

        {filtered.length === 0 && <p className="mt-12 text-center text-sm text-zinc-500">Nada encontrado para “{q}”.</p>}

        {filtered.map((c) => (
          <section key={c.id} id={`cat-${c.id}`} className="scroll-mt-36 pt-8" aria-labelledby={`h-${c.id}`}>
            <h2 id={`h-${c.id}`} className="text-xl font-extrabold tracking-tight">{c.name}</h2>
            {c.description && <p className="text-sm text-zinc-500">{c.description}</p>}
            {!c.available_now && <p className="mt-1 text-xs font-medium text-amber-700">Disponível apenas em horários específicos.</p>}
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {c.products.map((p) => {
                const ok = availableIn(c.available_now, p);
                const promo = p.promo_price_cents != null && p.promo_price_cents < p.price_cents;
                return (
                  <button key={p.id} onClick={() => pick(p, c.available_now)} disabled={!ok} aria-disabled={!ok}
                    className="group flex w-full gap-3 rounded-2xl bg-white p-3.5 text-left shadow-soft ring-1 ring-zinc-200/70 transition hover:shadow-lift hover:ring-zinc-300 disabled:cursor-not-allowed disabled:hover:shadow-soft">
                    <div className={`flex min-w-0 flex-1 flex-col ${ok ? "" : "opacity-55"}`}>
                      <p className="font-bold leading-snug">{p.name}</p>
                      {p.description && <p className="mt-1 line-clamp-2 text-sm leading-snug text-zinc-500">{p.description}</p>}
                      <div className="mt-auto flex flex-wrap items-center gap-2 pt-2">
                        <span className="text-base font-extrabold" style={{ color: ok ? color : undefined }}>
                          {p.option_groups.some((g) => g.min > 0) && effectivePrice(p) === 0 ? "A partir das opções" : brl(effectivePrice(p))}
                        </span>
                        {promo && <span className="text-xs text-zinc-400 line-through">{brl(p.price_cents)}</span>}
                        {promo && <span className="badge bg-emerald-50 text-emerald-700">-{Math.round((1 - (p.promo_price_cents as number) / p.price_cents) * 100)}%</span>}
                        {!ok && <span className="badge bg-zinc-100 text-zinc-600">Esgotado</span>}
                        {p.tags.map((t) => <span key={t} className="badge bg-amber-50 text-amber-800">{TAG_LABEL[t] ?? t}</span>)}
                      </div>
                    </div>
                    <div className="relative shrink-0">
                      {p.image_url ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={p.image_url} alt="" loading="lazy" className={`h-24 w-24 rounded-xl object-cover ${ok ? "" : "grayscale"}`} />
                      ) : (
                        <div className="grid h-24 w-24 place-items-center rounded-xl text-2xl font-black" style={{ background: `${color}14`, color }}>{p.name.slice(0, 1)}</div>
                      )}
                      {ok && (
                        <span className="absolute -bottom-1.5 -right-1.5 grid h-8 w-8 place-items-center rounded-full border-2 border-white text-lg font-bold leading-none text-white shadow transition group-hover:scale-110" style={{ background: color }} aria-hidden="true">+</span>
                      )}
                    </div>
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
          onAdd={(i) => {
            cart.add(i);
            funnel(unit.slug, "add_to_cart");
            trackEvent(unit.tracking, { name: "add_to_cart", items: [{ id: i.product_id, name: i.name, price_cents: i.unit_price_cents, quantity: i.quantity }] });
            setOpen(null); setToast(`${i.name} adicionado à sacola`); setTimeout(() => setToast(""), 2000);
          }} />
      )}

      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-24 z-40 flex justify-center px-4">
        {toast && <span className="rounded-full bg-zinc-900 px-4 py-2.5 text-sm font-medium text-white shadow-lift">✓ {toast}</span>}
      </div>

      {cart.ready && cart.count > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-30 p-3 sm:p-4">
          <button className="btn mx-auto flex w-full max-w-3xl justify-between rounded-2xl py-3.5 pl-3 pr-5 text-base text-white shadow-lift" style={{ background: color }} onClick={() => setCartOpen(true)}>
            <span className="flex items-center gap-2.5">
              <span className="grid h-8 min-w-8 place-items-center rounded-full bg-white/20 px-2 text-sm font-extrabold">{cart.count}</span>
              Ver sacola
            </span>
            <span className="font-extrabold">{brl(cart.total)}</span>
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
                    <p className="mt-1 text-sm font-extrabold" style={{ color }}>{brl(i.unit_price_cents * i.quantity)}</p>
                  </div>
                  <Stepper value={i.quantity} label={i.name} onChange={(v) => cart.setQty(i.key, v)} canInc={i.quantity < 99} />
                </li>
              ))}
            </ul>
            <div className="mt-3 flex justify-between border-t border-zinc-200 pt-4 text-lg font-extrabold">
              <span>Subtotal</span><span>{brl(cart.total)}</span>
            </div>
            {unit.min_order_cents > cart.total && (
              <p className="mt-2 text-sm text-amber-700">Faltam {brl(unit.min_order_cents - cart.total)} para o pedido mínimo.</p>
            )}
            <Link href={`/loja/${unit.slug}/checkout`} className="btn mt-4 w-full rounded-2xl py-3.5 text-base text-white shadow-lift" style={{ background: color }}>
              Continuar
            </Link>
            <button className="btn-ghost mt-2 w-full" onClick={() => { cart.clear(); setCartOpen(false); }}>Esvaziar sacola</button>
          </>
        )}
      </Modal>
      <ConsentBanner tracking={unit.tracking} color={color} />
    </div>
  );
}
