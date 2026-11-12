// Domma Food · Integrações de gestão
//   POST /erp/f360/worker   → envia a fila de cupons ao "Webhook F360 - PDV" de cada loja (x-worker-secret, chamado pelo cron)
import { createClient } from "npm:@supabase/supabase-js@2.119.0";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });
function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

type Job = { id: number; unit_id: string; url: string; payload: unknown };

async function f360Worker(req: Request) {
  const { data: expected } = await admin.rpc("erp_worker_secret");
  const s = req.headers.get("x-worker-secret") ?? "";
  if (!expected || !s || !safeEqual(s, String(expected))) return json({ error: "Proibido" }, 403);
  const { data, error } = await admin.rpc("f360_jobs", { p_limit: 40 });
  if (error) return json({ error: error.message }, 500);
  let sent = 0, failed = 0;
  for (const j of (data ?? []) as Job[]) {
    let ok = false, msg = "";
    // só envia para o domínio do F360 (a URL é validada também ao salvar)
    if (!/^https:\/\/webhook\.f360\.com\.br\/[A-Za-z0-9_-]+\/f360-cupom-fiscal$/.test(j.url)) msg = "URL do F360 inválida";
    else {
      try {
        const r = await fetch(j.url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(j.payload), signal: AbortSignal.timeout(20_000) });
        ok = r.ok;
        if (!ok) msg = `O F360 respondeu ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`;
      } catch (e) { msg = `Sem resposta do F360 (${(e as Error).message.slice(0, 120)})`; }
    }
    await admin.rpc("f360_job_result", { p_id: j.id, p_ok: ok, p_error: ok ? null : msg });
    if (ok) sent++; else failed++;
  }
  return json({ sent, failed });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Método não permitido" }, 405);
  const path = new URL(req.url).pathname.replace(/^.*\/erp/, "") || "/";
  try {
    if (path === "/f360/worker") return await f360Worker(req);
    return json({ error: "Rota não encontrada" }, 404);
  } catch (e) {
    console.error(e);
    return json({ error: "Erro interno" }, 500);
  }
});
