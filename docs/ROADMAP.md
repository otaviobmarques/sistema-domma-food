# Roadmap (do Descritivo Técnico v1.0)

| Fase | Status | Entregas |
|---|---|---|
| 0. Fundação | ✅ | Multi-tenant, autenticação e perfis, RLS, 2FA, auditoria, CI, backup |
| 1. MVP Delivery | ✅ (Pix manual) | Cardápio + checkout, gestão do cardápio, gestor de pedidos, áreas e taxas, cupons, dashboard |
| 1b. Pendências do MVP | ⏳ | Gateway de pagamento (Pix automático + cartão tokenizado: Asaas/Mercado Pago), cobrança SaaS (Asaas), convite de equipe por e-mail, impressão automática (Print Agent), domínio próprio por loja |
| 2. Salão e caixa | ⏳ | PDV e caixa, mesas e comandas, app do garçom, QR na mesa, KDS, modo offline |
| 3. WhatsApp e marketing | ⏳ | Atendente IA (Domma Chat), avisos de status, recuperação de carrinho, RFM, disparador, automações, cashback e pontos, avaliações |
| 4. Gestão | ⏳ | Estoque e ficha técnica, financeiro (fluxo, contas, DRE), fiado e carteira, NFC-e via provedor |
| 5. Escala | ⏳ | App do entregador e roteirização, totem com TEF, iFood homologado, redes multiunidade |
| 6. Ecossistema | ⏳ | Domma IA + MCP, API pública e webhooks, App Store, portal de revendas |

O esquema já tem pontos de extensão para as próximas fases: `order_channel` (whatsapp, ifood, table, totem), `order_type.dine_in`, `payments.gateway/txid`, dados fiscais por produto, `product_unit_overrides` (preço por loja), `plans.features`.
