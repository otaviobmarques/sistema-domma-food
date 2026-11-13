"use client";
import { supabaseBrowser } from "@/lib/supabase/client";
import type { CartItem } from "@/components/store/types";

const tokenKey = (slug: string) => `df_cart_token_${slug}`;
export const couponKey = (slug: string) => `df_coupon_${slug}`;

/** Identificador aleatório da sacola atual neste aparelho (vira o link do lembrete). */
export function cartToken(slug: string): string {
  try {
    const t = localStorage.getItem(tokenKey(slug));
    if (t && /^[a-f0-9]{32}$/.test(t)) return t;
    const b = crypto.getRandomValues(new Uint8Array(16));
    const v = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
    localStorage.setItem(tokenKey(slug), v);
    return v;
  } catch { return ""; }
}
export function clearCartToken(slug: string) {
  try { localStorage.removeItem(tokenKey(slug)); } catch { /* ignora */ }
}

/** Assinatura de notificações que este aparelho já tem (não pede permissão). */
async function existingPushEndpoint(): Promise<string | null> {
  try {
    if (!("serviceWorker" in navigator) || typeof Notification === "undefined" || Notification.permission !== "granted") return null;
    const reg = await navigator.serviceWorker.getRegistration("/");
    return (await reg?.pushManager.getSubscription())?.endpoint ?? null;
  } catch { return null; }
}

export async function snapshotCart(slug: string, d: {
  name: string; phone: string; optIn: boolean; deviceToken: string | null; items: CartItem[]; subtotal: number;
}) {
  const token = cartToken(slug);
  if (!token) return;
  await supabaseBrowser().rpc("cart_snapshot", {
    p_slug: slug, p_token: token,
    p: {
      name: d.name, phone: d.phone, opt_in: d.optIn, device_token: d.deviceToken, subtotal_cents: d.subtotal,
      push_endpoint: d.optIn ? await existingPushEndpoint() : null,
      items: d.items.map((i) => ({ product_id: i.product_id, quantity: i.quantity, notes: i.notes || null,
        options: i.options.map((o) => ({ option_id: o.option_id, name: o.name, quantity: o.quantity })) })),
    },
  });
}
