"use client";
import { supabaseBrowser } from "@/lib/supabase/client";

/** Registra o service worker (avisos do pedido e página sem internet). */
export async function registerSW(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return null;
  try { return await navigator.serviceWorker.register("/sw.js", { scope: "/" }); } catch { return null; }
}

export const isStandalone = () =>
  typeof window !== "undefined" && (window.matchMedia?.("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true);
export const isIOS = () => typeof navigator !== "undefined" && /iphone|ipad|ipod/i.test(navigator.userAgent) && !/crios|fxios/i.test(navigator.userAgent);
export const pushSupported = () =>
  typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

function keyBytes(b64: string): Uint8Array<ArrayBuffer> {
  const t = b64.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(t + "===".slice((t.length + 3) % 4));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function publicKey(): Promise<string | null> {
  const { data } = await supabaseBrowser().rpc("push_public_key");
  if (data) return data as string;
  try {
    const r = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/push/key`);
    return r.ok ? ((await r.json()) as { public_key: string }).public_key : null;
  } catch { return null; }
}

async function currentSubscription(): Promise<PushSubscription | null> {
  const reg = await registerSW();
  return reg ? await reg.pushManager.getSubscription() : null;
}

/** Avisos deste pedido estão ligados neste aparelho? */
export async function pushIsOn(token: string): Promise<boolean> {
  if (!pushSupported() || Notification.permission !== "granted") return false;
  const sub = await currentSubscription();
  if (!sub) return false;
  const { data } = await supabaseBrowser().rpc("push_is_on", { p_token: token, p_endpoint: sub.endpoint });
  return data === true;
}

/** Pede permissão, assina o push e vincula ao pedido. Devolve uma mensagem de erro ou null. */
export async function enablePush(token: string): Promise<string | null> {
  if (!pushSupported()) return "Este navegador não recebe notificações.";
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return "Você não permitiu as notificações. Dá para liberar nas configurações do navegador.";
  const reg = await registerSW();
  if (!reg) return "Não foi possível ativar os avisos neste navegador.";
  await navigator.serviceWorker.ready;
  const key = await publicKey();
  if (!key) return "Os avisos estão indisponíveis agora. Tente de novo em instantes.";
  let sub = await reg.pushManager.getSubscription();
  try {
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) });
  } catch {
    return "Não foi possível ativar os avisos neste navegador.";
  }
  const j = sub.toJSON() as { endpoint: string; keys?: { p256dh?: string; auth?: string } };
  const { error } = await supabaseBrowser().rpc("push_subscribe", {
    p_token: token, p_endpoint: j.endpoint, p_p256dh: j.keys?.p256dh ?? "", p_auth: j.keys?.auth ?? "",
  });
  return error ? error.message : null;
}

export async function disablePush(token: string) {
  const sub = await currentSubscription();
  if (sub) await supabaseBrowser().rpc("push_unsubscribe", { p_token: token, p_endpoint: sub.endpoint });
}

// ---------- Pedidos guardados neste aparelho (para "pedir de novo") ----------
const ordersKey = (slug: string) => `df_orders_${slug}`;
export function savedOrderTokens(slug: string): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(ordersKey(slug)) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(0, 20) : [];
  } catch { return []; }
}
export function rememberOrder(slug: string, token: string) {
  try {
    const list = [token, ...savedOrderTokens(slug).filter((t) => t !== token)].slice(0, 20);
    localStorage.setItem(ordersKey(slug), JSON.stringify(list));
  } catch { /* armazenamento indisponível */ }
}
