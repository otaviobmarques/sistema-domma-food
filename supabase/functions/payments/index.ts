// Domma Food · Pagamento online via Mercado Pago (API /v1/payments)
//   POST /payments/pix      {token, email}        → cria (ou reaproveita) a cobrança Pix do pedido
//   POST /payments/card     {token, form}         → paga com cartão (token gerado pelo formulário do Mercado Pago)
//   POST /payments/sync     {token}               → consulta o status no Mercado Pago (rede de segurança)
//   POST /payments/webhook?unit=<id>              → notificação do Mercado Pago (assinatura x-signature)
//   POST /payments/test     {unit_id}             → testa as credenciais (JWT do dono da conta)
//   POST /payments/worker                          → estornos e conferência de pendentes (x-worker-secret)
//   POST /payments/point         {token}           → totem: manda o valor do pedido para a maquininha Point (API Orders)
//   POST /payments/point/cancel  {token}           → totem: cliente desistiu; cancela a cobrança na maquininha
//   POST /payments/terminals     {unit_id, setup?} → painel: lista as maquininhas Point e ativa o modo integrado (JWT do dono)
// O valor cobrado sempre vem do pedido no banco; o navegador nunca define o valor.
import { createClient } from "npm:@supabase/supabase-js@2.119.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
const MP = Deno.env.get("MP_API_BASE") ?? "https://api.mercadopago.com";   // trocável só para testes locais

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS } });
const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
async function hmacHex(secret: string, msg: string) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
}
function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
const TOKEN_RE = /^[0-9a-f]{36}$/;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,}$/i;
// horário de Brasília no formato que o Mercado Pago pede: 2026-11-11T12:00:00.000-03:00
const mpDate = (d: Date) => new Date(d.getTime() - 3 * 3600_000).toISOString().replace("Z", "-03:00");

async function mp(token: string, method: string, path: string, body?: unknown, idem?: string, extra: Record<string, string> = {}) {
  try {
    const res = await fetch(MP + path, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(idem ? { "X-Idempotency-Key": idem } : {}), ...extra },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(25_000),
    });
    let data: Record<string, unknown> = {};
    try { data = await res.json(); } catch { /* resposta vazia */ }
    return { http: res.status, data };
  } catch (e) {
    return { http: 0, data: { message: (e as Error).message } };
  }
}

const CARD_MSG: Record<string, string> = {
  cc_rejected_insufficient_amount: "Cartão sem limite suficiente.",
  cc_rejected_bad_filled_security_code: "Código de segurança incorreto.",
  cc_rejected_bad_filled_date: "Data de validade incorreta.",
  cc_rejected_bad_filled_other: "Confira os dados do cartão.",
  cc_rejected_call_for_authorize: "O banco pediu autorização. Ligue para o banco e tente de novo.",
  cc_rejected_card_disabled: "Cartão bloqueado. Fale com o banco.",
  cc_rejected_duplicated_payment: "Pagamento duplicado. Confira se já foi cobrado.",
  cc_rejected_high_risk: "Pagamento recusado por segurança. Tente outro cartão ou o Pix.",
  cc_rejected_max_attempts: "Muitas tentativas. Use outro cartão.",
};

type Ctx = {
  order_id: string; unit_id: string; number: number; status: string; payment_status: string; payment_method: string;
  total_cents: number; customer_name: string; store: string; pix_expires_at: string; enabled: boolean; pix_enabled: boolean;
  card_enabled: boolean; max_installments: number; statement_descriptor: string | null; token: string | null; card_attempts: number;
  open_pix: { id: string; external_id: string | null; status: string; expires_at: string | null } | null;
  last_payment: { id: string; external_id: string | null; kind: string; status: string; updated_at: string } | null;
};
async function context(orderToken: unknown): Promise<Ctx | null> {
  if (typeof orderToken !== "string" || !TOKEN_RE.test(orderToken)) return null;
  const { data } = await admin.rpc("gateway_context", { p_order_token: orderToken });
  return (data as Ctx) ?? null;
}
const notifyUrl = (unit: string) => `${SUPABASE_URL}/functions/v1/payments/webhook?unit=${unit}`;
const firstName = (n: string) => (n || "Cliente").trim().split(/\s+/)[0].slice(0, 40);

async function record(gpId: string, data: Record<string, unknown>) {
  const { data: st } = await admin.rpc("gateway_record", { p_id: gpId, p_body: data });
  return String(st ?? "error");
}

async function createPix(body: { token?: string; email?: string }) {
  const c = await context(body.token);
  if (!c) return json({ error: "Pedido não encontrado." }, 404);
  if (!c.enabled || !c.pix_enabled || !c.token || c.payment_method !== "pix") return json({ error: "Pix online indisponível para este pedido." }, 400);
  if (c.payment_status === "paid") return json({ status: "paid" });
  if (c.status !== "awaiting_payment") return json({ error: "Este pedido não está aguardando pagamento." }, 400);
  if (c.open_pix?.external_id && c.open_pix.status === "pending" && (!c.open_pix.expires_at || new Date(c.open_pix.expires_at) > new Date())) {
    return json({ status: "pending" });   // já existe cobrança válida
  }
  const email = String(body.email ?? "").trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return json({ error: "Informe um e-mail válido para o Pix." }, 400);
  const { data: gpId, error } = await admin.rpc("gateway_begin", { p_order_id: c.order_id, p_kind: "pix", p_amount_cents: c.total_cents });
  if (error || !gpId) return json({ error: "Não foi possível iniciar o pagamento." }, 500);
  // o Mercado Pago exige pelo menos 30 minutos de validade no Pix
  const exp = new Date(Math.max(new Date(c.pix_expires_at).getTime(), Date.now() + 31 * 60_000));
  const r = await mp(c.token, "POST", "/v1/payments", {
    transaction_amount: c.total_cents / 100, description: `Pedido #${c.number} · ${c.store}`.slice(0, 120),
    payment_method_id: "pix", payer: { email, first_name: firstName(c.customer_name) },
    external_reference: c.order_id, notification_url: notifyUrl(c.unit_id), date_of_expiration: mpDate(exp),
  }, String(gpId));
  if (r.http >= 300 || !r.data.id) {
    await record(String(gpId), { status: "error", status_detail: `http_${r.http}` });
    return json({ error: "O Mercado Pago não gerou o Pix agora. Tente de novo em instantes." }, 502);
  }
  return json({ status: await record(String(gpId), r.data) });
}

type CardForm = { token?: string; issuer_id?: string | number; payment_method_id?: string; installments?: number;
  payer?: { email?: string; identification?: { type?: string; number?: string } } };
async function payCard(body: { token?: string; form?: CardForm }) {
  const c = await context(body.token);
  if (!c) return json({ error: "Pedido não encontrado." }, 404);
  if (!c.enabled || !c.card_enabled || !c.token || c.payment_method !== "online_card") return json({ error: "Cartão online indisponível para este pedido." }, 400);
  if (c.payment_status === "paid") return json({ status: "paid" });
  if (c.status !== "awaiting_payment") return json({ error: "Este pedido não está aguardando pagamento." }, 400);
  if (c.card_attempts >= 5) return json({ error: "Limite de tentativas atingido. Fale com a loja." }, 429);
  const f = body.form ?? {};
  const email = String(f.payer?.email ?? "").trim().toLowerCase();
  const inst = Math.trunc(Number(f.installments ?? 1));
  if (!f.token || typeof f.token !== "string" || f.token.length > 200 || !f.payment_method_id || !EMAIL_RE.test(email)) {
    return json({ error: "Dados do cartão incompletos." }, 400);
  }
  if (!(inst >= 1 && inst <= c.max_installments)) return json({ error: "Número de parcelas não permitido." }, 400);
  const { data: gpId, error } = await admin.rpc("gateway_begin", { p_order_id: c.order_id, p_kind: "card", p_amount_cents: c.total_cents });
  if (error || !gpId) return json({ error: "Não foi possível iniciar o pagamento." }, 500);
  const idn = f.payer?.identification;
  const r = await mp(c.token, "POST", "/v1/payments", {
    transaction_amount: c.total_cents / 100, token: f.token, installments: inst, payment_method_id: String(f.payment_method_id).slice(0, 40),
    ...(f.issuer_id ? { issuer_id: Number(f.issuer_id) || f.issuer_id } : {}),
    description: `Pedido #${c.number} · ${c.store}`.slice(0, 120), binary_mode: true,
    payer: { email, ...(idn?.number ? { identification: { type: String(idn.type ?? "CPF").slice(0, 10), number: String(idn.number).replace(/\D/g, "").slice(0, 14) } } : {}) },
    external_reference: c.order_id, notification_url: notifyUrl(c.unit_id),
    ...(c.statement_descriptor ? { statement_descriptor: c.statement_descriptor } : {}),
  }, String(gpId));
  if (r.http >= 300 || !r.data.id) {
    await record(String(gpId), { status: "rejected", status_detail: `http_${r.http}` });
    return json({ status: "rejected", message: "O pagamento não foi processado. Confira os dados e tente de novo." });
  }
  const st = await record(String(gpId), r.data);
  const detail = String(r.data.status_detail ?? "");
  return json({ status: st, message: st === "paid" ? "Pagamento aprovado!" : CARD_MSG[detail] ?? (st === "rejected" ? "Pagamento recusado. Tente outro cartão ou o Pix." : "Pagamento em análise.") });
}

// ---------- Maquininha Point (totem) ----------
type PointCtx = { order_id: string; unit_id: string; number: number; status: string; payment_status: string; payment_method: string;
  total_cents: number; store: string; terminal_id: string | null; allow_card: boolean; token: string | null; attempts: number;
  open: { id: string; external_id: string | null; status: string; updated_at: string } | null };
async function pointContext(orderToken: unknown): Promise<PointCtx | null> {
  if (typeof orderToken !== "string" || !TOKEN_RE.test(orderToken)) return null;
  const { data } = await admin.rpc("gateway_point_context", { p_order_token: orderToken });
  return (data as PointCtx) ?? null;
}
const POINT_ID = /^ORD[0-9A-Z]{10,40}$/;
async function recordPoint(gpId: string, data: Record<string, unknown>) {
  const { data: st } = await admin.rpc("gateway_record_point", { p_id: gpId, p_body: data });
  return String(st ?? "error");
}
const POINT_MSG: Record<string, string> = {
  insufficient_amount: "Cartão sem limite ou saldo suficiente.", card_disabled: "Cartão bloqueado. Fale com o banco.",
  high_risk: "Pagamento recusado por segurança. Tente outro cartão.", required_call_for_authorize: "O banco pediu autorização. Tente outro cartão.",
  bad_filled_card_data: "Não foi possível ler o cartão. Tente de novo.", max_attempts_exceeded: "Muitas tentativas. Use outro cartão.",
  processing_error: "A maquininha não conseguiu processar. Tente de novo.",
};

async function pointCreate(body: { token?: string }) {
  const c = await pointContext(body.token);
  if (!c) return json({ error: "Pedido não encontrado." }, 404);
  if (c.payment_status === "paid") return json({ status: "paid" });
  if (!c.allow_card || !c.terminal_id || !c.token || !["credit_card", "debit_card"].includes(c.payment_method)) return json({ error: "Cartão indisponível neste totem. Pague no caixa." }, 400);
  if (c.status !== "awaiting_payment") return json({ error: "Este pedido não está aguardando pagamento." }, 400);
  // já há cobrança na maquininha: não manda outra
  if (c.open?.external_id && (c.open.status === "in_process" || Date.now() - new Date(c.open.updated_at).getTime() < 200_000)) return json({ status: c.open.status });   // a cobrança vence em 3 min (PT3M)
  if (c.attempts >= 6) return json({ error: "Limite de tentativas atingido. Pague no caixa." }, 429);
  const { data: gpId, error } = await admin.rpc("gateway_begin", { p_order_id: c.order_id, p_kind: "point", p_amount_cents: c.total_cents });
  if (error || !gpId) return json({ error: "Não foi possível iniciar o pagamento." }, 500);
  await admin.from("gateway_payments").update({ point_terminal_id: c.terminal_id, card_type: c.payment_method }).eq("id", gpId);
  const r = await mp(c.token, "POST", "/v1/orders", {
    type: "point", external_reference: c.order_id, expiration_time: "PT3M",
    description: `Pedido #${c.number} · ${c.store}`.slice(0, 150),
    transactions: { payments: [{ amount: (c.total_cents / 100).toFixed(2) }] },
    config: { point: { terminal_id: c.terminal_id, print_on_terminal: "no_ticket" }, payment_method: { default_type: c.payment_method } },
  }, String(gpId));
  if (r.http >= 300 || !r.data.id) {
    await recordPoint(String(gpId), { status: "failed", status_detail: `http_${r.http}` });
    const code = JSON.stringify(r.data).slice(0, 400);
    const msg = /terminal_owner/.test(code) ? "A maquininha não está vinculada à conta Mercado Pago da loja. Chame um atendente."
      : r.http === 409 || /terminal.*busy|in_use|already/i.test(code) ? "A maquininha está ocupada. Aguarde um instante e tente de novo."
      : "Não foi possível falar com a maquininha agora. Tente de novo ou pague no caixa.";
    return json({ status: "rejected", message: msg });
  }
  return json({ status: await recordPoint(String(gpId), r.data) });
}

async function pointCancel(body: { token?: string }) {
  const c = await pointContext(body.token);
  if (!c) return json({ error: "Pedido não encontrado." }, 404);
  if (!c.open?.external_id || !c.token) return json({ status: "none" });
  const r = await mp(c.token, "POST", `/v1/orders/${encodeURIComponent(c.open.external_id)}/cancel`, undefined, `cancel-${c.open.id}`,
    { "x-allow-cancelable-status": "at_terminal" });
  if (r.http < 300 && r.data.id) return json({ status: await recordPoint(c.open.id, r.data) });
  // não deu para cancelar (cliente já pagando?): confere o estado real
  const g = await mp(c.token, "GET", `/v1/orders/${encodeURIComponent(c.open.external_id)}`);
  return json({ status: g.http === 200 ? await recordPoint(c.open.id, g.data) : c.open.status });
}

async function terminals(req: Request) {
  const user = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } }, auth: { persistSession: false } });
  const { unit_id, setup } = await req.json().catch(() => ({}));
  if (typeof unit_id !== "string") return json({ error: "Loja inválida" }, 400);
  const { data: can } = await user.rpc("gateway_can_test", { p_unit_id: unit_id });
  if (can !== true) return json({ error: "Só o dono da conta vincula maquininhas." }, 403);
  const { data: sec } = await admin.rpc("gateway_secrets", { p_unit_id: unit_id });
  if (!sec?.token) return json({ error: "Cadastre o Access Token do Mercado Pago em Pagamentos primeiro." }, 400);
  if (typeof setup === "string") {
    if (!/^[A-Z0-9_]{2,40}__[A-Z0-9]{4,40}$/.test(setup)) return json({ error: "Maquininha inválida." }, 400);
    const r = await mp(sec.token, "PATCH", "/terminals/v1/setup", { terminals: [{ id: setup, operating_mode: "PDV" }] });
    if (r.http >= 300) return json({ error: `O Mercado Pago não ativou o modo integrado (HTTP ${r.http}).` }, 502);
  }
  const r = await mp(sec.token, "GET", "/terminals/v1/list?limit=50");
  if (r.http !== 200) return json({ error: r.http === 401 ? "O Mercado Pago recusou o Access Token." : `O Mercado Pago respondeu HTTP ${r.http}.` }, 502);
  const list = ((r.data as { data?: { terminals?: Record<string, unknown>[] } }).data?.terminals ?? [])
    .map((t) => ({ id: String(t.id ?? ""), operating_mode: String(t.operating_mode ?? ""), store_id: t.store_id ?? null, pos_id: t.pos_id ?? null }))
    .filter((t) => t.id);
  return json({ terminals: list, live: sec.live === true });
}

async function sync(body: { token?: string }) {
  const c = await context(body.token);
  if (!c) return json({ error: "Pedido não encontrado." }, 404);
  const p = c.last_payment;
  if (!c.token || !p?.external_id || !["pending", "in_process"].includes(p.status)) return json({ status: p?.status ?? "none" });
  if (Date.now() - new Date(p.updated_at).getTime() < (p.kind === "point" ? 3_000 : 8_000)) return json({ status: p.status }); // evita martelar a API
  if (p.kind === "point") {
    if (!POINT_ID.test(p.external_id)) return json({ status: p.status });
    const g = await mp(c.token, "GET", `/v1/orders/${encodeURIComponent(p.external_id)}`);
    if (g.http !== 200) return json({ status: p.status });
    const st = await recordPoint(p.id, g.data);
    const detail = String(((g.data.transactions as { payments?: { status_detail?: string }[] })?.payments ?? [])[0]?.status_detail ?? "");
    return json({ status: st, message: st === "rejected" ? POINT_MSG[detail] ?? "Pagamento recusado. Tente outro cartão ou pague no caixa." : undefined });
  }
  const r = await mp(c.token, "GET", `/v1/payments/${encodeURIComponent(p.external_id)}`);
  if (r.http !== 200) return json({ status: p.status });
  return json({ status: await record(p.id, r.data) });
}

async function webhook(req: Request) {
  const url = new URL(req.url);
  const unit = url.searchParams.get("unit") ?? "";
  if (!/^[0-9a-f-]{36}$/.test(unit)) return json({ error: "Loja inválida" }, 400);
  const body = await req.json().catch(() => ({})) as { type?: string; topic?: string; data?: { id?: string | number } };
  const type = url.searchParams.get("type") ?? url.searchParams.get("topic") ?? body.type ?? body.topic;
  const rawId = url.searchParams.get("data.id") ?? url.searchParams.get("id") ?? (body.data?.id != null ? String(body.data.id) : "");
  const dataId = /^[a-z0-9]+$/i.test(rawId) ? rawId.toLowerCase() : rawId;
  const { data: sec } = await admin.rpc("gateway_secrets", { p_unit_id: unit });
  if (!sec?.token) return json({ ok: true });                       // loja sem integração: ignora
  if (sec.webhook_secret) {
    const sig = req.headers.get("x-signature") ?? "";
    const parts = Object.fromEntries(sig.split(",").map((s) => s.trim().split("=", 2) as [string, string]));
    const reqId = req.headers.get("x-request-id");
    const manifest = (dataId ? `id:${dataId};` : "") + (reqId ? `request-id:${reqId};` : "") + `ts:${parts.ts ?? ""};`;
    if (!parts.ts || !parts.v1 || !safeEqual(await hmacHex(sec.webhook_secret, manifest), parts.v1)) return json({ error: "Assinatura inválida" }, 401);
  }
  if (type === "order" && POINT_ID.test(rawId)) {
    const { data: gpId } = await admin.rpc("gateway_find", { p_unit_id: unit, p_external_id: rawId });
    if (!gpId) return json({ ok: true });
    const r = await mp(sec.token, "GET", `/v1/orders/${rawId}`);
    if (r.http !== 200) return json({ error: "Falha ao consultar" }, 502);
    return json({ ok: true, status: await recordPoint(String(gpId), r.data) });
  }
  if (type !== "payment" || !/^\d{1,20}$/.test(dataId)) return json({ ok: true });
  // nunca confiar no corpo: consulta o pagamento no Mercado Pago
  const { data: gpId } = await admin.rpc("gateway_find", { p_unit_id: unit, p_external_id: dataId });
  if (!gpId) return json({ ok: true });
  const r = await mp(sec.token, "GET", `/v1/payments/${dataId}`);
  if (r.http !== 200) return json({ error: "Falha ao consultar" }, 502);  // o Mercado Pago reenvia
  return json({ ok: true, status: await record(String(gpId), r.data) });
}

async function test(req: Request) {
  const user = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } }, auth: { persistSession: false } });
  const { unit_id } = await req.json().catch(() => ({}));
  if (typeof unit_id !== "string") return json({ error: "Loja inválida" }, 400);
  const { data: can } = await user.rpc("gateway_can_test", { p_unit_id: unit_id });
  if (can !== true) return json({ error: "Só o dono da conta testa as credenciais." }, 403);
  const { data: sec } = await admin.rpc("gateway_secrets", { p_unit_id: unit_id });
  if (!sec?.token) return json({ ok: false, message: "Salve o Access Token primeiro." });
  const r = await mp(sec.token, "GET", "/users/me");
  const ok = r.http === 200;
  const who = ok ? String((r.data as { nickname?: string }).nickname ?? (r.data as { id?: number }).id ?? "") : "";
  const message = ok ? `Conectado à conta ${who} do Mercado Pago (${sec.live ? "produção" : "teste"}).`
    : r.http === 401 ? "O Mercado Pago recusou o Access Token." : `O Mercado Pago respondeu HTTP ${r.http}.`;
  await admin.rpc("gateway_test_result", { p_unit_id: unit_id, p_ok: ok, p_message: message });
  return json({ ok, message });
}

async function worker(req: Request) {
  const given = req.headers.get("x-worker-secret") ?? "";
  const { data: secret } = await admin.rpc("gateway_worker_secret");
  if (!secret || !safeEqual(given, String(secret))) return json({ error: "Não autorizado" }, 401);
  const out: unknown[] = [];
  const { data: jobs } = await admin.rpc("gateway_refund_jobs");
  for (const j of (jobs ?? []) as { id: string; external_id: string; token: string; kind: string }[]) {
    if (j.kind === "point") {
      let r = await mp(j.token, "POST", `/v1/orders/${encodeURIComponent(j.external_id)}/refund`, undefined, `refund-${j.id}`);
      let ok = r.http === 200 || r.http === 201;
      if (!ok) { const g = await mp(j.token, "GET", `/v1/orders/${encodeURIComponent(j.external_id)}`); if (g.http === 200 && g.data.status === "refunded") { ok = true; r = g; } }
      await admin.rpc("gateway_refund_result", { p_id: j.id, p_ok: ok, p_message: ok ? "Estornado" : `HTTP ${r.http}: ${String(r.data.message ?? "").slice(0, 200)}` });
      out.push({ refund: j.id, ok });
      continue;
    }
    let r = await mp(j.token, "POST", `/v1/payments/${encodeURIComponent(j.external_id)}/refunds`, {}, `refund-${j.id}`);
    let ok = r.http === 200 || r.http === 201;
    if (!ok) { // já estornado antes?
      const g = await mp(j.token, "GET", `/v1/payments/${encodeURIComponent(j.external_id)}`);
      if (g.http === 200 && g.data.status === "refunded") { ok = true; r = g; }
    }
    await admin.rpc("gateway_refund_result", { p_id: j.id, p_ok: ok, p_message: ok ? "Estornado" : `HTTP ${r.http}: ${String(r.data.message ?? "").slice(0, 200)}` });
    out.push({ refund: j.id, ok });
  }
  const { data: pend } = await admin.rpc("gateway_pending_checks");
  for (const p of (pend ?? []) as { id: string; external_id: string; token: string; kind: string }[]) {
    if (p.kind === "point") {
      const r = await mp(p.token, "GET", `/v1/orders/${encodeURIComponent(p.external_id)}`);
      if (r.http === 200) out.push({ check: p.id, status: await recordPoint(p.id, r.data) });
      continue;
    }
    const r = await mp(p.token, "GET", `/v1/payments/${encodeURIComponent(p.external_id)}`);
    if (r.http === 200) out.push({ check: p.id, status: await record(p.id, r.data) });
  }
  return json({ processed: out.length, results: out });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "Método não permitido" }, 405);
  const path = new URL(req.url).pathname.replace(/^.*\/payments/, "") || "/";
  try {
    if (path === "/webhook") return await webhook(req);
    if (path === "/worker") return await worker(req);
    if (path === "/test") return await test(req);
    if (path === "/terminals") return await terminals(req);
    const body = await req.json().catch(() => ({}));
    if (path === "/pix") return await createPix(body);
    if (path === "/card") return await payCard(body);
    if (path === "/sync") return await sync(body);
    if (path === "/point") return await pointCreate(body);
    if (path === "/point/cancel") return await pointCancel(body);
    return json({ error: "Rota não encontrada" }, 404);
  } catch (e) {
    console.error(e);
    return json({ error: "Erro interno" }, 500);
  }
});
