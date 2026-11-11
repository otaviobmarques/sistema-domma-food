// Domma Food · NFC-e via Focus NFe (API v2)
//   POST /fiscal/worker  → processa a fila de emissão e cancelamento (x-worker-secret)
//   POST /fiscal/test    → testa o token do provedor da loja (JWT do dono da conta)
// A nota é montada no banco (private.fiscal_payload); aqui só acontece o HTTP.
import { createClient } from "npm:@supabase/supabase-js@2.119.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const HOSTS = { homologacao: "https://homologacao.focusnfe.com.br", producao: "https://api.focusnfe.com.br" } as const;
type Env = keyof typeof HOSTS;
type Job = { id: string; action: "emit" | "emit_or_consult" | "cancel"; environment: Env; ref: string; token: string; payload?: unknown; reason?: string };

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS } });

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function focus(env: Env, token: string, method: string, path: string, body?: unknown) {
  const host = HOSTS[env] ?? HOSTS.homologacao;
  try {
    const res = await fetch(`${host}/v2${path}`, {
      method,
      headers: { Authorization: "Basic " + btoa(`${token}:`), "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(45_000),
    });
    let data: Record<string, unknown> = {};
    try { data = await res.json(); } catch { data = { mensagem: `Resposta inválida do provedor (HTTP ${res.status})` }; }
    // caminhos de arquivo vêm relativos ao host
    for (const k of ["caminho_xml_nota_fiscal", "caminho_danfe", "caminho_xml_cancelamento"]) {
      const v = data[k];
      if (typeof v === "string" && v.startsWith("/")) data[k] = host + v;
    }
    return { http: res.status, data };
  } catch (e) {
    return { http: 0, data: { mensagem: `Falha de comunicação com o provedor: ${(e as Error).message}` } };
  }
}

async function runJob(j: Job) {
  const ref = encodeURIComponent(j.ref);
  let r;
  if (j.action === "cancel") {
    r = await focus(j.environment, j.token, "DELETE", `/nfce/${ref}`, { justificativa: j.reason });
  } else {
    if (j.action === "emit_or_consult") {
      // tentativa anterior pode ter chegado ao provedor: consulta antes de reenviar
      const c = await focus(j.environment, j.token, "GET", `/nfce/${ref}`);
      if (c.http === 200 && c.data.status && c.data.status !== "processando_autorizacao") r = c;
      else if (c.http === 200) r = { http: 503, data: { mensagem: "Nota em processamento no provedor" } };
    }
    if (!r) r = await focus(j.environment, j.token, "POST", `/nfce?ref=${ref}`, j.payload);
    if (r.http === 422 && r.data.codigo === "already_processed") r = await focus(j.environment, j.token, "GET", `/nfce/${ref}`);
  }
  const { data, error } = await admin.rpc("fiscal_job_result", { p_id: j.id, p_http: r.http, p_body: r.data });
  return { id: j.id, action: j.action, http: r.http, status: error ? `erro: ${error.message}` : data };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const path = new URL(req.url).pathname.replace(/^.*\/fiscal/, "") || "/";
  if (req.method !== "POST") return json({ error: "Método não permitido" }, 405);

  if (path === "/worker") {
    const given = req.headers.get("x-worker-secret") ?? "";
    const { data: secret } = await admin.rpc("fiscal_worker_secret");
    if (!secret || !safeEqual(given, String(secret))) return json({ error: "Não autorizado" }, 401);
    const done = [];
    for (let round = 0; round < 3; round++) {
      const { data: jobs, error } = await admin.rpc("fiscal_jobs", { p_limit: 10 });
      if (error) return json({ error: error.message }, 500);
      if (!Array.isArray(jobs) || jobs.length === 0) break;
      done.push(...(await Promise.all((jobs as Job[]).map(runJob))));
    }
    return json({ processed: done.length, results: done.map(({ id, action, http, status }) => ({ id, action, http, status })) });
  }

  if (path === "/test") {
    const auth = req.headers.get("Authorization") ?? "";
    const user = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
    const { unit_id } = await req.json().catch(() => ({}));
    if (typeof unit_id !== "string") return json({ error: "Loja inválida" }, 400);
    const { data: can } = await user.rpc("fiscal_can_test", { p_unit_id: unit_id });
    if (can !== true) return json({ error: "Só o dono da conta testa a conexão fiscal." }, 403);
    const { data: cfg } = await admin.rpc("fiscal_test_token", { p_unit_id: unit_id });
    if (!cfg?.token) return json({ ok: false, message: "Salve o token do provedor primeiro." });
    // consulta uma referência inexistente: 404 = token aceito; 401/403 = token recusado
    const r = await focus(cfg.environment, cfg.token, "GET", `/nfce/teste-conexao-domma`);
    const ok = r.http === 404 || r.http === 200;
    const message = ok ? `Conexão com o provedor OK (${cfg.environment === "producao" ? "produção" : "homologação"}).`
      : r.http === 401 || r.http === 403 ? "O provedor recusou o token. Confira o token e o ambiente."
      : `O provedor respondeu HTTP ${r.http}: ${String(r.data.mensagem ?? "").slice(0, 200)}`;
    await admin.rpc("fiscal_test_result", { p_unit_id: unit_id, p_ok: ok, p_message: message });
    return json({ ok, message });
  }
  return json({ error: "Rota não encontrada" }, 404);
});
