// Domma Food · Domínio próprio por loja (API da Vercel)
//   POST /domains/add    {unit_id, domain} → cadastra no projeto da Vercel e devolve o DNS a configurar (gestor da loja)
//   POST /domains/check  {unit_id}         → confere DNS/verificação e ativa
//   POST /domains/remove {unit_id}         → remove o domínio
//   POST /domains/test                     → testa o token (super admin)
//   POST /domains/worker                   → confere pendentes (x-worker-secret)
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
const DOMAIN = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;
const BLOCKED = /(^|\.)(vercel\.app|vercel\.com|supabase\.co|supabase\.in|dommafood\.com\.br|dommafood\.com)$/;
function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

type Ctx = { project_id: string; team_id: string | null; token: string | null };
async function ctx(): Promise<Ctx> {
  const { data } = await admin.rpc("domains_context");
  const c = data as Ctx | null;
  if (!c?.token) throw new Error("O domínio próprio ainda não foi liberado pela plataforma.");
  return c;
}
async function vercel(c: Ctx, method: string, path: string, body?: unknown) {
  const url = new URL("https://api.vercel.com" + path);
  if (c.team_id) url.searchParams.set("teamId", c.team_id);
  try {
    const res = await fetch(url, { method, headers: { Authorization: `Bearer ${c.token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
    let data: Record<string, unknown> = {};
    try { data = await res.json(); } catch { /* vazio */ }
    return { http: res.status, data };
  } catch (e) {
    return { http: 0, data: { error: { message: (e as Error).message } } };
  }
}
const errOf = (r: { http: number; data: Record<string, unknown> }) => {
  const e = r.data.error as { code?: string; message?: string } | undefined;
  return { code: e?.code ?? String(r.http), message: e?.message ?? `Erro ${r.http} na Vercel` };
};

type Rec = { type: string; name: string; value: string; reason?: string };
/** Confere o domínio na Vercel e monta os registros de DNS que faltam. */
async function inspect(c: Ctx, domain: string) {
  const pid = encodeURIComponent(c.project_id), d = encodeURIComponent(domain);
  let info = await vercel(c, "GET", `/v9/projects/${pid}/domains/${d}`);
  if (info.http === 404) return { exists: false } as const;
  if (info.http !== 200) throw new Error(errOf(info).message);
  if (info.data.verified === false) {
    const v = await vercel(c, "POST", `/v9/projects/${pid}/domains/${d}/verify`);
    if (v.http === 200) info = v;
  }
  const cfg = await vercel(c, "GET", `/v6/domains/${d}/config`);
  const apex = String(info.data.apexName ?? domain);
  const isApex = apex === domain;
  const ipv4 = ((cfg.data.recommendedIPv4 as { rank: number; value: string[] }[] | undefined) ?? []).sort((a, b) => a.rank - b.rank)[0]?.value?.[0] ?? "76.76.21.21";
  const cname = (((cfg.data.recommendedCNAME as { rank: number; value: string }[] | undefined) ?? []).sort((a, b) => a.rank - b.rank)[0]?.value ?? "cname.vercel-dns.com").replace(/\.$/, "");
  const recs: Rec[] = isApex ? [{ type: "A", name: "@", value: ipv4 }] : [{ type: "CNAME", name: domain.slice(0, -(apex.length + 1)), value: cname }];
  for (const v of (info.data.verification as { type: string; domain: string; value: string; reason?: string }[] | undefined) ?? []) {
    recs.push({ type: v.type, name: v.domain.endsWith("." + apex) ? v.domain.slice(0, -(apex.length + 1)) : v.domain, value: v.value, reason: v.reason });
  }
  const verified = info.data.verified !== false;
  const configured = cfg.http === 200 && cfg.data.misconfigured === false;
  return { exists: true, active: verified && configured, verified, configured, recs, apex } as const;
}

async function check(c: Ctx, unitId: string, domain: string) {
  try {
    const r = await inspect(c, domain);
    if (!r.exists) {
      await admin.rpc("domain_upsert", { p_unit_id: unitId, p_domain: domain, p_status: "error", p_dns: null, p_error: "Domínio não está mais cadastrado na plataforma. Remova e adicione de novo." });
      return { status: "error" };
    }
    const msg = r.active ? null : !r.verified ? "Aguardando o registro TXT de verificação." : "Aguardando o DNS apontar para o Domma (pode levar até algumas horas).";
    await admin.rpc("domain_upsert", { p_unit_id: unitId, p_domain: domain, p_status: r.active ? "active" : "pending", p_dns: r.recs, p_error: msg });
    return { status: r.active ? "active" : "pending", dns: r.recs };
  } catch (e) {
    await admin.rpc("domain_upsert", { p_unit_id: unitId, p_domain: domain, p_status: "error", p_dns: null, p_error: (e as Error).message });
    return { status: "error", error: (e as Error).message };
  }
}

function userClient(req: Request) {
  return createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } }, auth: { persistSession: false } });
}
async function guard(req: Request) {
  const b = await req.json().catch(() => ({}));
  if (typeof b.unit_id !== "string" || !UUID.test(b.unit_id)) return { error: json({ error: "Loja inválida" }, 400) };
  const { data } = await userClient(req).rpc("domain_can_manage", { p_unit_id: b.unit_id });
  if (data !== true) return { error: json({ error: "Só o dono ou a gerência configuram o domínio." }, 403) };
  const { data: cur } = await admin.from("unit_domains").select("domain").eq("unit_id", b.unit_id).maybeSingle();
  return { b, current: (cur as { domain: string } | null)?.domain ?? null };
}

async function add(req: Request) {
  const g = await guard(req); if (g.error) return g.error;
  const domain = String(g.b.domain ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/\.$/, "");
  if (!DOMAIN.test(domain) || domain.length > 253) return json({ error: "Domínio inválido. Exemplo: pedidos.minhaloja.com.br" }, 400);
  if (BLOCKED.test(domain)) return json({ error: "Use um domínio seu (não da Vercel nem do Domma)." }, 400);
  const { data: taken } = await admin.from("unit_domains").select("unit_id").eq("domain", domain).maybeSingle();
  if (taken && (taken as { unit_id: string }).unit_id !== g.b.unit_id) return json({ error: "Este domínio já está em uso por outra loja." }, 409);
  const c = await ctx();
  const pid = encodeURIComponent(c.project_id);
  if (g.current && g.current !== domain) await vercel(c, "DELETE", `/v9/projects/${pid}/domains/${encodeURIComponent(g.current)}`);
  const r = await vercel(c, "POST", `/v10/projects/${pid}/domains`, { name: domain });
  if (r.http !== 200 && !(r.http === 409 && ["domain_already_in_use", "domain_already_exists"].includes(errOf(r).code) && g.current === domain)) {
    const e = errOf(r);
    const human = e.code === "domain_already_in_use" ? "Este domínio já está ligado a outro projeto na Vercel. Remova-o de lá ou fale com o suporte."
      : e.code === "invalid_domain" ? "A Vercel não aceitou este domínio. Confira se ele existe e está registrado." : e.message;
    return json({ error: human }, 400);
  }
  return json({ ok: true, ...(await check(c, g.b.unit_id, domain)) });
}

async function checkRoute(req: Request) {
  const g = await guard(req); if (g.error) return g.error;
  if (!g.current) return json({ error: "Nenhum domínio cadastrado." }, 404);
  return json({ ok: true, ...(await check(await ctx(), g.b.unit_id, g.current)) });
}

async function remove(req: Request) {
  const g = await guard(req); if (g.error) return g.error;
  if (g.current) {
    const c = await ctx();
    const r = await vercel(c, "DELETE", `/v9/projects/${encodeURIComponent(c.project_id)}/domains/${encodeURIComponent(g.current)}`);
    if (r.http !== 200 && r.http !== 404) return json({ error: errOf(r).message }, 502);
  }
  await admin.rpc("domain_delete", { p_unit_id: g.b.unit_id });
  return json({ ok: true });
}

async function test(req: Request) {
  const { data: isAdmin } = await userClient(req).rpc("admin_can_billing_test");
  if (isAdmin !== true) return json({ error: "Só o administrador da plataforma." }, 403);
  let ok = false, message = "";
  try {
    const c = await ctx();
    const r = await vercel(c, "GET", `/v9/projects/${encodeURIComponent(c.project_id)}`);
    ok = r.http === 200;
    message = ok ? `Conectado ao projeto ${String(r.data.name ?? c.project_id)} na Vercel.` : `A Vercel recusou: ${errOf(r).message}`;
  } catch (e) { message = (e as Error).message; }
  await admin.rpc("domains_test_result", { p_ok: ok, p_message: message });
  return json({ ok, message });
}

async function worker(req: Request) {
  const s = req.headers.get("x-worker-secret") ?? "";
  const { data: expected } = await admin.rpc("domains_worker_secret");
  if (!expected || !s || !safeEqual(s, String(expected))) return json({ error: "Proibido" }, 403);
  const { data } = await admin.rpc("domains_to_check");
  const list = (data ?? []) as { unit_id: string; domain: string }[];
  if (!list.length) return json({ checked: 0 });
  const c = await ctx();
  let active = 0;
  for (const d of list.slice(0, 50)) { if ((await check(c, d.unit_id, d.domain)).status === "active") active++; }
  return json({ checked: Math.min(list.length, 50), active });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "Método não permitido" }, 405);
  const path = new URL(req.url).pathname.replace(/^.*\/domains/, "") || "/";
  try {
    if (path === "/add") return await add(req);
    if (path === "/check") return await checkRoute(req);
    if (path === "/remove") return await remove(req);
    if (path === "/test") return await test(req);
    if (path === "/worker") return await worker(req);
    return json({ error: "Rota não encontrada" }, 404);
  } catch (e) {
    console.error(e);
    const m = (e as Error).message ?? "";
    return json({ error: m.includes("plataforma") ? m : "Erro interno" }, 500);
  }
});
