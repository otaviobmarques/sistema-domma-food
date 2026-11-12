// Domma Food · Notificações no aparelho do cliente (Web Push)
//   GET  /push/key      → chave pública VAPID (gera o par na primeira vez; a privada fica no Vault)
//   POST /push/worker   → envia a fila de avisos de pedido (x-worker-secret; chamado pelo banco e pelo cron)
import { createClient } from "npm:@supabase/supabase-js@2.119.0";
import { generateVapidKeys, sendPush, type VapidKeys } from "./webpush.ts";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const SUBJECT = "https://domma-food.vercel.app";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "authorization, apikey, content-type" };
const json = (b: unknown, s = 200, h: Record<string, string> = {}) =>
  new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json", ...h } });
function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

let cached: VapidKeys | null = null;
async function keys(): Promise<VapidKeys> {
  if (cached) return cached;
  const { data, error } = await admin.rpc("push_vapid_get");
  if (error) throw error;
  let v = data as { public: string | null; private: string | null };
  if (!v.public || !v.private) {
    const k = await generateVapidKeys();
    const r = await admin.rpc("push_vapid_init", { p_public: k.publicKey, p_private: JSON.stringify(k.privateJwk) });
    if (r.error) throw r.error;
    v = r.data as { public: string; private: string };
  }
  cached = { publicKey: v.public!, privateJwk: JSON.parse(v.private!) };
  return cached;
}

type Job = { id: number; endpoint: string; p256dh: string; auth: string; payload: Record<string, unknown>; urgent: boolean };

async function worker(req: Request) {
  const { data: expected } = await admin.rpc("push_worker_secret");
  const s = req.headers.get("x-worker-secret") ?? "";
  if (!expected || !s || !safeEqual(s, String(expected))) return json({ error: "Proibido" }, 403);
  const k = await keys();
  let sent = 0, failed = 0, gone = 0;
  for (let round = 0; round < 5; round++) {
    const { data, error } = await admin.rpc("push_jobs", { p_limit: 50 });
    if (error) return json({ error: error.message }, 500);
    const jobs = (data ?? []) as Job[];
    if (!jobs.length) break;
    await Promise.all(jobs.map(async (j) => {
      let r;
      try { r = await sendPush(j, j.payload, k, SUBJECT, { urgency: j.urgent ? "high" : "normal", ttl: 6 * 3600 }); }
      catch (e) { r = { ok: false, gone: false, status: 0, error: `Sem resposta do serviço de push (${(e as Error).message.slice(0, 120)})` }; }
      await admin.rpc("push_job_result", { p_id: j.id, p_ok: r.ok, p_gone: r.gone, p_error: r.ok ? null : r.error });
      if (r.ok) sent++; else if (r.gone) gone++; else failed++;
    }));
  }
  return json({ sent, failed, gone });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  const path = new URL(req.url).pathname.replace(/^.*\/push/, "") || "/";
  try {
    if (path === "/key" && req.method === "GET") return json({ public_key: (await keys()).publicKey }, 200, { ...cors, "Cache-Control": "public, max-age=3600" });
    if (path === "/worker" && req.method === "POST") return await worker(req);
    return json({ error: "Rota não encontrada" }, 404);
  } catch (e) {
    console.error(e);
    return json({ error: "Erro interno" }, 500, cors);
  }
});
