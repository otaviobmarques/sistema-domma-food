# Integrações com marketplaces — 99Food, Keeta, aiqfome (Open Delivery)

Os três marketplaces aceitam o padrão aberto **Open Delivery** da Abrasel (v1.7). O Domma Food implementa o papel de
**Software Service** desse padrão, então uma única integração atende todos eles e qualquer outro aplicativo aderente.

## Como funciona
```
Marketplace ──(webhook assinado HMAC-SHA256)──▶ Edge Function "opendelivery" ──▶ pedido no gestor (com selo)
     ▲                                                   │
     │   OAuth2 client_credentials + POST /orders/{id}/… │  (fila com retentativa: 2, 4, 8 … até 60 min)
     └───────────────────────────────────────────────────┘
pg_cron (a cada minuto): envia a fila e faz polling de eventos (reserva caso o webhook falhe)
```

| Rota (Edge Function) | Uso |
|---|---|
| `GET  /functions/v1/opendelivery/m/{merchantId}/v1/merchant` | O marketplace lê dados da loja e o cardápio (header `X-API-KEY`) |
| `POST /functions/v1/opendelivery/m/{merchantId}/v1/newEvent` | Webhook de eventos (headers `X-App-Id`, `X-App-MerchantId`, `X-App-Signature`) |
| `POST /functions/v1/opendelivery/worker` | Interno (pg_cron/pg_net), protegido por segredo guardado no Vault |
| `POST /functions/v1/opendelivery/test` | Botão "Testar conexão" do painel (JWT do lojista + RLS) |

## Mapeamento de status
| Domma Food | Enviado ao marketplace |
|---|---|
| Aceitar (Novos → Em preparo) | `confirm` (+ `preparing` se o marketplace pedir) |
| Pronto | `readyForPickup` |
| Despachar (entrega própria) | `dispatch` |
| Concluir | `delivered` / `pickedUp` (quando o marketplace pede) |
| Cancelar | `requestCancellation` com o motivo |
| Marketplace pediu cancelamento | aviso no pedido → `acceptCancellation` ou `denyCancellation` |

Eventos recebidos: `CREATED` (busca o pedido completo pela API), `CANCELLED`, `ORDER_CANCELLATION_REQUEST`,
`DISPATCHED`, `DELIVERED`, `PICKED_UP`, `CONCLUDED`. Eventos repetidos são ignorados (idempotência por `eventId`).

## Segurança
- `client_secret` de cada loja fica no **Supabase Vault** (criptografado); o painel nunca lê o valor de volta.
- A `X-API-KEY` do GET /merchant é mostrada uma única vez; o banco guarda só o hash SHA-256.
- Webhook: assinatura HMAC-SHA256 do corpo, comparação em tempo constante; merchant e app conferidos.
- URLs do marketplace só `https://` públicas (bloqueio de endereços internos).
- Tabelas da integração com RLS; funções internas só para `service_role`.

## Ativar para uma loja
1. Cadastre-se como integrador no marketplace e peça as credenciais Open Delivery da loja:
   [99Food](https://developer-food.99app.com/pt-BR/openapi) · [aiqfome](https://developer.aiqfome.com/docs/category/api-open-delivery) · [Keeta](https://www.keeta-global.com/BR/pt-BR)
2. Painel → **Integrações** → Conectar → preencha Client ID, Client Secret e URL da API → **Testar conexão** → ative.
3. Informe ao marketplace o **Merchant ID**, a **URL do GET /merchant**, a **URL do webhook** e a **X-API-KEY**.

## Selos
Cada pedido de marketplace aparece com o selo do canal no gestor de pedidos; pedidos do cardápio próprio ficam sem selo.
Os selos usam o nome e a cor de cada marketplace. Para usar o logotipo oficial (do kit de parceiro), coloque o arquivo em
`public/marketplaces/<canal>.svg` e registre em `LOGO_FILES` (`src/components/channel-badge.tsx`).

## Testes
- `supabase/tests/functional_test.sql`: ingestão de pedido no formato Open Delivery, idempotência, fila de saída,
  cancelamento pedido pelo marketplace, isolamento entre lojas e proteção do segredo.
- Teste ponta a ponta feito em produção com um marketplace simulado: webhook com assinatura falsa → 403; assinado → 204
  e pedido criado; repetido → ignorado; aceite na loja → `confirm` e `preparing` entregues ao marketplace.
