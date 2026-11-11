-- =====================================================================
-- Domma Food · 039 · Integração iFood (Merchant API, aplicativo distribuído)
-- O Domma tem UM aplicativo no iFood (client id/secret no Vault, cadastrados
-- pelo super admin). Cada loja autoriza esse app pelo Portal do Parceiro
-- (código de vínculo) e os tokens da loja ficam no Vault.
-- Polling de eventos a cada 30 s (exigência do iFood), confirmação de recebimento,
-- pedidos entram na mesma fila de pedidos e o status volta pelo integration_outbox.
-- =====================================================================
alter table public.marketplace_connections drop constraint marketplace_connections_provider_check;
alter table public.marketplace_connections add constraint marketplace_connections_provider_check
  check (provider in ('99food','keeta','aiqfome','other','ifood'));
alter table public.marketplace_connections add column external_merchant_id text;   -- id da loja no iFood
alter table public.marketplace_connections add column external_status jsonb;       -- último status da loja no iFood
create unique index marketplace_connections_ifood_uq on public.marketplace_connections(external_merchant_id) where provider = 'ifood' and external_merchant_id is not null;

-- app do Domma no iFood (singleton)
create table public.ifood_app (
  id boolean primary key default true check (id),
  client_id text, client_secret_id uuid,
  last_test_at timestamptz, last_test_ok boolean, last_test_message text,
  updated_at timestamptz not null default now()
);
insert into public.ifood_app (id) values (true);
-- dados sensíveis da autorização de cada loja (sem acesso pelo painel)
create table public.ifood_auth (
  connection_id uuid primary key references public.marketplace_connections(id) on delete cascade,
  verifier_secret_id uuid,          -- authorizationCodeVerifier (válido por ~10 min)
  token_secret_id uuid,             -- {"access_token","refresh_token","expires_at"}
  user_code text, verification_url text, code_expires_at timestamptz,
  merchants jsonb,                  -- lojas que a autorização enxerga (para escolher)
  updated_at timestamptz not null default now()
);
alter table public.ifood_app enable row level security;
alter table public.ifood_app force row level security;
alter table public.ifood_auth enable row level security;
alter table public.ifood_auth force row level security;
revoke all on public.ifood_app, public.ifood_auth from anon, authenticated;

-- ---------- Super admin: credenciais do app ----------
create or replace function public.admin_ifood_settings()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_platform_admin() then raise exception 'Sem permissão.' using errcode = '42501'; end if;
  return (select jsonb_build_object('client_id', client_id, 'has_secret', client_secret_id is not null,
    'last_test_at', last_test_at, 'last_test_ok', last_test_ok, 'last_test_message', last_test_message,
    'connections', (select count(*) from public.marketplace_connections where provider = 'ifood' and active)) from public.ifood_app where id);
end $$;
create or replace function public.admin_ifood_save(p_client_id text, p_client_secret text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare a public.ifood_app; v uuid; k text := nullif(trim(p_client_secret), '');
begin
  if not private.is_platform_admin() then raise exception 'Sem permissão.' using errcode = '42501'; end if;
  if nullif(trim(p_client_id), '') is null or trim(p_client_id) !~ '^[A-Za-z0-9-]{8,80}$' then raise exception 'Client ID do iFood inválido.'; end if;
  select * into a from public.ifood_app where id for update;
  if k is not null then
    if char_length(k) not between 16 and 300 then raise exception 'Client secret do iFood inválido.'; end if;
    if a.client_secret_id is not null then perform vault.update_secret(a.client_secret_id, k);
    else v := vault.create_secret(k, 'ifood_client_secret', 'Domma Food: client secret do app iFood');
         update public.ifood_app set client_secret_id = v where id; end if;
  end if;
  update public.ifood_app set client_id = trim(p_client_id), last_test_ok = null, updated_at = now() where id;
end $$;

-- ---------- Painel da loja ----------
create or replace function public.ifood_overview(p_unit_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare u public.units; c public.marketplace_connections; a public.ifood_auth;
begin
  select * into u from public.units where id = p_unit_id;
  if not found or not private.can_manage(u.tenant_id) or not private.can_access_unit(u.id) then raise exception 'Sem permissão.' using errcode = '42501'; end if;
  select * into c from public.marketplace_connections where unit_id = u.id and provider = 'ifood';
  select * into a from public.ifood_auth where connection_id = c.id;
  return jsonb_build_object(
    'app_ready', (select client_id is not null and client_secret_id is not null from public.ifood_app where id),
    'connection', case when c.id is null then null else jsonb_build_object('id', c.id, 'active', c.active, 'auto_confirm', c.auto_confirm,
      'external_merchant_id', c.external_merchant_id, 'display_name', c.display_name, 'external_status', c.external_status,
      'last_event_at', c.last_event_at, 'last_sync_at', c.last_sync_at, 'last_error', c.last_error,
      'authorized', a.token_secret_id is not null,
      'pending_code', case when a.code_expires_at > now() then jsonb_build_object('user_code', a.user_code, 'url', a.verification_url, 'expires_at', a.code_expires_at) end,
      'merchants', a.merchants) end,
    'orders_today', (select count(*) from public.orders o where o.unit_id = u.id and o.channel = 'ifood' and o.created_at > date_trunc('day', now() at time zone 'America/Sao_Paulo') at time zone 'America/Sao_Paulo'));
end $$;
create or replace function public.ifood_can_manage(p_unit_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.units u where u.id = p_unit_id and private.can_manage(u.tenant_id) and private.can_access_unit(u.id));
$$;
create or replace function public.ifood_set_options(p_unit_id uuid, p_auto_confirm boolean, p_active boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare c public.marketplace_connections;
begin
  if not public.ifood_can_manage(p_unit_id) then raise exception 'Sem permissão.' using errcode = '42501'; end if;
  select * into c from public.marketplace_connections where unit_id = p_unit_id and provider = 'ifood';
  if not found then raise exception 'Conecte o iFood primeiro.'; end if;
  if p_active and (c.external_merchant_id is null or not exists (select 1 from public.ifood_auth where connection_id = c.id and token_secret_id is not null)) then
    raise exception 'Termine a autorização da loja no iFood antes de ativar.'; end if;
  update public.marketplace_connections set auto_confirm = p_auto_confirm, active = p_active, last_error = null where id = c.id;
end $$;
create or replace function public.ifood_disconnect(p_unit_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare c public.marketplace_connections; a public.ifood_auth;
begin
  if not public.ifood_can_manage(p_unit_id) then raise exception 'Sem permissão.' using errcode = '42501'; end if;
  select * into c from public.marketplace_connections where unit_id = p_unit_id and provider = 'ifood';
  if not found then return; end if;
  select * into a from public.ifood_auth where connection_id = c.id;
  delete from vault.secrets where id in (a.verifier_secret_id, a.token_secret_id);
  delete from public.ifood_auth where connection_id = c.id;
  update public.marketplace_connections set active = false, external_merchant_id = null, external_status = null where id = c.id;
end $$;

-- ---------- Serviço (Edge Function) ----------
create or replace function public.ifood_app_secret()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.assert_service_role();
  return (select jsonb_build_object('client_id', client_id,
    'client_secret', (select decrypted_secret from vault.decrypted_secrets where id = client_secret_id)) from public.ifood_app where id);
end $$;
create or replace function public.ifood_app_test_result(p_ok boolean, p_message text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.assert_service_role();
  update public.ifood_app set last_test_at = now(), last_test_ok = p_ok, last_test_message = left(p_message, 300) where id;
end $$;
-- passo 1: guarda o código de vínculo (cria a conexão se não houver)
create or replace function public.ifood_save_user_code(p_unit_id uuid, p_user_code text, p_url text, p_verifier text, p_expires_in integer)
returns uuid language plpgsql security definer set search_path = '' as $$
declare u public.units; c public.marketplace_connections; a public.ifood_auth; v uuid;
begin
  perform private.assert_service_role();
  select * into u from public.units where id = p_unit_id;
  insert into public.marketplace_connections (tenant_id, unit_id, provider, display_name, polling_enabled, active)
  values (u.tenant_id, u.id, 'ifood', 'iFood', true, false)
  on conflict (unit_id, provider) do nothing;
  select * into c from public.marketplace_connections where unit_id = u.id and provider = 'ifood';
  insert into public.ifood_auth (connection_id) values (c.id) on conflict (connection_id) do nothing;
  select * into a from public.ifood_auth where connection_id = c.id for update;
  if a.verifier_secret_id is not null then perform vault.update_secret(a.verifier_secret_id, p_verifier);
  else v := vault.create_secret(p_verifier, 'ifood_verifier_' || c.id, 'Domma Food: iFood authorizationCodeVerifier'); end if;
  update public.ifood_auth set verifier_secret_id = coalesce(v, verifier_secret_id), user_code = left(p_user_code, 40),
    verification_url = left(p_url, 300), code_expires_at = now() + make_interval(secs => greatest(coalesce(p_expires_in, 600), 60)), updated_at = now()
  where connection_id = c.id;
  return c.id;
end $$;
create or replace function public.ifood_auth_context(p_connection_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare a public.ifood_auth; c public.marketplace_connections;
begin
  perform private.assert_service_role();
  select * into c from public.marketplace_connections where id = p_connection_id and provider = 'ifood';
  select * into a from public.ifood_auth where connection_id = p_connection_id;
  return jsonb_build_object('connection_id', c.id, 'unit_id', c.unit_id, 'tenant_id', c.tenant_id, 'active', c.active,
    'external_merchant_id', c.external_merchant_id, 'auto_confirm', c.auto_confirm,
    'verifier', case when a.code_expires_at > now() then (select decrypted_secret from vault.decrypted_secrets where id = a.verifier_secret_id) end,
    'token', (select decrypted_secret::jsonb from vault.decrypted_secrets where id = a.token_secret_id));
end $$;
create or replace function public.ifood_save_token(p_connection_id uuid, p_token jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare a public.ifood_auth; v uuid;
begin
  perform private.assert_service_role();
  insert into public.ifood_auth (connection_id) values (p_connection_id) on conflict (connection_id) do nothing;
  select * into a from public.ifood_auth where connection_id = p_connection_id for update;
  if a.token_secret_id is not null then perform vault.update_secret(a.token_secret_id, p_token::text);
  else v := vault.create_secret(p_token::text, 'ifood_token_' || p_connection_id, 'Domma Food: tokens iFood da loja'); end if;
  update public.ifood_auth set token_secret_id = coalesce(v, token_secret_id), code_expires_at = null, user_code = null, updated_at = now()
   where connection_id = p_connection_id;
  if a.verifier_secret_id is not null then
    delete from vault.secrets where id = a.verifier_secret_id;
    update public.ifood_auth set verifier_secret_id = null where connection_id = p_connection_id;
  end if;
end $$;
create or replace function public.ifood_set_merchant(p_connection_id uuid, p_merchant_id text, p_name text, p_merchants jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.assert_service_role();
  update public.ifood_auth set merchants = p_merchants where connection_id = p_connection_id;
  if p_merchant_id is not null then
    update public.marketplace_connections set external_merchant_id = p_merchant_id, display_name = left(coalesce(p_name, 'iFood'), 120),
      active = true, last_error = null where id = p_connection_id;
  end if;
end $$;
create or replace function public.ifood_connections()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.assert_service_role();
  return coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'tenant_id', c.tenant_id, 'unit_id', c.unit_id,
      'external_merchant_id', c.external_merchant_id, 'auto_confirm', c.auto_confirm,
      'token', (select decrypted_secret::jsonb from vault.decrypted_secrets ds join public.ifood_auth a on a.token_secret_id = ds.id where a.connection_id = c.id)))
    from public.marketplace_connections c join public.tenants t on t.id = c.tenant_id
    where c.provider = 'ifood' and c.active and c.external_merchant_id is not null and t.status <> 'suspended'), '[]'::jsonb);
end $$;

-- pedido do iFood → pedido do Domma
create or replace function public.ifood_ingest_order(p_connection_id uuid, o jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare c public.marketplace_connections; u public.units; v_order uuid; v_number int; v_type public.order_type;
  v_pm public.payment_method := 'online_card'; v_paid boolean; m jsonb; it jsonb; v_total int; v_status public.order_status;
  v_phone text; v_notes text; v_sub int; v_disc int; v_fee int; v_addr jsonb; d jsonb := o->'delivery';
begin
  perform private.assert_service_role();
  select * into c from public.marketplace_connections where id = p_connection_id and provider = 'ifood';
  if not found then raise exception 'Conexão iFood não encontrada'; end if;
  select id into v_order from public.orders where connection_id = c.id and external_id = o->>'id';
  if v_order is not null then return v_order; end if;
  select * into u from public.units where id = c.unit_id;

  v_type := case o->>'orderType' when 'DELIVERY' then 'delivery'::public.order_type when 'DINE_IN' then 'dine_in'::public.order_type
                                 else 'pickup'::public.order_type end;
  v_paid := coalesce((o->'payments'->>'pending')::numeric, 0) = 0;
  if not v_paid then
    select x into m from jsonb_array_elements(coalesce(o->'payments'->'methods', '[]'::jsonb)) x where x->>'type' = 'OFFLINE' limit 1;
    v_pm := case m->>'method' when 'CASH' then 'cash'::public.payment_method when 'PIX' then 'pix'::public.payment_method
              when 'MEAL_VOUCHER' then 'voucher'::public.payment_method when 'FOOD_VOUCHER' then 'voucher'::public.payment_method
              else 'card_on_delivery'::public.payment_method end;
  end if;
  v_sub := round(coalesce((o->'total'->>'subTotal')::numeric, 0) * 100)::int;
  v_disc := round(coalesce((o->'total'->>'benefits')::numeric, 0) * 100)::int;
  v_fee := round((coalesce((o->'total'->>'deliveryFee')::numeric, 0) + coalesce((o->'total'->>'additionalFees')::numeric, 0)) * 100)::int;
  v_total := round(coalesce((o->'total'->>'orderAmount')::numeric, 0) * 100)::int;
  v_status := case when c.auto_confirm then 'preparing'::public.order_status else 'pending'::public.order_status end;
  -- telefone do iFood é um 0800 com código localizador (não é o celular do cliente: não vira cadastro)
  v_phone := left(private.only_digits(o->'customer'->'phone'->>'number'), 13);
  v_notes := nullif(concat_ws(' · ',
    nullif(o->>'extraInfo', ''), nullif(d->>'observations', ''),
    case when o->'customer'->'phone'->>'localizer' is not null then 'Contato iFood: ' || coalesce(o->'customer'->'phone'->>'number', '') || ' código ' || (o->'customer'->'phone'->>'localizer') end,
    case when d->>'pickupCode' is not null then 'Código de coleta: ' || (d->>'pickupCode') end,
    case when (o->>'isTest')::boolean then 'PEDIDO DE TESTE' end), '');
  if v_type = 'delivery' then
    v_addr := jsonb_build_object('street', d->'deliveryAddress'->>'streetName', 'number', d->'deliveryAddress'->>'streetNumber',
      'complement', d->'deliveryAddress'->>'complement', 'neighborhood', d->'deliveryAddress'->>'neighborhood',
      'city', d->'deliveryAddress'->>'city', 'reference', d->'deliveryAddress'->>'reference',
      'lat', (d->'deliveryAddress'->'coordinates'->>'latitude')::float8, 'lng', (d->'deliveryAddress'->'coordinates'->>'longitude')::float8,
      'delivered_by', d->>'deliveredBy', 'pickup_code', d->>'pickupCode');
  end if;

  update public.units set order_counter = order_counter + 1 where id = u.id returning order_counter into v_number;
  insert into public.orders (tenant_id, unit_id, number, channel, type, status, customer_name, customer_phone,
     address, scheduled_for, subtotal_cents, discount_cents, delivery_fee_cents, total_cents, payment_method, payment_status,
     change_for_cents, notes, accepted_at, estimated_ready_at, paid_at, external_id, external_display_id, connection_id, external_flags)
  values (c.tenant_id, u.id, v_number, 'ifood', v_type, v_status,
     left(coalesce(nullif(trim(o->'customer'->>'name'), ''), 'Cliente iFood'), 120), coalesce(nullif(v_phone, ''), '00000000000'),
     v_addr, case when o->>'orderTiming' = 'SCHEDULED' then (o->'schedule'->>'deliveryDateTimeStart')::timestamptz end,
     v_sub, v_disc, v_fee, v_total, v_pm, case when v_paid then 'paid'::public.payment_status else 'pending'::public.payment_status end,
     case when v_pm = 'cash' then round((m->'cash'->>'changeFor')::numeric * 100)::int end,
     left(v_notes, 500), case when v_status = 'preparing' then now() end,
     coalesce((d->>'deliveryDateTime')::timestamptz, (o->'takeout'->>'takeoutDateTime')::timestamptz),
     case when v_paid then now() end, o->>'id', o->>'displayId', c.id,
     jsonb_build_object('deliveredBy', coalesce(d->>'deliveredBy', 'MERCHANT'), 'sendPreparing', false, 'sendDelivered', false, 'sendPickedUp', false,
       'is_test', coalesce((o->>'isTest')::boolean, false), 'phone_localizer', o->'customer'->'phone'->>'localizer'))
  returning id into v_order;

  for it in select * from jsonb_array_elements(coalesce(o->'items', '[]'::jsonb)) loop
    insert into public.order_items (tenant_id, order_id, product_id, name, quantity, unit_price_cents, total_cents, options, notes)
    values (c.tenant_id, v_order,
      (select p.id from public.products p where p.tenant_id = c.tenant_id and p.id::text = it->>'externalCode'),
      left(it->>'name', 200), greatest(1, least(99, round(coalesce((it->>'quantity')::numeric, 1))::int)),
      round(coalesce((it->>'unitPrice')::numeric, 0) * 100)::int, round(coalesce((it->>'totalPrice')::numeric, 0) * 100)::int,
      coalesce((select jsonb_agg(jsonb_build_object('name', op->>'name', 'quantity', (op->>'quantity')::numeric,
                 'price_cents', round(coalesce((op->>'unitPrice')::numeric, 0) * 100)::int))
                from jsonb_array_elements(coalesce(it->'options', '[]'::jsonb)) op), '[]'::jsonb),
      left(it->>'observations', 300));
  end loop;
  insert into public.payments (tenant_id, order_id, method, gateway, amount_cents, status)
  values (c.tenant_id, v_order, v_pm, 'ifood', v_total, case when v_paid then 'paid'::public.payment_status else 'pending'::public.payment_status end);
  insert into public.order_events (tenant_id, order_id, from_status, to_status, note)
  values (c.tenant_id, v_order, null, v_status, 'Pedido recebido do iFood #' || coalesce(o->>'displayId', o->>'id'));
  if v_status = 'preparing' then
    insert into public.integration_outbox (tenant_id, connection_id, order_id, action) values (c.tenant_id, c.id, v_order, 'confirm');
  end if;
  update public.marketplace_connections set last_event_at = now(), last_error = null where id = c.id;
  return v_order;
end $$;

-- eventos do iFood num pedido existente
create or replace function public.ifood_apply_event(p_connection_id uuid, p_external_id text, p_code text, p_meta jsonb default '{}')
returns void language plpgsql security definer set search_path = '' as $$
declare o public.orders;
begin
  perform private.assert_service_role();
  select * into o from public.orders where connection_id = p_connection_id and external_id = p_external_id for update;
  if not found then return; end if;
  if p_code = 'CAN' and o.status not in ('cancelled','completed') then
    update public.orders set status = 'cancelled', cancelled_at = now(), cancel_reason = 'Cancelado pelo marketplace',
           marketplace_cancel_requested = false where id = o.id;
    insert into public.order_events (tenant_id, order_id, from_status, to_status, note) values (o.tenant_id, o.id, o.status, 'cancelled', 'Cancelado no iFood');
  elsif p_code = 'CFM' and o.status = 'pending' then
    -- confirmado direto no gestor do iFood: segue em preparo aqui também (sem reenviar confirmação)
    update public.orders set status = 'preparing', accepted_at = now(), external_flags = coalesce(external_flags, '{}') || '{"confirmed_remote":true}' where id = o.id;
    insert into public.order_events (tenant_id, order_id, from_status, to_status, note) values (o.tenant_id, o.id, o.status, 'preparing', 'Confirmado no iFood');
  elsif p_code = 'DSP' and o.status in ('preparing','ready') and o.type = 'delivery' then
    update public.orders set status = 'dispatched', dispatched_at = now(), external_flags = coalesce(external_flags, '{}') || '{"dispatched_remote":true}' where id = o.id;
    insert into public.order_events (tenant_id, order_id, from_status, to_status, note) values (o.tenant_id, o.id, o.status, 'dispatched', 'Saiu para entrega (iFood)');
  elsif p_code = 'CON' and o.status not in ('cancelled','completed') then
    update public.orders set status = 'completed', completed_at = now(), payment_status = 'paid', paid_at = coalesce(paid_at, now()) where id = o.id;
    insert into public.order_events (tenant_id, order_id, from_status, to_status, note) values (o.tenant_id, o.id, o.status, 'completed', 'Concluído no iFood');
  elsif p_code = 'HSD' and o.status not in ('cancelled','completed') then
    -- cliente pediu cancelamento (plataforma de negociação): a loja aceita ou recusa no painel
    update public.orders set marketplace_cancel_requested = true,
      external_flags = coalesce(external_flags, '{}') || jsonb_build_object('dispute_id', coalesce(p_meta->>'disputeId', p_meta->>'id'),
        'dispute_action', p_meta->>'action', 'dispute_message', left(p_meta->>'message', 300), 'dispute_expires_at', p_meta->>'expiresAt')
    where id = o.id;
  elsif p_code = 'HSS' then
    update public.orders set marketplace_cancel_requested = false where id = o.id;
  end if;
end $$;

-- ---------- Fila de saída: acorda o worker certo ----------
do $$ begin
  if not exists (select 1 from vault.secrets where name = 'ifood_worker_secret') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'ifood_worker_secret', 'Domma Food: worker iFood');
  end if;
  if not exists (select 1 from vault.secrets where name = 'ifood_worker_url') then
    perform vault.create_secret('https://kcwidutqdqbyphrjnlef.supabase.co/functions/v1/ifood/worker', 'ifood_worker_url', 'Domma Food: URL do worker iFood');
  end if;
end $$;
create or replace function public.ifood_worker_secret()
returns text language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.assert_service_role();
  return (select decrypted_secret from vault.decrypted_secrets where name = 'ifood_worker_secret');
end $$;
create or replace function private.kick_ifood_worker(p_job text default 'all')
returns void language plpgsql security definer set search_path = '' as $$
declare v_url text; v_secret text;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'ifood_worker_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'ifood_worker_secret';
  if v_url is null or v_secret is null then return; end if;
  perform net.http_post(url := v_url, body := jsonb_build_object('job', p_job),
    headers := jsonb_build_object('Content-Type','application/json','x-worker-secret', v_secret), timeout_milliseconds := 25000);
exception when others then null;
end $$;
create or replace function private.kick_marketplace_worker(p_connection_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if (select provider from public.marketplace_connections where id = p_connection_id) = 'ifood' then perform private.kick_ifood_worker('outbox');
  else perform private.kick_od_worker(); end if;
end $$;
do $$ declare d text; begin
  d := pg_get_functiondef('private.enqueue_marketplace_update()'::regprocedure);
  if position('perform private.kick_od_worker();' in d) = 0 then raise exception 'enqueue_marketplace_update mudou'; end if;
  -- iFood: confirmação feita no gestor do iFood ou saída registrada pelo iFood não voltam para o iFood
  d := replace(d, $x$if v_action is null then return new; end if;$x$,
    $x$if v_action is null then return new; end if;
  if v_action = 'confirm' and (new.external_flags->>'confirmed_remote')::boolean then return new; end if;
  if v_action = 'dispatch' and (new.external_flags->>'dispatched_remote')::boolean then return new; end if;$x$);
  execute replace(d, 'perform private.kick_od_worker();', 'perform private.kick_marketplace_worker(new.connection_id);');
  d := pg_get_functiondef('public.respond_marketplace_cancellation(uuid, boolean)'::regprocedure);
  if position('perform private.kick_od_worker();' in d) = 0 then raise exception 'respond_marketplace_cancellation mudou'; end if;
  execute replace(d, 'perform private.kick_od_worker();', 'perform private.kick_marketplace_worker(o.connection_id);');
  -- o worker Open Delivery não trata conexões do iFood
  d := pg_get_functiondef('private.od_cron_tick()'::regprocedure);
  if position('where active)' in d) = 0 then raise exception 'od_cron_tick mudou'; end if;
  execute replace(d, 'where active)', $x$where active and provider <> 'ifood')$x$);
end $$;

-- polling a cada 30 s (o iFood considera a loja conectada enquanto houver polling)
create or replace function private.ifood_cron_tick()
returns void language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.marketplace_connections where provider = 'ifood' and active)
     or exists (select 1 from public.integration_outbox q join public.marketplace_connections c on c.id = q.connection_id
                where c.provider = 'ifood' and q.done_at is null and q.next_attempt_at <= now()) then
    perform private.kick_ifood_worker('all');
  end if;
end $$;
select cron.schedule('domma-ifood', '30 seconds', $$select private.ifood_cron_tick()$$);

grant execute on function public.ifood_app_secret(), public.ifood_app_test_result(boolean, text), public.ifood_save_user_code(uuid, text, text, text, integer),
  public.ifood_auth_context(uuid), public.ifood_save_token(uuid, jsonb), public.ifood_set_merchant(uuid, text, text, jsonb), public.ifood_connections(),
  public.ifood_ingest_order(uuid, jsonb), public.ifood_apply_event(uuid, text, text, jsonb), public.ifood_worker_secret() to service_role;
grant execute on function public.admin_ifood_settings(), public.admin_ifood_save(text, text), public.ifood_overview(uuid), public.ifood_can_manage(uuid),
  public.ifood_set_options(uuid, boolean, boolean), public.ifood_disconnect(uuid) to authenticated;
revoke execute on function public.ifood_app_secret(), public.ifood_app_test_result(boolean, text), public.ifood_save_user_code(uuid, text, text, text, integer),
  public.ifood_auth_context(uuid), public.ifood_save_token(uuid, jsonb), public.ifood_set_merchant(uuid, text, text, jsonb), public.ifood_connections(),
  public.ifood_ingest_order(uuid, jsonb), public.ifood_apply_event(uuid, text, text, jsonb), public.ifood_worker_secret() from public, anon, authenticated;
revoke execute on function public.admin_ifood_settings(), public.admin_ifood_save(text, text), public.ifood_overview(uuid), public.ifood_can_manage(uuid),
  public.ifood_set_options(uuid, boolean, boolean), public.ifood_disconnect(uuid) from public, anon;
revoke execute on function private.kick_ifood_worker(text), private.kick_marketplace_worker(uuid), private.ifood_cron_tick() from public, anon, authenticated;
