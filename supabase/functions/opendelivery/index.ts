// Domma Food · Integração Open Delivery (Abrasel v1.7) — 99Food, Keeta, aiqfome e outros.
// Papel: SOFTWARE SERVICE.
//   GET  /opendelivery/m/{merchantId}/v1/merchant      → dados da loja + cardápio (X-API-KEY)
//   POST /opendelivery/m/{merchantId}/v1/newEvent      → webhook de eventos (X-App-Signature, HMAC-SHA256)
//   POST /opendelivery/worker   {job: outbox|poll|all} → fila de saída + polling (x-worker-secret)
//   POST /opendelivery/test     {connection_id}        → testa credenciais (JWT do lojista)
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.119.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

type Conn = {
  id: string; tenant_id: string; unit_id: string; provider: string; merchant_id: string; app_id: string | null;
  client_id: string | null; auth_base_url: string | null; api_base_url: string | null; merchant_api_key_hash: string | null;
  polling_enabled: boolean; active: boolean;
};

const json = (body: unknown, status = 200, extra: HeadersInit = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...extra } });
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

// ---------------- util ----------------
const enc = new TextEncoder();
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
async function sha256Hex(s: string) { return hex(await crypto.subtle.digest("SHA-256", enc.encode(s))); }
async function hmacHex(secret: string, body: string) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(body)));
}
function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
// Bloqueia URLs internas (proteção contra SSRF)
function assertPublicHttps(u: string) {
  const url = new URL(u);
  const h = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || h === "localhost" || h.endsWith(".internal") || h.endsWith(".local") ||
      /^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h) || h.includes(":")) {
    throw new Error("URL do marketplace inválida");
  }
  return url;
}

// ---------------- OAuth2 client_credentials (cache por conexão) ----------------
const tokens = new Map<string, { token: string; exp: number }>();
async function getToken(c: Conn): Promise<string> {
  const cached = tokens.get(c.id);
  if (cached && cached.exp > Date.now() + 30_000) return cached.token;
  const { data: secret, error } = await admin.rpc("od_connection_secret", { p_connection_id: c.id });
  if (error || !secret || !c.client_id) throw new Error("Credenciais incompletas");
  const base = assertPublicHttps(c.auth_base_url || c.api_base_url!);
  const res = await fetch(new URL("oauth/token", base.href.endsWith("/") ? base : base.href + "/"), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: c.client_id, client_secret: secret as string, grant_type: "client_credentials" }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Autenticação recusada pelo marketplace (HTTP ${res.status})`);
  const t = await res.json();
  tokens.set(c.id, { token: t.access_token, exp: Date.now() + (Number(t.expires_in) || 3600) * 1000 });
  return t.access_token;
}

async function odFetch(c: Conn, path: string, init: RequestInit = {}) {
  const base = assertPublicHttps(c.api_base_url!);
  const url = base.href.replace(/\/$/, "") + path;
  const doFetch = async () => fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${await getToken(c)}`, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(15_000),
  });
  let res = await doFetch();
  if (res.status === 401) { tokens.delete(c.id); res = await doFetch(); }
  return res;
}

async function setError(c: Conn, msg: string | null) {
  await admin.from("marketplace_connections").update({ last_error: msg ? msg.slice(0, 500) : null, last_sync_at: new Date().toISOString() }).eq("id", c.id);
}

// ---------------- Eventos (webhook e polling) ----------------
type ODEvent = { eventId: string; eventType: string; orderId: string; orderURL?: string; createdAt?: string };

async function handleEvent(c: Conn, ev: ODEvent, source: "webhook" | "polling") {
  const { error: insErr } = await admin.from("marketplace_events").insert({
    tenant_id: c.tenant_id, connection_id: c.id, event_id: ev.eventId, event_type: ev.eventType,
    external_order_id: ev.orderId, payload: ev, source,
  });
  if (insErr) {
    if (insErr.code === "23505") return; // evento repetido: idempotente
    throw insErr;
  }
  try {
    const { data: existing } = await admin.from("orders").select("id").eq("connection_id", c.id).eq("external_id", ev.orderId).maybeSingle();
    if (!existing) {
      // Busca o pedido completo pela API do marketplace (nunca pela URL enviada sem validação)
      const res = await odFetch(c, `/v1/orders/${encodeURIComponent(ev.orderId)}`);
      if (!res.ok) throw new Error(`Não foi possível obter o pedido ${ev.orderId} (HTTP ${res.status})`);
      const order = await res.json();
      const { error } = await admin.rpc("od_ingest_order", { p_connection_id: c.id, o: order });
      if (error) throw error;
    }
    if (ev.eventType !== "CREATED") {
      const { error } = await admin.rpc("od_apply_event", { p_connection_id: c.id, p_external_id: ev.orderId, p_event: ev.eventType });
      if (error) throw error;
    }
    await admin.from("marketplace_events").update({ processed_at: new Date().toISOString() })
      .eq("connection_id", c.id).eq("event_id", ev.eventId);
    await setError(c, null);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await admin.from("marketplace_events").update({ error: msg.slice(0, 500) }).eq("connection_id", c.id).eq("event_id", ev.eventId);
    await setError(c, msg);
    throw e;
  }
}

async function loadConn(merchantId: string): Promise<Conn | null> {
  const { data } = await admin.from("marketplace_connections").select("*").eq("merchant_id", merchantId).maybeSingle();
  return data as Conn | null;
}

async function webhook(req: Request, merchantId: string) {
  const c = await loadConn(merchantId);
  if (!c || !c.active) return json({ title: "Not found" }, 404);
  const raw = await req.text();
  if (raw.length > 1_000_000) return json({ title: "Payload too large" }, 413);
  const sig = (req.headers.get("x-app-signature") ?? "").toLowerCase();
  const { data: secret } = await admin.rpc("od_connection_secret", { p_connection_id: c.id });
  if (!secret || !sig || !safeEqual(sig, await hmacHex(secret as string, raw))) return json({ title: "Invalid signature" }, 403);
  if ((req.headers.get("x-app-merchantid") ?? merchantId) !== merchantId) return json({ title: "Merchant mismatch" }, 403);
  if (c.app_id && req.headers.get("x-app-id") && req.headers.get("x-app-id") !== c.app_id) return json({ title: "App mismatch" }, 403);
  let ev: ODEvent;
  try { ev = JSON.parse(raw); } catch { return json({ title: "Invalid JSON" }, 400); }
  if (!ev?.eventId || !ev?.eventType || !ev?.orderId) return json({ title: "Invalid event" }, 400);
  try { await handleEvent(c, ev, "webhook"); }
  catch { /* registrado; o polling e o marketplace (reenvio) tentam de novo */ return json({ title: "Temporary failure" }, 503); }
  return new Response(null, { status: 204 });
}

async function poll(c: Conn) {
  const res = await odFetch(c, "/v1/events:polling");
  if (res.status === 204) { await setError(c, null); return 0; }
  if (!res.ok) throw new Error(`Polling falhou (HTTP ${res.status})`);
  const events: ODEvent[] = await res.json();
  const acks: { id: string; orderId: string; eventType: string }[] = [];
  for (const ev of events ?? []) {
    try { await handleEvent(c, ev, "polling"); acks.push({ id: ev.eventId, orderId: ev.orderId, eventType: ev.eventType }); }
    catch { /* não confirma: volta no próximo polling */ }
  }
  for (let i = 0; i < acks.length; i += 100) {
    await odFetch(c, "/v1/events/acknowledgment", { method: "POST", body: JSON.stringify(acks.slice(i, i + 100)) });
  }
  await setError(c, null);
  return acks.length;
}

// ---------------- Fila de saída (status -> marketplace) ----------------
async function processOutbox() {
  const { data: jobs } = await admin.from("integration_outbox")
    .select("*, orders(external_id), marketplace_connections!inner(*)")
    .neq("marketplace_connections.provider", "ifood")   // iFood tem worker próprio
    .is("done_at", null).lte("next_attempt_at", new Date().toISOString()).lt("attempts", 12)
    .order("id").limit(50);
  let ok = 0;
  for (const j of jobs ?? []) {
    const c = j.marketplace_connections as Conn;
    const ext = (j.orders as { external_id: string } | null)?.external_id;
    try {
      if (!c?.active || !ext) throw new Error("Conexão inativa ou pedido sem ID externo");
      const res = await odFetch(c, `/v1/orders/${encodeURIComponent(ext)}/${j.action}`, {
        method: "POST", body: JSON.stringify(j.payload ?? {}),
      });
      if (!res.ok && res.status !== 409) throw new Error(`${j.action} recusado (HTTP ${res.status}): ${(await res.text()).slice(0, 200)}`);
      await admin.from("integration_outbox").update({ done_at: new Date().toISOString(), attempts: j.attempts + 1, last_error: null }).eq("id", j.id);
      ok++;
    } catch (e) {
      const attempts = j.attempts + 1;
      const backoff = Math.min(60 * 2 ** attempts, 3600); // 2 min, 4 min ... até 1 h
      const msg = e instanceof Error ? e.message : String(e);
      await admin.from("integration_outbox").update({
        attempts, last_error: msg.slice(0, 500), next_attempt_at: new Date(Date.now() + backoff * 1000).toISOString(),
      }).eq("id", j.id);
      if (c) await setError(c, msg);
    }
  }
  return ok;
}

// ---------------- GET /merchant (cardápio no formato Open Delivery) ----------------
const DAYS = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"];
const KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const price = (cents: number) => ({ value: Math.round(cents) / 100, currency: "BRL" });

async function merchant(req: Request, merchantId: string) {
  const c = await loadConn(merchantId);
  if (!c) return json({ title: "Not found" }, 404);
  const key = req.headers.get("x-api-key") ?? "";
  if (!c.merchant_api_key_hash || !key || !safeEqual(await sha256Hex(key), c.merchant_api_key_hash)) {
    return json({ title: "Unauthorized" }, 401);
  }
  const [{ data: u }, { data: t }, { data: cats }, { data: prods }, { data: groups }, { data: opts }, { data: links }, { data: zones }] = await Promise.all([
    admin.from("units").select("*").eq("id", c.unit_id).single(),
    admin.from("tenants").select("name, cnpj, status").eq("id", c.tenant_id).single(),
    admin.from("categories").select("*").eq("tenant_id", c.tenant_id).order("position"),
    admin.from("products").select("*").eq("tenant_id", c.tenant_id).eq("active", true).order("position"),
    admin.from("option_groups").select("*").eq("tenant_id", c.tenant_id),
    admin.from("options").select("*").eq("tenant_id", c.tenant_id).order("position"),
    admin.from("product_option_groups").select("*").eq("tenant_id", c.tenant_id).order("position"),
    admin.from("delivery_zones").select("*").eq("unit_id", c.unit_id).eq("active", true),
  ]);
  if (!u || !t) return json({ title: "Not found" }, 404);
  const now = Date.now();
  const hours = KEYS.flatMap((k, i) => ((u.opening_hours?.[k] ?? []) as [string, string][]).map(([s, e]) => ({
    dayOfWeek: [DAYS[i]], timePeriods: { startTime: `${s}:00.000Z`, endTime: `${e === "00:00" ? "23:59" : e}:00.000Z` },
  })));
  const catAvail = (cat: Record<string, unknown>) => cat.available_days || cat.available_from ? [`av-${cat.id}`] : [];
  const usedGroups = new Set((links ?? []).map((l) => l.group_id));
  const body = {
    lastUpdate: new Date().toISOString(),
    TTL: 300,
    id: c.merchant_id,
    status: t.status === "suspended" || !u.active ? "UNAVAILABLE" : "AVAILABLE",
    basicInfo: {
      name: u.name, document: t.cnpj ?? "", corporateName: t.name, description: u.description ?? u.name,
      averagePreparationTime: u.prep_time_min, minOrderValue: price(u.min_order_cents),
      merchantType: "RESTAURANT", merchantCategories: ["OTHER"],
      address: { country: "BR", state: u.state ?? "", city: u.city ?? "", district: u.neighborhood ?? "", street: u.street ?? "",
        number: u.number ?? "", postalCode: (u.zip ?? "").replace(/\D/g, ""), complement: u.complement ?? "",
        latitude: u.lat ?? 0, longitude: u.lng ?? 0 },
      contactEmails: [], contactPhones: { commercialNumber: u.phone ?? u.whatsapp ?? "", whatsappNumber: u.whatsapp ?? undefined },
      logoImage: { URL: u.logo_url ?? "" }, bannerImage: u.cover_url ? { URL: u.cover_url } : undefined,
    },
    services: [
      ...(u.accepts_delivery ? [{ id: `svc-delivery-${u.id}`, status: "AVAILABLE", serviceType: "DELIVERY", menuId: `menu-${u.id}`,
        serviceArea: { id: `area-${u.id}`, geoRadius: u.lat ? { geoMidpointLatitude: u.lat, geoMidpointLongitude: u.lng,
          radius: (zones ?? []).filter((z) => z.kind === "radius").map((z) => ({ size: Number(z.radius_km) * 1000,
            price: price(z.fee_cents), estimateDeliveryTime: z.eta_min })) } : undefined },
        serviceHours: { id: `hours-${u.id}`, weekHours: hours } }] : []),
      ...(u.accepts_pickup ? [{ id: `svc-takeout-${u.id}`, status: "AVAILABLE", serviceType: "TAKEOUT", menuId: `menu-${u.id}`,
        serviceHours: { id: `hours-${u.id}`, weekHours: hours } }] : []),
    ],
    menus: [{ id: `menu-${u.id}`, name: "Cardápio", externalCode: `menu-${u.id}`, categoryId: (cats ?? []).map((x) => x.id) }],
    categories: (cats ?? []).map((cat) => ({
      id: cat.id, index: cat.position, name: cat.name, description: cat.description ?? undefined, externalCode: cat.id,
      status: cat.active ? "AVAILABLE" : "UNAVAILABLE", availabilityId: catAvail(cat),
      itemOfferId: (prods ?? []).filter((p) => p.category_id === cat.id).map((p) => `offer-${p.id}`),
    })),
    itemOffers: (prods ?? []).map((p, i) => ({
      id: `offer-${p.id}`, itemId: p.id, index: i,
      status: p.paused_until && new Date(p.paused_until).getTime() > now ? "UNAVAILABLE" : "AVAILABLE",
      price: { value: (p.promo_price_cents ?? p.price_cents) / 100, originalValue: p.price_cents / 100, currency: "BRL" },
      optionGroupsId: (links ?? []).filter((l) => l.product_id === p.id).map((l) => l.group_id),
    })),
    items: [
      ...(prods ?? []).map((p) => ({ id: p.id, name: p.name, description: p.description ?? p.name, externalCode: p.id,
        status: "AVAILABLE", unit: "UN", ean: p.barcode ?? undefined, image: p.image_url ? { URL: p.image_url } : undefined })),
      ...(opts ?? []).filter((o) => usedGroups.has(o.group_id)).map((o) => ({ id: `opt-${o.id}`, name: o.name,
        description: o.description ?? o.name, externalCode: o.id, status: o.active ? "AVAILABLE" : "UNAVAILABLE", unit: "UN" })),
    ],
    optionGroups: (groups ?? []).filter((g) => usedGroups.has(g.id)).map((g, i) => ({
      id: g.id, index: i, name: g.name, externalCode: g.id, status: "AVAILABLE",
      minPermitted: g.min_select, maxPermitted: g.max_select, priceMethod: String(g.price_rule).toUpperCase(),
      options: (opts ?? []).filter((o) => o.group_id === g.id).map((o, j) => ({
        id: o.id, itemId: `opt-${o.id}`, index: j, status: o.active ? "AVAILABLE" : "UNAVAILABLE",
        price: { value: o.price_cents / 100, originalValue: o.price_cents / 100, currency: "BRL" },
        maxPermitted: g.allow_repeat ? g.max_select : 1,
      })),
    })),
    availabilities: (cats ?? []).filter((cat) => cat.available_days || cat.available_from).map((cat) => ({
      id: `av-${cat.id}`,
      hours: [{ dayOfWeek: ((cat.available_days ?? [0, 1, 2, 3, 4, 5, 6]) as number[]).map((d) => DAYS[d]),
        timePeriods: { startTime: `${(cat.available_from ?? "00:00").slice(0, 5)}:00.000Z`, endTime: `${(cat.available_to ?? "23:59").slice(0, 5)}:00.000Z` } }],
    })),
  };
  return json(body, 200, { "Cache-Control": "no-store" });
}

// ---------------- Teste de conexão (chamado pelo painel) ----------------
async function testConnection(req: Request) {
  const auth = req.headers.get("authorization") ?? "";
  const userClient: SupabaseClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: auth } } });
  const { connection_id } = await req.json().catch(() => ({}));
  // RLS garante que só gestores da própria loja enxergam a conexão
  const { data: c } = await userClient.from("marketplace_connections").select("*").eq("id", connection_id).maybeSingle();
  if (!c) return json({ ok: false, error: "Conexão não encontrada" }, 404, CORS);
  try {
    tokens.delete(c.id);
    await getToken(c as Conn);
    await setError(c as Conn, null);
    return json({ ok: true }, 200, CORS);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await setError(c as Conn, msg);
    return json({ ok: false, error: msg }, 200, CORS);
  }
}

// ---------------- Roteador ----------------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const path = new URL(req.url).pathname.replace(/^.*\/opendelivery/, "");
  try {
    let m = path.match(/^\/m\/([A-Za-z0-9._-]{8,120})\/(?:v1\/)?merchant$/);
    if (m && req.method === "GET") return await merchant(req, m[1]);
    m = path.match(/^\/m\/([A-Za-z0-9._-]{8,120})\/(?:v1\/)?(?:newEvent|orderUpdate)$/);
    if (m && req.method === "POST") return await webhook(req, m[1]);
    if (path === "/test" && req.method === "POST") return await testConnection(req);
    if (path === "/worker" && req.method === "POST") {
      const s = req.headers.get("x-worker-secret") ?? "";
      const { data: expected } = await admin.rpc("od_worker_secret");
      if (!expected || !s || !safeEqual(s, expected as string)) return json({ title: "Forbidden" }, 403);
      const { job = "all" } = await req.json().catch(() => ({}));
      const out: Record<string, number> = {};
      if (job === "outbox" || job === "all") out.sent = await processOutbox();
      if (job === "poll" || job === "all") {
        const { data: conns } = await admin.from("marketplace_connections").select("*").eq("active", true).eq("polling_enabled", true).neq("provider", "ifood");
        let n = 0;
        for (const c of (conns ?? []) as Conn[]) { try { n += await poll(c); } catch (e) { await setError(c, e instanceof Error ? e.message : String(e)); } }
        out.received = n;
      }
      return json(out);
    }
    return json({ title: "Not found" }, 404);
  } catch (e) {
    console.error(e);
    return json({ title: "Internal error" }, 500);
  }
});
