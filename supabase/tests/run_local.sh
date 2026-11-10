#!/usr/bin/env bash
# Aplica shim + migrações num Postgres local (pg_cron é ignorado localmente).
set -euo pipefail
DB=${1:-dftest}
cd "$(dirname "$0")/.."
psql -v ON_ERROR_STOP=1 -q -d "$DB" -f tests/local_supabase_shim.sql
for f in migrations/*.sql; do
  echo "→ $f"
  grep -v -E "pg_cron|pg_net|cron\.schedule" "$f" | psql -v ON_ERROR_STOP=1 -q -d "$DB"
done
