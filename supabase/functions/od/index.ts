// Domma Food · Open Delivery (Pedidos) — o Domma como Ordering Application
// Base URL para o PDV (Eclética ou outro aderente): https://<projeto>.supabase.co/functions/v1/od
//   POST /oauth/token                          client_credentials (clientId/clientSecret gerados no painel)
//   GET  /v1/events:polling                    eventos pendentes da loja (200 com lista, 204 vazio)
//   POST /v1/events/acknowledgment             [{id, orderId, eventType}]
//   GET  /v1/orders/{orderId}                  pedido no formato Open Delivery
//   POST /v1/orders/{orderId}/{acao}           confirm | preparing | readyForPickup | dispatch | delivered | pickedUp
//                                              | requestCancellation | acceptCancellation | denyCancellation
import { createClient } from "npm:@supabase/supabase-js@2.119.0";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const BASE = `${Deno.env.get("SUPABASE_URL")}/functions/v1/od`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIONS = ["confirm", "preparing", "readyForPickup", "dispatch", "delivered", "pickedUp", "requestCancellation", "acceptCancellation", "denyCancellation"];
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });
// formato de erro do Open Delivery
const err = (status: number, title: string) => json({ status, title }, status);

async function token(req: Request) {
  let id = "", secret = "", grant = "";
  const ct = req.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    const b = await req.json().catch(() => ({}));
    id = String(b.client_id ?? b.clientId ?? ""); secret = String(b.client_secret ?? b.clientSecret ?? ""); grant = String(b.grant_type ?? b.grantType ?? "");
  } else {
    const f = new URLSearchParams(await req.text());
    id = f.get("client_id") ?? f.get("clientId") ?? ""; secret = f.get("client_secret") ?? f.get("clientSecret") ?? ""; grant = f.get("grant_type") ?? f.get("grantType") ?? "";
    // client_secret_basic
    const auth = req.headers.get("authorization") ?? "";
    if ((!id || !secret) && auth.startsWith("Basic ")) {
      try { const [a, b] = atob(auth.slice(6)).split(":"); id = id || a; secret = secret || b; } catch { /* ignora */ }
    }
  }
  if (grant && grant !== "client_credentials") return err(400, "unsupported_grant_type");
  if (!/^dmo_[0-9a-f]{24}$/.test(id) || !secret) return err(401, "invalid_client");
  const { data } = await admin.rpc("od_issue_token", { p_client_id: id, p_client_secret: secret });
  if (!data) return err(401, "invalid_client");
  return json(data);
}

async function unitOf(req: Request) {
  const t = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!/^dmt_[0-9a-f]{48}$/.test(t)) return null;
  const { data } = await admin.rpc("od_unit", { p_token: t });
  return (data as string | null) ?? null;
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^.*\/functions\/v1\/od/, "").replace(/^\/od(?=\/)/, "") || "/";
  try {
    if (path === "/oauth/token" && req.method === "POST") return await token(req);

    const unit = await unitOf(req);
    if (!unit) return err(401, "Token inválido ou expirado");
    const merchants = (req.headers.get("x-polling-merchants") ?? "").split(",").map((s) => s.trim()).filter(Boolean);

    if (path === "/v1/events:polling" && req.method === "GET") {
      if (merchants.length && !merchants.includes(unit)) return new Response(null, { status: 204 });
      const types = url.searchParams.getAll("eventType").flatMap((x) => x.split(",")).map((x) => x.trim().toUpperCase()).filter(Boolean);
      const { data, error } = await admin.rpc("od_poll", { p_unit_id: unit, p_types: types.length ? types : null });
      if (error) return err(503, "Serviço indisponível");
      const list = ((data ?? []) as { eventId: string; eventType: string; orderId: string; createdAt: string }[])
        .map((e) => ({ ...e, orderURL: `${BASE}/v1/orders/${e.orderId}`, sourceAppId: "domma-food" }));
      return list.length ? json(list) : new Response(null, { status: 204 });
    }

    if (path === "/v1/events/acknowledgment" && req.method === "POST") {
      const b = await req.json().catch(() => null);
      if (!Array.isArray(b)) return err(400, "Envie uma lista de eventos");
      const ids = b.map((x) => String(x?.id ?? x?.eventId ?? "")).filter((x) => UUID.test(x)).slice(0, 500);
      await admin.rpc("od_ack", { p_unit_id: unit, p_ids: ids });
      return new Response(null, { status: 202 });
    }

    const m = path.match(/^\/v1\/orders\/([^/]+)(?:\/([A-Za-z]+))?$/);
    if (m) {
      const orderId = m[1], action = m[2];
      if (!UUID.test(orderId)) return err(404, "Pedido não encontrado");
      if (!action && req.method === "GET") {
        const { data } = await admin.rpc("od_order", { p_unit_id: unit, p_order_id: orderId });
        return data ? json(data) : err(404, "Pedido não encontrado");
      }
      if (action && req.method === "POST" && ACTIONS.includes(action)) {
        const body = await req.json().catch(() => ({}));
        const { data, error } = await admin.rpc("od_action", { p_unit_id: unit, p_order_id: orderId, p_action: action, p_body: body ?? {} });
        if (error) return err(503, "Serviço indisponível");
        if (data === "not_found") return err(404, "Pedido não encontrado");
        if (data === "invalid") return err(422, "O pedido não está num estado que permita esta ação");
        return new Response(null, { status: action === "acceptCancellation" || action === "denyCancellation" ? 200 : 202 });
      }
      if (action === "tracking" || action === "validateCode" || action === "details") return new Response(null, { status: 202 });
    }
    return err(404, "Rota não encontrada");
  } catch (e) {
    console.error(e);
    return err(503, "Serviço indisponível");
  }
});
