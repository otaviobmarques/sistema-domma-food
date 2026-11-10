# Segurança — Domma Food

## Princípios
1. **O banco é a fronteira de segurança.** Toda tabela tem Row Level Security (RLS) *forçado*. Mesmo que o front-end tenha um bug, um lojista não lê nem altera dados de outro.
2. **O navegador nunca dita valores.** Preço, complementos, taxa de entrega, cupom, horário e pedido mínimo são recalculados no servidor (`private.compute_order`). Enviar `unit_price_cents: 1` não tem efeito (há teste automatizado para isso).
3. **Visitante anônimo não acessa tabelas.** Ele só chama 4 funções: `get_store`, `quote_order`, `place_order` e `get_order_by_token`.
4. **Nenhum segredo no código.** As únicas chaves no repositório são a URL e a chave *publishable* do Supabase, que são públicas por definição e só funcionam com o RLS. A `service_role` key não é usada pelo app.

## Controles implementados
| Controle | Onde |
|---|---|
| Isolamento por tenant (RLS) | `supabase/migrations/*_security_rls_audit.sql`; testes em `supabase/tests/functional_test.sql` |
| Perfis (dono, gerente, caixa, atendente, cozinha, garçom, entregador) e acesso por unidade | `private.has_role`, `private.can_access_unit` |
| 2FA (TOTP) **exigido no banco** para quem ativou | `private.mfa_ok()` + `src/proxy.ts` |
| Máquina de estados do pedido (sem pular etapas) e permissões por perfil | `public.set_order_status` |
| Auditoria imutável (preço, cardápio, cupons, cancelamentos, pagamentos, acessos, IP) | `private.audit_row` → `audit_logs` (somente leitura) |
| Plano/status do tenant só muda pelo billing | `private.protect_tenant_billing` |
| Anti-abuso no checkout (5 pedidos/telefone/10 min, limites de itens e quantidades) | `public.place_order` |
| Token de acompanhamento com 144 bits aleatórios | `orders.public_token` |
| Upload de fotos só para gestores, na pasta do próprio tenant, imagens até 5 MB | políticas `media_*` em `storage.objects` |
| Cabeçalhos HTTP: CSP, HSTS, X-Frame-Options, nosniff, Referrer-Policy, Permissions-Policy | `next.config.ts` |
| Senha mínima de 10 caracteres | cadastro + configuração do Supabase Auth |
| LGPD: opt-in de marketing desmarcado por padrão, exportação CSV, anonimização | checkout, `/painel/clientes`, `public.anonymize_customer` |
| CI: typecheck, testes, testes de RLS, `npm audit` | `.github/workflows/ci.yml` |

## Ações manuais recomendadas (painel do Supabase)
- **Authentication → Providers → Email**: manter "Confirm email" ligado; senha mínima 10; ativar *Leaked password protection*.
- **Authentication → URL Configuration**: *Site URL* = domínio de produção; adicionar `https://<domínio>/auth/callback` nos Redirect URLs.
- **Authentication → Rate limits**: revisar limites de cadastro/login.
- **Authentication → SMTP**: configurar SMTP próprio (ex.: Resend) — o SMTP padrão tem limite baixo de envios.
- Tornar o repositório GitHub **privado**.
- Teste de intrusão antes do lançamento comercial (item 9 do descritivo).
