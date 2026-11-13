import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "API e webhooks · Domma Food para desenvolvedores",
  description: "Referência da API pública e dos webhooks do Domma Food: pedidos, cardápio, clientes e eventos assinados.",
};

const BASE = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/api/v1`;
const MCP = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/mcp`;

function Code({ children }: { children: string }) {
  return <pre className="overflow-x-auto rounded-xl bg-zinc-900 p-4 text-[13px] leading-relaxed text-zinc-100"><code>{children}</code></pre>;
}
function Endpoint({ method, path, scope, children }: { method: string; path: string; scope?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-zinc-200 bg-white p-5">
      <p className="flex flex-wrap items-center gap-2 font-mono text-sm">
        <span className={`rounded-md px-2 py-0.5 text-xs font-bold text-white ${method === "GET" ? "bg-emerald-600" : method === "POST" ? "bg-sky-600" : "bg-amber-600"}`}>{method}</span>
        <span className="font-semibold">{path}</span>
        {scope && <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] text-zinc-600">{scope}</span>}
      </p>
      <div className="mt-3 space-y-3 text-sm leading-relaxed text-zinc-700">{children}</div>
    </div>
  );
}

export default function Developers() {
  return (
    <div className="min-h-screen bg-cream">
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-4 py-4">
          <Link href="/" className="flex items-center gap-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/brand/domma-food-logo.svg" alt="Domma Food" className="h-7" />
            <span className="text-sm text-zinc-500">para desenvolvedores</span>
          </Link>
          <Link href="/login" className="text-sm font-medium text-brand-700">Entrar no painel</Link>
        </div>
      </header>

      <main className="mx-auto max-w-4xl space-y-10 px-4 py-10">
        <section>
          <h1 className="text-3xl font-black tracking-tight">API e webhooks</h1>
          <p className="mt-3 max-w-2xl text-zinc-600">
            Conecte o Domma Food ao seu ERP, BI ou automação. A API REST lê pedidos, cardápio e clientes e muda o status dos pedidos;
            os webhooks avisam o seu sistema assim que um pedido entra, muda de status ou é pago.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-extrabold">Autenticação</h2>
          <p className="text-sm text-zinc-700">
            O dono da conta cria a chave no painel, em <strong>Integrações › API e webhooks</strong>, escolhendo as permissões (escopos) e, se quiser, uma loja só.
            A chave aparece uma única vez. Envie no cabeçalho <code>Authorization</code>. Ela é para servidor: não coloque em sites ou apps.
          </p>
          <Code>{`curl ${BASE}/me \\
  -H "Authorization: Bearer dmf_sua_chave"`}</Code>
          <ul className="list-disc space-y-1 pl-5 text-sm text-zinc-700">
            <li>A chave age em nome do dono que a criou: as regras do painel valem igual, e ela deixa de funcionar se essa pessoa sair da conta.</li>
            <li>Limite: 120 chamadas por minuto por chave (resposta <code>429</code> com <code>Retry-After</code>).</li>
            <li>Valores em centavos; datas em ISO 8601 (UTC).</li>
            <li>Erros: <code>{`{"error": {"code": "...", "message": "..."}}`}</code> com <code>400</code> inválido, <code>401</code> chave, <code>403</code> sem escopo, <code>404</code> não encontrado.</li>
          </ul>
        </section>

        <section className="space-y-4">
          <h2 className="text-xl font-extrabold">Endpoints</h2>
          <p className="text-sm text-zinc-600">Base: <code className="break-all">{BASE}</code></p>
          <Endpoint method="GET" path="/me">
            <p>Conta, lojas que a chave alcança e escopos da chave.</p>
          </Endpoint>
          <Endpoint method="GET" path="/orders" scope="orders:read">
            <p>Pedidos do mais novo para o mais antigo. Filtros: <code>status</code> (vírgula: <code>pending,preparing</code>), <code>since</code> (alterados desde),
              <code>unit_id</code>, <code>limit</code> (até 100). Para a próxima página, envie <code>before</code> com o <code>next_before</code> da resposta.</p>
            <Code>{`curl "${BASE}/orders?status=pending,preparing&limit=50" -H "Authorization: Bearer dmf_..."`}</Code>
          </Endpoint>
          <Endpoint method="GET" path="/orders/{id}" scope="orders:read">
            <p>Um pedido com cliente, endereço, itens (com <code>pdv_code</code> e opções), valores, pagamento e link de acompanhamento.</p>
          </Endpoint>
          <Endpoint method="POST" path="/orders/{id}/status" scope="orders:write">
            <p>Avança o pedido com as mesmas regras do painel: <code>preparing</code>, <code>ready</code>, <code>dispatched</code>, <code>awaiting_pickup</code>,
              <code>completed</code> ou <code>cancelled</code> (exige <code>reason</code>). Estoque, fidelidade, nota fiscal e avisos ao cliente acontecem como no painel.</p>
            <Code>{`curl -X POST ${BASE}/orders/ID/status \\
  -H "Authorization: Bearer dmf_..." -H "Content-Type: application/json" \\
  -d '{"status": "preparing"}'`}</Code>
          </Endpoint>
          <Endpoint method="GET" path="/menu" scope="menu:read">
            <p>Categorias e produtos de uma loja (<code>unit_id</code> opcional), com preço da loja, disponibilidade, <code>pdv_code</code> e SKU.</p>
          </Endpoint>
          <Endpoint method="PATCH" path="/products/{id}" scope="menu:write">
            <p>Esgota ou volta um produto (<code>available</code>; esgotado vale até as 5 h do dia seguinte, ou até <code>paused_until</code>) e muda o preço
              (<code>price_cents</code>). Com <code>unit_id</code>, vale só para aquela loja.</p>
            <Code>{`curl -X PATCH ${BASE}/products/ID \\
  -H "Authorization: Bearer dmf_..." -H "Content-Type: application/json" \\
  -d '{"available": false}'`}</Code>
          </Endpoint>
          <Endpoint method="GET" path="/customers" scope="customers:read">
            <p>Clientes (nome, telefone, e-mail, etiquetas, aceite de ofertas, pedidos e total gasto), do mais recente. Filtros: <code>since</code>, <code>before</code>, <code>limit</code>.
              São dados pessoais: trate de acordo com a LGPD.</p>
          </Endpoint>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-extrabold">Webhooks</h2>
          <p className="text-sm text-zinc-700">
            Cadastre um endereço <code>https</code> público no painel e escolha os eventos: <code>order.created</code>, <code>order.status_changed</code> (com <code>previous_status</code>)
            e <code>order.paid</code>. Cada envio é um <code>POST</code> JSON com o pedido completo:
          </p>
          <Code>{`{
  "id": "e3b1…",                       // id do evento (use para não processar duas vezes)
  "type": "order.status_changed",
  "created_at": "2026-11-13T12:00:00Z",
  "data": { "previous_status": "pending", "order": { "id": "…", "number": 381, "status": "preparing", … } }
}`}</Code>
          <p className="text-sm text-zinc-700">
            Responda com <code>2xx</code> em até 10 segundos. Sem resposta, tentamos de novo em 1 min, 5 min, 30 min, 2 h e 6 h; depois de 50 falhas seguidas o webhook é desligado
            (religue no painel). Os envios chegam em ordem aproximada: use <code>updated_at</code> e o <code>status</code> do pedido como verdade.
          </p>
          <h3 className="pt-2 font-bold">Conferindo a assinatura</h3>
          <p className="text-sm text-zinc-700">
            O cabeçalho <code>Domma-Signature: t=&lt;unix&gt;,v1=&lt;hex&gt;</code> traz o HMAC-SHA256 de <code>{"`${t}.${corpo}`"}</code> com o segredo do webhook (<code>whsec_…</code>).
            Recuse se não bater ou se <code>t</code> tiver mais de 5 minutos.
          </p>
          <Code>{`import crypto from "node:crypto";

function verify(rawBody, header, secret) {
  const { t, v1 } = Object.fromEntries(header.split(",").map((p) => p.split("=")));
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const expected = crypto.createHmac("sha256", secret).update(\`\${t}.\${rawBody}\`).digest("hex");
  return v1.length === expected.length && crypto.timingSafeEqual(Buffer.from(v1), Buffer.from(expected));
}`}</Code>
          <p className="text-sm text-zinc-700">Outros cabeçalhos: <code>Domma-Event</code> (tipo) e <code>Domma-Delivery</code> (id do evento). No painel dá para enviar um evento de teste (<code>ping</code>) e reenviar entregas que falharam.</p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-extrabold">Assistentes de IA (MCP)</h2>
          <p className="text-sm text-zinc-700">
            O Domma Food tem um servidor <strong>MCP</strong> (Model Context Protocol): conecte o Claude, o Cursor ou outro app compatível e pergunte
            &quot;como foram as vendas ontem?&quot;, &quot;quais pedidos estão em preparo?&quot; ou peça &quot;esgota a pizza de calabresa&quot;. Ele usa a mesma chave de API,
            com as mesmas permissões: uma chave só de leitura não altera nada.
          </p>
          <ul className="list-disc space-y-1 pl-5 text-sm text-zinc-700">
            <li><strong>Ferramentas</strong>: info da conta, resumo de vendas, listar e ver pedidos (pelo número), mudar status, ver cardápio, buscar produto,
              esgotar/voltar produto, alterar preço e listar clientes. Cada ferramenta só aparece se a chave tiver a permissão.</li>
            <li><strong>Endereço</strong>: <code className="break-all">{MCP}</code> (HTTP, sem sessão), com <code>Authorization: Bearer dmf_…</code>.</li>
            <li>Apps que só aceitam um endereço, como os conectores personalizados do Claude: use <code className="break-all">{MCP}/dmf_sua_chave</code>.
              Esse endereço dá acesso à loja: guarde como senha e revogue a chave se vazar.</li>
          </ul>
          <p className="text-sm font-semibold">Claude Code</p>
          <Code>{`claude mcp add --transport http domma-food ${MCP} \
  --header "Authorization: Bearer dmf_sua_chave"`}</Code>
          <p className="text-sm font-semibold">Apps com configuração em JSON (Cursor e outros)</p>
          <Code>{`{
  "mcpServers": {
    "domma-food": {
      "url": "${MCP}",
      "headers": { "Authorization": "Bearer dmf_sua_chave" }
    }
  }
}`}</Code>
        </section>

        <p className="border-t border-zinc-200 pt-6 text-xs text-zinc-500">Dúvidas sobre a integração? Fale com o suporte do Domma Food pelo painel.</p>
      </main>
    </div>
  );
}
