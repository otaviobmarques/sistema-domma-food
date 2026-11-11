# Domma Food

Sistema SaaS multiempresa para restaurantes, pizzarias, hamburguerias e afins: cardápio digital próprio (sem comissão), checkout com Pix, gestor de pedidos em tempo real, gestão do cardápio, áreas de entrega, cupons, CRM e dashboard.

Base técnica: **Next.js 16 (App Router) + Supabase (Postgres 17, Auth, Realtime, Storage) + Vercel**, conforme o Descritivo Técnico v1.0.

## O que já está pronto (Fases 0 e 1 do roadmap)

| Área | Funcionalidades |
|---|---|
| Fundação | Multiempresa (tenant → unidades → perfis), RLS em todas as tabelas, 7 perfis de acesso, 2FA (TOTP) aplicado também no banco, auditoria automática, LGPD (exportação e anonimização de cliente) |
| App do cliente | `/loja/<slug>`: cardápio com busca, destaques, complementos (mín./máx., meio a meio por maior preço ou média), sacola, checkout com entrega/retirada/agendamento, cupom, Pix (QR + copia e cola), acompanhamento em `/pedido/<token>` |
| Gestor de pedidos | Kanban em tempo real, alerta sonoro, cronômetro com cores, confirmar Pix, aceite/preparo/pronto/despacho/conclusão, cancelamento com motivo, impressão de comanda |
| Cardápio | Categorias com horário/dias, produtos com foto, promoção, esgotar até o fim do dia, tags, dados fiscais (NCM, CFOP, CSOSN, CEST), grupos de complementos reutilizáveis |
| Entregas | Áreas por raio (km) ou por bairro, taxa, tempo, pedido mínimo e frete grátis acima de um valor |
| Marketing | Cupons (%, valor fixo, frete grátis; mínimo, 1º pedido, limite total e por cliente, validade); CRM com segmentos e opt-in de marketing |
| Marketplaces | 99Food, Keeta e aiqfome via padrão **Open Delivery**: pedidos entram no gestor com o selo do canal e o status volta automaticamente (ver `docs/INTEGRACOES.md`) |
| Super Admin | `/admin`: todas as empresas, MRR, GMV, troca de plano e situação (teste, ativa, inadimplente, suspensa); login por usuário ou e-mail |
| Demonstração | Loja fictícia "Bella Massa Pizzaria" em `/loja/bella-massa` com cardápio, fotos e 2 semanas de pedidos (`supabase/seed/demo_bella_massa.sql`) |
| Salão e caixa | Caixa (abertura, sangria, suprimento, fechamento cego), PDV com vários pagamentos e troco, mesas e comandas com taxa de serviço e pré-conta, KDS por setor |
| Equipe | Convite por e-mail, 7 perfis, limite de desconto por pessoa |
| Gestão | Histórico de pedidos com filtros e CSV, análise de vendas com comparação de período; Dashboard (faturamento, pedidos, ticket médio, preparo médio, por hora/dia/pagamento/tipo, mais vendidos), configurações de horário, pagamentos e loja |

Próximas fases (ver `docs/ROADMAP.md`): IA no WhatsApp (Domma Chat), PDV offline/TEF.

## Rodando localmente

```bash
npm install
cp .env.example .env.local
npm run dev
```

Testes:

```bash
npm test            # unitários (Pix, formatação)
npm run lint        # TypeScript
npm run test:db     # migrações + regras de negócio + RLS num Postgres local
```

## Estrutura

```
supabase/migrations/   esquema, RLS, regras de negócio (RPCs), endurecimento
supabase/functions/    Edge Function da integração Open Delivery
supabase/tests/        testes do banco (isolamento entre tenants, preços, 2FA)
src/app/loja/          cardápio público e checkout
src/app/pedido/        acompanhamento do pedido
src/app/painel/        retaguarda do lojista
public/brand/           logo Domma Food (SVG: claro, escuro, branco, ícone)
public/marketing/       capturas reais do sistema usadas no site
src/lib/               clientes Supabase, Pix (BR Code), formatação
docs/                  arquitetura, segurança, backup e recuperação
```

Leia `docs/SEGURANCA.md`, `docs/INTEGRACOES.md` e `docs/BACKUP_E_RECUPERACAO.md` antes de ir para produção.
