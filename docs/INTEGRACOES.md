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

## Avisos de status pelo WhatsApp

- Usa a mesma conta da API oficial do Marketing. Em **Marketing › Avisos de pedido** a loja escolhe os eventos (recebido, em preparo, pronto para retirada, saiu para entrega, concluído, cancelado) e informa o nome do modelo aprovado de cada um (categoria **Utilidade** na Meta). O painel sugere o texto e a ordem das variáveis e tem envio de teste para um número (até 10 por hora).
- Só recebe quem marcou "receber avisos deste pedido" no checkout (a opção aparece apenas quando a loja tem avisos ligados). Pedidos de marketplace e de mesa nunca recebem.
- O gatilho no banco enfileira o aviso na mudança de status (um por evento por pedido) e aciona o worker na hora; o worker envia os avisos antes das campanhas, sem janela de horário. Aviso com mais de 30 minutos na fila é descartado para não chegar fora de hora. Entregue/lido/falhou chegam pelo mesmo webhook do Marketing.
- Sem a API: no detalhe do pedido, **Avisar status ↗** abre o WhatsApp da loja com a mensagem do status atual já escrita.

## Cobrança da assinatura (Asaas)

- Assinatura mensal por empresa no Asaas, com fatura paga por Pix, boleto ou cartão na página do próprio Asaas. Dados de cartão nunca passam pelo Domma.
- **Dono da conta:** em **Assinatura**, escolhe o plano, informa CPF/CNPJ e o e-mail das faturas e assina. Se assinar durante o teste grátis, a 1ª fatura vence no fim do teste. Também pode trocar de plano (vale para a fatura em aberto e as próximas, sem cobrança proporcional) e cancelar (a conta fica ativa até o fim do período já pago). As faturas aparecem com o link para pagar.
- **Situação da empresa:** teste → ativa quando a fatura é paga. Teste vencido ou fatura vencida → **pagamento pendente** (faixa vermelha no painel) → **suspensa** depois da carência, que é configurável e de 7 dias por padrão. Suspensa, a loja sai do ar e o painel fica bloqueado; só a tela de Assinatura continua aberta para o dono pagar, e o pagamento reativa na hora. Suspensão feita pelo admin não é desfeita por pagamento.
- **Super admin (/admin):**
  - Configura ambiente (sandbox/produção), chave da API (no Vault) e carência, e testa a conexão.
  - Cria no Asaas o webhook de **Cobranças** (v3, envio sequencial) com a URL e o token mostrados. O token vai no cabeçalho `asaas-access-token`.
  - Só então liga a cobrança. Enquanto estiver desligada, ninguém é cobrado nem suspenso.
  - Marca empresas **isentas** (demonstração, parceiros).
- **Webhook:** cada aviso é processado uma única vez, pelo `id` do evento. A Edge Function confere a cobrança no Asaas antes de aplicar, então não confia só no corpo do aviso.
- **Rotina diária (6h23 de Brasília):** fim do teste, fim da carência e fim de assinatura cancelada.
- Nota fiscal de serviço: pode ser emitida pelo próprio Asaas (configuração na conta do Asaas).

## iFood (Merchant API)

- O iFood não usa o Open Delivery. A integração é pela **Merchant API** oficial, com um **aplicativo distribuído** do Domma: um único app para toda a plataforma.
- **Super admin (/admin):** informa o Client ID e o Client Secret do app, que ficam no Vault, e testa.
  - O app é criado no Portal do Desenvolvedor iFood com os módulos Order, Merchant e Events.
  - Precisa passar pela homologação do iFood antes de atender lojas reais.
- **Loja (Integrações › iFood):**
  1. Clica em **Conectar iFood** e recebe um código de vínculo.
  2. Autoriza o Domma no Portal do Parceiro.
  3. Cola o código de autorização que o portal mostra.

  Os tokens da loja ficam no Vault e são renovados sozinhos. Se a conta enxergar mais de uma loja no iFood, a loja escolhe qual vincular.
- **Pedidos:** consulta de eventos a cada **30 segundos** (cron), como o iFood exige para considerar a loja conectada, com confirmação de cada evento recebido. Pedido novo (`PLC`) é buscado inteiro na API e entra na fila de pedidos com o selo do iFood.
  - Entrega pelo iFood ou pela loja. O código de coleta e o contato 0800 com localizador vão nas observações.
  - O telefone do iFood não vira cadastro de cliente.
- **Status, do Domma para o iFood:** aceitar → `confirm`; pronto → `readyToPickup`; saiu (entrega própria) → `dispatch`; cancelar → `requestCancellation`, com o motivo escolhido na lista do próprio iFood. Tudo passa pela fila com novas tentativas.
- **Status, do iFood para o Domma:** confirmado no gestor do iFood (`CFM`), saiu (`DSP`), concluído (`CON`) e cancelado (`CAN`) são aplicados sem reenviar para o iFood.
- **Cancelamento pedido pelo cliente:** chega pela plataforma de negociação (`HSD`) e aparece no pedido para a loja aceitar ou recusar (`disputes/{id}/accept|reject`).
- Para ligar os itens do iFood aos produtos do Domma (estoque e relatórios), use o ID do produto do Domma como código PDV no cardápio do iFood.

## Domínio próprio por loja

- **Loja (Configurações › Domínio próprio do cardápio):** informa o domínio, como `pedidos.minhapizzaria.com.br`. Um subdomínio é o mais simples.
  - O Domma cadastra o domínio no projeto da Vercel, que emite o HTTPS sozinha, e mostra o DNS a criar: `CNAME → cname.vercel-dns.com` para subdomínio, `A → 76.76.21.21` para domínio raiz, mais o TXT de verificação quando a Vercel pedir.
  - Uma rotina confere a cada 10 minutos e ativa quando o DNS estiver certo. Domínios ativos são conferidos uma vez por dia.
- **Funcionamento (`src/proxy.ts`):** o host vira loja pela função `get_unit_by_domain`, só para domínios ativos de lojas não suspensas, com cache de 60 s.
  - `/` mostra o cardápio, `/checkout` o checkout e `/pedido/...` o acompanhamento.
  - Painel, login e admin redirecionam para o domínio da plataforma, para a sessão nunca ficar em domínio de terceiros.
  - Cardápio de outra loja e domínio desconhecido também redirecionam para a plataforma.
- **Links:** avisos de status e campanhas do WhatsApp passam a usar o domínio da loja quando ele está ativo.
- **Super admin (/admin):** informa o token da Vercel (Account Settings › Tokens, com acesso ao time do projeto), que fica no Vault. Projeto e time já vêm preenchidos.
- Se a plataforma ganhar um domínio próprio, por exemplo `dommafood.com.br`, inclua-o em `NEXT_PUBLIC_MAIN_HOSTS` na Vercel para ele ser tratado como domínio principal, e não como loja.

## Totem de autoatendimento

- **Painel › Totens:** o gestor cria um totem (por exemplo, "Totem da entrada") e recebe um link `/totem/<chave>` com QR Code.
  - A chave é guardada só como hash, então o link aparece uma vez; dá para gerar outro ou desativar o totem.
  - Opções por totem: comer aqui, para levar, Pix na tela, pagar no caixa e aceitar automaticamente.
  - O painel mostra se o totem está ligado agora (sinal a cada minuto).
- **No aparelho (tablet ou tela touch):**
  - Fluxo: tela de início → comer aqui ou levar → cardápio por categoria → adicionais → revisão → nome → pagamento → número do pedido em destaque.
  - Inatividade: depois de 75 s sem toque, pergunta se o cliente ainda está ali e recomeça sozinho, apagando a sacola e os dados do cliente anterior.
  - Para travar o aparelho no cardápio: Android "Fixar app", iPad "Acesso Guiado", computador com Chrome `--kiosk`.
- **Pagamento:**
  - **Pix na tela:** usa o Mercado Pago configurado em Pagamento online. O pedido fica aguardando pagamento e entra na cozinha quando o Pix é confirmado.
  - **Pagar no caixa:** o pedido entra marcado "PAGAR NO CAIXA". Em Pedidos, o botão **Receber no caixa** (`order_receive`) registra a forma de pagamento e o troco no caixa aberto.
  - Cartão direto no totem (TEF/maquininha integrada) ainda não é suportado. Nesse caso, o cliente paga no caixa.
- **Proteções:** limite de 15 pedidos a cada 10 minutos por totem, teto de valor por pedido, loja fechada não aceita pedidos e totem desativado para na hora.

## Pixel do Meta, Google Analytics 4 e funil de conversão

- **Painel › Marketing › Anúncios e métricas** (dono e gerência, por loja):
  - IDs da loja: Pixel do Meta (só números), GA4 (`G-…`) e, se quiser, a conversão de compra do Google Ads (`AW-…` + rótulo).
  - Os IDs são validados no banco (`tracking_save`) e vão para o cardápio pelo `get_store` (`unit.tracking`). Não há segredo: esses IDs aparecem no HTML de qualquer site que usa as ferramentas.
- **Eventos enviados pelo cardápio:**

  | Momento | Meta Pixel | GA4 |
  | --- | --- | --- |
  | Abriu o cardápio | `PageView` | `page_view` |
  | Abriu um produto | `ViewContent` | `view_item` |
  | Adicionou à sacola | `AddToCart` | `add_to_cart` |
  | Abriu o checkout | `InitiateCheckout` | `begin_checkout` |
  | Fez o pedido | `Purchase` (valor, `eventID` = id do pedido) | `purchase` (`transaction_id` = id do pedido) e conversão do Google Ads |

  - O token público do pedido nunca é enviado às ferramentas.
- **LGPD:**
  - Se a loja tem algum ID, o cardápio mostra um aviso de cookies.
  - Pixel e gtag só carregam depois do **Aceitar**. Recusar não muda nada no pedido.
  - A escolha fica guardada no aparelho (`df_consent_v1`).
- **Funil do Domma (`funnel_track` / `funnel_report`):**
  - Contagem própria, anônima e sem cookies: um id aleatório por sessão do navegador (`sessionStorage`) conta uma vez em cada etapa. As etapas são visita, produto, sacola, checkout e pedido.
  - A origem vem de `utm_source`. Sem ela, vem de `fbclid`/`gclid` ou do site de onde o cliente veio; o resto conta como "direto". O painel tem links prontos com `utm_source`.
  - Os dados ficam guardados por 180 dias (cron `domma-funnel-purge`).
- **Segurança (CSP):**
  - Os domínios do Meta e do Google só são liberados nas páginas públicas da loja: `/loja/*`, `/pedido/*` e domínio próprio.
  - O painel e o admin continuam com a política fechada.

## PDV pelo WhatsApp (Atendimento)

- **Painel › Atendimento WhatsApp** (dono, gerência, caixa e atendimento):
  - **Caixa de entrada:** as mensagens que chegam no número oficial (webhook `marketing/webhook`) viram conversas, com filtros abertas, não lidas e encerradas, e atualizam em tempo real.
  - O cliente é reconhecido pelo telefone. Ao lado da conversa aparecem os pedidos anteriores, o total gasto, o cashback e o último endereço.
  - **Responder:** `marketing/inbox/send` envia o texto pela Cloud API. A regra fica no banco (`inbox_queue_reply`): só a equipe responde, só dentro da janela de 24 h desde a última mensagem do cliente e com limite de 20 mensagens por minuto.
  - Os vistos (enviada, entregue, lida) vêm do webhook.
  - Fora da janela de 24 h, o painel oferece abrir a conversa no WhatsApp da loja.
  - Mídias (áudio, foto, documento) aparecem como aviso ou legenda; o arquivo fica no celular.
- **Lançar pedido** (`wa_order`):
  - Usa as mesmas regras do cardápio (`place_order_core`): preço do servidor, adicionais, área e taxa de entrega, cupom, horário da loja e pedido mínimo.
  - O pedido entra no canal **WhatsApp**, já aceito e em preparo. Com Pix, fica aguardando o pagamento; cartão online não é aceito por aqui.
  - Depois do lançamento sai um resumo pronto com o link de acompanhamento, que pode ser enviado na conversa ou pelo WhatsApp da loja (`wa.me`).
- **Sem a API da Meta:** o botão **Novo pedido** funciona do mesmo jeito para pedidos que chegam pelo WhatsApp comum da loja.

## CRM com filtros avançados

- **Painel › Clientes** (dono e gerência): a busca e os filtros rodam no servidor (`crm_search`), sem o limite de 1.000 clientes no navegador. Todos os filtros somam (condição "E"):
  - **Relacionamento:** segmento (novo, recorrente, fiel, em risco, inativo, sem pedido), situação de marketing e etiquetas.
  - **Frequência e valor:** número de pedidos, gasto total, ticket médio, cashback mínimo e fiado em aberto.
  - **Datas:** sem pedir há X dias, pediu nos últimos X dias, primeiro pedido recente e aniversário (hoje, 7 dias, este mês ou o próximo).
  - **Pedidos:** canal, forma de pagamento, produto comprado, bairro de entrega e loja, com período opcional ("pedidos dos últimos X dias"). Pedidos cancelados não contam.
- **Filtros salvos** (`crm_segments`, até 50 por conta): ficam em chips no topo da tela e aparecem como público **Filtro do CRM** em Marketing › Campanhas.
  - O botão **Criar campanha** abre uma campanha nova já com o filtro atual.
  - A campanha continua respeitando o opt-in de marketing, o descadastro e o intervalo entre mensagens.
- **Etiquetas:**
  - Por cliente (`crm_set_tags`): até 20, normalizadas em minúsculas.
  - Em massa, para todos os clientes do filtro (`crm_bulk_tag`).
- **Exportar CSV:** exporta o resultado filtrado, até 5.000 clientes, com segmento, etiquetas, ticket médio e aniversário.

## Logística sob demanda: Foody Delivery e Entrega iFood

Serve para chamar um entregador externo em pedidos de entrega de qualquer canal (cardápio, WhatsApp, balcão, telefone). Pedidos que vieram de marketplace ficam de fora, porque a logística deles é do próprio app.

- **Configuração:** em **Painel › Integrações › Logística** (dono e gerência, por loja).
  - **Foody Delivery** (padrão Open Delivery, Logistics):
    - Na Foody, crie a credencial em Menu › Minha conta › APIs e Hooks › Criar credencial, do tipo Open Delivery.
    - Copie para o Domma o `baseUrl`, o `clientId` e o `clientSecret`. O secret fica no Vault.
    - Cadastre na Foody o **gatilho** (webhook) que o painel mostra: `…/functions/v1/logistics/webhook?h=<token da loja>`.
    - O token vai em `{baseUrl}/oauth/token` (client_credentials) e é renovado sozinho. A Foody devolve `expires_in` em milissegundos e o Domma trata isso.
  - **Entrega iFood** (Shipping API, pedidos de fora do iFood):
    - Usa a conexão iFood da loja (Integrações › iFood) e exige o serviço contratado no Portal do Parceiro.
    - Os eventos chegam pelo mesmo polling do iFood: `handleEvent` encaminha para a logística os eventos de entregas solicitadas pelo Domma.
  - **Retorno à loja:** opção para o entregador voltar depois da entrega (por exemplo, para trazer a maquininha).
- **Na tela de Pedidos**, no detalhe de um pedido de entrega:
  - **Chamar entregador** cota os parceiros ligados ao mesmo tempo (preço e prazo). É só escolher e clicar em **Chamar**.
  - Durante a entrega aparecem o status, o entregador, a previsão, o custo e o código de entrega, com links para rastrear e cancelar.
  - A Entrega iFood exige o **CEP** e a **localização** (latitude e longitude) do cliente. Se o pedido não tiver, a equipe preenche na hora.
  - A Entrega iFood aceita pedido já pago ou pago na entrega em dinheiro ou cartão. O cliente confirma a entrega com os 4 últimos dígitos do telefone.
- **Reflexo no pedido** (`logistics_event`):
  - Quando o entregador coleta, o pedido vai para **saiu para entrega**. Quando entrega, vai para **concluído**.
  - Cancelamento, recusa ou falha liberam uma nova solicitação. Entrega concluída não volta atrás, e eventos fora de ordem não fazem o status regredir.
- **Segurança:**
  - A Edge Function confere a permissão da equipe no banco (`logistics_can`) antes de qualquer chamada. As credenciais só saem do banco para o servidor (`service_role`).
  - O webhook da Foody exige o token da loja na URL e confere a assinatura `X-App-Signature` (HMAC-SHA256 com o clientSecret) quando ela vem. Também só aceita eventos de entregas daquela loja.
