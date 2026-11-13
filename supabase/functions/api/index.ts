// Domma Food · API pública e webhooks
//   Authorization: Bearer dmf_...  (chave criada em Integrações › API e webhooks)
//   GET   /api/v1/me
//   GET   /api/v1/orders?status=&since=&before=&unit_id=&limit=
//   GET   /api/v1/orders/{id}
//   POST  /api/v1/orders/{id}/status   {"status":"preparing","reason":"..."}
//   GET   /api/v1/menu?unit_id=
//   PATCH /api/v1/products/{id}        {"available":false} | {"price_cents":1990,"unit_id":"..."}
//   GET   /api/v1/customers?since=&before=&limit=
//   POST  /api/webhooks/worker         → entrega a fila de webhooks (x-worker-secret)
import { createClient } from "npm:@supabase/supabase-js@2.119.0";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const sha256 = async (s: string) => hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
async function hmacHex(secret: string, msg: string) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
}
function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
// sem CORS: a chave é para servidor, não para navegador
const json = (b: unknown, s = 200, h: Record<string, string> = {}) =>
  new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json; charset=utf-8", ...h } });
const ERR: Record<string, [number, string]> = {
  invalid_key: [401, "Chave de API inválida ou revogada."],
  rate_limited: [429, "Limite de 120 chamadas por minuto atingido. Tente de novo em instantes."],
  forbidden: [403, "A chave não tem permissão para esta operação."],
  not_found: [404, "Não encontrado."],
  invalid: [400, "Requisição inválida."],
};
const fail = (code: string, message?: string) => {
  const [s, m] = ERR[code] ?? [400, "Requisição inválida."];
  return json({ error: { code, message: message ?? m } }, s, code === "rate_limited" ? { "Retry-After": "30" } : {});
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function api(req: Request, path: string, url: URL) {
  const auth = req.headers.get("authorization") ?? "";
  const key = auth.match(/^Bearer\s+(dmf_[a-f0-9]{48})$/)?.[1];
  if (!key) return fail("invalid_key");
  const { data: ctx, error } = await admin.rpc("api_auth", { p_key_hash: await sha256(key) });
  if (error) { console.error(error); return json({ error: { code: "internal", message: "Erro interno." } }, 500); }
  if (ctx?.error) return fail(ctx.error);
  const q = Object.fromEntries([...url.searchParams].filter(([k]) => ["status", "since", "before", "until", "unit_id", "limit"].includes(k)));
  const body = async () => { try { const b = await req.json(); return b && typeof b === "object" && !Array.isArray(b) ? b : null; } catch { return null; } };
  let op: string, p: Record<string, unknown> = {};
  let m: RegExpMatchArray | null;
  if (req.method === "GET" && path === "/v1/me") op = "me";
  else if (req.method === "GET" && path === "/v1/orders") { op = "orders.list"; p = q; }
  else if (req.method === "GET" && (m = path.match(/^\/v1\/orders\/([^/]+)$/))) { op = "orders.get"; p = { id: m[1] }; }
  else if (req.method === "POST" && (m = path.match(/^\/v1\/orders\/([^/]+)\/status$/))) {
    const b = await body();
    if (!b || typeof b.status !== "string") return fail("invalid", 'Envie {"status": "..."}.');
    op = "orders.status"; p = { id: m[1], status: b.status, reason: typeof b.reason === "string" ? b.reason : null };
  }
  else if (req.method === "GET" && path === "/v1/menu") { op = "menu.get"; p = q.unit_id ? { unit_id: q.unit_id } : {}; }
  else if (req.method === "PATCH" && (m = path.match(/^\/v1\/products\/([^/]+)$/))) {
    const b = await body();
    if (!b) return fail("invalid", "Envie um JSON.");
    p = { id: m[1] };
    if (typeof b.available === "boolean") p.available = b.available;
    if (Number.isInteger(b.price_cents)) p.price_cents = b.price_cents;
    if (typeof b.unit_id === "string") p.unit_id = b.unit_id;
    if (typeof b.paused_until === "string") p.paused_until = b.paused_until;
    if (Object.keys(p).length === 1) return fail("invalid", "Nada para alterar: use available, price_cents ou paused_until.");
    op = "products.update";
  }
  else if (req.method === "GET" && path === "/v1/customers") { op = "customers.list"; p = q; }
  else return fail("not_found", "Rota não encontrada. Veja a documentação em /desenvolvedores.");
  if (p.id != null && !UUID.test(String(p.id))) return fail("not_found");
  if (p.unit_id != null && !UUID.test(String(p.unit_id))) return fail("invalid", "unit_id inválido.");
  const { data, error: e2 } = await admin.rpc("api_call", { p_key_id: ctx.key_id, p_op: op, p });
  if (e2) { console.error(e2); return json({ error: { code: "internal", message: "Erro interno." } }, 500); }
  if (data?.error) return fail(data.error, data.message);
  return json(data);
}

// ---------- Webhooks ----------
const PRIVATE_V4 = [/^10\./, /^127\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^0\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./];
async function publicHost(host: string) {
  // o banco já recusa IP/localhost; aqui conferimos para onde o domínio aponta (sem rede interna)
  try {
    const v4 = await Deno.resolveDns(host, "A").catch(() => [] as string[]);
    const v6 = await Deno.resolveDns(host, "AAAA").catch(() => [] as string[]);
    if (!v4.length && !v6.length) return false;
    if (v4.some((ip) => PRIVATE_V4.some((r) => r.test(ip)))) return false;
    if (v6.some((ip) => /^(::1|fc|fd|fe80|::ffff:)/i.test(ip))) return false;
    return true;
  } catch { return true; }   // sem resolução de DNS disponível: segue a validação do banco
}

type Job = { id: number; url: string; event_id: string; event: string; payload: unknown; secret: string };

async function deliver(j: Job) {
  const u = new URL(j.url);
  if (u.protocol !== "https:" || !(await publicHost(u.hostname))) return { ok: false, code: null, error: "Endereço não permitido (rede interna ou sem DNS)." };
  const body = JSON.stringify(j.payload);
  const t = Math.floor(Date.now() / 1000);
  const sig = await hmacHex(j.secret, `${t}.${body}`);
  try {
    const r = await fetch(j.url, {
      method: "POST", redirect: "manual", signal: AbortSignal.timeout(10_000), body,
      headers: { "Content-Type": "application/json", "User-Agent": "DommaFood-Webhooks/1.0",
        "Domma-Event": j.event, "Domma-Delivery": j.event_id, "Domma-Signature": `t=${t},v1=${sig}` },
    });
    await r.body?.cancel();
    return r.status >= 200 && r.status < 300 ? { ok: true, code: r.status, error: null } : { ok: false, code: r.status, error: `Respondeu ${r.status}` };
  } catch (e) {
    return { ok: false, code: null, error: `Sem resposta (${(e as Error).message.slice(0, 120)})` };
  }
}

async function worker(req: Request) {
  const { data: expected } = await admin.rpc("api_worker_secret");
  const s = req.headers.get("x-worker-secret") ?? "";
  if (!expected || !s || !safeEqual(s, String(expected))) return json({ error: "Proibido" }, 403);
  let sent = 0, failed = 0;
  for (let round = 0; round < 4; round++) {
    const { data, error } = await admin.rpc("webhook_jobs", { p_limit: 50 });
    if (error) return json({ error: error.message }, 500);
    const jobs = (data ?? []) as Job[];
    if (!jobs.length) break;
    await Promise.all(jobs.map(async (j) => {
      const r = await deliver(j);
      await admin.rpc("webhook_job_result", { p_id: j.id, p_ok: r.ok, p_code: r.code, p_error: r.error });
      if (r.ok) sent++; else failed++;
    }));
  }
  return json({ sent, failed });
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^.*?\/api(?=\/)/, "").replace(/\/+$/, "") || "/";
  try {
    if (path === "/webhooks/worker" && req.method === "POST") return await worker(req);
    if (path.startsWith("/v1/")) return await api(req, path, url);
    return fail("not_found", "Rota não encontrada. Veja a documentação em /desenvolvedores.");
  } catch (e) {
    console.error(e);
    return json({ error: { code: "internal", message: "Erro interno." } }, 500);
  }
});
