"use client";
// Rastreamento do cardápio: Pixel do Meta, Google Analytics 4 / Google Ads (só com consentimento)
// e o funil próprio do Domma (anônimo, sem cookies).
import { supabaseBrowser } from "@/lib/supabase/client";

export type Tracking = { meta_pixel_id: string | null; ga4_id: string | null; ads_id: string | null; ads_label: string | null };
export type Consent = "granted" | "denied";
export type TrackItem = { id: string; name: string; price_cents: number; quantity: number };

const CONSENT_KEY = "df_consent_v1";
const SID_KEY = "df_sid";
const SRC_KEY = "df_src";

type W = Window & {
  fbq?: ((...a: unknown[]) => void) & { callMethod?: (...a: unknown[]) => void; queue?: unknown[]; loaded?: boolean; version?: string; push?: unknown };
  _fbq?: unknown;
  dataLayer?: unknown[];
  gtag?: (...a: unknown[]) => void;
};
const w = () => (typeof window === "undefined" ? null : (window as W));

export function getConsent(): Consent | null {
  try { const v = localStorage.getItem(CONSENT_KEY); return v === "granted" || v === "denied" ? v : null; } catch { return null; }
}
export function setConsent(v: Consent) {
  try { localStorage.setItem(CONSENT_KEY, v); } catch { /* armazenamento indisponível */ }
  window.dispatchEvent(new Event("df-consent"));
}

const has = (t: Tracking | null | undefined): t is Tracking => !!t && !!(t.meta_pixel_id || t.ga4_id || t.ads_id);
export const hasTracking = has;

let loaded = "";
/** Carrega Pixel/gtag uma vez por página, só se o cliente aceitou. */
export function loadTrackers(t: Tracking | null | undefined) {
  const win = w();
  if (!win || !has(t) || getConsent() !== "granted") return false;
  const sig = [t.meta_pixel_id, t.ga4_id, t.ads_id].join("|");
  if (loaded === sig) return true;
  loaded = sig;
  if (t.meta_pixel_id && /^[0-9]{8,20}$/.test(t.meta_pixel_id) && !win.fbq) {
    const f = function (...a: unknown[]) { if (f.callMethod) f.callMethod(...a); else f.queue!.push(a); } as NonNullable<W["fbq"]>;
    f.push = f; f.loaded = true; f.version = "2.0"; f.queue = [];
    win.fbq = f; win._fbq = f;
    addScript("https://connect.facebook.net/en_US/fbevents.js");
    win.fbq("init", t.meta_pixel_id);
    win.fbq("track", "PageView");
  }
  const gIds = [t.ga4_id, t.ads_id].filter((x): x is string => !!x && /^(G|AW)-[A-Z0-9]{4,16}$/.test(x));
  if (gIds.length && !win.gtag) {
    win.dataLayer = win.dataLayer || [];
    // eslint-disable-next-line prefer-rest-params
    win.gtag = function () { win.dataLayer!.push(arguments); };
    win.gtag("js", new Date());
    for (const id of gIds) win.gtag("config", id);
    addScript(`https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(gIds[0])}`);
  }
  return true;
}
function addScript(src: string) {
  const s = document.createElement("script");
  s.async = true; s.src = src;
  document.head.appendChild(s);
}

const ga = (items: TrackItem[]) => items.map((i) => ({ item_id: i.id, item_name: i.name, price: i.price_cents / 100, quantity: i.quantity }));
const fb = (items: TrackItem[]) => ({ content_ids: items.map((i) => i.id), content_type: "product", contents: items.map((i) => ({ id: i.id, quantity: i.quantity })) });
const sum = (items: TrackItem[]) => items.reduce((s, i) => s + i.price_cents * i.quantity, 0) / 100;

type Ev =
  | { name: "view_item"; items: TrackItem[] }
  | { name: "add_to_cart"; items: TrackItem[] }
  | { name: "begin_checkout"; items: TrackItem[] }
  | { name: "purchase"; items: TrackItem[]; value_cents: number; order_id: string };

/** Envia o evento para as ferramentas da loja (se carregadas). */
export function trackEvent(t: Tracking | null | undefined, e: Ev) {
  const win = w();
  if (!win || !has(t) || getConsent() !== "granted") return;
  const value = e.name === "purchase" ? e.value_cents / 100 : sum(e.items);
  const fbName = { view_item: "ViewContent", add_to_cart: "AddToCart", begin_checkout: "InitiateCheckout", purchase: "Purchase" }[e.name];
  try {
    win.fbq?.("track", fbName, { ...fb(e.items), value, currency: "BRL", ...(e.name === "begin_checkout" ? { num_items: e.items.reduce((s, i) => s + i.quantity, 0) } : {}) },
      e.name === "purchase" ? { eventID: `order-${e.order_id}` } : undefined);
  } catch { /* ignora */ }
  try {
    win.gtag?.("event", e.name, { currency: "BRL", value, items: ga(e.items), ...(e.name === "purchase" ? { transaction_id: e.order_id } : {}) });
    if (e.name === "purchase" && t.ads_id && t.ads_label) {
      win.gtag?.("event", "conversion", { send_to: `${t.ads_id}/${t.ads_label}`, value, currency: "BRL", transaction_id: e.order_id });
    }
  } catch { /* ignora */ }
}

// ---------- Funil do Domma (anônimo) ----------
function sid() {
  try {
    let v = sessionStorage.getItem(SID_KEY);
    if (!v) { v = crypto.randomUUID(); sessionStorage.setItem(SID_KEY, v); }
    return v;
  } catch { return null; }
}
/** Origem do tráfego: utm_source, ou o site que trouxe o cliente; guardada na sessão. */
function source() {
  try {
    const cur = sessionStorage.getItem(SRC_KEY);
    if (cur) return cur;
    const p = new URLSearchParams(location.search);
    let s = p.get("utm_source") || (p.get("fbclid") ? "facebook" : p.get("gclid") ? "google" : "");
    if (!s && document.referrer) {
      try {
        const h = new URL(document.referrer).hostname.replace(/^(www|m|l|lm)\./, "");
        if (h !== location.hostname) s = h.split(".")[0];
      } catch { /* ignora */ }
    }
    s = (s || "direto").toLowerCase().replace(/[^a-z0-9._-]/g, "").slice(0, 40) || "direto";
    sessionStorage.setItem(SRC_KEY, s);
    return s;
  } catch { return "direto"; }
}
export type Step = "visit" | "view_item" | "add_to_cart" | "checkout" | "order";
const sent = new Set<string>();
export function funnel(slug: string, step: Step, valueCents?: number) {
  const s = sid();
  if (!s || sent.has(slug + step)) return;
  sent.add(slug + step);
  const src = source();
  void supabaseBrowser().rpc("funnel_track", { p_slug: slug, p_sid: s, p_step: step, p_source: src, p_value_cents: valueCents ?? null })
    .then(() => undefined, () => undefined);
}

