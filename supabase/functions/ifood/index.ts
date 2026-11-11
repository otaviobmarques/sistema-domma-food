// Domma Food · Integração iFood (Merchant API, aplicativo distribuído)
//   POST /ifood/connect/start    {unit_id}                     → gera o código de vínculo (gestor da loja)
//   POST /ifood/connect/finish   {unit_id, authorization_code} → troca o código de autorização por tokens
//   POST /ifood/connect/merchant {unit_id, merchant_id}        → escolhe a loja do iFood (se houver mais de uma)
//   POST /ifood/status           {unit_id}                     → status da loja no iFood
//   POST /ifood/test                                           → valida o app (super admin)
//   POST /ifood/worker           {job: all|poll|outbox}        → polling de eventos + fila de status (x-worker-secret)
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
    return json({ error: "Rota não encontrada" }, 404);
  } catch (e) {
    console.error(e);
    return json({ error: e instanceof Error && e.message.includes("iFood") ? e.message : "Erro interno" }, 500);
  }
});
