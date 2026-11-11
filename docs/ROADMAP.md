# Roadmap (do Descritivo Técnico v1.0)

| Fase | Status | Entregas |
|---|---|---|
| 0. Fundação | ✅ | Multi-tenant, autenticação e perfis, RLS, 2FA, auditoria, CI, backup |
| 1. MVP Delivery | ✅ (Pix manual) | Cardápio + checkout, gestão do cardápio, gestor de pedidos, áreas e taxas, cupons, dashboard |
| 1b. Pendências do MVP | 🟡 | ✅ Pagamento online via Mercado Pago (Pix com confirmação automática, cartão de crédito tokenizado, webhook assinado, estorno automático) · ✅ Impressão automática (agente no computador da loja ou estação no navegador) · ⏳ cobrança SaaS, domínio próprio por loja |
| 1c. Marketplaces | ✅ (aguarda credenciais) | 99Food, Keeta e aiqfome via Open Delivery: webhook, polling, fila de status, cancelamento, selos |
| 2. Salão e caixa | ✅ (parcial) | Pronto: caixa com fechamento cego, PDV, mesas e comandas (garçom usa pelo painel no celular), KDS por setor, QR Code na mesa (cliente pede, chama o garçom e pede a conta; equipe aceita os pedidos). Falta: modo offline, TEF |
| 3. WhatsApp e marketing | ⏳ | Atendente IA (Domma Chat), avisos de status, recuperação de carrinho, RFM, disparador, automações, cashback e pontos, avaliações |
| 4. Gestão | 🟡 | ✅ Estoque com ficha técnica, custo médio e baixa automática · ✅ Financeiro (contas a pagar/receber, DRE simplificada, CMV) · ✅ Fiado com limite por cliente no PDV e nas mesas · ✅ NFC-e via Focus NFe (emissão automática ou manual, cancelamento em 30 min, reenvio; ativa quando a loja cadastra o token do provedor) |
| 5. Escala | 🟡 | ✅ Entregadores e rotas (despacho em rota, app do entregador por link, acerto do dia) · ⏳ totem com TEF, iFood homologado (API própria do iFood, fora do Open Delivery), redes multiunidade |
| 6. Ecossistema | ⏳ | Domma IA + MCP, API pública e webhooks, App Store, portal de revendas |

O esquema já tem pontos de extensão para as próximas fases: `order_channel` (whatsapp, ifood, table, totem), `order_type.dine_in`, `payments.gateway/txid`, dados fiscais por produto, `product_unit_overrides` (preço por loja), `plans.features`.
