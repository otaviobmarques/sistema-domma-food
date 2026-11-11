// Domma Food · Cobrança da assinatura do SaaS via Asaas
//   POST /billing/subscribe {tenant_id, plan_id, name, cpf_cnpj, email, phone} → cria/atualiza cliente e assinatura (dono)
//   POST /billing/cancel    {tenant_id}                                         → cancela a assinatura (dono)
//   POST /billing/sync      {tenant_id}                                         → atualiza as faturas (dono ou admin)
//   POST /billing/webhook                                                        → eventos do Asaas (asaas-access-token)
//   POST /billing/test                                                           → testa a chave da API (super admin)
// O cliente paga na fatura do Asaas (Pix, boleto ou cartão); dados de cartão nunca passam por aqui.
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
function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
const digits = (v: unknown) => String(v ?? "").replace(/\D/g, "");
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });   // AAAA-MM-DD

type Ctx = { env: "sandbox" | "production"; enabled: boolean; api_key: string | null };
async function asaas(ctx: Ctx, method: string, path: string, body?: unknown) {
  const base = ctx.env === "production" ? "https://api.asaas.com/v3" : "https://api-sandbox.asaas.com/v3";
  try {
    const res = await fetch(base + path, {
      method,
      headers: { access_token: ctx.api_key ?? "", "Content-Type": "application/json", "User-Agent": "DommaFood/1.0 (Supabase Edge)" },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20_000),
    });
    let data: Record<string, unknown> = {};
    try { data = await res.json(); } catch { /* vazio */ }
    return { http: res.status, data };
  } catch (e) {
    return { http: 0, data: { errors: [{ description: (e as Error).message }] } };
  }
}
const errMsg = (r: { http: number; data: Record<string, unknown> }) => {
  const e = (r.data.errors as { code?: string; description?: string }[] | undefined)?.[0];
  if (r.http === 401) return "Chave da API do Asaas inválida ou de outro ambiente.";
  return e?.description ?? `Erro ${r.http} no Asaas`;
};

function userClient(req: Request) {
  return createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } }, auth: { persistSession: false } });
}
async function ownerOnly(req: Request, tenant: unknown) {
  if (typeof tenant !== "string" || !UUID.test(tenant)) return "Conta inválida";
  const { data } = await userClient(req).rpc("billing_can_manage", { p_tenant_id: tenant });
  return data === true ? null : "Só o dono da conta gerencia a assinatura.";
}

async function syncPayments(ctx: Ctx, subscriptionId: string) {
  const r = await asaas(ctx, "GET", `/subscriptions/${encodeURIComponent(subscriptionId)}/payments?limit=20`);
  if (r.http !== 200) return errMsg(r);
  for (const p of (r.data.data as Record<string, unknown>[] | undefined) ?? []) {
    await admin.rpc("billing_apply_payment", { p: { ...p, subscription: p.subscription ?? subscriptionId } });
  }
  return null;
}

async function subscribe(req: Request) {
  const b = await req.json().catch(() => ({}));
  const denied = await ownerOnly(req, b.tenant_id);
  if (denied) return json({ error: denied }, 403);
  const { data: c } = await admin.rpc("billing_context", { p_tenant_id: b.tenant_id });
  const ctx = c as Ctx & { tenant: { name: string; status: string; trial_ends_at: string; exempt: boolean }; account: Record<string, string> | null;
    plans: Record<string, { name: string; price_cents: number }> };
  if (!ctx?.enabled || !ctx.api_key) return json({ error: "A cobrança online ainda não foi ativada pela plataforma. Fale com o suporte." }, 409);
  if (ctx.tenant.exempt) return json({ error: "Esta conta é isenta de cobrança." }, 409);
  const plan = ctx.plans?.[b.plan_id];
  if (!plan) return json({ error: "Plano inválido." }, 400);
  const doc = digits(b.cpf_cnpj), phone = digits(b.phone), name = String(b.name ?? "").trim().slice(0, 120), email = String(b.email ?? "").trim().slice(0, 120);
  if (doc.length !== 11 && doc.length !== 14) return json({ error: "Informe um CPF ou CNPJ válido." }, 400);
  if (name.length < 3 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: "Informe o nome e um e-mail válido para a cobrança." }, 400);
  const acc = ctx.account;

  // cliente no Asaas
  const customer = { name, cpfCnpj: doc, email, ...(phone.length >= 10 ? { mobilePhone: phone } : {}), externalReference: b.tenant_id };
  let customerId = acc?.customer_id ?? null;
  const rc = customerId ? await asaas(ctx, "POST", `/customers/${encodeURIComponent(customerId)}`, customer) : await asaas(ctx, "POST", "/customers", customer);
  if (rc.http !== 200) return json({ error: errMsg(rc) }, 502);
  customerId = String(rc.data.id);

  // assinatura: cria (1ª cobrança no fim do teste) ou troca o plano (vale para as faturas em aberto e as próximas)
  const value = plan.price_cents / 100;
  const description = `Domma Food · plano ${plan.name}`;
  let subId = acc?.status === "active" ? acc?.subscription_id ?? null : null;
  let nextDue: string;
  if (subId) {
    const ru = await asaas(ctx, "POST", `/subscriptions/${encodeURIComponent(subId)}`, { value, description, updatePendingPayments: true });
    if (ru.http !== 200) return json({ error: errMsg(ru) }, 502);
    nextDue = String(ru.data.nextDueDate ?? acc?.next_due_date ?? today());
  } else {
    const trialEnd = ctx.tenant.status === "trial" ? new Date(ctx.tenant.trial_ends_at).toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" }) : "";
    nextDue = trialEnd > today() ? trialEnd : today();
    const rs = await asaas(ctx, "POST", "/subscriptions", { customer: customerId, billingType: "UNDEFINED", value, nextDueDate: nextDue,
      cycle: "MONTHLY", description, externalReference: b.tenant_id });
    if (rs.http !== 200) return json({ error: errMsg(rs) }, 502);
    subId = String(rs.data.id);
    nextDue = String(rs.data.nextDueDate ?? nextDue);
  }
  const { error } = await admin.rpc("billing_save_account", { p_tenant_id: b.tenant_id, p: { customer_id: customerId, subscription_id: subId,
    plan_id: b.plan_id, name, cpf_cnpj: doc, email, phone: phone || null, status: "active", next_due_date: nextDue } });
  if (error) return json({ error: "Assinatura criada no Asaas, mas não foi possível salvar. Tente sincronizar." }, 500);
  await syncPayments(ctx, subId);
  return json({ ok: true, subscription_id: subId, next_due_date: nextDue });
}

async function cancel(req: Request) {
  const b = await req.json().catch(() => ({}));
  const denied = await ownerOnly(req, b.tenant_id);
  if (denied) return json({ error: denied }, 403);
  const { data: c } = await admin.rpc("billing_context", { p_tenant_id: b.tenant_id });
  const ctx = c as Ctx & { account: Record<string, string> | null };
  const subId = ctx?.account?.subscription_id;
  if (!subId || ctx.account?.status !== "active") return json({ error: "Não há assinatura ativa." }, 409);
  const r = await asaas(ctx, "DELETE", `/subscriptions/${encodeURIComponent(subId)}`);
  if (r.http !== 200 && r.http !== 404) return json({ error: errMsg(r) }, 502);
  await admin.rpc("billing_save_account", { p_tenant_id: b.tenant_id, p: { status: "canceled", subscription_id: null, next_due_date: null } });
  return json({ ok: true });
}

async function sync(req: Request) {
  const b = await req.json().catch(() => ({}));
  const denied = await ownerOnly(req, b.tenant_id);
  if (denied) {
    const { data: isAdmin } = await userClient(req).rpc("admin_can_billing_test");
    if (isAdmin !== true) return json({ error: denied }, 403);
  }
  const { data: c } = await admin.rpc("billing_context", { p_tenant_id: b.tenant_id });
  const ctx = c as Ctx & { account: Record<string, string> | null };
  if (!ctx?.api_key || !ctx.account?.subscription_id) return json({ ok: true });
  const e = await syncPayments(ctx, ctx.account.subscription_id);
  return e ? json({ error: e }, 502) : json({ ok: true });
}

async function webhook(req: Request) {
  const { data: w } = await admin.rpc("billing_webhook_context");
  const ctx = w as Ctx & { token: string };
  if (!ctx?.token || !safeEqual(req.headers.get("asaas-access-token") ?? "", String(ctx.token))) return json({ error: "Não autorizado" }, 401);
  const body = await req.json().catch(() => null) as { id?: string; event?: string; payment?: Record<string, unknown> } | null;
  if (!body?.event?.startsWith("PAYMENT_") || !body.payment?.id) return json({ ok: true });
  const evId = String(body.id ?? `${body.event}:${body.payment.id}:${body.payment.status ?? ""}`);
  const { data: seen } = await admin.rpc("billing_event_seen", { p_id: evId, p_event: body.event, p_payment: String(body.payment.id) });
  if (seen === true) return json({ ok: true, duplicate: true });
  // fonte da verdade: consulta a cobrança no Asaas (não confia só no corpo do aviso)
  let payment: Record<string, unknown> = body.payment;
  if (ctx.api_key) {
    const r = await asaas(ctx, "GET", `/payments/${encodeURIComponent(String(body.payment.id))}`);
    if (r.http === 200) payment = r.data;
    else if (r.http === 404 && body.event === "PAYMENT_DELETED") payment = { ...body.payment, status: "DELETED" };
    else if (r.http !== 404) {
      await admin.rpc("billing_event_forget", { p_id: evId }).then(() => {}, () => {});
      return json({ error: "Asaas indisponível" }, 503);
    }
  }
  if (body.event === "PAYMENT_DELETED") payment = { ...payment, status: "DELETED" };
  await admin.rpc("billing_apply_payment", { p: payment });
  return json({ ok: true });
}

async function test(req: Request) {
  const { data: isAdmin } = await userClient(req).rpc("admin_can_billing_test");
  if (isAdmin !== true) return json({ error: "Só o administrador da plataforma." }, 403);
  const { data: w } = await admin.rpc("billing_webhook_context");
  const ctx = w as Ctx;
  if (!ctx?.api_key) return json({ ok: false, message: "Salve a chave da API primeiro." });
  const r = await asaas(ctx, "GET", "/finance/balance");
  const ok = r.http === 200;
  const message = ok ? `Conectado ao Asaas (${ctx.env === "production" ? "produção" : "sandbox"}).` : `O Asaas recusou: ${errMsg(r)}`;
  await admin.rpc("billing_test_result", { p_ok: ok, p_message: message });
  return json({ ok, message });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "Método não permitido" }, 405);
  const path = new URL(req.url).pathname.replace(/^.*\/billing/, "") || "/";
  try {
    if (path === "/webhook") return await webhook(req);
    if (path === "/subscribe") return await subscribe(req);
    if (path === "/cancel") return await cancel(req);
    if (path === "/sync") return await sync(req);
    if (path === "/test") return await test(req);
    return json({ error: "Rota não encontrada" }, 404);
  } catch (e) {
    console.error(e);
    return json({ error: "Erro interno" }, 500);
  }
});
