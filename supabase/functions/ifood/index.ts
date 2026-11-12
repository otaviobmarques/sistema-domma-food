// Domma Food · Integração iFood (Merchant API, aplicativo distribuído)
//   POST /ifood/connect/start    {unit_id}                     → gera o código de vínculo (gestor da loja)
//   POST /ifood/connect/finish   {unit_id, authorization_code} → troca o código de autorização por tokens
//   POST /ifood/connect/merchant {unit_id, merchant_id}        → escolhe a loja do iFood (se houver mais de uma)
//   POST /ifood/status           {unit_id}                     → status da loja no iFood
//   POST /ifood/test                                           → valida o app (super admin)
//   POST /ifood/worker           {job: all|poll|outbox}        → polling de eventos + fila de status (x-worker-secret)
//   POST /ifood/shipping/quote   {order_id, address?}          → Entrega iFood: cotação para pedido de fora do iFood (equipe)
//   POST /ifood/shipping/request {order_id, quote_id, address?} → Entrega iFood: cadastra o pedido e aloca entregador
//   POST /ifood/shipping/cancel  {order_id}                     → Entrega iFood: cancela
import { createClient } from "npm:@supabase/supabase-js@2.119.0";

const API = "https://merchant-api.ifood.com.br";
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
function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
type Token = { access_token: string; refresh_token: string; expires_at: number };
type Conn = { id: string; tenant_id: string; unit_id: string; external_merchant_id: string; auto_confirm: boolean; token: Token | null };

async function call(method: string, path: string, opts: { token?: string; form?: Record<string, string>; body?: unknown; headers?: Record<string, string> } = {}) {
  try {
    const res = await fetch(API + path, {
      method,
      headers: {
        ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.form ? { "Content-Type": "application/x-www-form-urlencoded" } : opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(opts.headers ?? {}),
      },
      body: opts.form ? new URLSearchParams(opts.form) : opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    let data: unknown = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { http: res.status, data };
  } catch (e) {
    return { http: 0, data: { message: (e as Error).message } };
  }
}
const errMsg = (r: { http: number; data: unknown }) => {
  const d = r.data as { message?: string; error?: { message?: string } | string; details?: string } | null;
  const m = typeof d === "string" ? d : d?.message ?? (typeof d?.error === "string" ? d.error : d?.error?.message) ?? d?.details;
  return `${r.http || "rede"}: ${String(m ?? "erro no iFood").slice(0, 200)}`;
};

async function app() {
  const { data } = await admin.rpc("ifood_app_secret");
  const a = data as { client_id: string | null; client_secret: string | null } | null;
  if (!a?.client_id || !a?.client_secret) throw new Error("O app do iFood ainda não foi configurado pela plataforma.");
  return a as { client_id: string; client_secret: string };
}
function toToken(d: Record<string, unknown>, old?: Token | null): Token {
  return { access_token: String(d.accessToken), refresh_token: String(d.refreshToken ?? old?.refresh_token ?? ""),
    expires_at: Math.floor(Date.now() / 1000) + Number(d.expiresIn ?? 21600) };
}
async function accessToken(c: { id: string; token: Token | null }, force = false) {
  if (!c.token?.refresh_token) throw new Error("Loja sem autorização do iFood. Conecte de novo.");
  if (!force && c.token.access_token && c.token.expires_at > Date.now() / 1000 + 120) return c.token.access_token;
  const a = await app();
  const r = await call("POST", "/authentication/v1.0/oauth/token", { form: {
    grantType: "refresh_token", clientId: a.client_id, clientSecret: a.client_secret, refreshToken: c.token.refresh_token } });
  if (r.http !== 200) throw new Error(`Não foi possível renovar o acesso ao iFood (${errMsg(r)}). Reconecte a loja.`);
  c.token = toToken(r.data as Record<string, unknown>, c.token);
  await admin.rpc("ifood_save_token", { p_connection_id: c.id, p_token: c.token });
  return c.token.access_token;
}
async function api(c: { id: string; token: Token | null }, method: string, path: string, opts: { body?: unknown; headers?: Record<string, string> } = {}) {
  let r = await call(method, path, { ...opts, token: await accessToken(c) });
  if (r.http === 401) r = await call(method, path, { ...opts, token: await accessToken(c, true) });
  return r;
}
async function setError(id: string, msg: string | null) {
  await admin.from("marketplace_connections").update({ last_error: msg ? msg.slice(0, 500) : null, last_sync_at: new Date().toISOString() }).eq("id", id);
}

// ---------------- Conexão da loja (painel) ----------------
function userClient(req: Request) {
  return createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } }, auth: { persistSession: false } });
}
async function guard(req: Request) {
  const b = await req.json().catch(() => ({}));
  if (typeof b.unit_id !== "string" || !UUID.test(b.unit_id)) return { error: json({ error: "Loja inválida" }, 400) };
  const { data } = await userClient(req).rpc("ifood_can_manage", { p_unit_id: b.unit_id });
  if (data !== true) return { error: json({ error: "Só o dono ou a gerência conectam o iFood." }, 403) };
  const { data: c } = await admin.from("marketplace_connections").select("id").eq("unit_id", b.unit_id).eq("provider", "ifood").maybeSingle();
  return { b, connId: (c as { id: string } | null)?.id ?? null };
}

async function connectStart(req: Request) {
  const g = await guard(req); if (g.error) return g.error;
  const a = await app();
  const r = await call("POST", "/authentication/v1.0/oauth/userCode", { form: { clientId: a.client_id } });
  if (r.http !== 200) return json({ error: `O iFood recusou o pedido de código (${errMsg(r)}).` }, 502);
  const d = r.data as { userCode: string; authorizationCodeVerifier: string; verificationUrlComplete?: string; verificationUrl?: string; expiresIn?: number };
  await admin.rpc("ifood_save_user_code", { p_unit_id: g.b.unit_id, p_user_code: d.userCode, p_url: d.verificationUrlComplete ?? d.verificationUrl ?? "https://portal.ifood.com.br/apps/code",
    p_verifier: d.authorizationCodeVerifier, p_expires_in: d.expiresIn ?? 600 });
  return json({ ok: true, user_code: d.userCode, url: d.verificationUrlComplete ?? d.verificationUrl, expires_in: d.expiresIn ?? 600 });
}

async function connectFinish(req: Request) {
  const g = await guard(req); if (g.error) return g.error;
  if (!g.connId) return json({ error: "Gere o código de vínculo primeiro." }, 409);
  const code = String(g.b.authorization_code ?? "").trim();
  if (!/^[A-Za-z0-9-]{4,40}$/.test(code)) return json({ error: "Código de autorização inválido." }, 400);
  const { data: ctx } = await admin.rpc("ifood_auth_context", { p_connection_id: g.connId });
  if (!ctx?.verifier) return json({ error: "O código de vínculo expirou. Gere um novo." }, 409);
  const a = await app();
  const r = await call("POST", "/authentication/v1.0/oauth/token", { form: {
    grantType: "authorization_code", clientId: a.client_id, clientSecret: a.client_secret, authorizationCode: code, authorizationCodeVerifier: ctx.verifier } });
  if (r.http !== 200) return json({ error: `O iFood não aceitou o código (${errMsg(r)}). Confira e tente de novo.` }, 400);
  const conn = { id: g.connId, token: toToken(r.data as Record<string, unknown>) };
  await admin.rpc("ifood_save_token", { p_connection_id: conn.id, p_token: conn.token });
  const m = await api(conn, "GET", "/merchant/v1.0/merchants");
  const list = (Array.isArray(m.data) ? m.data : []) as { id: string; name: string; corporateName?: string }[];
  const merchants = list.map((x) => ({ id: x.id, name: x.name, corporate_name: x.corporateName ?? null }));
  const only = merchants.length === 1 ? merchants[0] : null;
  await admin.rpc("ifood_set_merchant", { p_connection_id: conn.id, p_merchant_id: only?.id ?? null, p_name: only?.name ?? null, p_merchants: merchants });
  if (!merchants.length) return json({ ok: true, merchants, warning: "A autorização não enxerga nenhuma loja. Confira a conta usada no Portal do Parceiro." });
  return json({ ok: true, merchants, connected: !!only });
}

async function connectMerchant(req: Request) {
  const g = await guard(req); if (g.error) return g.error;
  if (!g.connId) return json({ error: "Conecte o iFood primeiro." }, 409);
  const { data: a } = await admin.from("ifood_auth").select("merchants").eq("connection_id", g.connId).maybeSingle();
  const m = ((a as { merchants: { id: string; name: string }[] | null } | null)?.merchants ?? []).find((x) => x.id === g.b.merchant_id);
  if (!m) return json({ error: "Loja do iFood inválida." }, 400);
  const { error } = await admin.rpc("ifood_set_merchant", { p_connection_id: g.connId, p_merchant_id: m.id, p_name: m.name, p_merchants: (a as { merchants: unknown }).merchants });
  if (error) return json({ error: error.message.includes("duplicate") ? "Esta loja do iFood já está ligada a outra loja do Domma." : "Não foi possível salvar." }, 409);
  return json({ ok: true });
}

async function status(req: Request) {
  const g = await guard(req); if (g.error) return g.error;
  if (!g.connId) return json({ ok: true, status: null });
  const { data: ctx } = await admin.rpc("ifood_auth_context", { p_connection_id: g.connId });
  if (!ctx?.token || !ctx?.external_merchant_id) return json({ ok: true, status: null });
  try {
    const r = await api({ id: g.connId, token: ctx.token }, "GET", `/merchant/v1.0/merchants/${encodeURIComponent(ctx.external_merchant_id)}/status`);
    if (r.http !== 200) return json({ error: `Não foi possível consultar o iFood (${errMsg(r)}).` }, 502);
    await admin.from("marketplace_connections").update({ external_status: { at: new Date().toISOString(), data: r.data } }).eq("id", g.connId);
    return json({ ok: true, status: r.data });
  } catch (e) {
    return json({ error: (e as Error).message }, 502);
  }
}

async function test(req: Request) {
  const { data: isAdmin } = await userClient(req).rpc("admin_can_billing_test");
  if (isAdmin !== true) return json({ error: "Só o administrador da plataforma." }, 403);
  let ok = false, message = "";
  try {
    const a = await app();
    const r = await call("POST", "/authentication/v1.0/oauth/userCode", { form: { clientId: a.client_id } });
    ok = r.http === 200;
    message = ok ? "Client ID aceito pelo iFood. O segredo é validado quando a primeira loja se conectar." : `O iFood recusou: ${errMsg(r)}`;
  } catch (e) { message = (e as Error).message; }
  await admin.rpc("ifood_app_test_result", { p_ok: ok, p_message: message });
  return json({ ok, message });
}

// ---------------- Entrega iFood (Shipping API, pedidos de fora do iFood) ----------------
type ShipCtx = {
  order: { id: string; number: number; type: string; status: string; customer_name: string; customer_phone: string; address: Record<string, unknown> | null;
    delivery_fee_cents: number; total_cents: number; payment_method: string; payment_status: string; change_for_cents: number | null };
  items: { id: string; name: string; quantity: number; unit_price_cents: number; total_cents: number }[];
  unit: { id: string; state: string | null; prep_time_min: number };
  ifood: { connection_id: string; merchant_id: string } | null;
  active: { id: string; provider: string; external_id: string; status: string } | null;
};
const dig = (v: unknown) => String(v ?? "").replace(/\D/g, "");
async function shipLoad(req: Request) {
  const b = await req.json().catch(() => ({}));
  if (typeof b.order_id !== "string" || !UUID.test(b.order_id)) return { error: json({ error: "Pedido inválido" }, 400) };
  const { data: can } = await userClient(req).rpc("logistics_can", { p_order_id: b.order_id });
  if (can !== true) return { error: json({ error: "Sem permissão para este pedido." }, 403) };
  const { data } = await admin.rpc("logistics_order_context", { p_order_id: b.order_id });
  const c = data as ShipCtx | null;
  if (!c) return { error: json({ error: "Pedido não encontrado." }, 404) };
  if (!c.ifood) return { error: json({ error: "A Entrega iFood não está ligada nesta loja (Integrações › Logística)." }, 409) };
  if (c.order.type !== "delivery") return { error: json({ error: "Só pedidos de entrega podem chamar entregador." }, 409) };
  if (["cancelled", "completed", "awaiting_payment"].includes(c.order.status)) return { error: json({ error: "Este pedido não está em andamento." }, 409) };
  const a = c.order.address ?? {};
  const lat = Number.isFinite(b.address?.lat) ? Number(b.address.lat) : typeof a.lat === "number" ? a.lat : null;
  const lng = Number.isFinite(b.address?.lng) ? Number(b.address.lng) : typeof a.lng === "number" ? a.lng : null;
  const cep = dig(b.address?.postal_code ?? a.postal_code ?? a.zip ?? "");
  if (lat == null || lng == null || Math.abs(lat) > 90 || Math.abs(lng) > 180)
    return { error: json({ error: "A Entrega iFood precisa da localização do cliente. Informe latitude e longitude (ou peça a localização pelo WhatsApp)." }, 422) };
  const { data: ctx } = await admin.rpc("ifood_auth_context", { p_connection_id: c.ifood.connection_id });
  if (!ctx?.token) return { error: json({ error: "A autorização do iFood desta loja expirou. Conecte de novo em Integrações › iFood." }, 409) };
  const { data: { user } } = await userClient(req).auth.getUser();
  return { b, c, lat, lng, cep, conn: { id: c.ifood.connection_id, token: ctx.token as Token }, uid: user?.id ?? null };
}
const reais = (cents: number) => Math.round(cents) / 100;

async function shipQuote(req: Request) {
  const g = await shipLoad(req); if (g.error) return g.error;
  const r = await api(g.conn, "GET", `/shipping/v1.0/merchants/${encodeURIComponent(g.c.ifood!.merchant_id)}/deliveryAvailabilities?latitude=${g.lat}&longitude=${g.lng}`);
  if (r.http !== 200) {
    const code = (r.data as { code?: string } | null)?.code ?? "";
    const human: Record<string, string> = {
      DeliveryDistanceTooHigh: "Endereço longe demais para a Entrega iFood.", OffOpeningHours: "Fora do horário da Entrega iFood.",
      ServiceAreaMismatch: "Endereço fora da área atendida pela Entrega iFood.", HighDemand: "Alta demanda: sem entregadores agora. Tente em alguns minutos.",
      MerchantStatusAvailability: "A loja está indisponível no iFood agora.", OriginNotFound: "O iFood não encontrou o endereço da loja.",
    };
    return json({ error: human[code] ?? `O iFood não cotou a entrega (${errMsg(r)}). Confira se o serviço está contratado no Portal do Parceiro.` }, 502);
  }
  const q = r.data as { id: string; expirationAt?: string; distance?: number; quote?: { netValue?: number }; deliveryTime?: { min?: number; max?: number } };
  return json({ ok: true, provider: "ifood", quote_id: q.id, expires_at: q.expirationAt ?? null, distance_m: q.distance ?? null,
    price_cents: q.quote?.netValue != null ? Math.round(q.quote.netValue * 100) : null,
    delivery_min: q.deliveryTime?.min != null ? Math.round(q.deliveryTime.min / 60) : null,
    delivery_max: q.deliveryTime?.max != null ? Math.round(q.deliveryTime.max / 60) : null });
}

async function shipRequest(req: Request) {
  const g = await shipLoad(req); if (g.error) return g.error;
  if (g.c.active) return json({ error: "Já existe um entregador solicitado para este pedido." }, 409);
  if (typeof g.b.quote_id !== "string" || !UUID.test(g.b.quote_id)) return json({ error: "Faça a cotação antes de chamar o entregador." }, 400);
  if (!/^\d{8}$/.test(g.cep)) return json({ error: "Informe o CEP do cliente (8 dígitos): a Entrega iFood exige." }, 422);
  const o = g.c.order, a = o.address ?? {};
  const paid = o.payment_status === "paid" || o.payment_method === "online_card";
  const method = ({ cash: "CASH", credit_card: "CREDIT", debit_card: "DEBIT", card_on_delivery: "CREDIT" } as Record<string, string>)[o.payment_method];
  if (!paid && !method) return json({ error: "A Entrega iFood só leva pedidos já pagos ou pagos na entrega em dinheiro ou cartão." }, 422);
  const phone = o.customer_phone.replace(/^55/, "");
  const validPhone = /^\d{10,11}$/.test(phone) && !/^0+$/.test(phone);
  const body = {
    customer: { name: o.customer_name.slice(0, 50),
      phone: validPhone ? { type: "CUSTOMER", countryCode: "55", areaCode: phone.slice(0, 2), number: phone.slice(2) } : { type: "STORE" } },
    delivery: {
      merchantFee: reais(o.delivery_fee_cents ?? 0), quoteId: g.b.quote_id, preparationTime: 0,
      deliveryAddress: {
        postalCode: g.cep, streetNumber: String(a.number ?? "S/N").slice(0, 10) || "S/N", streetName: String(a.street ?? "").slice(0, 50),
        ...(a.complement ? { complement: String(a.complement).slice(0, 50) } : {}), ...(a.reference ? { reference: String(a.reference).slice(0, 70) } : {}),
        neighborhood: String(a.neighborhood ?? "").slice(0, 50), city: String(a.city ?? "").slice(0, 50),
        state: String(a.state ?? g.c.unit.state ?? "").slice(0, 2).toUpperCase(), country: "BR",
        coordinates: { latitude: g.lat, longitude: g.lng } },
    },
    items: g.c.items.slice(0, 50).map((i) => ({ id: i.id, name: i.name.slice(0, 50), quantity: i.quantity, unitPrice: reais(i.unit_price_cents),
      price: reais(i.unit_price_cents * i.quantity), optionsPrice: Math.max(0, reais(i.total_cents - i.unit_price_cents * i.quantity)), totalPrice: reais(i.total_cents) })),
    ...(paid ? {} : { payments: { methods: [{ method, type: "OFFLINE", value: reais(o.total_cents),
      ...(method === "CASH" ? { cash: { changeFor: reais(o.change_for_cents ?? o.total_cents) } } : { card: { brand: "OTHER" } }) }] } }),
    displayId: String(o.number).slice(-4),
    metadata: { domma: String(o.number).slice(0, 12) },
  };
  const r = await api(g.conn, "POST", `/shipping/v1.0/merchants/${encodeURIComponent(g.c.ifood!.merchant_id)}/orders`, { body });
  if (r.http !== 202 && r.http !== 200) return json({ error: `O iFood recusou a entrega (${errMsg(r)}).` }, 502);
  const d = r.data as { id?: string; trackingUrl?: string };
  if (!d.id) return json({ error: "O iFood não devolveu o identificador da entrega." }, 502);
  const { error } = await admin.rpc("logistics_record", { p_order_id: o.id, p_provider: "ifood", p_external_id: d.id, p_status: "pending",
    p_fee_cents: null, p_eta: null, p_tracking_url: d.trackingUrl ?? null, p_actor: g.uid, p_error: null });
  if (error) return json({ error: error.message }, 409);
  return json({ ok: true, tracking_url: d.trackingUrl ?? null });
}

async function shipCancel(req: Request) {
  const g = await shipLoad(req); if (g.error) return g.error;
  const act = g.c.active;
  if (!act || act.provider !== "ifood") return json({ error: "Não há Entrega iFood em andamento neste pedido." }, 409);
  const ext = encodeURIComponent(act.external_id);
  const rs = await api(g.conn, "GET", `/shipping/v1.0/orders/${ext}/cancellationReasons`);
  if (rs.http === 204) return json({ error: "O iFood não permite cancelar esta entrega agora (o entregador já pode ter saído)." }, 409);
  const reasons = (Array.isArray(rs.data) ? rs.data : []) as { cancelCodeId: string; description: string }[];
  const pick = reasons.find((x) => /loja|restaurante|cliente desistiu|desist/i.test(x.description)) ?? reasons[0];
  if (!pick) return json({ error: `Motivos de cancelamento indisponíveis (${errMsg(rs)}).` }, 502);
  const r = await api(g.conn, "POST", `/shipping/v1.0/orders/${ext}/cancel`, { body: { reason: String(g.b.message ?? pick.description).slice(0, 250), cancellationCode: Number(pick.cancelCodeId) } });
  if (r.http >= 300) return json({ error: `O iFood não cancelou (${errMsg(r)}).` }, 502);
  await admin.rpc("logistics_event", { p_provider: "ifood", p_external_id: act.external_id, p_code: "CANCELLATION_REQUESTED", p_payload: { message: "Pedido pela loja" } });
  return json({ ok: true });
}

// ---------------- Worker: eventos e fila ----------------
type Ev = { id: string; code: string; fullCode?: string; orderId: string; merchantId?: string; createdAt?: string; metadata?: Record<string, unknown> };

async function handleEvent(c: Conn, ev: Ev) {
  const { error: insErr } = await admin.from("marketplace_events").insert({ tenant_id: c.tenant_id, connection_id: c.id, event_id: ev.id,
    event_type: ev.code, external_order_id: ev.orderId, payload: ev, source: "polling" });
  if (insErr && insErr.code !== "23505") throw insErr;
  if (insErr?.code === "23505") {
    const { data: prev } = await admin.from("marketplace_events").select("processed_at").eq("connection_id", c.id).eq("event_id", ev.id).maybeSingle();
    if ((prev as { processed_at: string | null } | null)?.processed_at) return;   // já tratado: só confirma de novo
  }
  try {
    // eventos da Entrega iFood (pedidos de fora do iFood) vão para a logística
    const { data: handled } = await admin.rpc("logistics_event", { p_provider: "ifood", p_external_id: ev.orderId,
      p_code: ev.fullCode ?? ev.code, p_payload: { ...(ev.metadata ?? {}), code: ev.code } });
    if (handled === true) {
      await admin.from("marketplace_events").update({ processed_at: new Date().toISOString(), error: null }).eq("connection_id", c.id).eq("event_id", ev.id);
      return;
    }
    if (ev.code === "PLC") {
      const r = await api(c, "GET", `/order/v1.0/orders/${encodeURIComponent(ev.orderId)}`);
      if (r.http !== 200) throw new Error(`Não foi possível obter o pedido ${ev.orderId} (${errMsg(r)})`);
      const { error } = await admin.rpc("ifood_ingest_order", { p_connection_id: c.id, o: r.data });
      if (error) throw error;
    } else {
      const { error } = await admin.rpc("ifood_apply_event", { p_connection_id: c.id, p_external_id: ev.orderId, p_code: ev.code, p_meta: ev.metadata ?? {} });
      if (error) throw error;
    }
    await admin.from("marketplace_events").update({ processed_at: new Date().toISOString(), error: null }).eq("connection_id", c.id).eq("event_id", ev.id);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await admin.from("marketplace_events").update({ error: msg.slice(0, 500) }).eq("connection_id", c.id).eq("event_id", ev.id);
    throw e;
  }
}

async function poll(c: Conn) {
  const r = await api(c, "GET", "/events/v1.0/events:polling", { headers: { "x-polling-merchants": c.external_merchant_id } });
  if (r.http === 204) { await setError(c.id, null); return 0; }
  if (r.http !== 200) throw new Error(`Polling do iFood falhou (${errMsg(r)})`);
  const events = (Array.isArray(r.data) ? r.data : []) as Ev[];
  const acks: { id: string }[] = [];
  for (const ev of events) {
    if (ev.merchantId && ev.merchantId !== c.external_merchant_id) continue;
    try { await handleEvent(c, ev); acks.push({ id: ev.id }); } catch { /* sem confirmação: volta no próximo polling */ }
  }
  for (let i = 0; i < acks.length; i += 100) {
    const a = await api(c, "POST", "/events/v1.0/events/acknowledgment", { body: acks.slice(i, i + 100) });
    if (a.http >= 300) throw new Error(`Confirmação de eventos recusada (${errMsg(a)})`);
  }
  await setError(c.id, null);
  return acks.length;
}

async function processOutbox(conns: Conn[]) {
  const byId = new Map(conns.map((c) => [c.id, c]));
  const { data: jobs } = await admin.from("integration_outbox")
    .select("*, orders(external_id, external_flags), marketplace_connections!inner(provider)")
    .eq("marketplace_connections.provider", "ifood")
    .is("done_at", null).lte("next_attempt_at", new Date().toISOString()).lt("attempts", 12).order("id").limit(50);
  let ok = 0;
  for (const j of jobs ?? []) {
    const c = byId.get(j.connection_id);
    const o = j.orders as { external_id: string | null; external_flags: Record<string, string> | null } | null;
    const ext = o?.external_id ? encodeURIComponent(o.external_id) : null;
    const done = async (err: string | null) => { await admin.from("integration_outbox").update({ done_at: new Date().toISOString(), attempts: j.attempts + 1, last_error: err }).eq("id", j.id); };
    try {
      if (!c || !ext) throw new Error("Conexão do iFood inativa ou pedido sem ID do iFood");
      let r: { http: number; data: unknown } | null = null;
      switch (j.action) {
        case "confirm": r = await api(c, "POST", `/order/v1.0/orders/${ext}/confirm`); break;
        case "preparing": r = await api(c, "POST", `/order/v1.0/orders/${ext}/startPreparation`); break;
        case "readyForPickup": r = await api(c, "POST", `/order/v1.0/orders/${ext}/readyToPickup`); break;
        case "dispatch": r = await api(c, "POST", `/order/v1.0/orders/${ext}/dispatch`); break;
        case "delivered": case "pickedUp": await done(null); ok++; continue;   // o iFood conclui sozinho
        case "requestCancellation": {
          const rs = await api(c, "GET", `/order/v1.0/orders/${ext}/cancellationReasons`);
          const reasons = (Array.isArray(rs.data) ? rs.data : []) as { cancelCodeId: string; description: string }[];
          const pick = reasons.find((x) => /problema|interno|restaurante|loja/i.test(x.description)) ?? reasons[0];
          if (!pick) throw new Error(rs.http === 200 ? "O iFood não permite cancelar este pedido agora." : `Motivos de cancelamento indisponíveis (${errMsg(rs)})`);
          r = await api(c, "POST", `/order/v1.0/orders/${ext}/requestCancellation`, { body: {
            reason: String((j.payload as { reason?: string })?.reason ?? pick.description).slice(0, 250), cancellationCode: pick.cancelCodeId } });
          break;
        }
        case "acceptCancellation": case "denyCancellation": {
          const dispute = o?.external_flags?.dispute_id;
          if (!dispute) throw new Error("Pedido de cancelamento sem identificação da disputa");
          r = await api(c, "POST", `/order/v1.0/disputes/${encodeURIComponent(dispute)}/${j.action === "acceptCancellation" ? "accept" : "reject"}`,
            j.action === "denyCancellation" ? { body: { reason: "O pedido já está em preparo" } } : {});
          break;
        }
        default: await done("Ação não usada no iFood"); continue;
      }
      if (r.http >= 200 && r.http < 300) { await done(null); ok++; continue; }
      if (r.http >= 400 && r.http < 500 && ![401, 408, 429].includes(r.http)) { await done(`${j.action} recusado pelo iFood (${errMsg(r)})`); await setError(c.id, `${j.action}: ${errMsg(r)}`); continue; }
      throw new Error(`${j.action} falhou (${errMsg(r)})`);
    } catch (e) {
      const attempts = j.attempts + 1;
      const msg = e instanceof Error ? e.message : String(e);
      await admin.from("integration_outbox").update({ attempts, last_error: msg.slice(0, 500),
        next_attempt_at: new Date(Date.now() + Math.min(30 * 2 ** attempts, 1800) * 1000).toISOString() }).eq("id", j.id);
      if (c) await setError(c.id, msg);
    }
  }
  return ok;
}

async function worker(req: Request) {
  const s = req.headers.get("x-worker-secret") ?? "";
  const { data: expected } = await admin.rpc("ifood_worker_secret");
  if (!expected || !s || !safeEqual(s, String(expected))) return json({ error: "Proibido" }, 403);
  const { job = "all" } = await req.json().catch(() => ({}));
  const { data } = await admin.rpc("ifood_connections");
  const conns = (data ?? []) as Conn[];
  const out: Record<string, number> = {};
  if (job === "outbox" || job === "all") out.sent = await processOutbox(conns);
  if (job === "poll" || job === "all") {
    let n = 0;
    for (const c of conns) { try { n += await poll(c); } catch (e) { await setError(c.id, e instanceof Error ? e.message : String(e)); } }
    out.received = n;
  }
  return json(out);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "Método não permitido" }, 405);
  const path = new URL(req.url).pathname.replace(/^.*\/ifood/, "") || "/";
  try {
    if (path === "/worker") return await worker(req);
    if (path === "/connect/start") return await connectStart(req);
    if (path === "/connect/finish") return await connectFinish(req);
    if (path === "/connect/merchant") return await connectMerchant(req);
    if (path === "/status") return await status(req);
    if (path === "/test") return await test(req);
    if (path === "/shipping/quote") return await shipQuote(req);
    if (path === "/shipping/request") return await shipRequest(req);
    if (path === "/shipping/cancel") return await shipCancel(req);
    return json({ error: "Rota não encontrada" }, 404);
  } catch (e) {
    console.error(e);
    return json({ error: e instanceof Error && e.message.includes("iFood") ? e.message : "Erro interno" }, 500);
  }
});
