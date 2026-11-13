// Domma Food · Servidor MCP (Model Context Protocol, transporte HTTP "streamable", sem sessão)
//   POST /functions/v1/mcp                 Authorization: Bearer dmf_...   (recomendado)
//   POST /functions/v1/mcp/dmf_...         chave no endereço, para apps que não enviam cabeçalho
// Usa a mesma chave de API e as mesmas regras (escopos, loja, limite) da API pública.
import { createClient } from "npm:@supabase/supabase-js@2.119.0";

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const enc = new TextEncoder();
const sha256 = async (s: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)))].map((x) => x.toString(16).padStart(2, "0")).join("");
const PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const KEY_RE = /^dmf_[a-f0-9]{48}$/;

type Ctx = { key_id: string; tenant_id: string; unit_id: string | null; scopes: string[] };
type Rpc = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: Record<string, unknown> };
type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

class ToolError extends Error {}
const ok = (data: unknown): ToolResult => ({ content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 1) }] });
const ERR_TEXT: Record<string, string> = {
  forbidden: "A chave de API não tem permissão para isso.", not_found: "Não encontrado.", invalid: "Parâmetro inválido.",
  rate_limited: "Limite de chamadas por minuto atingido; tente de novo em instantes.", invalid_key: "Chave de API inválida ou revogada.",
};
async function call(ctx: Ctx, op: string, p: Record<string, unknown> = {}, ext = false) {
  const { data, error } = await admin.rpc(ext ? "api_call_ext" : "api_call", { p_key_id: ctx.key_id, p_op: op, p });
  if (error) { console.error(error); throw new ToolError("Erro interno ao consultar a loja."); }
  if (data?.error) throw new ToolError([data.message ?? ERR_TEXT[data.error] ?? data.error, data.options ? JSON.stringify(data.options) : ""].filter(Boolean).join(" "));
  return data;
}
const brl = (c: number) => "R$ " + (c / 100).toFixed(2).replace(".", ",");
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const int = (v: unknown) => (typeof v === "number" && Number.isInteger(v) ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : undefined);

// pedido pelo número ou id
async function orderId(ctx: Ctx, a: Record<string, unknown>) {
  if (str(a.pedido_id)) return str(a.pedido_id)!;
  const n = int(String(a.numero ?? "").replace(/^#/, ""));
  if (n == null) throw new ToolError("Informe o número do pedido (ex.: 379) ou o pedido_id.");
  const r = await call(ctx, "orders.find", { number: n, ...(str(a.loja_id) ? { unit_id: a.loja_id } : {}) }, true);
  return r.data.id as string;
}
// produto pelo nome ou id (pede para escolher quando há vários)
async function productId(ctx: Ctx, a: Record<string, unknown>) {
  if (str(a.produto_id)) return str(a.produto_id)!;
  const q = str(a.produto);
  if (!q) throw new ToolError("Informe o nome do produto ou o produto_id.");
  const r = await call(ctx, "products.search", { q }, true);
  const list = r.data as { id: string; name: string; category: string; price_cents: number; available: boolean; score: number }[];
  if (!list.length) throw new ToolError(`Nenhum produto encontrado com "${q}".`);
  const exact = list.filter((x) => x.score === 0);
  if (list.length === 1 || exact.length === 1) return (exact[0] ?? list[0]).id;
  throw new ToolError(`Mais de um produto combina com "${q}". Pergunte qual e chame de novo com produto_id: ` +
    JSON.stringify(list.map((x) => ({ produto_id: x.id, nome: x.name, categoria: x.category, preco: brl(x.price_cents), disponivel: x.available }))));
}

type OrderJson = { id: string; number: number; status: string; type: string; channel: string; created_at: string; total_cents: number;
  customer: { name: string }; unit_name: string; items: { name: string; quantity: number }[] };
const orderLine = (o: OrderJson) => ({ pedido_id: o.id, numero: o.number, status: o.status, tipo: o.type, canal: o.channel, criado_em: o.created_at,
  cliente: o.customer?.name, total: brl(o.total_cents), loja: o.unit_name, itens: o.items.map((i) => `${i.quantity}x ${i.name}`).join(", ") });

const STATUS = ["preparing", "ready", "dispatched", "awaiting_pickup", "completed", "cancelled"];
const tools: { name: string; title: string; description: string; inputSchema: Record<string, unknown>; annotations: Record<string, boolean>;
  run: (ctx: Ctx, a: Record<string, unknown>) => Promise<ToolResult> }[] = [
  {
    name: "info_conta", title: "Conta e lojas",
    description: "Mostra a conta, as lojas que esta conexão alcança (com loja_id) e as permissões da chave. Use primeiro se não souber qual loja.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true },
    run: async (ctx) => ok(await call(ctx, "me")),
  },
  {
    name: "resumo_vendas", title: "Resumo de vendas",
    description: "Vendas de um período: pedidos, faturamento, ticket médio, cancelados, por canal, tipo e forma de pagamento, por hora (um dia) ou por dia, e os produtos mais vendidos. Sem datas = hoje. Pedidos cancelados não entram no faturamento. Valores em centavos.",
    inputSchema: { type: "object", additionalProperties: false, properties: {
      de: { type: "string", description: "Início, ISO 8601 (ex.: 2026-11-01 ou 2026-11-01T00:00:00-03:00). Use o fuso da loja." },
      ate: { type: "string", description: "Fim (exclusivo), ISO 8601. Ex.: para o dia 01/11 inteiro, de=2026-11-01T00:00:00-03:00 e ate=2026-11-02T00:00:00-03:00." },
      loja_id: { type: "string", description: "Só esta loja (opcional)." } } },
    annotations: { readOnlyHint: true },
    run: async (ctx, a) => ok(await call(ctx, "reports.sales", { ...(str(a.de) ? { from: a.de } : {}), ...(str(a.ate) ? { to: a.ate } : {}), ...(str(a.loja_id) ? { unit_id: a.loja_id } : {}) }, true)),
  },
  {
    name: "listar_pedidos", title: "Listar pedidos",
    description: "Pedidos mais recentes, com filtros. Status possíveis: awaiting_payment, pending (aguardando aceite), preparing, ready, dispatched, awaiting_pickup, completed, cancelled.",
    inputSchema: { type: "object", additionalProperties: false, properties: {
      status: { type: "string", description: "Um ou mais status separados por vírgula (ex.: pending,preparing)." },
      desde: { type: "string", description: "Só pedidos alterados desde esta data/hora (ISO 8601)." },
      limite: { type: "integer", minimum: 1, maximum: 50, description: "Quantos (padrão 20)." },
      loja_id: { type: "string" } } },
    annotations: { readOnlyHint: true },
    run: async (ctx, a) => {
      const r = await call(ctx, "orders.list", { limit: int(a.limite) ?? 20, ...(str(a.status) ? { status: a.status } : {}),
        ...(str(a.desde) ? { since: a.desde } : {}), ...(str(a.loja_id) ? { unit_id: a.loja_id } : {}) });
      return ok({ pedidos: (r.data as OrderJson[]).map(orderLine), mais: !!r.next_before });
    },
  },
  {
    name: "ver_pedido", title: "Ver pedido",
    description: "Detalhes de um pedido pelo número (ex.: 379) ou pedido_id: cliente, endereço, itens com opções, valores, pagamento e andamento. Valores em centavos.",
    inputSchema: { type: "object", additionalProperties: false, properties: {
      numero: { type: "integer", description: "Número do pedido." }, pedido_id: { type: "string" }, loja_id: { type: "string" } } },
    annotations: { readOnlyHint: true },
    run: async (ctx, a) => ok((await call(ctx, "orders.get", { id: await orderId(ctx, a) })).data),
  },
  {
    name: "mudar_status_pedido", title: "Mudar status do pedido",
    description: "Avança um pedido com as mesmas regras do painel (estoque, fidelidade, nota fiscal e avisos ao cliente acontecem igual). Confirme com a pessoa antes de cancelar. Cancelar exige motivo.",
    inputSchema: { type: "object", additionalProperties: false, required: ["status"], properties: {
      numero: { type: "integer" }, pedido_id: { type: "string" }, loja_id: { type: "string" },
      status: { type: "string", enum: STATUS, description: "preparing = aceitar/preparar; ready = pronto; dispatched = saiu para entrega; awaiting_pickup = aguardando retirada; completed = concluído; cancelled = cancelar." },
      motivo: { type: "string", description: "Obrigatório para cancelar." } } },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    run: async (ctx, a) => {
      if (!STATUS.includes(String(a.status))) throw new ToolError("Status inválido. Use: " + STATUS.join(", "));
      const id = await orderId(ctx, a);
      const r = await call(ctx, "orders.status", { id, status: a.status, ...(str(a.motivo) ? { reason: a.motivo } : {}) });
      return ok({ ok: true, pedido: orderLine(r.data) });
    },
  },
  {
    name: "ver_cardapio", title: "Ver cardápio",
    description: "Categorias e produtos de uma loja com preço (da loja) e se estão disponíveis agora.",
    inputSchema: { type: "object", additionalProperties: false, properties: { loja_id: { type: "string" } } },
    annotations: { readOnlyHint: true },
    run: async (ctx, a) => {
      const r = await call(ctx, "menu.get", str(a.loja_id) ? { unit_id: a.loja_id } : {});
      return ok({ loja_id: r.unit_id, categorias: (r.data as { name: string; products: { id: string; name: string; price_cents: number; promo_price_cents: number | null; available: boolean }[] }[])
        .map((c) => ({ categoria: c.name, produtos: c.products.map((p) => ({ produto_id: p.id, nome: p.name, preco: brl(p.price_cents),
          ...(p.promo_price_cents != null ? { promocao: brl(p.promo_price_cents) } : {}), disponivel: p.available })) })) });
    },
  },
  {
    name: "buscar_produto", title: "Buscar produto",
    description: "Procura produtos pelo nome (sem diferenciar acentos) e devolve produto_id, preço e disponibilidade.",
    inputSchema: { type: "object", additionalProperties: false, required: ["produto"], properties: { produto: { type: "string", minLength: 2 } } },
    annotations: { readOnlyHint: true },
    run: async (ctx, a) => ok((await call(ctx, "products.search", { q: a.produto }, true)).data),
  },
  {
    name: "disponibilidade_produto", title: "Esgotar ou voltar produto",
    description: "Marca um produto como esgotado (disponivel=false, até as 5 h do dia seguinte, como no painel) ou de volta (disponivel=true). Com loja_id, vale só para aquela loja.",
    inputSchema: { type: "object", additionalProperties: false, required: ["disponivel"], properties: {
      produto: { type: "string", description: "Nome do produto." }, produto_id: { type: "string" }, disponivel: { type: "boolean" },
      ate: { type: "string", description: "Esgotado até esta data/hora (ISO 8601, opcional; vale sem loja_id)." }, loja_id: { type: "string" } } },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    run: async (ctx, a) => {
      if (typeof a.disponivel !== "boolean") throw new ToolError("Informe disponivel: true ou false.");
      const id = await productId(ctx, a);
      await call(ctx, "products.update", { id, available: a.disponivel, ...(str(a.ate) ? { paused_until: a.ate } : {}), ...(str(a.loja_id) ? { unit_id: a.loja_id } : {}) });
      return ok({ ok: true, produto_id: id, disponivel: a.disponivel });
    },
  },
  {
    name: "alterar_preco", title: "Alterar preço",
    description: "Muda o preço de um produto (em reais, ex.: 39.9). Com loja_id, vale só para aquela loja. Confirme o valor com a pessoa antes.",
    inputSchema: { type: "object", additionalProperties: false, required: ["preco"], properties: {
      produto: { type: "string" }, produto_id: { type: "string" }, preco: { type: "number", minimum: 0, maximum: 100000 }, loja_id: { type: "string" } } },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    run: async (ctx, a) => {
      const preco = Number(a.preco);
      if (!Number.isFinite(preco) || preco < 0 || preco > 100000) throw new ToolError("Preço inválido.");
      const id = await productId(ctx, a);
      await call(ctx, "products.update", { id, price_cents: Math.round(preco * 100), ...(str(a.loja_id) ? { unit_id: a.loja_id } : {}) });
      return ok({ ok: true, produto_id: id, preco: brl(Math.round(preco * 100)) });
    },
  },
  {
    name: "listar_clientes", title: "Listar clientes",
    description: "Clientes da conta (nome, telefone, pedidos, total gasto, último pedido, aceite de ofertas), do mais recente. Dados pessoais: use só para atender a loja.",
    inputSchema: { type: "object", additionalProperties: false, properties: {
      desde: { type: "string", description: "Só clientes atualizados desde (ISO 8601)." }, limite: { type: "integer", minimum: 1, maximum: 50 } } },
    annotations: { readOnlyHint: true },
    run: async (ctx, a) => ok((await call(ctx, "customers.list", { limit: int(a.limite) ?? 20, ...(str(a.desde) ? { since: a.desde } : {}) })).data),
  },
];

const INSTRUCTIONS = "Ferramentas da loja no Domma Food (cardápio digital e gestão de pedidos). Valores em centavos, salvo quando a ferramenta já mostra em reais. " +
  "Fale em português do Brasil. Antes de cancelar pedido ou mudar preço, confirme com a pessoa.";

const rpcResult = (id: Rpc["id"], result: unknown) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id: Rpc["id"], code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
const json = (b: unknown, s = 200, h: Record<string, string> = {}) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json", ...h } });

async function handle(ctx: Ctx, m: Rpc) {
  switch (m.method) {
    case "initialize": {
      const asked = String(m.params?.protocolVersion ?? "");
      return rpcResult(m.id, { protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } }, serverInfo: { name: "domma-food", title: "Domma Food", version: "1.0.0" }, instructions: INSTRUCTIONS });
    }
    case "ping": return rpcResult(m.id, {});
    case "tools/list": {
      // só as ferramentas que a chave pode usar
      const need: Record<string, string[]> = { resumo_vendas: ["orders:read"], listar_pedidos: ["orders:read"], ver_pedido: ["orders:read"],
        mudar_status_pedido: ["orders:write"], ver_cardapio: ["menu:read"], buscar_produto: ["menu:read", "menu:write"],
        disponibilidade_produto: ["menu:write"], alterar_preco: ["menu:write"], listar_clientes: ["customers:read"] };
      const visible = tools.filter((t) => !need[t.name] || need[t.name].some((s) => ctx.scopes.includes(s)));
      return rpcResult(m.id, { tools: visible.map(({ run: _run, ...t }) => t) });
    }
    case "tools/call": {
      const name = String(m.params?.name ?? "");
      const t = tools.find((x) => x.name === name);
      if (!t) return rpcError(m.id, -32602, `Ferramenta desconhecida: ${name}`);
      const args = (m.params?.arguments && typeof m.params.arguments === "object" ? m.params.arguments : {}) as Record<string, unknown>;
      try { return rpcResult(m.id, await t.run(ctx, args)); }
      catch (e) {
        if (e instanceof ToolError) return rpcResult(m.id, { content: [{ type: "text", text: e.message }], isError: true });
        console.error(e);
        return rpcResult(m.id, { content: [{ type: "text", text: "Erro interno." }], isError: true });
      }
    }
    default: return rpcError(m.id, -32601, `Método não suportado: ${m.method}`);
  }
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const rest = url.pathname.replace(/^.*?\/mcp/, "").replace(/^\/+|\/+$/g, "");
  if (req.method !== "POST") return json({ error: "Use POST (MCP via HTTP, sem sessão)." }, 405, { Allow: "POST" });
  const key = req.headers.get("authorization")?.match(/^Bearer\s+(dmf_[a-f0-9]{48})$/)?.[1] ?? (KEY_RE.test(rest) ? rest : undefined);
  if (!key) return json(rpcError(null, -32001, "Envie a chave de API (Authorization: Bearer dmf_...)."), 401, { "WWW-Authenticate": 'Bearer realm="domma-food"' });
  const { data: auth, error } = await admin.rpc("api_auth", { p_key_hash: await sha256(key) });
  if (error) { console.error(error); return json(rpcError(null, -32603, "Erro interno."), 500); }
  if (auth?.error) return json(rpcError(null, -32001, ERR_TEXT[auth.error] ?? auth.error), auth.error === "rate_limited" ? 429 : 401);
  const ctx = auth as Ctx;
  let body: unknown;
  try { body = await req.json(); } catch { return json(rpcError(null, -32700, "JSON inválido."), 400); }
  const msgs = (Array.isArray(body) ? body : [body]) as Rpc[];
  if (!msgs.length || msgs.some((m) => !m || m.jsonrpc !== "2.0" || typeof m.method !== "string")) return json(rpcError(null, -32600, "Requisição JSON-RPC inválida."), 400);
  const out = [];
  for (const m of msgs) if (m.id !== undefined && m.id !== null) out.push(await handle(ctx, m));   // notificações não têm resposta
  if (!out.length) return new Response(null, { status: 202 });
  return json(Array.isArray(body) ? out : out[0]);
});
