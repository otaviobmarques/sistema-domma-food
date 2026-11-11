-- =====================================================================
-- Domma Food · 040 · Domínio próprio por loja
-- O lojista informa o domínio; a Edge Function "domains" cadastra no projeto
-- da Vercel (que emite o HTTPS), mostra o DNS a configurar e confere até ativar.
-- O proxy do Next resolve o host → loja (só domínios ativos).
-- =====================================================================
create table public.unit_domains (
  unit_id uuid primary key references public.units(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  domain text not null unique,
  status text not null default 'pending' check (status in ('pending','active','error')),
  dns jsonb,                       -- registros a configurar (tipo, nome, valor)
  last_check_at timestamptz, last_error text, verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (char_length(domain) between 4 and 253),
  check (domain ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$'),
  check (domain !~ '(^|\.)(vercel\.app|vercel\.com|supabase\.co|supabase\.in|dommafood\.com\.br|dommafood\.com)$')
);
alter table public.unit_domains enable row level security;
alter table public.unit_domains force row level security;
create policy ud_select on public.unit_domains for select to authenticated using (private.can_manage(tenant_id));
revoke all on public.unit_domains from anon;
revoke insert, update, delete on public.unit_domains from authenticated;

create table public.domains_app (
  id boolean primary key default true check (id),
  project_id text not null default 'prj_89scP2ePbhAEqZH5ROxwvsTW0yk6',
  team_id text default 'team_ibaMk1FkRo9Gly9XqQGLl7Wj',
  token_secret_id uuid,
  last_test_at timestamptz, last_test_ok boolean, last_test_message text,
  updated_at timestamptz not null default now()
);
insert into public.domains_app (id) values (true);
alter table public.domains_app enable row level security;
alter table public.domains_app force row level security;
revoke all on public.domains_app from anon, authenticated;

-- ---------- URL pública da loja (usa o domínio próprio quando ativo) ----------
create or replace function private.store_base_url(p_unit uuid)
returns text language sql stable security definer set search_path = '' as $$
  select coalesce((select 'https://' || d.domain from public.unit_domains d where d.unit_id = p_unit and d.status = 'active'),
                  'https://domma-food.vercel.app');
$$;
create or replace function private.store_url_by_slug(p_slug text)
returns text language sql stable security definer set search_path = '' as $$
  select coalesce((select 'https://' || d.domain from public.unit_domains d join public.units u on u.id = d.unit_id
                   where u.slug = p_slug and d.status = 'active'),
                  'https://domma-food.vercel.app/loja/' || p_slug);
$$;
do $$ declare d text; begin
  d := pg_get_functiondef('private.campaign_render(text, public.customers, text, text, text)'::regprocedure);
  if position($x$'https://domma-food.vercel.app/loja/' || p_slug$x$ in d) = 0 then raise exception 'campaign_render mudou'; end if;
  execute replace(d, $x$'https://domma-food.vercel.app/loja/' || p_slug$x$, $x$private.store_url_by_slug(p_slug)$x$);
  d := pg_get_functiondef('private.campaign_generate(uuid, text)'::regprocedure);
  if position($x$'https://domma-food.vercel.app/loja/' || u.slug$x$ in d) = 0 then raise exception 'campaign_generate mudou'; end if;
  execute replace(d, $x$'https://domma-food.vercel.app/loja/' || u.slug$x$, $x$private.store_url_by_slug(u.slug)$x$);
  d := pg_get_functiondef('private.status_enqueue(uuid, text)'::regprocedure);
  if position($x$'https://domma-food.vercel.app/pedido/' || o.public_token$x$ in d) = 0 then raise exception 'status_enqueue mudou'; end if;
  execute replace(d, $x$'https://domma-food.vercel.app/pedido/' || o.public_token$x$, $x$private.store_base_url(o.unit_id) || '/pedido/' || o.public_token$x$);
  d := pg_get_functiondef('public.status_test(uuid, text, text)'::regprocedure);
  if position($x$'https://domma-food.vercel.app/loja/' || coalesce(u.slug, '')$x$ in d) = 0 then raise exception 'status_test mudou'; end if;
  execute replace(d, $x$'https://domma-food.vercel.app/loja/' || coalesce(u.slug, '')$x$, $x$private.store_url_by_slug(u.slug)$x$);
end $$;

-- ---------- Resolução do host (proxy do Next, chave pública) ----------
create or replace function public.get_unit_by_domain(p_host text)
returns text language sql stable security definer set search_path = '' as $$
  select u.slug from public.unit_domains d join public.units u on u.id = d.unit_id join public.tenants t on t.id = u.tenant_id
  where d.domain = lower(split_part(trim(p_host), ':', 1)) and d.status = 'active' and u.active and t.status <> 'suspended';
$$;

-- ---------- Painel ----------
create or replace function public.domain_overview(p_unit_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare u public.units; d public.unit_domains;
begin
  select * into u from public.units where id = p_unit_id;
  if not found or not private.can_manage(u.tenant_id) or not private.can_access_unit(u.id) then raise exception 'Sem permissão.' using errcode = '42501'; end if;
  select * into d from public.unit_domains where unit_id = u.id;
  return jsonb_build_object('ready', (select token_secret_id is not null from public.domains_app where id), 'slug', u.slug,
    'domain', case when d.unit_id is null then null else jsonb_build_object('domain', d.domain, 'status', d.status, 'dns', d.dns,
      'last_check_at', d.last_check_at, 'last_error', d.last_error, 'verified_at', d.verified_at) end);
end $$;
create or replace function public.domain_can_manage(p_unit_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.units u where u.id = p_unit_id and private.can_manage(u.tenant_id) and private.can_access_unit(u.id));
$$;

-- ---------- Serviço (Edge Function) ----------
create or replace function public.domains_context()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.assert_service_role();
  return (select jsonb_build_object('project_id', project_id, 'team_id', team_id,
    'token', (select decrypted_secret from vault.decrypted_secrets where id = token_secret_id)) from public.domains_app where id);
end $$;
create or replace function public.domain_upsert(p_unit_id uuid, p_domain text, p_status text, p_dns jsonb, p_error text)
returns void language plpgsql security definer set search_path = '' as $$
declare u public.units;
begin
  perform private.assert_service_role();
  select * into u from public.units where id = p_unit_id;
  insert into public.unit_domains (unit_id, tenant_id, domain, status, dns, last_check_at, last_error, verified_at)
  values (u.id, u.tenant_id, lower(p_domain), p_status, p_dns, now(), left(p_error, 300), case when p_status = 'active' then now() end)
  on conflict (unit_id) do update set domain = excluded.domain, status = excluded.status, dns = coalesce(excluded.dns, public.unit_domains.dns),
    last_check_at = now(), last_error = excluded.last_error,
    verified_at = case when excluded.status = 'active' then coalesce(public.unit_domains.verified_at, now()) end, updated_at = now();
end $$;
create or replace function public.domain_delete(p_unit_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.assert_service_role();
  delete from public.unit_domains where unit_id = p_unit_id;
end $$;
create or replace function public.domains_to_check()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.assert_service_role();
  -- pendentes até 14 dias; ativos uma vez por dia (pega DNS removido)
  return coalesce((select jsonb_agg(jsonb_build_object('unit_id', unit_id, 'domain', domain, 'status', status)) from public.unit_domains
    where (status <> 'active' and created_at > now() - interval '14 days')
       or (status = 'active' and coalesce(last_check_at, '-infinity') < now() - interval '1 day')), '[]'::jsonb);
end $$;
create or replace function public.domains_test_result(p_ok boolean, p_message text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.assert_service_role();
  update public.domains_app set last_test_at = now(), last_test_ok = p_ok, last_test_message = left(p_message, 300) where id;
end $$;
do $$ begin
  if not exists (select 1 from vault.secrets where name = 'domains_worker_secret') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'domains_worker_secret', 'Domma Food: worker de domínios');
  end if;
end $$;
create or replace function public.domains_worker_secret()
returns text language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.assert_service_role();
  return (select decrypted_secret from vault.decrypted_secrets where name = 'domains_worker_secret');
end $$;
create or replace function private.domains_cron_tick()
returns void language plpgsql security definer set search_path = '' as $$
declare v_secret text;
begin
  if not exists (select 1 from public.unit_domains where status <> 'active' or last_check_at < now() - interval '1 day') then return; end if;
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'domains_worker_secret';
  perform net.http_post(url := 'https://kcwidutqdqbyphrjnlef.supabase.co/functions/v1/domains/worker', body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type','application/json','x-worker-secret', v_secret), timeout_milliseconds := 25000);
exception when others then null;
end $$;
select cron.schedule('domma-domains', '*/10 * * * *', $$select private.domains_cron_tick()$$);

-- ---------- Super admin ----------
create or replace function public.admin_domains_settings()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_platform_admin() then raise exception 'Sem permissão.' using errcode = '42501'; end if;
  return (select jsonb_build_object('project_id', project_id, 'team_id', team_id, 'has_token', token_secret_id is not null,
    'last_test_at', last_test_at, 'last_test_ok', last_test_ok, 'last_test_message', last_test_message,
    'active', (select count(*) from public.unit_domains where status = 'active'),
    'pending', (select count(*) from public.unit_domains where status <> 'active')) from public.domains_app where id);
end $$;
create or replace function public.admin_domains_save(p_project_id text, p_team_id text, p_token text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare a public.domains_app; v uuid; k text := nullif(trim(p_token), '');
begin
  if not private.is_platform_admin() then raise exception 'Sem permissão.' using errcode = '42501'; end if;
  if trim(p_project_id) !~ '^prj_[A-Za-z0-9]{10,60}$' then raise exception 'ID do projeto da Vercel inválido (prj_...).'; end if;
  if nullif(trim(p_team_id), '') is not null and trim(p_team_id) !~ '^team_[A-Za-z0-9]{10,60}$' then raise exception 'ID do time da Vercel inválido (team_...).'; end if;
  select * into a from public.domains_app where id for update;
  if k is not null then
    if char_length(k) not between 20 and 200 or k ~ '\s' then raise exception 'Token da Vercel inválido.'; end if;
    if a.token_secret_id is not null then perform vault.update_secret(a.token_secret_id, k);
    else v := vault.create_secret(k, 'vercel_domains_token', 'Domma Food: token da Vercel para domínios');
         update public.domains_app set token_secret_id = v where id; end if;
  end if;
  update public.domains_app set project_id = trim(p_project_id), team_id = nullif(trim(p_team_id), ''), last_test_ok = null, updated_at = now() where id;
end $$;

grant execute on function public.get_unit_by_domain(text) to anon, authenticated;
grant execute on function public.domain_overview(uuid), public.domain_can_manage(uuid), public.admin_domains_settings(), public.admin_domains_save(text, text, text) to authenticated;
grant execute on function public.domains_context(), public.domain_upsert(uuid, text, text, jsonb, text), public.domain_delete(uuid),
  public.domains_to_check(), public.domains_test_result(boolean, text), public.domains_worker_secret() to service_role;
revoke execute on function public.domains_context(), public.domain_upsert(uuid, text, text, jsonb, text), public.domain_delete(uuid),
  public.domains_to_check(), public.domains_test_result(boolean, text), public.domains_worker_secret() from public, anon, authenticated;
revoke execute on function public.domain_overview(uuid), public.domain_can_manage(uuid), public.admin_domains_settings(), public.admin_domains_save(text, text, text) from public, anon;
revoke execute on function private.store_base_url(uuid), private.store_url_by_slug(text), private.domains_cron_tick() from public, anon, authenticated;
