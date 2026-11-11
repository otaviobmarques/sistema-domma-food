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

## NFC-e (Focus NFe)

- A nota é montada no banco (`private.fiscal_payload`) com itens, descontos rateados e formas de pagamento proporcionais ao total; taxa de serviço e de entrega ficam fora da nota.
- Fila em `fiscal_documents`; a Edge Function `fiscal` (`/worker`) envia para a API v2 da Focus (`POST /v2/nfce?ref=`, cancelamento `DELETE /v2/nfce/{ref}`), com nova tentativa e espera crescente quando o provedor não responde, e consulta antes de reenviar.
- O token do provedor fica no Vault e só é lido pela função interna (trava `private.assert_service_role`).
- Emissão automática (opcional): PDV na venda, delivery/retirada ao concluir pago, mesa ao fechar a conta. Marketplaces ficam de fora por padrão.
- Para produção, cada CNPJ precisa: conta no provedor, certificado A1, CSC da SEFAZ e inscrição estadual habilitada. NCM/CFOP/CSOSN devem ser conferidos pelo contador.
- Teste de ponta a ponta (11/11/2026): com token inválido em homologação a Focus respondeu "Access token inválido" e a nota ficou como rejeitada, com reenvio disponível.

## Pagamento online (Mercado Pago)

- Cada loja conecta a própria conta Mercado Pago (Public Key, Access Token e assinatura secreta do webhook). O dinheiro cai na conta da loja; as tarifas são do Mercado Pago. Token e assinatura ficam no Vault.
- Edge Function `payments`: `/pix` e `/card` criam o pagamento em `POST /v1/payments` com `X-Idempotency-Key`; o valor sempre vem do pedido no banco. O cartão é tokenizado pelo Card Payment Brick no navegador, então os dados do cartão não passam pelo nosso servidor.
- Webhook `/payments/webhook?unit=<id>`: valida `x-signature` (HMAC-SHA256 do manifesto `id:...;request-id:...;ts:...;`) e, mesmo assim, consulta o pagamento no Mercado Pago antes de mudar qualquer coisa. Rede de segurança: a página do pedido consulta o status e o cron confere pendentes a cada minuto.
- Valor aprovado diferente do pedido não confirma. Pagamento aprovado com pedido cancelado ou já pago gera estorno automático. Cancelar um pedido pago online estorna sozinho (`POST /v1/payments/{id}/refunds`), com novas tentativas.
- O Pix do Mercado Pago precisa ter pelo menos 30 minutos de validade. Se o cliente pagar depois de o pedido expirar, o valor é estornado automaticamente.
- Teste de ponta a ponta (12/11/2026, credenciais falsas): o Mercado Pago real recusou o token; o webhook recusou a assinatura forjada (401); o Pix mostrou o erro do provedor; a política de segurança da página do pedido não bloqueia nada do SDK.

## Entregadores e rotas

- Entregador sem login: cada um tem um link próprio (`/entregador/<token>`, 128 bits aleatórios) que só mostra as entregas atribuídas a ele e só enquanto estiverem em andamento. "Gerar novo link" invalida o anterior. Só a gerência lê o link.
- Rota: ordem sugerida pelo vizinho mais próximo a partir da loja; "Abrir rota no mapa" usa o Google Maps com paradas, sem chave de API.
- Saída só com o pedido pronto; "Entreguei" exige a forma de pagamento quando há valor a cobrar; "Não consegui entregar" volta o pedido para pronto.
- Acerto: taxas do entregador (fixa, a taxa de entrega cobrada ou percentual) contra o dinheiro recebido dos clientes; entra no caixa aberto e lança a conta a pagar "Entregadores" no Financeiro.

## Impressão automática

- Impressoras por loja: rede (IP:9100, ESC/POS), do computador (spooler do Windows/macOS/Linux) ou navegador (estação de impressão no painel, com Chrome `--kiosk-printing`).
- A comanda de cada setor e a via do pedido entram na fila ao aceitar o pedido (ou assim que ele chega, conforme a impressora); itens de mesa imprimem quando lançados.
- Agente: `tools/print-agent/print-agent.mjs` (também em `/print-agent.mjs`), Node 18+, sem dependências. Autentica com chave própria (só o hash fica no banco), busca a fila a cada 3 s e devolve o resultado; trabalho preso volta para a fila em 2 min.
- Teste (11/11/2026): impressora de rede simulada recebeu o teste e o pedido #365 (comanda com complemento e observação; via com troco, endereço e referência).

## Marketing e WhatsApp

- Públicos: inativos, novos, frequentes, aniversariantes, todos. Só clientes com autorização de marketing (LGPD), no máximo uma mensagem a cada N dias, quem responde SAIR é descadastrado.
- Cupom automático único por cliente (uso único) ou compartilhado.
- Envio manual (o lojista envia pelo próprio WhatsApp, um a um, com a mensagem pronta) ou pela API oficial (WhatsApp Cloud API, modelos aprovados pela Meta) com status de entregue/lido pelo webhook assinado (`X-Hub-Signature-256`).
- Automações diárias (~10h): aniversário e "sentimos sua falta". Conversão: pedido do cliente em até 7 dias após a mensagem.
