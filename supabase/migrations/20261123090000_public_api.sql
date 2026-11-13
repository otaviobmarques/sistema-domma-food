-- =====================================================================
-- Domma Food · 050 · API pública e webhooks
--   - Chaves de API por conta (escopos; opcionalmente presas a uma loja)
--   - A chave age em nome do dono que a criou: mudar status de pedido usa a
--     mesma regra do painel (set_order_status) e deixa de funcionar se essa
--     pessoa sair da conta
--   - Webhooks assinados (HMAC-SHA256) para pedido criado, status, pago
--   - Fila com novas tentativas; endpoint desligado após muitas falhas
-- Segredos: só o hash da chave fica no banco; o segredo do webhook fica no Vault.
-- =====================================================================

create table public.api_keys (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  unit_id uuid references public.units(id) on delete cascade,           -- nulo = todas as lojas da conta
  name text not null check (char_length(name) between 2 and 60),
  prefix text not null,                                                  -- começo da chave, para reconhecer
  key_hash text not null unique check (key_hash ~ '^[a-f0-9]{64}$'),
  scopes text[] not null check (cardinality(scopes) between 1 and 6
    and scopes <@ array['orders:read','orders:write','menu:read','menu:write','customers:read']::text[]),
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
create index api_keys_tenant_idx on public.api_keys(tenant_id);

create table public.api_usage (
  key_id uuid not null references public.api_keys(id) on delete cascade,
  minute timestamptz not null,
  calls integer not null default 0,
  primary key (key_id, minute)
);

create table public.webhook_endpoints (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  unit_id uuid references public.units(id) on delete cascade,
  url text not null check (char_length(url) <= 500 and url ~ '^https://[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:[0-9]{2,5})?(/[^\s]*)?$'
    and url !~ '^https://([^/]*\.)?(localhost|local|internal|lan|home|corp|intranet)(:[0-9]+)?(/|$)'
    and url !~ '^https://[0-9.]+(:[0-9]+)?(/|$)'),
  events text[] not null check (cardinality(events) between 1 and 3
    and events <@ array['order.created','order.status_changed','order.paid']::text[]),
  secret_id uuid not null,
  active boolean not null default true,
  failures integer not null default 0,                -- falhas seguidas
  disabled_reason text,
  last_success_at timestamptz, last_error text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index webhook_endpoints_tenant_idx on public.webhook_endpoints(tenant_id) where active;

create table public.webhook_deliveries (
  id bigint generated always as identity primary key,
  endpoint_id uuid not null references public.webhook_endpoints(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  event_id uuid not null default gen_random_uuid(),
  event text not null,
  payload jsonb not null,
  status text not null default 'queued' check (status in ('queued','sending','sent','failed')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  response_code integer, error text,
  created_at timestamptz not null default now(),
  delivered_at timestamptz
);
create index webhook_deliveries_ready_idx on public.webhook_deliveries(next_attempt_at) where status = 'queued';
create index webhook_deliveries_endpoint_idx on public.webhook_deliveries(endpoint_id, created_at desc);

alter table public.api_keys enable row level security;
alter table public.api_keys force row level security;
alter table public.api_usage enable row level security;
alter table public.api_usage force row level security;
alter table public.webhook_endpoints enable row level security;
alter table public.webhook_endpoints force row level security;
alter table public.webhook_deliveries enable row level security;
alter table public.webhook_deliveries force row level security;
-- sem políticas: painel e API usam só as funções abaixo
revoke all on public.api_keys, public.api_usage, public.webhook_endpoints, public.webhook_deliveries from anon, authenticated;

-- domínio em minúsculas; o caminho fica como veio (pode ter token)
create or replace function private.norm_url(p text)
returns text language sql immutable set search_path = '' as $$
  select lower(substring(trim(p) from '^[A-Za-z]+://[^/?#]+')) || coalesce(substring(trim(p) from '^[A-Za-z]+://[^/?#]+(.*)$'), '');
$$;

-- ---------- Formato dos dados ----------
create or replace function private.api_order_json(o public.orders)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', o.id, 'number', o.number, 'unit_id', o.unit_id, 'unit_name', u.name,
    'channel', o.channel, 'type', o.type, 'status', o.status,
    'payment_method', o.payment_method, 'payment_status', o.payment_status,
    'created_at', o.created_at, 'updated_at', o.updated_at, 'scheduled_for', o.scheduled_for,
    'estimated_ready_at', o.estimated_ready_at, 'accepted_at', o.accepted_at, 'ready_at', o.ready_at,
    'dispatched_at', o.dispatched_at, 'completed_at', o.completed_at, 'cancelled_at', o.cancelled_at,
    'cancel_reason', o.cancel_reason,
    'customer', jsonb_build_object('id', o.customer_id, 'name', o.customer_name, 'phone', o.customer_phone),
    'address', o.address,
    'notes', o.notes, 'coupon_code', o.coupon_code, 'change_for_cents', o.change_for_cents,
    'subtotal_cents', o.subtotal_cents, 'discount_cents', o.discount_cents, 'delivery_fee_cents', o.delivery_fee_cents,
    'cashback_used_cents', o.cashback_used_cents, 'total_cents', o.total_cents,
    'tracking_url', 'https://domma-food.vercel.app/pedido/' || o.public_token,
    'items', coalesce((select jsonb_agg(jsonb_build_object('product_id', i.product_id, 'pdv_code', p.pdv_code, 'name', i.name,
        'quantity', i.quantity, 'unit_price_cents', i.unit_price_cents, 'total_cents', i.total_cents, 'notes', i.notes,
        'options', i.options) order by i.id)
      from public.order_items i left join public.products p on p.id = i.product_id where i.order_id = o.id), '[]'::jsonb))
  from public.units u where u.id = o.unit_id;
$$;

-- ---------- Webhooks: enfileirar ----------
create or replace function private.webhook_kick()
returns void language plpgsql security definer set search_path = '' as $$
declare v_secret text;
begin
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'api_worker_secret';
  if v_secret is null then return; end if;
  perform net.http_post(url := 'https://kcwidutqdqbyphrjnlef.supabase.co/functions/v1/api/webhooks/worker', body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type','application/json','x-worker-secret', v_secret), timeout_milliseconds := 25000);
exception when others then null;
end $$;

create or replace function private.webhook_enqueue(o public.orders, p_event text, p_extra jsonb default '{}')
returns integer language plpgsql security definer set search_path = '' as $$
declare n int; v_data jsonb;
begin
  if not exists (select 1 from public.webhook_endpoints e where e.tenant_id = o.tenant_id and e.active
                 and p_event = any (e.events) and (e.unit_id is null or e.unit_id = o.unit_id)) then return 0; end if;
  v_data := private.api_order_json(o);
  insert into public.webhook_deliveries (endpoint_id, tenant_id, event, payload)
  select e.id, o.tenant_id, p_event, jsonb_build_object('type', p_event, 'created_at', now(), 'data', jsonb_build_object('order', v_data) || p_extra)
  from public.webhook_endpoints e
  where e.tenant_id = o.tenant_id and e.active and p_event = any (e.events) and (e.unit_id is null or e.unit_id = o.unit_id);
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function private.webhook_on_order_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
declare o public.orders;
begin
  select * into o from public.orders where id = new.id;   -- valor final (itens e ajustes do checkout já gravados)
  if found and private.webhook_enqueue(o, 'order.created') > 0 then perform private.webhook_kick(); end if;
  return null;
exception when others then return null;   -- webhook nunca bloqueia o pedido
end $$;
create constraint trigger orders_webhook_insert after insert on public.orders deferrable initially deferred
  for each row execute function private.webhook_on_order_insert();

create or replace function private.webhook_on_order_update()
returns trigger language plpgsql security definer set search_path = '' as $$
declare n int := 0;
begin
  if new.status is distinct from old.status then
    n := n + private.webhook_enqueue(new, 'order.status_changed', jsonb_build_object('previous_status', old.status));
  end if;
  if new.payment_status = 'paid' and old.payment_status is distinct from 'paid' then
    n := n + private.webhook_enqueue(new, 'order.paid');
  end if;
  if n > 0 then perform private.webhook_kick(); end if;
  return null;
exception when others then return null;
end $$;
create trigger orders_webhook_update after update of status, payment_status on public.orders for each row
  execute function private.webhook_on_order_update();

-- ---------- Webhooks: worker (função api) ----------
do $$ begin
  if not exists (select 1 from vault.secrets where name = 'api_worker_secret') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'api_worker_secret', 'Domma Food: worker de webhooks');
  end if;
end $$;
create or replace function public.api_worker_secret()
returns text language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.assert_service_role();
  return (select decrypted_secret from vault.decrypted_secrets where name = 'api_worker_secret');
end $$;

create or replace function public.webhook_jobs(p_limit integer default 50)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v jsonb;
begin
  perform private.assert_service_role();
  update public.webhook_deliveries set status = 'queued' where status = 'sending' and next_attempt_at < now() - interval '5 minutes';
  with c as (
    select d.id from public.webhook_deliveries d join public.webhook_endpoints e on e.id = d.endpoint_id
    where d.status = 'queued' and d.next_attempt_at <= now() and e.active
    order by d.id limit least(greatest(p_limit, 1), 100) for update of d skip locked),
  upd as (update public.webhook_deliveries d set status = 'sending', attempts = attempts + 1, next_attempt_at = now()
          from c where d.id = c.id returning d.id, d.endpoint_id, d.event_id, d.event, d.payload)
  select coalesce(jsonb_agg(jsonb_build_object('id', upd.id, 'url', e.url, 'event_id', upd.event_id, 'event', upd.event,
      'payload', upd.payload || jsonb_build_object('id', upd.event_id),
      'secret', (select decrypted_secret from vault.decrypted_secrets where id = e.secret_id)) order by upd.id), '[]'::jsonb) into v
  from upd join public.webhook_endpoints e on e.id = upd.endpoint_id;
  return v;
end $$;

create or replace function public.webhook_job_result(p_id bigint, p_ok boolean, p_code integer, p_error text)
returns void language plpgsql security definer set search_path = '' as $$
declare d public.webhook_deliveries; e public.webhook_endpoints;
begin
  perform private.assert_service_role();
  select * into d from public.webhook_deliveries where id = p_id;
  if not found then return; end if;
  if p_ok then
    update public.webhook_deliveries set status = 'sent', delivered_at = now(), response_code = p_code, error = null where id = p_id;
    update public.webhook_endpoints set failures = 0, last_success_at = now(), last_error = null where id = d.endpoint_id;
  else
    -- novas tentativas: 1 min, 5 min, 30 min, 2 h, 6 h
    update public.webhook_deliveries set status = case when d.attempts >= 6 then 'failed' else 'queued' end, response_code = p_code,
      error = left(p_error, 300),
      next_attempt_at = now() + case d.attempts when 1 then interval '1 minute' when 2 then interval '5 minutes'
        when 3 then interval '30 minutes' when 4 then interval '2 hours' else interval '6 hours' end
    where id = p_id;
    update public.webhook_endpoints set failures = failures + 1, last_error = left(coalesce(p_code::text || ' ', '') || coalesce(p_error, ''), 300)
    where id = d.endpoint_id returning * into e;
    if e.failures >= 50 then
      update public.webhook_endpoints set active = false, disabled_reason = 'Desligado após 50 falhas seguidas. Corrija o endereço e ligue de novo.'
      where id = e.id;
    end if;
  end if;
end $$;

create or replace function private.webhook_cron_tick()
returns void language plpgsql security definer set search_path = '' as $$
begin
  delete from public.webhook_deliveries where created_at < now() - interval '30 days';
  delete from public.api_usage where minute < now() - interval '1 day';
  if exists (select 1 from public.webhook_deliveries d join public.webhook_endpoints e on e.id = d.endpoint_id
             where d.status = 'queued' and d.next_attempt_at <= now() and e.active) then perform private.webhook_kick(); end if;
exception when others then null;
end $$;
select cron.schedule('domma-webhooks', '* * * * *', $$select private.webhook_cron_tick()$$);

-- ---------- API: autenticação ----------
-- a função "api" manda o hash da chave; devolve o contexto ou um erro (limite: 120 chamadas por minuto)
create or replace function public.api_auth(p_key_hash text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare k public.api_keys; n int;
begin
  perform private.assert_service_role();
  select * into k from public.api_keys where key_hash = p_key_hash and revoked_at is null;
  if not found then return jsonb_build_object('error', 'invalid_key'); end if;
  -- quem criou a chave ainda é dono da conta?
  if not exists (select 1 from public.memberships m where m.tenant_id = k.tenant_id and m.user_id = k.created_by and m.role = 'owner') then
    return jsonb_build_object('error', 'invalid_key'); end if;
  insert into public.api_usage (key_id, minute, calls) values (k.id, date_trunc('minute', now()), 1)
  on conflict (key_id, minute) do update set calls = api_usage.calls + 1 returning calls into n;
  if n > 120 then return jsonb_build_object('error', 'rate_limited'); end if;
  if k.last_used_at is null or k.last_used_at < now() - interval '1 minute' then
    update public.api_keys set last_used_at = now() where id = k.id;
  end if;
  return jsonb_build_object('key_id', k.id, 'tenant_id', k.tenant_id, 'unit_id', k.unit_id, 'scopes', k.scopes);
end $$;

-- age como o dono que criou a chave (as regras do painel valem igual)
create or replace function private.api_act_as(p_user uuid)
returns void language sql security definer set search_path = '' as $$
  select set_config('request.jwt.claims', jsonb_build_object('sub', p_user, 'role', 'authenticated', 'aal', 'aal2')::text, true),
         set_config('request.jwt.claim.sub', p_user::text, true);
$$;

-- ---------- API: operações ----------
create or replace function public.api_call(p_key_id uuid, p_op text, p jsonb default '{}')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare k public.api_keys; v_scope text; v_units uuid[]; v_limit int; o public.orders; pr public.products; v jsonb;
  v_status public.order_status; v_unit uuid; v_tz text;
begin
  perform private.assert_service_role();
  select * into k from public.api_keys where id = p_key_id and revoked_at is null;
  if not found then return jsonb_build_object('error', 'invalid_key'); end if;
  v_scope := case p_op when 'me' then null when 'orders.list' then 'orders:read' when 'orders.get' then 'orders:read'
    when 'orders.status' then 'orders:write' when 'menu.get' then 'menu:read' when 'products.update' then 'menu:write'
    when 'customers.list' then 'customers:read' else 'unknown' end;
  if v_scope = 'unknown' then return jsonb_build_object('error', 'not_found'); end if;
  if v_scope is not null and not (v_scope = any (k.scopes)) then
    return jsonb_build_object('error', 'forbidden', 'message', 'A chave não tem o escopo ' || v_scope || '.'); end if;
  select coalesce(array_agg(id), '{}') into v_units from public.units where tenant_id = k.tenant_id and (k.unit_id is null or id = k.unit_id);
  v_limit := least(greatest(coalesce((p->>'limit')::int, 50), 1), 100);

  if p_op = 'me' then
    return jsonb_build_object('tenant', (select jsonb_build_object('id', t.id, 'name', t.name) from public.tenants t where t.id = k.tenant_id),
      'key', jsonb_build_object('name', k.name, 'prefix', k.prefix, 'scopes', k.scopes, 'unit_id', k.unit_id),
      'units', (select jsonb_agg(jsonb_build_object('id', u.id, 'name', u.name, 'slug', u.slug, 'active', u.active) order by u.name)
                from public.units u where u.id = any (v_units)));

  elsif p_op = 'orders.list' then
    if p ? 'unit_id' and not ((p->>'unit_id')::uuid = any (v_units)) then return jsonb_build_object('error', 'not_found'); end if;
    select coalesce(jsonb_agg(private.api_order_json(x) order by x.created_at desc, x.id desc), '[]'::jsonb) into v from (
      select * from public.orders
      where unit_id = any (v_units)
        and (not p ? 'unit_id' or unit_id = (p->>'unit_id')::uuid)
        and (not p ? 'status' or status::text = any (string_to_array(p->>'status', ',')))
        and (not p ? 'since' or updated_at >= (p->>'since')::timestamptz)
        and (not p ? 'until' or created_at < (p->>'until')::timestamptz)
        and (not p ? 'before' or created_at < (p->>'before')::timestamptz)
      order by created_at desc, id desc limit v_limit) x;
    return jsonb_build_object('data', v, 'next_before', case when jsonb_array_length(v) = v_limit then v->(v_limit - 1)->>'created_at' end);

  elsif p_op = 'orders.get' then
    select * into o from public.orders where id = (p->>'id')::uuid and unit_id = any (v_units);
    if not found then return jsonb_build_object('error', 'not_found'); end if;
    return jsonb_build_object('data', private.api_order_json(o));

  elsif p_op = 'orders.status' then
    select * into o from public.orders where id = (p->>'id')::uuid and unit_id = any (v_units);
    if not found then return jsonb_build_object('error', 'not_found'); end if;
    begin v_status := (p->>'status')::public.order_status;
    exception when others then return jsonb_build_object('error', 'invalid', 'message', 'Status inválido.'); end;
    perform private.api_act_as(k.created_by);
    begin
      perform public.set_order_status(o.id, v_status, nullif(left(trim(coalesce(p->>'reason', '')), 300), ''));
    exception when others then
      return jsonb_build_object('error', 'invalid', 'message', sqlerrm);
    end;
    select * into o from public.orders where id = o.id;
    return jsonb_build_object('data', private.api_order_json(o));

  elsif p_op = 'menu.get' then
    v_unit := coalesce((p->>'unit_id')::uuid, k.unit_id, (select id from public.units where id = any (v_units) order by created_at limit 1));
    if not (v_unit = any (v_units)) then return jsonb_build_object('error', 'not_found'); end if;
    return jsonb_build_object('unit_id', v_unit, 'data', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'position', c.position,
        'products', coalesce((select jsonb_agg(jsonb_build_object('id', pr2.id, 'name', pr2.name, 'description', pr2.description,
            'pdv_code', pr2.pdv_code, 'sku', pr2.sku, 'image_url', pr2.image_url,
            'price_cents', coalesce(ov.price_cents, pr2.price_cents), 'promo_price_cents', pr2.promo_price_cents,
            'active', pr2.active, 'available', pr2.active and (pr2.paused_until is null or pr2.paused_until <= now()) and coalesce(ov.available, true),
            'paused_until', pr2.paused_until) order by pr2.position, pr2.name)
          from public.products pr2 left join public.product_unit_overrides ov on ov.product_id = pr2.id and ov.unit_id = v_unit
          where pr2.category_id = c.id), '[]'::jsonb)) order by c.position, c.name)
      from public.categories c where c.tenant_id = k.tenant_id), '[]'::jsonb));

  elsif p_op = 'products.update' then
    select * into pr from public.products where id = (p->>'id')::uuid and tenant_id = k.tenant_id;
    if not found then return jsonb_build_object('error', 'not_found'); end if;
    if p ? 'price_cents' and ((p->>'price_cents')::int < 0 or (p->>'price_cents')::int > 10000000) then
      return jsonb_build_object('error', 'invalid', 'message', 'Preço inválido.'); end if;
    v_unit := coalesce((p->>'unit_id')::uuid, k.unit_id);
    if v_unit is not null then
      -- disponibilidade/preço só desta loja
      if not (v_unit = any (v_units)) then return jsonb_build_object('error', 'not_found'); end if;
      insert into public.product_unit_overrides (product_id, unit_id, tenant_id, price_cents, available)
      values (pr.id, v_unit, k.tenant_id, (p->>'price_cents')::int, coalesce((p->>'available')::boolean, true))
      on conflict (product_id, unit_id) do update set
        price_cents = case when p ? 'price_cents' then excluded.price_cents else product_unit_overrides.price_cents end,
        available = case when p ? 'available' then excluded.available else product_unit_overrides.available end;
    else
      select coalesce((select timezone from public.units where tenant_id = k.tenant_id order by created_at limit 1), 'America/Sao_Paulo') into v_tz;
      update public.products set
        price_cents = coalesce((p->>'price_cents')::int, price_cents),
        paused_until = case when not p ? 'available' then paused_until
          when (p->>'available')::boolean then null
          -- "esgotado" como no painel: até as 5 h do dia seguinte (ou a data enviada)
          else coalesce((p->>'paused_until')::timestamptz, ((date_trunc('day', now() at time zone v_tz) + interval '1 day 5 hours') at time zone v_tz)) end,
        updated_at = now()
      where id = pr.id;
    end if;
    insert into public.audit_logs (tenant_id, actor_id, action, entity, entity_id, after, ip)
    values (k.tenant_id, k.created_by, 'api_product_update', 'products', pr.id::text, (p - 'id') || jsonb_build_object('api_key', k.prefix), null);
    return jsonb_build_object('ok', true);

  elsif p_op = 'customers.list' then
    select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'phone', c.phone, 'email', c.email, 'birthday', c.birthday,
        'tags', c.tags, 'opt_in_marketing', c.opt_in_marketing and c.marketing_opt_out_at is null,
        'orders_count', c.orders_count, 'total_spent_cents', c.total_spent_cents,
        'first_order_at', c.first_order_at, 'last_order_at', c.last_order_at, 'created_at', c.created_at, 'updated_at', c.updated_at)
        order by c.updated_at desc, c.id desc), '[]'::jsonb) into v
    from (select * from public.customers where tenant_id = k.tenant_id
            and (not p ? 'since' or updated_at >= (p->>'since')::timestamptz)
            and (not p ? 'before' or updated_at < (p->>'before')::timestamptz)
          order by updated_at desc, id desc limit v_limit) c;
    return jsonb_build_object('data', v, 'next_before', case when jsonb_array_length(v) = v_limit then v->(v_limit - 1)->>'updated_at' end);
  end if;
  return jsonb_build_object('error', 'not_found');
exception when invalid_text_representation or invalid_datetime_format or datetime_field_overflow or numeric_value_out_of_range then
  return jsonb_build_object('error', 'invalid', 'message', 'Parâmetro inválido.');
end $$;

-- ---------- Painel (só o dono) ----------
create or replace function public.api_overview(p_tenant_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.has_role(p_tenant_id, array['owner']::public.member_role[]) then raise exception 'Só o dono da conta gerencia a API.' using errcode = '42501'; end if;
  return jsonb_build_object(
    'keys', coalesce((select jsonb_agg(jsonb_build_object('id', k.id, 'name', k.name, 'prefix', k.prefix, 'scopes', k.scopes,
        'unit_id', k.unit_id, 'unit_name', u.name, 'created_at', k.created_at, 'last_used_at', k.last_used_at,
        'calls_today', (select coalesce(sum(calls), 0) from public.api_usage x where x.key_id = k.id and x.minute >= date_trunc('day', now())))
        order by k.created_at desc)
      from public.api_keys k left join public.units u on u.id = k.unit_id where k.tenant_id = p_tenant_id and k.revoked_at is null), '[]'::jsonb),
    'webhooks', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'url', e.url, 'events', e.events, 'unit_id', e.unit_id, 'unit_name', u.name,
        'active', e.active, 'failures', e.failures, 'disabled_reason', e.disabled_reason, 'last_success_at', e.last_success_at,
        'last_error', e.last_error, 'created_at', e.created_at) order by e.created_at)
      from public.webhook_endpoints e left join public.units u on u.id = e.unit_id where e.tenant_id = p_tenant_id), '[]'::jsonb),
    'deliveries', coalesce((select jsonb_agg(x order by x.id desc) from (
        select d.id, d.endpoint_id, d.event, d.status, d.attempts, d.response_code, d.error, d.created_at, d.delivered_at,
          (d.payload->'data'->'order'->>'number')::int as order_number
        from public.webhook_deliveries d where d.tenant_id = p_tenant_id order by d.id desc limit 30) x), '[]'::jsonb),
    'units', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', name) order by name) from public.units where tenant_id = p_tenant_id), '[]'::jsonb));
end $$;

create or replace function public.api_key_create(p_tenant_id uuid, p_name text, p_scopes text[], p_unit_id uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_key text := 'dmf_' || encode(extensions.gen_random_bytes(24), 'hex'); v_id uuid;
begin
  if not private.has_role(p_tenant_id, array['owner']::public.member_role[]) then raise exception 'Só o dono da conta cria chaves.' using errcode = '42501'; end if;
  if p_unit_id is not null and not exists (select 1 from public.units where id = p_unit_id and tenant_id = p_tenant_id) then raise exception 'Loja inválida.'; end if;
  if (select count(*) from public.api_keys where tenant_id = p_tenant_id and revoked_at is null) >= 10 then
    raise exception 'Limite de 10 chaves ativas. Revogue uma que não usa mais.'; end if;
  if p_scopes is null or cardinality(p_scopes) = 0 then raise exception 'Escolha pelo menos uma permissão.'; end if;
  insert into public.api_keys (tenant_id, unit_id, name, prefix, key_hash, scopes, created_by)
  values (p_tenant_id, p_unit_id, trim(p_name), left(v_key, 12), encode(extensions.digest(v_key, 'sha256'), 'hex'),
    (select array_agg(distinct s) from unnest(p_scopes) s), auth.uid())
  returning id into v_id;
  insert into public.audit_logs (tenant_id, actor_id, action, entity, entity_id, after, ip)
  values (p_tenant_id, auth.uid(), 'api_key_create', 'api_keys', v_id::text, jsonb_build_object('name', p_name, 'scopes', p_scopes, 'unit_id', p_unit_id), private.request_ip());
  return jsonb_build_object('id', v_id, 'key', v_key);
end $$;

create or replace function public.api_key_revoke(p_key_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare k public.api_keys;
begin
  select * into k from public.api_keys where id = p_key_id;
  if not found or not private.has_role(k.tenant_id, array['owner']::public.member_role[]) then raise exception 'Sem permissão.' using errcode = '42501'; end if;
  update public.api_keys set revoked_at = now() where id = k.id and revoked_at is null;
  insert into public.audit_logs (tenant_id, actor_id, action, entity, entity_id, ip)
  values (k.tenant_id, auth.uid(), 'api_key_revoke', 'api_keys', k.id::text, private.request_ip());
end $$;

create or replace function public.webhook_save(p_tenant_id uuid, p_id uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare e public.webhook_endpoints; v_secret text; v_events text[]; v_sec uuid;
begin
  if not private.has_role(p_tenant_id, array['owner']::public.member_role[]) then raise exception 'Só o dono da conta gerencia webhooks.' using errcode = '42501'; end if;
  if p ? 'events' then select array_agg(distinct x) into v_events from jsonb_array_elements_text(p->'events') x; end if;
  if p ? 'unit_id' and p->>'unit_id' is not null and not exists (select 1 from public.units where id = (p->>'unit_id')::uuid and tenant_id = p_tenant_id) then
    raise exception 'Loja inválida.'; end if;
  if p_id is null then
    if (select count(*) from public.webhook_endpoints where tenant_id = p_tenant_id) >= 5 then raise exception 'Limite de 5 webhooks por conta.'; end if;
    v_secret := 'whsec_' || encode(extensions.gen_random_bytes(24), 'hex');
    v_sec := vault.create_secret(v_secret, 'webhook_' || encode(extensions.gen_random_bytes(6), 'hex'), 'Domma Food: segredo de webhook');
    begin
      insert into public.webhook_endpoints (tenant_id, unit_id, url, events, secret_id, created_by)
      values (p_tenant_id, (p->>'unit_id')::uuid, private.norm_url(p->>'url'), coalesce(v_events, array['order.created','order.status_changed']), v_sec, auth.uid())
      returning * into e;
    exception when check_violation or not_null_violation then
      raise exception 'Endereço inválido: use https:// com um domínio público (não aceitamos IP, localhost nem rede interna).';
    end;
    return jsonb_build_object('id', e.id, 'secret', v_secret);
  end if;
  select * into e from public.webhook_endpoints where id = p_id and tenant_id = p_tenant_id;
  if not found then raise exception 'Webhook não encontrado.'; end if;
  begin
    update public.webhook_endpoints set
      url = coalesce(private.norm_url(p->>'url'), url),
      events = coalesce(v_events, events),
      unit_id = case when p ? 'unit_id' then (p->>'unit_id')::uuid else unit_id end,
      active = coalesce((p->>'active')::boolean, active),
      failures = case when (p->>'active')::boolean then 0 else failures end,
      disabled_reason = case when (p->>'active')::boolean then null else disabled_reason end
    where id = e.id;
  exception when check_violation or not_null_violation then
    raise exception 'Endereço inválido: use https:// com um domínio público (não aceitamos IP, localhost nem rede interna).';
  end;
  if coalesce((p->>'rotate_secret')::boolean, false) then
    v_secret := 'whsec_' || encode(extensions.gen_random_bytes(24), 'hex');
    perform vault.update_secret(e.secret_id, v_secret);
    return jsonb_build_object('id', e.id, 'secret', v_secret);
  end if;
  return jsonb_build_object('id', e.id);
end $$;

create or replace function public.webhook_delete(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare e public.webhook_endpoints;
begin
  select * into e from public.webhook_endpoints where id = p_id;
  if not found or not private.has_role(e.tenant_id, array['owner']::public.member_role[]) then raise exception 'Sem permissão.' using errcode = '42501'; end if;
  delete from public.webhook_endpoints where id = e.id;
  delete from vault.secrets where id = e.secret_id;
end $$;

-- envia um evento de teste (ou reenvia uma entrega)
create or replace function public.webhook_test(p_id uuid, p_redeliver bigint default null)
returns void language plpgsql security definer set search_path = '' as $$
declare e public.webhook_endpoints;
begin
  select * into e from public.webhook_endpoints where id = p_id;
  if not found or not private.has_role(e.tenant_id, array['owner']::public.member_role[]) then raise exception 'Sem permissão.' using errcode = '42501'; end if;
  if not e.active then raise exception 'Ligue o webhook antes de testar.'; end if;
  if p_redeliver is not null then
    insert into public.webhook_deliveries (endpoint_id, tenant_id, event, payload)
    select e.id, e.tenant_id, d.event, d.payload from public.webhook_deliveries d where d.id = p_redeliver and d.endpoint_id = e.id;
  else
    insert into public.webhook_deliveries (endpoint_id, tenant_id, event, payload)
    values (e.id, e.tenant_id, 'ping', jsonb_build_object('type', 'ping', 'created_at', now(), 'data', jsonb_build_object('message', 'Teste do Domma Food')));
  end if;
  perform private.webhook_kick();
end $$;

grant execute on function public.api_overview(uuid), public.api_key_create(uuid, text, text[], uuid), public.api_key_revoke(uuid),
  public.webhook_save(uuid, uuid, jsonb), public.webhook_delete(uuid), public.webhook_test(uuid, bigint) to authenticated;
revoke execute on function public.api_overview(uuid), public.api_key_create(uuid, text, text[], uuid), public.api_key_revoke(uuid),
  public.webhook_save(uuid, uuid, jsonb), public.webhook_delete(uuid), public.webhook_test(uuid, bigint) from public, anon;
revoke execute on function public.api_auth(text), public.api_call(uuid, text, jsonb), public.webhook_jobs(integer),
  public.webhook_job_result(bigint, boolean, integer, text), public.api_worker_secret() from public, anon, authenticated;
grant execute on function public.api_auth(text), public.api_call(uuid, text, jsonb), public.webhook_jobs(integer),
  public.webhook_job_result(bigint, boolean, integer, text), public.api_worker_secret() to service_role;
revoke execute on function private.api_order_json(public.orders), private.webhook_kick(), private.webhook_enqueue(public.orders, text, jsonb),
  private.webhook_on_order_insert(), private.webhook_on_order_update(), private.webhook_cron_tick(), private.api_act_as(uuid), private.norm_url(text)
  from public, anon, authenticated;
