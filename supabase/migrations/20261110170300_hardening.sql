-- =====================================================================
-- Domma Food · 004 · Endurecimento (recomendações do Security Advisor)
-- =====================================================================
alter function private.request_ip() set search_path = '';
alter function private.touch_updated_at() set search_path = '';
alter function private.check_unit_slug() set search_path = '';
alter function private.protect_unit_counter() set search_path = '';
alter function private.only_digits(text) set search_path = '';
alter function private.haversine_km(float8, float8, float8, float8) set search_path = '';
alter function private.allowed_transition(public.order_status, public.order_status, public.order_type) set search_path = '';

-- Bucket público serve URLs diretas sem política de SELECT; remover evita
-- que qualquer pessoa liste todos os arquivos de todos os tenants.
drop policy if exists media_read on storage.objects;

-- Funções internas não precisam ser executáveis por usuários (só as do RLS)
revoke execute on function private.expire_pix_orders() from authenticated;
revoke execute on function private.compute_order(jsonb) from authenticated;
