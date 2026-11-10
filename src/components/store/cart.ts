"use client";
import { useCallback, useEffect, useState } from "react";
import type { CartItem, StoreGroup } from "./types";

const keyFor = (slug: string) => `df_cart_${slug}`;

export function readCart(slug: string): CartItem[] {
  try {
    const raw = localStorage.getItem(keyFor(slug));
    const v = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

export function writeCart(slug: string, items: CartItem[]) {
  try { localStorage.setItem(keyFor(slug), JSON.stringify(items)); } catch { /* armazenamento indisponível */ }
}

export function useCart(slug: string) {
  const [items, setItems] = useState<CartItem[]>([]);
  const [ready, setReady] = useState(false);
  useEffect(() => { setItems(readCart(slug)); setReady(true); }, [slug]);
  const update = useCallback((fn: (prev: CartItem[]) => CartItem[]) => {
    setItems((prev) => { const next = fn(prev); writeCart(slug, next); return next; });
  }, [slug]);
  const add = useCallback((item: CartItem) => update((prev) => {
    const same = prev.find((p) => p.key === item.key);
    return same ? prev.map((p) => p.key === item.key ? { ...p, quantity: Math.min(99, p.quantity + item.quantity) } : p) : [...prev, item];
  }), [update]);
  const setQty = useCallback((key: string, q: number) => update((prev) =>
    q <= 0 ? prev.filter((p) => p.key !== key) : prev.map((p) => p.key === key ? { ...p, quantity: Math.min(99, q) } : p)), [update]);
  const clear = useCallback(() => update(() => []), [update]);
  const total = items.reduce((s, i) => s + i.unit_price_cents * i.quantity, 0);
  const count = items.reduce((s, i) => s + i.quantity, 0);
  return { items, ready, add, setQty, clear, total, count };
}

/** Espelha a regra do servidor (compute_order) para exibir o preço. */
export function groupPrice(g: StoreGroup, selected: Record<string, number>): number {
  const prices: number[] = [];
  for (const o of g.options) for (let i = 0; i < (selected[o.id] ?? 0); i++) prices.push(o.price_cents);
  if (!prices.length) return 0;
  if (g.price_rule === "max") return Math.max(...prices);
  if (g.price_rule === "avg") return Math.ceil(prices.reduce((a, b) => a + b, 0) / prices.length);
  return prices.reduce((a, b) => a + b, 0);
}

export const effectivePrice = (p: { price_cents: number; promo_price_cents: number | null }) =>
  p.promo_price_cents ?? p.price_cents;
