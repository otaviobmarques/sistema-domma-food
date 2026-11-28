-- App Store
-- 1) Vitrine das integrações da plataforma: o painel mostra cada uma com a situação (conectada ou não) e onde configurar.
--    O admin escolhe quais aparecem, quais ficam em destaque e em quais planos entram (o catálogo fica no código).
-- 2) Apps de parceiros: o admin cadastra e publica (revisão). A loja instala com um clique, vendo as permissões.
--    Instalar cria uma chave da API pública só com as permissões do app (e um webhook, se o app pedir eventos)
--    e avisa o servidor do parceiro com uma mensagem assinada (app.installed) que leva a chave.
--    Desinstalar revoga tudo e avisa o parceiro (app.uninstalled). O parceiro usa a API pública como qualquer integração.

create or replace function private.safe_https_url(p text)
returns boolean language sql immutable as $$
  select p is not null and char_length(p) <= 500
    and p ~ '^https://[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:[0-9]{2,5})?(/[^\s]*)?$'
    and p !~ '^https://([^/]*\.)?(localhost|local|internal|lan|home|corp|intranet)(:[0-9]+)?(/|$)'
    and p !~ '^https://[0-9.]+(:[0-9]+)?(/|$)';
$$;

-- ---------- Integrações da plataforma (ajustes do admin) ----------
create table public.appstore_builtin (
  app_key text primary key check (app_key ~ '^[a-z0-9_]{2,40}$'),
  enabled boolean not null default true,
  featured boolean not null default false,
  plans text[],                       -- null = todos os planos
  updated_at timestamptz not null default now()
);

-- ---------- Apps de parceiros ----------
create table public.apps (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{2,39}$'),
  name text not null check (char_length(trim(name)) between 2 and 60),
  developer text not null check (char_length(trim(developer)) between 2 and 80),
  tagline text not null check (char_length(trim(tagline)) between 5 and 140),
  description text check (description is null or char_length(description) <= 3000),
  category text not null default 'outros' check (category in ('vendas','marketing','gestao','financeiro','logistica','atendimento','fiscal','outros')),
  icon_url text check (icon_url is null or private.safe_https_url(icon_url)),
  website_url text check (website_url is null or private.safe_https_url(website_url)),
  support_email text check (support_email is null or support_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  privacy_url text check (privacy_url is null or private.safe_https_url(privacy_url)),
  scopes text[] not null check (cardinality(scopes) between 1 and 5
    and scopes <@ array['orders:read','orders:write','menu:read','menu:write','customers:read']),
  install_url text not null check (private.safe_https_url(install_url)),      -- recebe app.installed / app.uninstalled
  config_url text check (config_url is null or private.safe_https_url(config_url)),  -- aberto depois de instalar
  webhook_url text check (webhook_url is null or private.safe_https_url(webhook_url)),
  webhook_events text[] check (webhook_events is null or (cardinality(webhook_events) between 1 and 3
    and webhook_events <@ array['order.created','order.status_changed','order.paid'])),
  secret_id uuid,                      -- segredo de assinatura (Vault)
  status text not null default 'draft' check (status in ('draft','published','suspended')),
  featured boolean not null default false,
  plans text[],
  price_note text check (price_note is null or char_length(price_note) <= 80),   -- ex.: "Grátis" ou "R$ 29/mês, cobrado pelo parceiro"
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((webhook_url is null) = (webhook_events is null))
);

create table public.app_installations (
  id uuid primary key default gen_random_uuid(),
  app_id uuid not null references public.apps(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  unit_id uuid references public.units(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','active','failed','uninstalled')),
  api_key_id uuid references public.api_keys(id) on delete set null,
  webhook_endpoint_id uuid references public.webhook_endpoints(id) on delete set null,
  installed_by uuid references auth.users(id) on delete set null,
  installed_at timestamptz not null default now(),
  activated_at timestamptz,
  uninstalled_at timestamptz,
  last_error text check (last_error is null or char_length(last_error) <= 300)
);
create unique index app_installations_live on public.app_installations(app_id, tenant_id) where status in ('pending','active');
create index app_installations_tenant on public.app_installations(tenant_id, installed_at desc);

alter table public.api_keys add column app_installation_id uuid references public.app_installations(id) on delete set null;
alter table public.webhook_endpoints add column app_installation_id uuid references public.app_installations(id) on delete set null;

-- avisos ao parceiro (fila; a chave viaja só na mensagem de instalação e fica no Vault até ser entregue)
create table public.app_events (
  id bigint generated always as identity primary key,
  installation_id uuid not null references public.app_installations(id) on delete cascade,
  app_id uuid not null references public.apps(id) on delete cascade,
  event text not null check (event in ('app.installed','app.uninstalled')),
  payload jsonb not null,
  key_secret_id uuid,
  webhook_secret_id uuid,
  status text not null default 'queued' check (status in ('queued','sending','sent','failed')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  response_code integer,
  error text,
  created_at timestamptz not null default now(),
  delivered_at timestamptz
);
create index app_events_due on public.app_events(next_attempt_at) where status = 'queued';

alter table public.appstore_builtin enable row level security;
alter table public.appstore_builtin force row level security;
alter table public.apps enable row level security;
alter table public.apps force row level security;
alter table public.app_installations enable row level security;
alter table public.app_installations force row level security;
alter table public.app_events enable row level security;
alter table public.app_events force row level security;
revoke all on public.appstore_builtin, public.apps, public.app_installations, public.app_events from anon, authenticated;

-- chaves e webhooks de apps não aparecem (nem contam no limite) na área de API da loja
do $$ declare d text; begin
  d := pg_get_functiondef('public.api_overview(uuid)'::regprocedure);
  if position($x$where k.tenant_id = p_tenant_id and k.revoked_at is null$x$ in d) = 0
     or position($x$where e.tenant_id = p_tenant_id), '[]'::jsonb)$x$ in d) = 0 then raise exception 'api_overview mudou'; end if;
  d := replace(d, $x$where k.tenant_id = p_tenant_id and k.revoked_at is null$x$,
                  $x$where k.tenant_id = p_tenant_id and k.revoked_at is null and k.app_installation_id is null$x$);
  d := replace(d, $x$where e.tenant_id = p_tenant_id), '[]'::jsonb)$x$,
                  $x$where e.tenant_id = p_tenant_id and e.app_installation_id is null), '[]'::jsonb)$x$);
  execute d;
  d := pg_get_functiondef('public.api_key_create(uuid, text, text[], uuid)'::regprocedure);
  if position($x$where tenant_id = p_tenant_id and revoked_at is null) >= 10$x$ in d) = 0 then raise exception 'api_key_create mudou'; end if;
  execute replace(d, $x$where tenant_id = p_tenant_id and revoked_at is null) >= 10$x$,
                     $x$where tenant_id = p_tenant_id and revoked_at is null and app_installation_id is null) >= 10$x$);
  d := pg_get_functiondef('public.webhook_save(uuid, uuid, jsonb)'::regprocedure);
  if position($x$where tenant_id = p_tenant_id) >= 5$x$ in d) = 0 then raise exception 'webhook_save mudou'; end if;
  execute replace(d, $x$where tenant_id = p_tenant_id) >= 5$x$, $x$where tenant_id = p_tenant_id and app_installation_id is null) >= 5$x$);
end $$;
-- a loja não revoga nem altera pela área de API o que pertence a um app (desinstala pela App Store).
-- Uso normal continua: a API marca o último uso da chave e o worker de webhooks registra falhas e sucesso.
create or replace function private.protect_app_key()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if old.app_installation_id is null or coalesce(current_setting('app.installing', true), '') = 'on' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE' or new.revoked_at is distinct from old.revoked_at or new.scopes is distinct from old.scopes
     or new.unit_id is distinct from old.unit_id or new.app_installation_id is distinct from old.app_installation_id then
    raise exception 'Este recurso pertence a um app. Desinstale o app pela App Store.' using errcode = '42501';
  end if;
  return new;
end $$;
create or replace function private.protect_app_webhook()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if old.app_installation_id is null or coalesce(current_setting('app.installing', true), '') = 'on' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE' or new.url is distinct from old.url or new.events is distinct from old.events
     or new.secret_id is distinct from old.secret_id or new.unit_id is distinct from old.unit_id
     or new.app_installation_id is distinct from old.app_installation_id then
    raise exception 'Este recurso pertence a um app. Desinstale o app pela App Store.' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger api_keys_app_guard before update or delete on public.api_keys for each row execute function private.protect_app_key();
create trigger webhook_endpoints_app_guard before update or delete on public.webhook_endpoints for each row execute function private.protect_app_webhook();

-- ---------- Worker dos avisos ----------
do $$ begin
  if not exists (select 1 from vault.secrets where name = 'apps_worker_secret') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'apps_worker_secret', 'Domma Food: worker da App Store');
  end if;
  if not exists (select 1 from vault.secrets where name = 'apps_worker_url') then
    perform vault.create_secret('https://kcwidutqdqbyphrjnlef.supabase.co/functions/v1/apps/worker', 'apps_worker_url', 'Domma Food: URL do worker da App Store');
  end if;
end $$;
create or replace function private.kick_apps_worker()
returns void language plpgsql security definer set search_path = '' as $$
declare v_url text; v_secret text;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'apps_worker_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'apps_worker_secret';
  if v_url is null or v_secret is null then return; end if;
  perform net.http_post(url := v_url, body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type','application/json','x-worker-secret', v_secret), timeout_milliseconds := 25000);
exception when others then null;
end $$;
create or replace function public.apps_worker_secret()
returns text language sql stable security definer set search_path = '' as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'apps_worker_secret';
$$;

-- ---------- Situação das integrações da plataforma ----------
create or replace function private.appstore_builtin_status(p_tenant uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'ifood', exists (select 1 from public.marketplace_connections where tenant_id = p_tenant and provider = 'ifood' and active),
    'keeta', exists (select 1 from public.marketplace_connections where tenant_id = p_tenant and provider = 'keeta' and active),
    '99food', exists (select 1 from public.marketplace_connections where tenant_id = p_tenant and provider = '99food' and active),
    'aiqfome', exists (select 1 from public.marketplace_connections where tenant_id = p_tenant and provider = 'aiqfome' and active),
    'mercadopago', exists (select 1 from public.payment_gateways where tenant_id = p_tenant and enabled),
    'nfce', exists (select 1 from public.fiscal_settings where tenant_id = p_tenant and enabled),
    'whatsapp', exists (select 1 from public.marketing_settings where tenant_id = p_tenant and wa_enabled and wa_phone_number_id is not null),
    'ai_attendant', exists (select 1 from public.ai_attendants where tenant_id = p_tenant and enabled),
    'foody', exists (select 1 from public.logistics_settings where tenant_id = p_tenant and foody_enabled),
    'entrega_ifood', exists (select 1 from public.logistics_settings where tenant_id = p_tenant and ifood_enabled),
    'f360', exists (select 1 from public.erp_settings where tenant_id = p_tenant and f360_enabled),
    'pdv_od', exists (select 1 from public.erp_settings where tenant_id = p_tenant and od_enabled),
    'meta_pixel', exists (select 1 from public.unit_tracking t join public.units u on u.id = t.unit_id where u.tenant_id = p_tenant and t.meta_pixel_id is not null),
    'ga4', exists (select 1 from public.unit_tracking t join public.units u on u.id = t.unit_id where u.tenant_id = p_tenant and t.ga4_id is not null),
    'domain', exists (select 1 from public.unit_domains d join public.units u on u.id = d.unit_id where u.tenant_id = p_tenant and d.status = 'active'),
    'printing', exists (select 1 from public.printers where tenant_id = p_tenant and active),
    'totem', exists (select 1 from public.totems where tenant_id = p_tenant and active),
    'api', exists (select 1 from public.api_keys where tenant_id = p_tenant and revoked_at is null and app_installation_id is null),
    'webhooks', exists (select 1 from public.webhook_endpoints where tenant_id = p_tenant and active and app_installation_id is null));
$$;

-- ---------- Painel da loja ----------
create or replace function public.appstore_overview(p_tenant_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_plan text;
begin
  if not private.can_manage(p_tenant_id) then raise exception 'Sem permissão.' using errcode = '42501'; end if;
  select plan_id into v_plan from public.tenants where id = p_tenant_id;
  return jsonb_build_object(
    'plan_id', v_plan,
    'can_install', private.has_role(p_tenant_id, array['owner']::public.member_role[]),
    'connected', private.appstore_builtin_status(p_tenant_id),
    'builtin', coalesce((select jsonb_object_agg(app_key, jsonb_build_object('enabled', enabled, 'featured', featured, 'plans', plans)) from public.appstore_builtin), '{}'::jsonb),
    'apps', coalesce((select jsonb_agg(jsonb_build_object(
        'id', a.id, 'slug', a.slug, 'name', a.name, 'developer', a.developer, 'tagline', a.tagline, 'description', a.description,
        'category', a.category, 'icon_url', a.icon_url, 'website_url', a.website_url, 'support_email', a.support_email,
        'privacy_url', a.privacy_url, 'scopes', a.scopes, 'webhook_events', a.webhook_events, 'config_url', a.config_url,
        'featured', a.featured, 'price_note', a.price_note, 'plans', a.plans,
        'in_plan', a.plans is null or v_plan = any (a.plans),
        'installation', (select jsonb_build_object('id', i.id, 'status', i.status, 'unit_id', i.unit_id, 'installed_at', i.installed_at,
            'activated_at', i.activated_at, 'last_error', i.last_error)
          from public.app_installations i where i.app_id = a.id and i.tenant_id = p_tenant_id
          order by (i.status in ('pending','active')) desc, i.installed_at desc limit 1))
        order by a.featured desc, a.name)
      from public.apps a where a.status = 'published'
        or exists (select 1 from public.app_installations i where i.app_id = a.id and i.tenant_id = p_tenant_id and i.status in ('pending','active'))), '[]'::jsonb));
end $$;

create or replace function public.app_install(p_app_id uuid, p_tenant_id uuid, p_unit_id uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare a public.apps; t public.tenants; u public.units; v_inst uuid; v_key text := 'dmf_' || encode(extensions.gen_random_bytes(24), 'hex');
  v_key_id uuid; v_key_sec uuid; v_wh_secret text; v_wh_sec uuid; v_wh uuid; v_payload jsonb;
begin
  if not private.has_role(p_tenant_id, array['owner']::public.member_role[]) then
    raise exception 'Só o dono da conta instala apps.' using errcode = '42501'; end if;
  select * into a from public.apps where id = p_app_id and status = 'published';
  if not found then raise exception 'App indisponível.'; end if;
  select * into t from public.tenants where id = p_tenant_id;
  if a.plans is not null and not (t.plan_id = any (a.plans)) then raise exception 'Este app não está incluído no seu plano.'; end if;
  if p_unit_id is not null then
    select * into u from public.units where id = p_unit_id and tenant_id = p_tenant_id;
    if not found then raise exception 'Loja inválida.'; end if;
  end if;
  if exists (select 1 from public.app_installations where app_id = a.id and tenant_id = p_tenant_id and status in ('pending','active')) then
    raise exception 'Este app já está instalado.'; end if;
  insert into public.app_installations (app_id, tenant_id, unit_id, installed_by) values (a.id, p_tenant_id, p_unit_id, auth.uid())
  returning id into v_inst;
  insert into public.api_keys (tenant_id, unit_id, name, prefix, key_hash, scopes, created_by, app_installation_id)
  values (p_tenant_id, p_unit_id, left('App: ' || a.name, 60), left(v_key, 12), encode(extensions.digest(v_key, 'sha256'), 'hex'), a.scopes, auth.uid(), v_inst)
  returning id into v_key_id;
  v_key_sec := vault.create_secret(v_key, 'appkey_' || v_inst, 'Domma Food: chave a entregar ao app (apagada após a entrega)');
  if a.webhook_url is not null then
    v_wh_secret := 'whsec_' || encode(extensions.gen_random_bytes(24), 'hex');
    v_wh_sec := vault.create_secret(v_wh_secret, 'webhook_' || encode(extensions.gen_random_bytes(6), 'hex'), 'Domma Food: segredo de webhook de app');
    insert into public.webhook_endpoints (tenant_id, unit_id, url, events, secret_id, created_by, app_installation_id)
    values (p_tenant_id, p_unit_id, private.norm_url(a.webhook_url), a.webhook_events, v_wh_sec, auth.uid(), v_inst) returning id into v_wh;
  end if;
  update public.app_installations set api_key_id = v_key_id, webhook_endpoint_id = v_wh where id = v_inst;
  -- a chave e o segredo do webhook entram na mensagem só na hora do envio (vêm do Vault)
  v_payload := jsonb_build_object('event', 'app.installed', 'installation_id', v_inst, 'app', a.slug,
    'account', jsonb_build_object('id', t.id, 'name', t.name),
    'store', case when u.id is null then null else jsonb_build_object('id', u.id, 'name', u.name, 'slug', u.slug, 'menu_url', private.store_url_by_slug(u.slug)) end,
    'stores', case when u.id is null then coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'name', x.name, 'slug', x.slug,
        'menu_url', private.store_url_by_slug(x.slug)) order by x.created_at) from public.units x where x.tenant_id = t.id and x.active), '[]'::jsonb) end,
    'scopes', to_jsonb(a.scopes),
    'webhook', case when v_wh is null then null else jsonb_build_object('url', a.webhook_url, 'events', to_jsonb(a.webhook_events)) end,
    'installed_at', now());
  insert into public.app_events (installation_id, app_id, event, payload, key_secret_id, webhook_secret_id)
  values (v_inst, a.id, 'app.installed', v_payload, v_key_sec, v_wh_sec);
  insert into public.audit_logs (tenant_id, actor_id, action, entity, entity_id, after, ip)
  values (p_tenant_id, auth.uid(), 'app_install', 'app_installations', v_inst::text,
          jsonb_build_object('app', a.slug, 'scopes', a.scopes, 'unit_id', p_unit_id), private.request_ip());
  perform private.kick_apps_worker();
  return jsonb_build_object('id', v_inst, 'status', 'pending');
end $$;

-- desfaz tudo que a instalação criou
create or replace function private.app_teardown(p_inst uuid, p_status text, p_error text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare i public.app_installations; v_sec uuid;
begin
  select * into i from public.app_installations where id = p_inst for update;
  perform set_config('app.installing', 'on', true);
  update public.api_keys set revoked_at = coalesce(revoked_at, now()) where id = i.api_key_id;
  select secret_id into v_sec from public.webhook_endpoints where id = i.webhook_endpoint_id;
  delete from public.webhook_endpoints where id = i.webhook_endpoint_id;
  if v_sec is not null then delete from vault.secrets where id = v_sec; end if;
  perform set_config('app.installing', 'off', true);
  -- chave ainda não entregue: some do Vault
  delete from vault.secrets where id in (select key_secret_id from public.app_events where installation_id = p_inst and status <> 'sent' and key_secret_id is not null);
  update public.app_events set status = case when status in ('queued','sending') then 'failed' else status end,
    error = case when status in ('queued','sending') then coalesce(error, 'Instalação encerrada.') else error end,
    key_secret_id = null, webhook_secret_id = null
   where installation_id = p_inst and status <> 'sent';
  update public.app_installations set status = p_status, uninstalled_at = case when p_status = 'uninstalled' then now() else uninstalled_at end,
    last_error = coalesce(left(p_error, 300), last_error) where id = p_inst;
end $$;

create or replace function public.app_uninstall(p_installation_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare i public.app_installations; a public.apps;
begin
  select * into i from public.app_installations where id = p_installation_id;
  if not found or not private.has_role(i.tenant_id, array['owner']::public.member_role[]) then
    raise exception 'Só o dono da conta desinstala apps.' using errcode = '42501'; end if;
  if i.status not in ('pending','active','failed') then raise exception 'Este app já foi desinstalado.'; end if;
  select * into a from public.apps where id = i.app_id;
  perform private.app_teardown(i.id, 'uninstalled');
  if i.status = 'active' then
    insert into public.app_events (installation_id, app_id, event, payload)
    values (i.id, i.app_id, 'app.uninstalled', jsonb_build_object('event', 'app.uninstalled', 'installation_id', i.id, 'app', a.slug,
      'account', jsonb_build_object('id', i.tenant_id), 'uninstalled_at', now()));
    perform private.kick_apps_worker();
  end if;
  insert into public.audit_logs (tenant_id, actor_id, action, entity, entity_id, after, ip)
  values (i.tenant_id, auth.uid(), 'app_uninstall', 'app_installations', i.id::text, jsonb_build_object('app', a.slug), private.request_ip());
end $$;

-- ---------- Worker (só o servidor) ----------
create or replace function public.app_event_jobs(p_limit integer default 20)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v jsonb;
begin
  perform private.assert_service_role();
  update public.app_events set status = 'queued' where status = 'sending' and next_attempt_at < now() - interval '5 minutes';
  with due as (
    select id from public.app_events where status = 'queued' and next_attempt_at <= now() order by id limit greatest(1, least(p_limit, 50)) for update skip locked
  ), upd as (
    update public.app_events e set status = 'sending', attempts = attempts + 1, next_attempt_at = now() from due where e.id = due.id returning e.*
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', upd.id, 'url', a.install_url, 'event', upd.event,
      'secret', (select decrypted_secret from vault.decrypted_secrets where id = a.secret_id),
      'payload', upd.payload
        || case when upd.key_secret_id is null then '{}'::jsonb else jsonb_build_object('api_key',
             (select decrypted_secret from vault.decrypted_secrets where id = upd.key_secret_id)) end
        || case when upd.webhook_secret_id is null then '{}'::jsonb else jsonb_build_object('webhook',
             (upd.payload->'webhook') || jsonb_build_object('secret', (select decrypted_secret from vault.decrypted_secrets where id = upd.webhook_secret_id))) end
        || jsonb_build_object('api_base', 'https://kcwidutqdqbyphrjnlef.supabase.co/functions/v1/api/v1', 'delivery_id', upd.id))), '[]'::jsonb)
    into v from upd join public.apps a on a.id = upd.app_id;
  return v;
end $$;

create or replace function public.app_event_result(p_id bigint, p_ok boolean, p_code integer, p_error text)
returns void language plpgsql security definer set search_path = '' as $$
declare e public.app_events; v_wait interval;
begin
  perform private.assert_service_role();
  select * into e from public.app_events where id = p_id and status = 'sending' for update;
  if not found then return; end if;
  if p_ok then
    update public.app_events set status = 'sent', response_code = p_code, error = null, delivered_at = now(), key_secret_id = null, webhook_secret_id = null where id = e.id;
    if e.key_secret_id is not null then delete from vault.secrets where id = e.key_secret_id; end if;   -- entregue: só o parceiro tem a chave
    if e.event = 'app.installed' then
      update public.app_installations set status = 'active', activated_at = now(), last_error = null where id = e.installation_id and status = 'pending';
    end if;
    return;
  end if;
  v_wait := case e.attempts when 1 then interval '1 minute' when 2 then interval '5 minutes' when 3 then interval '30 minutes' else null end;
  if v_wait is null then
    update public.app_events set status = 'failed', response_code = p_code, error = left(p_error, 300) where id = e.id;
    if e.event = 'app.installed' then
      perform private.app_teardown(e.installation_id, 'failed', 'O app não confirmou a instalação: ' || coalesce(left(p_error, 200), 'sem resposta'));
    end if;
  else
    update public.app_events set status = 'queued', response_code = p_code, error = left(p_error, 300), next_attempt_at = now() + v_wait where id = e.id;
  end if;
end $$;

create or replace function public.apps_cron_tick()
returns void language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.app_events where status = 'queued' and next_attempt_at <= now()) then perform private.kick_apps_worker(); end if;
  delete from public.app_events where status in ('sent','failed') and created_at < now() - interval '90 days';
end $$;
select cron.schedule('domma-apps', '* * * * *', 'select public.apps_cron_tick()');

-- ---------- Admin da plataforma ----------
create or replace function public.admin_appstore()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_platform_admin() then raise exception 'Sem permissão.' using errcode = '42501'; end if;
  return jsonb_build_object(
    'builtin', coalesce((select jsonb_object_agg(app_key, jsonb_build_object('enabled', enabled, 'featured', featured, 'plans', plans)) from public.appstore_builtin), '{}'::jsonb),
    'plans', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name) order by price_cents) from public.plans where active), '[]'::jsonb),
    'apps', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'slug', a.slug, 'name', a.name, 'developer', a.developer, 'tagline', a.tagline,
        'description', a.description, 'category', a.category, 'icon_url', a.icon_url, 'website_url', a.website_url, 'support_email', a.support_email,
        'privacy_url', a.privacy_url, 'scopes', a.scopes, 'install_url', a.install_url, 'config_url', a.config_url, 'webhook_url', a.webhook_url,
        'webhook_events', a.webhook_events, 'status', a.status, 'featured', a.featured, 'plans', a.plans, 'price_note', a.price_note,
        'created_at', a.created_at,
        'installs', (select count(*) from public.app_installations i where i.app_id = a.id and i.status = 'active'),
        'failed', (select count(*) from public.app_installations i where i.app_id = a.id and i.status = 'failed'),
        'last_events', coalesce((select jsonb_agg(x order by x.id desc) from (select id, event, status, attempts, response_code, error, created_at
            from public.app_events where app_id = a.id order by id desc limit 5) x), '[]'::jsonb))
        order by a.created_at desc) from public.apps a), '[]'::jsonb));
end $$;

create or replace function public.admin_builtin_save(p_key text, p jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_platform_admin() then raise exception 'Sem permissão.' using errcode = '42501'; end if;
  insert into public.appstore_builtin (app_key) values (p_key) on conflict (app_key) do nothing;
  update public.appstore_builtin set enabled = coalesce((p->>'enabled')::boolean, enabled), featured = coalesce((p->>'featured')::boolean, featured),
    plans = case when p ? 'plans' then (select nullif(array_agg(x), '{}') from jsonb_array_elements_text(case when jsonb_typeof(p->'plans') = 'array' then p->'plans' else '[]'::jsonb end) x) else plans end,
    updated_at = now() where app_key = p_key;
exception when check_violation then raise exception 'Integração inválida.';
end $$;

create or replace function public.admin_app_save(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_id uuid := nullif(p->>'id', '')::uuid; a public.apps; v_secret text; v_new boolean := false;
  v_arr text[];
begin
  if not private.is_platform_admin() then raise exception 'Sem permissão.' using errcode = '42501'; end if;
  if v_id is null then
    v_new := true;
    insert into public.apps (slug, name, developer, tagline, scopes, install_url)
    values (lower(trim(p->>'slug')), trim(p->>'name'), trim(p->>'developer'), trim(p->>'tagline'),
            (select array_agg(distinct x) from jsonb_array_elements_text(p->'scopes') x), lower(trim(p->>'install_url')))
    returning * into a;
    v_id := a.id;
  end if;
  update public.apps set
    slug = case when p ? 'slug' then lower(trim(p->>'slug')) else slug end,
    name = coalesce(trim(p->>'name'), name), developer = coalesce(trim(p->>'developer'), developer), tagline = coalesce(trim(p->>'tagline'), tagline),
    description = case when p ? 'description' then nullif(trim(p->>'description'), '') else description end,
    category = coalesce(p->>'category', category),
    icon_url = case when p ? 'icon_url' then nullif(trim(p->>'icon_url'), '') else icon_url end,
    website_url = case when p ? 'website_url' then nullif(trim(p->>'website_url'), '') else website_url end,
    support_email = case when p ? 'support_email' then nullif(lower(trim(p->>'support_email')), '') else support_email end,
    privacy_url = case when p ? 'privacy_url' then nullif(trim(p->>'privacy_url'), '') else privacy_url end,
    scopes = case when p ? 'scopes' then (select array_agg(distinct x) from jsonb_array_elements_text(p->'scopes') x) else scopes end,
    install_url = case when p ? 'install_url' then lower(trim(p->>'install_url')) else install_url end,
    config_url = case when p ? 'config_url' then nullif(trim(p->>'config_url'), '') else config_url end,
    webhook_url = case when p ? 'webhook_url' then nullif(trim(p->>'webhook_url'), '') else webhook_url end,
    webhook_events = case when p ? 'webhook_events' then (select nullif(array_agg(distinct x), '{}') from jsonb_array_elements_text(p->'webhook_events') x) else webhook_events end,
    status = coalesce(p->>'status', status), featured = coalesce((p->>'featured')::boolean, featured),
    plans = case when p ? 'plans' then (select nullif(array_agg(x), '{}') from jsonb_array_elements_text(case when jsonb_typeof(p->'plans') = 'array' then p->'plans' else '[]'::jsonb end) x) else plans end,
    price_note = case when p ? 'price_note' then nullif(trim(p->>'price_note'), '') else price_note end,
    updated_at = now()
  where id = v_id returning * into a;
  if not found then raise exception 'App não encontrado.'; end if;
  -- segredo de assinatura: criado junto com o app; aparece uma vez (ou ao gerar outro)
  if v_new or coalesce((p->>'rotate_secret')::boolean, false) then
    v_secret := 'appsec_' || encode(extensions.gen_random_bytes(24), 'hex');
    if a.secret_id is null then
      update public.apps set secret_id = vault.create_secret(v_secret, 'app_' || a.id, 'Domma Food: segredo de assinatura do app') where id = a.id;
    else
      perform vault.update_secret(a.secret_id, v_secret);
    end if;
  end if;
  insert into public.audit_logs (tenant_id, actor_id, action, entity, entity_id, after, ip)
  values (null, auth.uid(), 'app_save', 'apps', a.id::text, p - 'rotate_secret' || jsonb_build_object('rotated', v_secret is not null), private.request_ip());
  return jsonb_build_object('id', a.id, 'secret', v_secret);
exception
  when unique_violation then raise exception 'Já existe um app com este identificador.';
  when check_violation or not_null_violation then raise exception 'Confira os dados do app: identificador (3 a 40 letras minúsculas, números ou hífen), nome, desenvolvedor, resumo (5 a 140), permissões, endereços https públicos e eventos do webhook (com o endereço do webhook).';
end $$;

-- suspender um app desliga todas as instalações dele
create or replace function public.admin_app_suspend(p_app_id uuid)
returns integer language plpgsql security definer set search_path = '' as $$
declare r record; n int := 0;
begin
  if not private.is_platform_admin() then raise exception 'Sem permissão.' using errcode = '42501'; end if;
  update public.apps set status = 'suspended', updated_at = now() where id = p_app_id;
  if not found then raise exception 'App não encontrado.'; end if;
  for r in select id from public.app_installations where app_id = p_app_id and status in ('pending','active') loop
    perform private.app_teardown(r.id, 'uninstalled', 'App suspenso pela plataforma.');
    n := n + 1;
  end loop;
  insert into public.audit_logs (tenant_id, actor_id, action, entity, entity_id, after, ip)
  values (null, auth.uid(), 'app_suspend', 'apps', p_app_id::text, jsonb_build_object('installations', n), private.request_ip());
  return n;
end $$;

-- ---------- Permissões ----------
revoke execute on function private.safe_https_url(text), private.kick_apps_worker(), private.appstore_builtin_status(uuid),
  private.app_teardown(uuid, text, text), private.protect_app_key(), private.protect_app_webhook() from public, anon, authenticated;
revoke execute on function public.apps_worker_secret(), public.app_event_jobs(integer), public.app_event_result(bigint, boolean, integer, text),
  public.apps_cron_tick() from public, anon, authenticated;
grant execute on function public.apps_worker_secret(), public.app_event_jobs(integer), public.app_event_result(bigint, boolean, integer, text) to service_role;
revoke execute on function public.appstore_overview(uuid), public.app_install(uuid, uuid, uuid), public.app_uninstall(uuid),
  public.admin_appstore(), public.admin_builtin_save(text, jsonb), public.admin_app_save(jsonb), public.admin_app_suspend(uuid) from public, anon;
grant execute on function public.appstore_overview(uuid), public.app_install(uuid, uuid, uuid), public.app_uninstall(uuid),
  public.admin_appstore(), public.admin_builtin_save(text, jsonb), public.admin_app_save(jsonb), public.admin_app_suspend(uuid) to authenticated;
