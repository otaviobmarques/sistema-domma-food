// Domma Food · App Store: avisos de instalação aos apps de parceiros
//   POST /apps/worker → entrega app.installed / app.uninstalled no install_url do app (x-worker-secret)
// A mensagem vai assinada com o segredo do app: Domma-Signature: t=<unix>,v1=<HMAC-SHA256(segredo, "t.corpo")>.
// O parceiro confirma a instalação respondendo 2xx; sem confirmação (4 tentativas) a instalação falha e a chave é revogada.
import { createClient } from "npm:@supabase/supabase-js@2.119.0";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
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
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json; charset=utf-8" } });

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
  } catch { return true; }
}

type Job = { id: number; url: string; event: string; secret: string | null; payload: Record<string, unknown> };

async function deliver(j: Job) {
  if (!j.secret) return { ok: false, code: null, error: "App sem segredo de assinatura." };
  const u = new URL(j.url);
  if (u.protocol !== "https:" || !(await publicHost(u.hostname))) return { ok: false, code: null, error: "Endereço não permitido (rede interna ou sem DNS)." };
  const body = JSON.stringify(j.payload);
  const t = Math.floor(Date.now() / 1000);
  const sig = await hmacHex(j.secret, `${t}.${body}`);
  try {
    const r = await fetch(j.url, {
      method: "POST", redirect: "manual", signal: AbortSignal.timeout(10_000), body,
      headers: { "Content-Type": "application/json", "User-Agent": "DommaFood-Apps/1.0",
        "Domma-Event": j.event, "Domma-Delivery": String(j.id), "Domma-Signature": `t=${t},v1=${sig}` },
    });
    await r.body?.cancel();
    return r.status >= 200 && r.status < 300 ? { ok: true, code: r.status, error: null } : { ok: false, code: r.status, error: `Respondeu ${r.status}` };
  } catch (e) {
    return { ok: false, code: null, error: `Sem resposta (${(e as Error).message.slice(0, 120)})` };
  }
}

async function worker(req: Request) {
  const { data: expected } = await admin.rpc("apps_worker_secret");
  const s = req.headers.get("x-worker-secret") ?? "";
  if (!expected || !s || !safeEqual(s, String(expected))) return json({ error: "Proibido" }, 403);
  let sent = 0, failed = 0;
  for (let round = 0; round < 4; round++) {
    const { data, error } = await admin.rpc("app_event_jobs", { p_limit: 20 });
    if (error) return json({ error: error.message }, 500);
    const jobs = (data ?? []) as Job[];
    if (!jobs.length) break;
    await Promise.all(jobs.map(async (j) => {
      const r = await deliver(j);
      await admin.rpc("app_event_result", { p_id: j.id, p_ok: r.ok, p_code: r.code, p_error: r.error });
      if (r.ok) sent++; else failed++;
    }));
  }
  return json({ sent, failed });
}

Deno.serve(async (req) => {
  const path = new URL(req.url).pathname.replace(/^.*\/apps/, "") || "/";
  if (req.method !== "POST") return json({ error: "Método não permitido" }, 405);
  try {
    if (path === "/worker") return await worker(req);
    return json({ error: "Rota não encontrada" }, 404);
  } catch (e) {
    console.error(e);
    return json({ error: "Erro interno" }, 500);
  }
});
