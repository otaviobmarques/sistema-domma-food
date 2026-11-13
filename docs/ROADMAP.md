# Roadmap (do Descritivo Técnico v1.0)

| Fase | Status | Entregas |
|---|---|---|
| 0. Fundação | ✅ | Multi-tenant, autenticação e perfis, RLS, 2FA, auditoria, CI, backup |
| 1. MVP Delivery | ✅ (Pix manual) | Cardápio + checkout, gestão do cardápio, gestor de pedidos, áreas e taxas, cupons, dashboard |
| 1b. Pendências do MVP | ✅ | ✅ Pagamento online via Mercado Pago (Pix com confirmação automática, cartão de crédito tokenizado, webhook assinado, estorno automático) · ✅ Impressão automática (agente no computador da loja ou estação no navegador) · ✅ Cobrança da assinatura (Asaas) · ✅ Domínio próprio por loja (Vercel, HTTPS automático) |
| 1d. Cobrança do SaaS | ✅ (aguarda conta Asaas) | Assinatura mensal no Asaas (Pix, boleto, cartão), troca de plano, cancelamento, carência e suspensão automática, webhook verificado, isenção pelo admin |
| 1c. Marketplaces | ✅ (aguarda credenciais) | iFood (Merchant API, polling 30 s, disputas de cancelamento) e 99Food, Keeta e aiqfome via Open Delivery: webhook, polling, fila de status, cancelamento, selos |
| 2. Salão e caixa | ✅ (parcial) | Pronto: caixa com fechamento cego, PDV, mesas e comandas (garçom usa pelo painel no celular), KDS por setor, QR Code na mesa (cliente pede, chama o garçom e pede a conta; equipe aceita os pedidos). Falta: modo offline, TEF |
| 3. WhatsApp e marketing | 🟡 | ✅ Campanhas e disparador (manual ou API oficial), automações de aniversário e inativos, cupom automático, cashback e pontos, avaliações · ✅ Avisos de status do pedido pelo WhatsApp (API oficial ou mensagem pronta) · ✅ Recuperação de carrinho (WhatsApp, notificação no aparelho ou lista manual, com cupom) · ⏳ Atendente IA (Domma Chat) |
| 4. Gestão | 🟡 | ✅ Estoque com ficha técnica, custo médio e baixa automática · ✅ Financeiro (contas a pagar/receber, DRE simplificada, CMV) · ✅ Fiado com limite por cliente no PDV e nas mesas · ✅ NFC-e via Focus NFe (emissão automática ou manual, cancelamento em 30 min, reenvio; ativa quando a loja cadastra o token do provedor) |
| 5. Escala | 🟡 | ✅ Entregadores e rotas (despacho em rota, app do entregador por link, acerto do dia) · ✅ Totem de autoatendimento (Pix na tela ou pagar no caixa) · ✅ Pixel do Meta, GA4 e funil de conversão do cardápio · ✅ PDV pelo WhatsApp (caixa de entrada + lançar pedido) · ✅ CRM com filtros avançados, filtros salvos e etiquetas · ✅ Logística sob demanda (Foody Delivery e Entrega iFood) · ✅ F360 Finanças e PDV pelo Open Delivery (Eclética) · ✅ Redes e multiunidade (visão da rede, nova loja, preço por loja, limite do plano) · ✅ App do cliente instalável (PWA, avisos no aparelho, pedir de novo) · ⏳ TEF no totem |
| 6. Ecossistema | 🟡 | ✅ API pública e webhooks assinados (chaves com escopos, documentação em /desenvolvedores) · ⏳ Domma IA + MCP, App Store, portal de revendas |

O esquema já tem pontos de extensão para as próximas fases: `order_channel` (whatsapp, ifood, table, totem), `order_type.dine_in`, `payments.gateway/txid`, dados fiscais por produto, `product_unit_overrides` (preço por loja), `plans.features`.
