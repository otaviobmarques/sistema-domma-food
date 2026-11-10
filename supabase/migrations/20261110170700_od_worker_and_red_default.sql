-- =====================================================================
-- Domma Food · 008 · Agendamento da integração + cor padrão vermelha
-- O segredo do worker é gerado AQUI, dentro do banco, e guardado no Vault.
-- =====================================================================
create or replace function public.od_worker_secret()
returns text language sql stable security definer set search_path = '' as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'od_worker_secret';
$$;
revoke execute on function public.od_worker_secret() from public, anon, authenticated;
grant execute on function public.od_worker_secret() to service_role;

do $$ begin
  if not exists (select 1 from vault.secrets where name = 'od_worker_secret') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'od_worker_secret', 'Domma Food: worker Open Delivery');
  end if;
  if not exists (select 1 from vault.secrets where name = 'od_worker_url') then
    perform vault.create_secret('https://kcwidutqdqbyphrjnlef.supabase.co/functions/v1/opendelivery/worker', 'od_worker_url', 'Domma Food: URL do worker');
  end if;
end $$;

-- A cada minuto: envia a fila e faz polling (rede de segurança do webhook)
create or replace function private.od_cron_tick()
returns void language plpgsql security definer set search_path = '' as $$
declare v_url text; v_secret text;
begin
  if not exists (select 1 from public.marketplace_connections where active) then return; end if;
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'od_worker_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'od_worker_secret';
  perform net.http_post(url := v_url, body := '{"job":"all"}'::jsonb,
    headers := jsonb_build_object('Content-Type','application/json','x-worker-secret', v_secret), timeout_milliseconds := 25000);
end $$;
select cron.schedule('domma-opendelivery', '* * * * *', $$select private.od_cron_tick()$$);

alter table public.units alter column primary_color set default '#D9262B';
update public.units set primary_color = '#D9262B' where primary_color = '#6D28D9';
