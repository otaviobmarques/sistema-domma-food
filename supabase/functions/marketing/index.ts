// Domma Food · Marketing via WhatsApp Cloud API (Meta)
//   POST /marketing/worker            → envia avisos de pedido e a fila das campanhas (x-worker-secret)
//   GET  /marketing/webhook?tenant=   → verificação do webhook (hub.challenge)
//   POST /marketing/webhook?tenant=   → status (enviado/entregue/lido/falhou) e respostas (SAIR); assinatura X-Hub-Signature-256
//   POST /marketing/test {tenant_id}  → testa número e token (JWT do dono da conta)
//   POST /marketing/inbox/send {conversation_id, text, order_id?} → responde o cliente (JWT da equipe; janela de 24 h)
import { createClient } from "npm:@supabase/supabase-js@2.119.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json", ...CORS } });
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
const UUID = /^[0-9a-f-]{36}$/;

async function graph(version: string, token: string, method: string, path: string, body?: unknown) {
  try {
    const res = await fetch(`https://graph.facebook.com/${version}/${path}`, {
      method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20_000),
    });
    let data: Record<string, unknown> = {};
    try { data = await res.json(); } catch { /* vazio */ }
    return { http: res.status, data };
  } catch (e) {
    return { http: 0, data: { error: { message: (e as Error).message } } };
  }
}
const errMsg = (d: Record<string, unknown>) => {
  const e = d.error as { message?: string; error_user_msg?: string; code?: number } | undefined;
  return e ? `${e.code ?? ""} ${e.error_user_msg ?? e.message ?? ""}`.trim() : "Erro desconhecido";
};

type Job = { id: number; to: string; params: string[]; template: string; lang: string; phone_number_id: string; version: string; token: string };

async function sendTemplate(j: Job) {
  const body = {
    messaging_product: "whatsapp", to: j.to, type: "template",
    template: { name: j.template, language: { code: j.lang },
      ...(j.params?.length ? { components: [{ type: "body", parameters: j.params.map((t) => ({ type: "text", text: String(t).slice(0, 1000) || "-" })) }] } : {}) },
  };
  const r = await graph(j.version, j.token, "POST", `${j.phone_number_id}/messages`, body);
  const waId = (r.data.messages as { id: string }[] | undefined)?.[0]?.id ?? null;
  const ok = r.http === 200 && !!waId;
  return { ok, waId, error: ok ? null : errMsg(r.data) };
}

async function worker(req: Request) {
  const { data: secret } = await admin.rpc("marketing_worker_secret");
  if (!secret || !safeEqual(req.headers.get("x-worker-secret") ?? "", String(secret))) return json({ error: "Não autorizado" }, 401);
  let sent = 0, failed = 0;
  // 1) avisos de status do pedido: urgentes, sem janela de horário
  const { data: sjobs, error: serr } = await admin.rpc("status_jobs", { p_limit: 50 });
  if (serr) console.error(serr);
  for (const j of (sjobs ?? []) as Job[]) {
    const r = await sendTemplate(j);
    await admin.rpc("status_job_result", { p_id: j.id, p_ok: r.ok, p_wa_id: r.waId, p_error: r.error });
    if (r.ok) sent++; else failed++;
  }
  // 2) campanhas (respeitam a janela de envio da loja)
  const { data: jobs, error } = await admin.rpc("marketing_jobs", { p_limit: 50 });
  if (error) return json({ error: error.message }, 500);
  for (const j of (jobs ?? []) as Job[]) {
    const r = await sendTemplate(j);
    await admin.rpc("marketing_job_result", { p_id: j.id, p_ok: r.ok, p_wa_id: r.waId, p_error: r.error });
    if (r.ok) sent++; else failed++;
    await new Promise((res) => setTimeout(res, 120));   // ritmo moderado para não estourar limites da Meta
  }
  return json({ sent, failed });
}

type InMsg = {
  from: string; id: string; type: string; timestamp?: string;
  text?: { body?: string }; button?: { text?: string };
  image?: { caption?: string }; video?: { caption?: string }; document?: { caption?: string; filename?: string };
  interactive?: { button_reply?: { title?: string }; list_reply?: { title?: string } };
  location?: { latitude?: number; longitude?: number; name?: string; address?: string };
  reaction?: { emoji?: string };
};
/** Texto que aparece na conversa (mídias ficam no celular: mostramos a legenda). */
function inboundText(m: InMsg): string | null {
  switch (m.type) {
    case "text": return m.text?.body ?? null;
    case "button": return m.button?.text ?? null;
    case "interactive": return m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? null;
    case "image": return m.image?.caption ? `📷 ${m.image.caption}` : null;
    case "video": return m.video?.caption ? `🎬 ${m.video.caption}` : null;
    case "document": return `📄 ${m.document?.filename ?? "Documento"}${m.document?.caption ? ` · ${m.document.caption}` : ""}`;
    case "location": {
      const l = m.location;
      if (!l) return null;
      const where = [l.name, l.address].filter(Boolean).join(" · ");
      return `📍 ${where || "Localização"}${l.latitude != null && l.longitude != null ? ` https://maps.google.com/?q=${l.latitude},${l.longitude}` : ""}`;
    }
    case "reaction": return m.reaction?.emoji ? `Reagiu ${m.reaction.emoji}` : null;
    default: return null;
  }
}

async function inboxSend(req: Request) {
  const user = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } }, auth: { persistSession: false } });
  const b = await req.json().catch(() => ({}));
  if (typeof b.conversation_id !== "string" || !UUID.test(b.conversation_id) || typeof b.text !== "string") return json({ error: "Dados inválidos" }, 400);
  if (b.order_id != null && (typeof b.order_id !== "string" || !UUID.test(b.order_id))) return json({ error: "Pedido inválido" }, 400);
  // a regra (equipe, janela de 24 h, limite) fica no banco, com o usuário logado
  const { data: id, error } = await user.rpc("inbox_queue_reply", { p_conversation_id: b.conversation_id, p_text: b.text, p_order_id: b.order_id ?? null });
  if (error) return json({ error: error.message }, error.code === "42501" ? 403 : 400);
  const { data: job } = await admin.rpc("inbox_send_job", { p_message_id: id });
  if (!job) return json({ ok: false, id, error: "Mensagem não enviada: o WhatsApp oficial está desligado." });
  const j = job as { to: string; text: string; phone_number_id: string; version: string; token: string };
  const r = await graph(j.version, j.token, "POST", `${j.phone_number_id}/messages`,
    { messaging_product: "whatsapp", to: j.to, type: "text", text: { body: j.text, preview_url: true } });
  const waId = (r.data.messages as { id: string }[] | undefined)?.[0]?.id ?? null;
  const ok = r.http === 200 && !!waId;
  await admin.rpc("inbox_send_result", { p_message_id: id, p_ok: ok, p_wa_id: waId, p_error: ok ? null : errMsg(r.data) });
  return json({ ok, id, error: ok ? null : `A Meta recusou: ${errMsg(r.data)}` });
}

async function webhook(req: Request) {
  const url = new URL(req.url);
  const tenant = url.searchParams.get("tenant") ?? "";
  if (!UUID.test(tenant)) return json({ error: "Conta inválida" }, 400);
  const { data: ctx } = await admin.rpc("marketing_webhook_context", { p_tenant_id: tenant });
  if (!ctx) return json({ error: "Conta não configurada" }, 404);
  if (req.method === "GET") {
    const ok = url.searchParams.get("hub.mode") === "subscribe" && safeEqual(url.searchParams.get("hub.verify_token") ?? "", String(ctx.verify_token));
    return ok ? new Response(url.searchParams.get("hub.challenge") ?? "", { status: 200 }) : new Response("forbidden", { status: 403 });
  }
  const raw = await req.text();
  if (ctx.app_secret) {
    const sig = (req.headers.get("x-hub-signature-256") ?? "").replace(/^sha256=/, "");
    if (!sig || !safeEqual(await hmacHex(String(ctx.app_secret), raw), sig)) return json({ error: "Assinatura inválida" }, 401);
  } else {
    return json({ error: "Cadastre a chave secreta do app para receber notificações." }, 401);
  }
  let payload: { entry?: { changes?: { value?: Record<string, unknown> }[] }[] } = {};
  try { payload = JSON.parse(raw); } catch { return json({ ok: true }); }
  for (const e of payload.entry ?? []) for (const ch of e.changes ?? []) {
    const v = ch.value ?? {};
    const meta = v.metadata as { phone_number_id?: string } | undefined;
    if (meta?.phone_number_id && ctx.phone_number_id && meta.phone_number_id !== ctx.phone_number_id) continue;
    for (const s of (v.statuses as { id: string; status: string; errors?: { title?: string; message?: string }[] }[] | undefined) ?? []) {
      const err = s.errors?.[0] ? `${s.errors[0].title ?? ""} ${s.errors[0].message ?? ""}`.trim() : null;
      await admin.rpc("marketing_status_update", { p_tenant_id: tenant, p_wa_id: s.id, p_status: s.status, p_error: err });
      await admin.rpc("inbox_status", { p_tenant_id: tenant, p_wa_msg_id: s.id, p_status: s.status, p_error: err });
    }
    const names = new Map(((v.contacts as { wa_id?: string; profile?: { name?: string } }[] | undefined) ?? []).map((c) => [c.wa_id ?? "", c.profile?.name ?? ""]));
    for (const m of (v.messages as InMsg[] | undefined) ?? []) {
      const text = m.text?.body ?? m.button?.text ?? "";
      await admin.rpc("marketing_inbound", { p_tenant_id: tenant, p_from: m.from, p_text: text });
      const ts = Number(m.timestamp);
      await admin.rpc("inbox_inbound", { p_tenant_id: tenant, p_from: m.from, p_name: names.get(m.from) || null, p_wa_msg_id: m.id,
        p_kind: m.type, p_text: inboundText(m), p_ts: Number.isFinite(ts) && ts > 0 ? new Date(ts * 1000).toISOString() : null });
    }
  }
  return json({ ok: true });
}

async function test(req: Request) {
  const user = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } }, auth: { persistSession: false } });
  const { tenant_id } = await req.json().catch(() => ({}));
  if (typeof tenant_id !== "string" || !UUID.test(tenant_id)) return json({ error: "Conta inválida" }, 400);
  const { data: can } = await user.rpc("marketing_can_test", { p_tenant_id: tenant_id });
  if (can !== true) return json({ error: "Só o dono da conta testa o WhatsApp." }, 403);
  const { data: ctx } = await admin.rpc("marketing_test_context", { p_tenant_id: tenant_id });
  if (!ctx?.token || !ctx?.phone_number_id) return json({ ok: false, message: "Salve o ID do número e o token primeiro." });
  const r = await graph(ctx.version, ctx.token, "GET", `${ctx.phone_number_id}?fields=display_phone_number,verified_name,quality_rating`);
  const ok = r.http === 200 && !!r.data.display_phone_number;
  const message = ok ? `Conectado ao número ${r.data.display_phone_number} (${r.data.verified_name ?? "sem nome verificado"}, qualidade ${r.data.quality_rating ?? "?"}).`
    : `A Meta recusou: ${errMsg(r.data)}`;
  await admin.rpc("marketing_test_result", { p_tenant_id: tenant_id, p_ok: ok, p_message: message });
  return json({ ok, message });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const path = new URL(req.url).pathname.replace(/^.*\/marketing/, "") || "/";
  try {
    if (path === "/webhook") return await webhook(req);
    if (req.method !== "POST") return json({ error: "Método não permitido" }, 405);
    if (path === "/worker") return await worker(req);
    if (path === "/test") return await test(req);
    if (path === "/inbox/send") return await inboxSend(req);
    return json({ error: "Rota não encontrada" }, 404);
  } catch (e) {
    console.error(e);
    return json({ error: "Erro interno" }, 500);
  }
});
