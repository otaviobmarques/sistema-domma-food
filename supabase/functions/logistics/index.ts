// Domma Food · Logística sob demanda (Foody Delivery, padrão Open Delivery Logistics)
//   POST /logistics/quote   {order_id, address?}  → preço e prazo (equipe da loja)
//   POST /logistics/request {order_id, address?}  → chama o entregador
//   POST /logistics/cancel  {order_id, reason?}   → cancela a entrega
//   POST /logistics/test    {unit_id}             → testa a credencial (dono/gerência)
//   POST /logistics/webhook?h=<token>             → eventos da Foody (X-App-Signature HMAC-SHA256 com o clientSecret)
// A Entrega iFood fica na função ifood (/ifood/shipping/*), que já cuida do token do iFood.
import { createClient } from "npm:@supabase/supabase-js@2.119.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json", ...CORS } });
const UUID = /^[0-9a-f-]{36}$/;
const enc = new TextEncoder();
async function hmacHex(secret: string, msg: string) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(msg)))].map((x) => x.toString(16).padStart(2, "0")).join("");
}
function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
const userClient = (req: Request) => createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } }, auth: { persistSession: false } });

type Foody = { base_url: string; client_id: string; client_secret: string; token: { access_token: string; expires_at: number } | null };
type Ctx = {
  order: { id: string; number: number; type: string; status: string; created_at: string; customer_name: string; customer_phone: string;
    address: Record<string, unknown> | null; delivery_fee_cents: number; total_cents: number; payment_method: string; payment_status: string;
    change_for_cents: number | null; notes: string | null };
  items: { name: string; quantity: number }[];
  unit: { id: string; name: string; street: string | null; number: string | null; complement: string | null; neighborhood: string | null;
    city: string | null; state: string | null; zip: string | null; lat: number | null; lng: number | null; prep_time_min: number };
  return_to_merchant: boolean;
  foody: Foody | null;
  active: { id: string; provider: string; external_id: string; status: string } | null;
};
type Override = { postal_code?: string; lat?: number; lng?: number };

async function token(unitId: string, f: Foody, force = false) {
  if (!force && f.token?.access_token && f.token.expires_at > Date.now() + 120_000) return f.token.access_token;
  let res: Response;
  try {
    res = await fetch(`${f.base_url}/oauth/token`, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: f.client_id, client_secret: f.client_secret }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error("Não foi possível conectar à Foody. Confira o baseUrl da credencial.");
  }
  const d = await res.json().catch(() => ({})) as { access_token?: string; expires_in?: number };
  if (!res.ok || !d.access_token) throw new Error(res.status === 401 || res.status === 400 ? "A Foody recusou a credencial (confira clientId e clientSecret)." : `A Foody não respondeu ao login (${res.status}).`);
  // a Foody devolve expires_in como data em milissegundos; o padrão Open Delivery, em segundos
  const e = Number(d.expires_in ?? 0);
  const expires_at = e > 1e12 ? e : e > 0 ? Date.now() + e * 1000 : Date.now() + 6 * 3600_000;
  await admin.rpc("logistics_save_foody_token", { p_unit_id: unitId, p_token: { access_token: d.access_token, expires_at: Math.min(expires_at, Date.now() + 6 * 3600_000) } });
  return d.access_token;
}
async function od(unitId: string, f: Foody, path: string, body: unknown) {
  let t = await token(unitId, f);
  for (let attempt = 0; attempt < 2; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${f.base_url}${path}`, { method: "POST",
        headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}), signal: AbortSignal.timeout(20_000) });
    } catch {
      throw new Error("A Foody não respondeu. Tente de novo em instantes.");
    }
    if (res.status === 401 && attempt === 0) { t = await token(unitId, f, true); continue; }
    let data: Record<string, unknown> = {};
    try { data = await res.json(); } catch { /* vazio */ }
    return { http: res.status, data };
  }
  return { http: 401, data: {} };
}
const odErr = (d: Record<string, unknown>) => String((d.title ?? d.message ?? (d.error as { message?: string })?.message ?? "") || "").slice(0, 200);

const brl = (cents: number) => ({ value: Math.round(cents) / 100, currency: "BRL" });
const digits = (s: unknown) => String(s ?? "").replace(/\D/g, "");
function addr(a: Record<string, unknown>, extra: Override, fallbackState: string | null) {
  const lat = extra.lat ?? (typeof a.lat === "number" ? a.lat : undefined);
  const lng = extra.lng ?? (typeof a.lng === "number" ? a.lng : undefined);
  return {
    country: "BR", state: String(a.state ?? fallbackState ?? "").slice(0, 2).toUpperCase(), city: String(a.city ?? ""),
    district: String(a.neighborhood ?? ""), street: String(a.street ?? ""), number: String(a.number ?? "S/N") || "S/N",
    postalCode: digits(extra.postal_code ?? a.postal_code ?? a.zip ?? ""), complement: String(a.complement ?? ""),
    ...(a.reference ? { reference: String(a.reference) } : {}),
    ...(lat != null && lng != null ? { latitude: lat, longitude: lng } : {}),
  };
}
function payments(o: Ctx["order"]) {
  const paid = o.payment_status === "paid" || o.payment_method === "online_card";
  if (paid) return { method: "ONLINE" };
  const type = ({ cash: "CASH", pix: "PIX", credit_card: "CREDIT", debit_card: "DEBIT", card_on_delivery: "CREDIT_DEBIT", voucher: "MEAL_VOUCHER" } as Record<string, string>)[o.payment_method] ?? "OTHER";
  return {
    method: "OFFLINE", wirelessPos: ["CREDIT", "DEBIT", "CREDIT_DEBIT", "MEAL_VOUCHER"].includes(type),
    offlineMethod: [{ type, amount: brl(o.total_cents) }],
    ...(type === "CASH" && o.change_for_cents ? { change: brl(o.change_for_cents) } : {}),
  };
}
function base(c: Ctx, extra: Override) {
  const u = c.unit;
  const pickup = addr({ street: u.street, number: u.number, complement: u.complement, neighborhood: u.neighborhood, city: u.city, state: u.state,
    zip: u.zip, lat: u.lat, lng: u.lng }, {}, u.state);
  return {
    merchant: { id: u.id, name: u.name },
    pickupAddress: pickup,
    returnToMerchant: c.return_to_merchant,
    canCombine: true,
    deliveryAddress: addr(c.order.address ?? {}, extra, u.state),
    vehicle: { type: ["MOTORBIKE_BAG", "MOTORBIKE_BOX"], container: "THERMIC" },
    limitTimes: { pickupLimit: Math.max(10, u.prep_time_min ?? 20) + 15, deliveryLimit: 90, orderCreatedAt: new Date(c.order.created_at).toISOString() },
    totalOrderPrice: brl(c.order.total_cents),
    orderDeliveryFee: brl(c.order.delivery_fee_cents ?? 0),
    totalWeight: 1000,
    packageQuantity: 1,
    onlinePayment: payments(c.order).method === "ONLINE",
  };
}

async function load(req: Request) {
  const b = await req.json().catch(() => ({}));
  if (typeof b.order_id !== "string" || !UUID.test(b.order_id)) return { error: json({ error: "Pedido inválido" }, 400) };
  const { data: can } = await userClient(req).rpc("logistics_can", { p_order_id: b.order_id });
  if (can !== true) return { error: json({ error: "Sem permissão para este pedido." }, 403) };
  const { data } = await admin.rpc("logistics_order_context", { p_order_id: b.order_id });
  const c = data as Ctx | null;
  if (!c) return { error: json({ error: "Pedido não encontrado." }, 404) };
  if (!c.foody) return { error: json({ error: "A Foody Delivery não está ligada nesta loja (Integrações › Logística)." }, 409) };
  if (c.order.type !== "delivery") return { error: json({ error: "Só pedidos de entrega podem chamar entregador." }, 409) };
  if (["cancelled", "completed", "awaiting_payment"].includes(c.order.status)) return { error: json({ error: "Este pedido não está em andamento." }, 409) };
  if (!c.unit.street || !c.unit.city || !c.unit.state) return { error: json({ error: "Cadastre o endereço da loja em Configurações antes de chamar entregador." }, 409) };
  const o: Override = {};
  if (b.address && typeof b.address === "object") {
    if (typeof b.address.postal_code === "string" && /^\d{8}$/.test(digits(b.address.postal_code))) o.postal_code = digits(b.address.postal_code);
    if (Number.isFinite(b.address.lat) && Number.isFinite(b.address.lng) && Math.abs(b.address.lat) <= 90 && Math.abs(b.address.lng) <= 180) { o.lat = b.address.lat; o.lng = b.address.lng; }
  }
  const { data: { user } } = await userClient(req).auth.getUser();
  return { b, c, o, uid: user?.id ?? null };
}

async function quote(req: Request) {
  const g = await load(req); if (g.error) return g.error;
  const r = await od(g.c.unit.id, g.c.foody!, "/v1/logistics/availability", base(g.c, g.o));
  if (r.http !== 200) return json({ error: `A Foody não cotou a entrega: ${odErr(r.data) || `erro ${r.http}`}` }, 502);
  const p = r.data as { deliveryPrice?: { price?: { value?: number } }; ETAs?: { pickupEtaInMinutes?: number; deliveryEtaInMinutes?: number; deliveryEtaDatetime?: string };
    vehicles?: { availableVehicles?: number; nextAvailableVehicle?: number } };
  return json({ ok: true, provider: "foody", price_cents: p.deliveryPrice?.price?.value != null ? Math.round(p.deliveryPrice.price.value * 100) : null,
    pickup_min: p.ETAs?.pickupEtaInMinutes ?? null, delivery_min: p.ETAs?.deliveryEtaInMinutes ?? null, delivery_at: p.ETAs?.deliveryEtaDatetime ?? null,
    available: p.vehicles?.availableVehicles ?? null });
}

async function request(req: Request) {
  const g = await load(req); if (g.error) return g.error;
  if (g.c.active) return json({ error: "Já existe um entregador solicitado para este pedido." }, 409);
  const c = g.c, o = c.order;
  const body = {
    ...base(c, g.o),
    orderId: o.id, orderDisplayId: String(o.number),
    notifyReadyForPickup: false, notifyPickup: false, notifyConclusion: false, confirmationCodeRequired: false,
    customerName: o.customer_name.slice(0, 100),
    ...(/^\d{10,13}$/.test(o.customer_phone) && !/^0+$/.test(o.customer_phone) ? { customerPhone: "+55" + o.customer_phone.replace(/^55/, "") } : {}),
    items: c.items.slice(0, 50).map((i) => ({ name: i.name.slice(0, 100), quantity: i.quantity })),
    payments: payments(o),
    ...(o.notes ? { specialInstructions: o.notes.slice(0, 200) } : {}),
    preparationStartDateTime: new Date().toISOString(),
  };
  delete (body as Record<string, unknown>).onlinePayment;
  const r = await od(c.unit.id, c.foody!, "/v1/logistics/delivery", body);
  if (r.http !== 202 && r.http !== 200) return json({ error: `A Foody recusou a entrega: ${odErr(r.data) || `erro ${r.http}`}` }, 502);
  const d = r.data as { deliveryId?: string; event?: string; deliveryDetailsURL?: string };
  // o webhook usa o orderId (nosso) para identificar a entrega; guardamos o nosso id como chave externa
  const { error } = await admin.rpc("logistics_record", { p_order_id: o.id, p_provider: "foody", p_external_id: o.id,
    p_status: d.event === "ACCEPTED" ? "accepted" : "pending", p_fee_cents: null, p_eta: null, p_tracking_url: null, p_actor: g.uid,
    p_error: null });
  if (error) return json({ error: error.message }, 409);
  return json({ ok: true, delivery_id: d.deliveryId ?? null });
}

const CANCEL = ["CONSUMER_CANCELLATION_REQUESTED", "NO_SHOW", "PROBLEM_AT_MERCHANT", "HIGH_ACCEPTANCE_TIME", "OTHER"];
async function cancel(req: Request) {
  const g = await load(req); if (g.error) return g.error;
  if (!g.c.active || g.c.active.provider !== "foody") return json({ error: "Não há entrega da Foody em andamento neste pedido." }, 409);
  const reason = CANCEL.includes(String(g.b.reason)) ? String(g.b.reason) : "OTHER";
  const r = await od(g.c.unit.id, g.c.foody!, `/v1/logistics/cancel/${encodeURIComponent(g.c.order.id)}`,
    { reason, action: g.c.active.status === "picked" || g.c.active.status === "in_transit" ? "RETURN_TO_STORE" : "CANCEL_DELIVERY",
      message: String(g.b.message ?? "Cancelado pela loja").slice(0, 200) });
  if (r.http >= 300) return json({ error: `A Foody não cancelou: ${odErr(r.data) || `erro ${r.http}`}` }, 502);
  await admin.rpc("logistics_event", { p_provider: "foody", p_external_id: g.c.active.external_id, p_code: "CANCELLATION_REQUESTED", p_payload: { message: "Pedido pela loja" } });
  return json({ ok: true });
}

async function test(req: Request) {
  const b = await req.json().catch(() => ({}));
  if (typeof b.unit_id !== "string" || !UUID.test(b.unit_id)) return json({ error: "Loja inválida" }, 400);
  const { data: can } = await userClient(req).rpc("logistics_unit_can_manage", { p_unit_id: b.unit_id });
  if (can !== true) return json({ error: "Só o dono ou a gerência." }, 403);
  const { data } = await admin.rpc("logistics_foody_context", { p_unit_id: b.unit_id });
  if (!data) return json({ ok: false, message: "Salve o baseUrl, o clientId e o clientSecret primeiro." });
  let ok = false, message = "";
  try { await token(b.unit_id, data as Foody, true); ok = true; message = "Credencial aceita pela Foody."; }
  catch (e) { message = (e as Error).message; }
  await admin.rpc("logistics_test_result", { p_unit_id: b.unit_id, p_ok: ok, p_message: message });
  return json({ ok, message });
}

async function webhook(req: Request) {
  const h = new URL(req.url).searchParams.get("h") ?? "";
  const { data: ctx } = await admin.rpc("logistics_hook_context", { p_hook: h });
  if (!ctx) return json({ error: "Gatilho desconhecido" }, 404);
  const raw = await req.text();
  let p: Record<string, unknown> = {};
  try { p = JSON.parse(raw); } catch { return json({ ok: true }); }
  if (p.event === "hook_test") return json({ ok: true });           // validação do gatilho na Foody
  const sig = (req.headers.get("x-app-signature") ?? "").toLowerCase().replace(/^sha256=/, "");
  const secret = String((ctx as { client_secret: string | null }).client_secret ?? "");
  // a URL já tem um token secreto por loja; quando a Foody assina (Open Delivery), conferimos também a assinatura
  if (sig && (!secret || !safeEqual(await hmacHex(secret, raw), sig))) return json({ error: "Assinatura inválida" }, 401);
  const orderId = String(p.orderId ?? "");
  const ev = p.event as { type?: string } | string | undefined;
  const code = typeof ev === "string" ? (p.status ? String(p.status) : ev) : ev?.type;
  if (!UUID.test(orderId) || !code) return json({ ok: true });
  // só aceita eventos de entregas desta loja (o token da URL é por loja)
  const { data: own } = await admin.from("external_deliveries").select("unit_id").eq("provider", "foody").eq("external_id", orderId).maybeSingle();
  if (!own || (own as { unit_id: string }).unit_id !== (ctx as { unit_id: string }).unit_id) return json({ ok: true });
  await admin.rpc("logistics_event", { p_provider: "foody", p_external_id: orderId, p_code: String(code).toUpperCase(), p_payload: p });
  return json({ ok: true });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "Método não permitido" }, 405);
  const path = new URL(req.url).pathname.replace(/^.*\/logistics/, "") || "/";
  try {
    if (path === "/webhook") return await webhook(req);
    if (path === "/quote") return await quote(req);
    if (path === "/request") return await request(req);
    if (path === "/cancel") return await cancel(req);
    if (path === "/test") return await test(req);
    return json({ error: "Rota não encontrada" }, 404);
  } catch (e) {
    console.error(e);
    const m = (e as Error).message ?? "";
    return json({ error: m.includes("Foody") ? m : "Erro interno" }, 500);
  }
});
