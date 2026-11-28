/** Catálogo das integrações da plataforma (App Store). A situação vem de appstore_overview. */
export type BuiltinApp = {
  key: string; name: string; category: Category; tagline: string; href: string; icon: string;
  status?: false;          // sem indicador de conectado (recurso sempre disponível)
};
export type Category = "vendas" | "pagamentos" | "fiscal" | "atendimento" | "marketing" | "logistica" | "gestao" | "loja" | "desenvolvedores" | "financeiro" | "outros";

export const CATEGORIES: { key: Category | "todos"; label: string }[] = [
  { key: "todos", label: "Todos" }, { key: "vendas", label: "Canais de venda" }, { key: "pagamentos", label: "Pagamentos" },
  { key: "atendimento", label: "Atendimento" }, { key: "marketing", label: "Marketing" }, { key: "logistica", label: "Entrega" },
  { key: "gestao", label: "Gestão" }, { key: "financeiro", label: "Financeiro" }, { key: "fiscal", label: "Fiscal" },
  { key: "loja", label: "Loja e salão" }, { key: "desenvolvedores", label: "Desenvolvedores" }, { key: "outros", label: "Outros" },
];

export const BUILTIN: BuiltinApp[] = [
  { key: "ifood", name: "iFood", category: "vendas", icon: "🛵", href: "/painel/integracoes", tagline: "Receba os pedidos do iFood direto no painel, no KDS e na impressora." },
  { key: "keeta", name: "Keeta", category: "vendas", icon: "🛵", href: "/painel/integracoes", tagline: "Pedidos da Keeta pelo padrão Open Delivery." },
  { key: "99food", name: "99Food", category: "vendas", icon: "🛵", href: "/painel/integracoes", tagline: "Pedidos da 99Food pelo padrão Open Delivery." },
  { key: "aiqfome", name: "aiqfome", category: "vendas", icon: "🛵", href: "/painel/integracoes", tagline: "Pedidos do aiqfome pelo padrão Open Delivery." },
  { key: "mercadopago", name: "Mercado Pago", category: "pagamentos", icon: "💳", href: "/painel/pagamentos", tagline: "Pix automático e cartão no cardápio online, maquininha Point no totem e estorno." },
  { key: "nfce", name: "NFC-e (Focus NFe)", category: "fiscal", icon: "🧾", href: "/painel/fiscal", tagline: "Emissão automática ou manual da nota fiscal do consumidor." },
  { key: "whatsapp", name: "WhatsApp oficial", category: "atendimento", icon: "💬", href: "/painel/marketing", tagline: "Caixa de entrada, avisos do pedido, campanhas e recuperação de carrinho pela API da Meta." },
  { key: "ai_attendant", name: "Atendente IA", category: "atendimento", icon: "🤖", href: "/painel/atendimento", tagline: "Responde os clientes no WhatsApp e passa para a equipe quando precisa." },
  { key: "foody", name: "Foody Delivery", category: "logistica", icon: "📦", href: "/painel/integracoes", tagline: "Chame entregadores sob demanda para os pedidos de entrega." },
  { key: "entrega_ifood", name: "Entrega iFood", category: "logistica", icon: "📦", href: "/painel/integracoes", tagline: "Use a frota do iFood também nos pedidos do seu cardápio." },
  { key: "f360", name: "F360 Finanças", category: "financeiro", icon: "📊", href: "/painel/integracoes", tagline: "Vendas e recebimentos enviados para o financeiro da F360." },
  { key: "pdv_od", name: "PDV via Open Delivery", category: "gestao", icon: "🖥️", href: "/painel/integracoes", tagline: "Envie os pedidos para o PDV da loja (ex.: Eclética) pelo Open Delivery." },
  { key: "meta_pixel", name: "Pixel da Meta", category: "marketing", icon: "📈", href: "/painel/marketing", tagline: "Meça e otimize anúncios do Instagram e Facebook com o funil do cardápio." },
  { key: "ga4", name: "Google Analytics 4", category: "marketing", icon: "📈", href: "/painel/marketing", tagline: "Funil de conversão do cardápio no GA4 e no Google Ads." },
  { key: "domain", name: "Domínio próprio", category: "loja", icon: "🌐", href: "/painel/configuracoes", tagline: "Seu cardápio no seu endereço, com certificado automático." },
  { key: "printing", name: "Impressão automática", category: "loja", icon: "🖨️", href: "/painel/impressao", tagline: "Comandas e cupons impressos sozinhos na cozinha e no caixa." },
  { key: "totem", name: "Totem de autoatendimento", category: "loja", icon: "🧍", href: "/painel/totens", tagline: "Tablet ou tela touch para o cliente pedir e pagar sozinho." },
  { key: "pwa", name: "App do cliente", category: "loja", icon: "📱", href: "/painel/configuracoes", status: false, tagline: "Cardápio instalável no celular, com avisos do pedido no aparelho." },
  { key: "api", name: "API pública", category: "desenvolvedores", icon: "🔑", href: "/painel/integracoes", tagline: "Chaves com permissões para seus sistemas lerem e atualizarem pedidos e cardápio." },
  { key: "webhooks", name: "Webhooks", category: "desenvolvedores", icon: "🔔", href: "/painel/integracoes", tagline: "Avisos assinados de pedido criado, pago e mudança de situação." },
  { key: "mcp", name: "Servidor MCP", category: "desenvolvedores", icon: "🧠", href: "/painel/integracoes", status: false, tagline: "Conecte assistentes de IA à sua loja com as mesmas chaves da API." },
];

export const SCOPE_LABEL: Record<string, string> = {
  "orders:read": "Ver seus pedidos (itens, valores, cliente e endereço de entrega)",
  "orders:write": "Mudar a situação dos pedidos",
  "menu:read": "Ver seu cardápio",
  "menu:write": "Alterar preço e disponibilidade dos produtos",
  "customers:read": "Ver seus clientes (nome, telefone e histórico)",
};
export const EVENT_LABEL: Record<string, string> = {
  "order.created": "pedido criado", "order.status_changed": "mudança de situação do pedido", "order.paid": "pedido pago",
};
