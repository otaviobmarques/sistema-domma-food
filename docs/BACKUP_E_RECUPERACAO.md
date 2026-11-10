# Backup, redundância e recuperação

## Camadas
| Camada | O que protege | Como |
|---|---|---|
| 1. Backup físico diário do Supabase | Banco inteiro | Automático no plano Pro (retenção de 7 dias) |
| 2. PITR — recuperação ponto a ponto | Erros humanos ("apaguei sem querer às 14:32") | Add-on pago: Supabase → Project Settings → Add-ons → Point in Time Recovery (7, 14 ou 28 dias). **Necessário para cumprir o requisito "retenção de 30 dias e recuperação ponto a ponto" do descritivo.** |
| 3. Backup lógico externo diário, criptografado | Falha da conta/região do Supabase | `.github/workflows/backup.yml` → `pg_dump` + AES-256 → artefato do GitHub (30 dias) e, opcionalmente, bucket S3/R2/B2 |
| 4. Código e migrações versionados | Recriar o banco do zero | `supabase/migrations/` no Git |
| 5. Fotos | Mídias dos produtos | Supabase Storage (replicado no S3 da AWS). Para cópia externa: sincronizar o bucket `media` com `rclone` |

## Redundância e disponibilidade
- **Front-end (Vercel)**: rede global com CDN e failover automático entre regiões; cada deploy é imutável e pode ser revertido em 1 clique (*Instant Rollback*).
- **Banco (Supabase, região São Paulo `sa-east-1`)**: infraestrutura AWS com discos replicados. Para alta disponibilidade adicional: *Read Replica* (add-on) em outra região.
- **Fila de expiração do Pix**: `pg_cron` dentro do próprio banco (sem servidor extra para cair).
- **Tempo real**: o gestor de pedidos usa Realtime e, como reserva, recarrega a lista a cada 60 s; o cliente acompanha o pedido por consulta periódica.

## Ativar o backup externo (uma vez)
1. Supabase → **Connect** → *Session pooler* → copie a connection string e troque `[YOUR-PASSWORD]` pela senha do banco.
2. Gere uma frase-senha longa (ex.: `openssl rand -base64 48`) e **guarde num cofre** (1Password/Bitwarden). Sem ela, não há como restaurar.
3. GitHub → Settings → Secrets and variables → Actions → crie `SUPABASE_DB_URL` e `BACKUP_PASSPHRASE`.
4. Actions → *Backup do banco* → *Run workflow* para testar.

## Restaurar
```bash
gpg --decrypt domma-food-AAAAMMDDTHHMMSSZ.dump.gpg > db.dump
pg_restore --no-owner --no-privileges --dbname "<connection string do banco de destino>" db.dump
```
Para um projeto novo: crie o projeto, aplique `supabase/migrations/` e depois restaure apenas os dados (`pg_restore --data-only`).

## Teste de restauração
Faça uma restauração de teste **todo mês** num projeto Supabase temporário e confira contagens de `orders`, `customers` e `products`. Backup que nunca foi restaurado não é backup.
