"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { brl, STATUS_LABEL } from "@/lib/format";
import { isIOS, isStandalone, registerSW, savedOrderTokens } from "@/lib/pwa";
import { effectivePrice, groupPrice } from "./cart";
import type { CartItem, CartOption, StoreCategory } from "./types";

type BIPEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };
const dismissKey = (slug: string) => `df_install_dismissed_${slug}`;

/** Convite para instalar o cardápio como app (Android/Chrome) ou instrução para o iPhone. */
export function InstallBanner({ slug, name, color }: { slug: string; name: string; color: string }) {
  const [evt, setEvt] = useState<BIPEvent | null>(null);
  const [ios, setIos] = useState(false);
  const [hidden, setHidden] = useState(true);
  const [iosHelp, setIosHelp] = useState(false);

  useEffect(() => {
    void registerSW();
    if (isStandalone()) return;
    let dismissed = false;
    try { dismissed = Number(localStorage.getItem(dismissKey(slug)) ?? 0) > Date.now() - 14 * 864e5; } catch { /* ignora */ }
    if (dismissed) return;
    const onPrompt = (e: Event) => { e.preventDefault(); setEvt(e as BIPEvent); setHidden(false); };
    const onInstalled = () => setHidden(true);
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    if (isIOS()) { setIos(true); setHidden(false); }
    return () => { window.removeEventListener("beforeinstallprompt", onPrompt); window.removeEventListener("appinstalled", onInstalled); };
  }, [slug]);

  function dismiss() {
    setHidden(true);
    try { localStorage.setItem(dismissKey(slug), String(Date.now())); } catch { /* ignora */ }
  }
  async function install() {
    if (!evt) { setIosHelp(true); return; }
    await evt.prompt();
    const r = await evt.userChoice;
    setEvt(null);
    if (r.outcome === "accepted") setHidden(true);
  }

  if (hidden || (!evt && !ios)) return null;
  return (
    <div className="mt-4 rounded-2xl bg-white p-3.5 shadow-soft ring-1 ring-zinc-200/70" role="region" aria-label="Instalar o app">
      <div className="flex items-center gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl text-white" style={{ background: color }} aria-hidden="true">
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2.2"><rect x="6" y="2" width="12" height="20" rx="3" /><path d="M11 18h2" /></svg>
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold">Tenha {name} na tela do celular</p>
          <p className="text-xs text-zinc-500">Abra o cardápio com um toque e receba os avisos do seu pedido.</p>
        </div>
        <button className="btn shrink-0 rounded-full px-4 py-2 text-sm text-white" style={{ background: color }} onClick={() => void install()}>Instalar</button>
        <button className="shrink-0 rounded-full p-1.5 text-zinc-400 hover:text-zinc-700" onClick={dismiss} aria-label="Agora não">
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
        </button>
      </div>
      {iosHelp && (
        <ol className="mt-3 list-decimal space-y-1 rounded-xl bg-zinc-50 py-2.5 pl-8 pr-3 text-xs text-zinc-700">
          <li>No Safari, toque em <strong>Compartilhar</strong> <span aria-hidden="true">(o quadrado com a seta para cima)</span>.</li>
          <li>Escolha <strong>Adicionar à Tela de Início</strong> e confirme.</li>
          <li>Abra o app pelo ícone novo para receber os avisos do pedido.</li>
        </ol>
      )}
    </div>
  );
}

type PastItem = { product_id: string | null; name: string; quantity: number; notes: string | null; options: { option_id: string | null; name: string; quantity: number }[] };
type PastOrder = { token: string; number: number; status: string; type: string; created_at: string; total_cents: number; items: PastItem[] };

/** Remonta os itens de um pedido antigo com os preços e opções de hoje. Itens que mudaram ficam de fora. */
export function rebuildItems(order: PastOrder, menu: StoreCategory[]): { items: CartItem[]; skipped: string[] } {
  const products = new Map(menu.flatMap((c) => (c.available_now ? c.products.filter((p) => p.available) : []).map((p) => [p.id, p] as const)));
  const items: CartItem[] = [];
  const skipped: string[] = [];
  for (const it of order.items) {
    const p = it.product_id ? products.get(it.product_id) : undefined;
    if (!p) { skipped.push(it.name); continue; }
    const sel: Record<string, Record<string, number>> = {};
    const options: CartOption[] = [];
    let ok = true;
    for (const o of it.options) {
      const g = p.option_groups.find((gr) => gr.options.some((x) => x.id === o.option_id));
      const opt = g?.options.find((x) => x.id === o.option_id);
      if (!g || !opt) { ok = false; break; }
      sel[g.id] = { ...(sel[g.id] ?? {}), [opt.id]: o.quantity };
      options.push({ option_id: opt.id, name: opt.name, price_cents: opt.price_cents, quantity: o.quantity, group: g.name });
    }
    if (ok) for (const g of p.option_groups) {
      const n = Object.values(sel[g.id] ?? {}).reduce((a, b) => a + b, 0);
      if (n < g.min || n > g.max) { ok = false; break; }
    }
    if (!ok) { skipped.push(it.name); continue; }
    const notes = (it.notes ?? "").trim();
    const unit = effectivePrice(p) + p.option_groups.reduce((s, g) => s + groupPrice(g, sel[g.id] ?? {}), 0);
    const key = p.id + "|" + options.map((o) => `${o.option_id}x${o.quantity}`).sort().join(",") + "|" + notes;
    items.push({ key, product_id: p.id, name: p.name, quantity: Math.min(99, it.quantity), notes, options, unit_price_cents: unit });
  }
  return { items, skipped };
}

const OPEN = ["awaiting_payment", "pending", "preparing", "ready", "dispatched", "awaiting_pickup"];

/** Pedidos feitos neste aparelho: acompanhar os abertos e pedir de novo com um toque. */
export function PastOrders({ slug, menu, color, onReorder }: {
  slug: string; menu: StoreCategory[]; color: string; onReorder: (items: CartItem[], skipped: string[]) => void;
}) {
  const [orders, setOrders] = useState<PastOrder[]>([]);
  useEffect(() => {
    const tokens = savedOrderTokens(slug);
    if (!tokens.length) return;
    void (async () => {
      const { data } = await supabaseBrowser().rpc("my_orders", { p_slug: slug, p_tokens: tokens });
      setOrders((data as PastOrder[] | null) ?? []);
    })();
  }, [slug]);
  if (!orders.length) return null;
  const date = (iso: string) => new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "short" });
  return (
    <section className="mt-6" aria-labelledby="seus-pedidos">
      <h2 id="seus-pedidos" className="mb-3 text-lg font-extrabold tracking-tight">Seus pedidos</h2>
      <div className="no-scrollbar -mx-4 flex snap-x gap-3 overflow-x-auto px-4 pb-2">
        {orders.slice(0, 6).map((o) => {
          const open = OPEN.includes(o.status);
          return (
            <div key={o.token} className="w-64 shrink-0 snap-start rounded-2xl bg-white p-3.5 shadow-soft ring-1 ring-zinc-200/70">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-zinc-500">#{o.number} · {date(o.created_at)}</span>
                <span className={`badge ${open ? "bg-amber-50 text-amber-800" : o.status === "cancelled" ? "bg-zinc-100 text-zinc-500" : "bg-emerald-50 text-emerald-700"}`}>
                  {STATUS_LABEL[o.status as keyof typeof STATUS_LABEL] ?? o.status}</span>
              </div>
              <p className="mt-2 line-clamp-2 text-sm font-medium leading-snug">{o.items.map((i) => `${i.quantity}x ${i.name}`).join(", ")}</p>
              <p className="mt-1 text-sm font-extrabold">{brl(o.total_cents)}</p>
              <div className="mt-3 flex gap-2">
                {open
                  ? <Link href={`/pedido/${o.token}`} className="btn flex-1 rounded-full py-2 text-sm text-white" style={{ background: color }}>Acompanhar</Link>
                  : <button className="btn flex-1 rounded-full py-2 text-sm text-white" style={{ background: color }}
                      onClick={() => { const r = rebuildItems(o, menu); onReorder(r.items, r.skipped); }}>Pedir de novo</button>}
                {!open && <Link href={`/pedido/${o.token}`} className="btn-ghost rounded-full px-3 py-2 text-sm">Ver</Link>}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
