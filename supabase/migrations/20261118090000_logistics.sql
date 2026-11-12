-- =====================================================================
-- Domma Food · 045 · Logística sob demanda: Foody Delivery e Entrega iFood
-- A loja chama um entregador externo para pedidos de entrega de qualquer
-- canal (cardápio, WhatsApp, balcão...). Cotação de preço e prazo, solicitação,
-- acompanhamento (eventos do parceiro) e cancelamento.
--   Foody Delivery: padrão Open Delivery (Logistics), credencial por loja.
--   Entrega iFood: Shipping API (pedidos fora do iFood), usa a conexão iFood da loja.
-- =====================================================================
create table public.logistics_settings (
  unit_id uuid primary key references public.units(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  foody_enabled boolean not null default false,
  foody_base_url text check (foody_base_url ~ '^https://[A-Za-z0-9.-]+(:[0-9]{2,5})?(/[A-Za-z0-9._~/-]*)?$'),
  foody_client_id text check (char_length(foody_client_id) <= 200),
  foody_secret_id uuid,                 -- client secret (Vault)
  foody_token_id uuid,                  -- {"access_token","expires_at"} (Vault)
  foody_hook_token text not null default encode(extensions.gen_random_bytes(24), 'hex') unique,
  ifood_enabled boolean not null default false,
  return_to_merchant boolean not null default false,
  last_test_at timestamptz, last_test_ok boolean, last_test_message text,
  updated_at timestamptz not null default now()
);
alter table public.logistics_settings enable row level security;
alter table public.logistics_settings force row level security;
revoke all on public.logistics_settings from anon, authenticated;

create table public.external_deliveries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  unit_id uuid not null references public.units(id) on delete cascade,
  order_id uuid not null references public.orders(id) on delete cascade,
  provider text not null check (provider in ('foody','ifood')),
  external_id text,
  status text not null default 'pending' check (status in ('pending','accepted','to_pickup','at_merchant','picked','in_transit','at_customer',
    'delivered','returning','rejected','cancel_requested','cancelled','failed')),
  fee_cents int check (fee_cents >= 0),
  eta_at timestamptz,
  courier jsonb,                         -- {name, phone, vehicle}
  tracking_url text,
  drop_code text,
  error text,
  events jsonb not null default '[]',
  requested_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, external_id)
);
create unique index external_deliveries_one_active on public.external_deliveries (order_id)
  where status not in ('rejected','cancelled','failed');
create index external_deliveries_unit on public.external_deliveries (unit_id, created_at desc);
alter table public.external_deliveries enable row level security;
alter table public.external_deliveries force row level security;
create policy external_deliveries_select on public.external_deliveries for select to authenticated
  using (private.has_role(tenant_id, array['owner','manager','cashier','attendant']::public.member_role[]) and private.can_access_unit(unit_id));
revoke all on public.external_deliveries from anon;
revoke insert, update, delete on public.external_deliveries from authenticated;
alter publication supabase_realtime add table public.external_deliveries;

create or replace function private.vault_put(p_id uuid, p_value text, p_name text)
returns uuid language plpgsql security definer set search_path = '' as $$
begin
  if p_id is not null then perform vault.update_secret(p_id, p_value); return p_id; end if;
  return vault.create_secret(p_value, p_name || '_' || encode(extensions.gen_random_bytes(6), 'hex'), 'Domma Food: logística');
end $$;
revoke execute on function private.vault_put(uuid, text, text) from public, anon, authenticated;

-- ---------- Painel: configuração (dono/gerência) ----------
create or replace function public.logistics_overview(p_unit_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare u public.units; s public.logistics_settings; v_ifood public.marketplace_connections;
begin
  select * into u from public.units where id = p_unit_id;
  if not found or not private.can_access_unit(u.id)
     or not private.has_role(u.tenant_id, array['owner','manager','cashier','attendant']::public.member_role[]) then
    raise exception 'Sem permissão.' using errcode = '42501'; end if;
  select * into s from public.logistics_settings where unit_id = u.id;
  select * into v_ifood from public.marketplace_connections where unit_id = u.id and provider = 'ifood' and active and external_merchant_id is not null limit 1;
  return jsonb_build_object(
    'can_manage', private.can_manage(u.tenant_id),
    'unit_has_address', u.street is not null and u.city is not null and u.state is not null,
    'unit_has_location', u.lat is not null and u.lng is not null,
    'return_to_merchant', coalesce(s.return_to_merchant, false),
    'foody', jsonb_build_object('enabled', coalesce(s.foody_enabled, false), 'base_url', s.foody_base_url, 'client_id', s.foody_client_id,
      'has_secret', s.foody_secret_id is not null, 'hook_token', case when private.can_manage(u.tenant_id) then s.foody_hook_token end,
      'last_test_at', s.last_test_at, 'last_test_ok', s.last_test_ok, 'last_test_message', s.last_test_message),
    'ifood', jsonb_build_object('enabled', coalesce(s.ifood_enabled, false), 'connected', v_ifood.id is not null,
      'merchant_name', v_ifood.display_name));
end $$;

create or replace function public.logistics_save(p_unit_id uuid, p jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare u public.units; s public.logistics_settings; v_url text := nullif(trim(p->>'foody_base_url'), ''); v_secret text := nullif(trim(p->>'foody_client_secret'), '');
begin
  select * into u from public.units where id = p_unit_id;
  if not found or not private.can_manage(u.tenant_id) or not private.can_access_unit(u.id) then raise exception 'Sem permissão.' using errcode = '42501'; end if;
  insert into public.logistics_settings (unit_id, tenant_id) values (u.id, u.tenant_id) on conflict (unit_id) do nothing;
  select * into s from public.logistics_settings where unit_id = u.id for update;
  v_url := rtrim(v_url, '/');
  if v_url is not null and v_url !~ '^https://[A-Za-z0-9.-]+(:[0-9]{2,5})?(/[A-Za-z0-9._~/-]*)?$' then raise exception 'Endereço da API inválido: use o baseUrl que aparece na Foody (https://...).'; end if;
  if v_secret is not null and char_length(v_secret) > 500 then raise exception 'Client secret inválido.'; end if;
  update public.logistics_settings set
    foody_base_url = case when p ? 'foody_base_url' then v_url else foody_base_url end,
    foody_client_id = case when p ? 'foody_client_id' then left(nullif(trim(p->>'foody_client_id'), ''), 200) else foody_client_id end,
    foody_secret_id = case when v_secret is not null then private.vault_put(foody_secret_id, v_secret, 'foody_secret') else foody_secret_id end,
    foody_token_id = case when v_secret is not null or (p ? 'foody_client_id') then null else foody_token_id end,
    foody_enabled = coalesce((p->>'foody_enabled')::boolean, foody_enabled),
    ifood_enabled = coalesce((p->>'ifood_enabled')::boolean, ifood_enabled),
    return_to_merchant = coalesce((p->>'return_to_merchant')::boolean, return_to_merchant),
    updated_at = now()
  where unit_id = u.id returning * into s;
  if s.foody_enabled and (s.foody_base_url is null or s.foody_client_id is null or s.foody_secret_id is null) then
    raise exception 'Para ligar a Foody, informe o baseUrl, o clientId e o clientSecret da credencial Open Delivery.'; end if;
  if s.ifood_enabled and not exists (select 1 from public.marketplace_connections where unit_id = u.id and provider = 'ifood' and active and external_merchant_id is not null) then
    raise exception 'Conecte a loja ao iFood (Integrações › iFood) antes de ligar a Entrega iFood.'; end if;
end $$;

-- ---------- Edge Functions (só o servidor) ----------
create or replace function public.logistics_can(p_order_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.orders o where o.id = p_order_id and private.can_access_unit(o.unit_id)
    and private.has_role(o.tenant_id, array['owner','manager','cashier','attendant']::public.member_role[]));
$$;
create or replace function public.logistics_unit_can_manage(p_unit_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.units u where u.id = p_unit_id and private.can_manage(u.tenant_id) and private.can_access_unit(u.id));
$$;

create or replace function public.logistics_order_context(p_order_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare o public.orders; u public.units; s public.logistics_settings; c public.marketplace_connections; d public.external_deliveries;
begin
  perform private.assert_service_role();
  select * into o from public.orders where id = p_order_id;
  if not found then return null; end if;
  select * into u from public.units where id = o.unit_id;
  select * into s from public.logistics_settings where unit_id = u.id;
  select * into c from public.marketplace_connections where unit_id = u.id and provider = 'ifood' and active and external_merchant_id is not null limit 1;
  select * into d from public.external_deliveries where order_id = o.id and status not in ('rejected','cancelled','failed') limit 1;
  return jsonb_build_object(
    'order', jsonb_build_object('id', o.id, 'number', o.number, 'type', o.type, 'status', o.status, 'channel', o.channel, 'created_at', o.created_at,
      'customer_name', o.customer_name, 'customer_phone', o.customer_phone, 'address', o.address,
      'subtotal_cents', o.subtotal_cents, 'delivery_fee_cents', o.delivery_fee_cents, 'total_cents', o.total_cents,
      'payment_method', o.payment_method, 'payment_status', o.payment_status, 'change_for_cents', o.change_for_cents, 'notes', o.notes),
    'items', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'name', i.name, 'quantity', i.quantity, 'unit_price_cents', i.unit_price_cents,
        'total_cents', i.total_cents)) from public.order_items i where i.order_id = o.id), '[]'::jsonb),
    'unit', jsonb_build_object('id', u.id, 'name', u.name, 'street', u.street, 'number', u.number, 'complement', u.complement,
      'neighborhood', u.neighborhood, 'city', u.city, 'state', u.state, 'zip', u.zip, 'lat', u.lat, 'lng', u.lng, 'prep_time_min', u.prep_time_min, 'phone', u.phone),
    'return_to_merchant', coalesce(s.return_to_merchant, false),
    'foody', case when coalesce(s.foody_enabled, false) then jsonb_build_object('base_url', s.foody_base_url, 'client_id', s.foody_client_id,
      'client_secret', (select decrypted_secret from vault.decrypted_secrets where id = s.foody_secret_id),
      'token', (select decrypted_secret from vault.decrypted_secrets where id = s.foody_token_id)::jsonb) end,
    'ifood', case when coalesce(s.ifood_enabled, false) and c.id is not null then jsonb_build_object('connection_id', c.id, 'merchant_id', c.external_merchant_id) end,
    'active', case when d.id is null then null else jsonb_build_object('id', d.id, 'provider', d.provider, 'external_id', d.external_id, 'status', d.status) end);
end $$;

create or replace function public.logistics_foody_context(p_unit_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare s public.logistics_settings;
begin
  perform private.assert_service_role();
  select * into s from public.logistics_settings where unit_id = p_unit_id;
  if s.unit_id is null or s.foody_base_url is null or s.foody_client_id is null or s.foody_secret_id is null then return null; end if;
  return jsonb_build_object('base_url', s.foody_base_url, 'client_id', s.foody_client_id,
    'client_secret', (select decrypted_secret from vault.decrypted_secrets where id = s.foody_secret_id),
    'token', (select decrypted_secret from vault.decrypted_secrets where id = s.foody_token_id)::jsonb);
end $$;

create or replace function public.logistics_save_foody_token(p_unit_id uuid, p_token jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare s public.logistics_settings;
begin
  perform private.assert_service_role();
  select * into s from public.logistics_settings where unit_id = p_unit_id for update;
  if s.unit_id is null then return; end if;
  update public.logistics_settings set foody_token_id = private.vault_put(foody_token_id, p_token::text, 'foody_token') where unit_id = p_unit_id;
end $$;

create or replace function public.logistics_test_result(p_unit_id uuid, p_ok boolean, p_message text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.assert_service_role();
  update public.logistics_settings set last_test_at = now(), last_test_ok = p_ok, last_test_message = left(p_message, 300) where unit_id = p_unit_id;
end $$;

create or replace function public.logistics_hook_context(p_hook text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare s public.logistics_settings;
begin
  perform private.assert_service_role();
  if p_hook is null or p_hook !~ '^[0-9a-f]{48}$' then return null; end if;
  select * into s from public.logistics_settings where foody_hook_token = p_hook;
  if s.unit_id is null then return null; end if;
  return jsonb_build_object('unit_id', s.unit_id, 'client_secret', (select decrypted_secret from vault.decrypted_secrets where id = s.foody_secret_id));
end $$;

-- registra a solicitação aceita pelo parceiro
create or replace function public.logistics_record(p_order_id uuid, p_provider text, p_external_id text, p_status text,
  p_fee_cents int, p_eta timestamptz, p_tracking_url text, p_actor uuid, p_error text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare o public.orders; v uuid;
begin
  perform private.assert_service_role();
  select * into o from public.orders where id = p_order_id;
  if not found then raise exception 'Pedido não encontrado.'; end if;
  insert into public.external_deliveries (tenant_id, unit_id, order_id, provider, external_id, status, fee_cents, eta_at, tracking_url, requested_by, error,
    events)
  values (o.tenant_id, o.unit_id, o.id, p_provider, nullif(p_external_id, ''), coalesce(p_status, 'pending'), p_fee_cents, p_eta,
    left(p_tracking_url, 500), p_actor, left(p_error, 300),
    jsonb_build_array(jsonb_build_object('type', 'REQUESTED', 'at', now())))
  returning id into v;
  insert into public.order_events (tenant_id, order_id, from_status, to_status, note, actor_id)
  values (o.tenant_id, o.id, o.status, o.status, 'Entregador solicitado: ' || case p_provider when 'foody' then 'Foody Delivery' else 'Entrega iFood' end, p_actor);
  return v;
exception when unique_violation then raise exception 'Já existe um entregador solicitado para este pedido.';
end $$;

-- status de um evento do parceiro e reflexo no pedido
create or replace function private.logistics_map(p_provider text, p_code text)
returns text language sql immutable set search_path = '' as $$
  select case upper(coalesce(p_code, ''))
    when 'PENDING' then 'pending' when 'REQUEST_DRIVER' then 'pending'
    when 'ACCEPTED' then 'accepted' when 'REQUEST_DRIVER_SUCCESS' then 'accepted' when 'ASSIGN_DRIVER' then 'accepted' when 'ADR' then 'accepted'
    when 'PICKUP_ONGOING' then 'to_pickup' when 'GOING_TO_ORIGIN' then 'to_pickup' when 'GTO' then 'to_pickup'
    when 'ARRIVED_AT_MERCHANT' then 'at_merchant' when 'ARRIVED_AT_ORIGIN' then 'at_merchant' when 'AAO' then 'at_merchant'
    when 'ORDER_PICKED' then 'picked' when 'COLLECTED' then 'picked' when 'CLT' then 'picked'
    when 'DELIVERY_ONGOING' then 'in_transit' when 'DELIVERY_IN_TRANSIT' then 'in_transit' when 'DISPATCHED' then 'in_transit' when 'DSP' then 'in_transit'
    when 'ARRIVED_AT_CUSTOMER' then 'at_customer' when 'ARRIVED_AT_DESTINATION' then 'at_customer' when 'AAD' then 'at_customer'
    when 'ORDER_DELIVERED' then 'delivered' when 'DELIVERY_FINISHED' then 'delivered' when 'DELIVERY_CONCLUDED' then 'delivered' when 'CONCLUDED' then 'delivered' when 'CON' then 'delivered'
    when 'RETURNING_TO_MERCHANT' then 'returning' when 'RETURNED_TO_MERCHANT' then 'returning'
    when 'REJECTED' then 'rejected' when 'REQUEST_DRIVER_FAILED' then 'failed'
    when 'CANCELLATION_REQUESTED' then 'cancel_requested' when 'DELIVERY_CANCELLATION_REQUESTED' then 'cancel_requested'
    when 'CANCELLED' then 'cancelled' when 'DELIVERY_CANCELLED' then 'cancelled' when 'DELIVERY_CANCELLATION_REQUEST_ACCEPTED' then 'cancelled' when 'CAN' then 'cancelled'
    else null end;
$$;
create or replace function public.logistics_event(p_provider text, p_external_id text, p_code text, p_payload jsonb default '{}')
returns boolean language plpgsql security definer set search_path = '' as $$
declare d public.external_deliveries; v_new text := private.logistics_map(p_provider, p_code); o public.orders; v_order_new public.order_status;
  v_rank text[] := array['pending','accepted','to_pickup','at_merchant','picked','in_transit','at_customer','delivered','returning'];
  p jsonb := coalesce(p_payload, '{}'); v_courier jsonb; v_eta timestamptz; v_fee int;
begin
  perform private.assert_service_role();
  select * into d from public.external_deliveries where provider = p_provider and external_id = p_external_id for update;
  if not found then return false; end if;
  -- dados úteis do evento (Open Delivery e iFood)
  v_courier := nullif(jsonb_strip_nulls(jsonb_build_object(
    'name', coalesce(p#>>'{deliveryPerson,name}', p->>'workerName', p->>'driverName'),
    'phone', coalesce(p#>>'{deliveryPerson,phone}', p->>'workerPhone', p->>'driverPhone'),
    'vehicle', coalesce(p#>>'{vehicle,type}', p->>'vehicleType'))), '{}'::jsonb);
  begin v_eta := coalesce((p#>>'{eta,deliveryEtaDatetime}')::timestamptz, (p->>'expectedDelivery')::timestamptz); exception when others then v_eta := null; end;
  begin v_fee := round((p#>>'{deliveryPrice,price,value}')::numeric * 100)::int; exception when others then v_fee := null; end;
  update public.external_deliveries set
    status = case
      when v_new is null then status
      when status in ('cancelled','rejected','failed') then status                 -- terminal
      when status = 'delivered' and v_new <> 'returning' then status             -- entregue não volta atrás
      when v_new in ('cancelled','rejected','failed','cancel_requested') then v_new
      when array_position(v_rank, v_new) >= coalesce(array_position(v_rank, status), 0) then v_new
      else status end,
    courier = coalesce(courier, '{}'::jsonb) || coalesce(v_courier, '{}'::jsonb),
    eta_at = coalesce(v_eta, eta_at), fee_cents = coalesce(v_fee, fee_cents),
    tracking_url = coalesce(left(p->>'externalTrackingURL', 500), tracking_url),
    drop_code = coalesce(left(p->>'CODE', 10), drop_code),
    error = case when v_new in ('rejected','failed') then left(coalesce(p#>>'{event,rejectionInfo,reason}', p->>'message', p_code), 300) else error end,
    events = (events || jsonb_build_array(jsonb_build_object('type', upper(left(p_code, 60)), 'at', now(),
      'message', left(coalesce(p#>>'{event,message}', p->>'message'), 200))))
      - (case when jsonb_array_length(events) >= 60 then 0 else 999 end),
    updated_at = now()
  where id = d.id returning * into d;
  -- reflexo no pedido: coletado → saiu para entrega; entregue → concluído
  select * into o from public.orders where id = d.order_id for update;
  v_order_new := case
    when d.status in ('picked','in_transit','at_customer') and o.status in ('pending','preparing','ready') then 'dispatched'
    when d.status = 'delivered' and o.status in ('pending','preparing','ready','dispatched') then 'completed'
    else null end;
  if v_order_new is not null then
    update public.orders set status = v_order_new,
      dispatched_at = case when v_order_new = 'dispatched' then coalesce(dispatched_at, now()) else dispatched_at end,
      completed_at = case when v_order_new = 'completed' then coalesce(completed_at, now()) else completed_at end
    where id = o.id;
    insert into public.order_events (tenant_id, order_id, from_status, to_status, note)
    values (o.tenant_id, o.id, o.status, v_order_new, case d.provider when 'foody' then 'Foody Delivery' else 'Entrega iFood' end
      || case when v_order_new = 'dispatched' then ': entregador saiu com o pedido' else ': pedido entregue' end);
  end if;
  return true;
end $$;

grant execute on function public.logistics_overview(uuid), public.logistics_save(uuid, jsonb), public.logistics_can(uuid),
  public.logistics_unit_can_manage(uuid) to authenticated;
revoke execute on function public.logistics_overview(uuid), public.logistics_save(uuid, jsonb), public.logistics_can(uuid),
  public.logistics_unit_can_manage(uuid) from public, anon;
revoke execute on function public.logistics_order_context(uuid), public.logistics_foody_context(uuid), public.logistics_save_foody_token(uuid, jsonb),
  public.logistics_test_result(uuid, boolean, text), public.logistics_hook_context(text),
  public.logistics_record(uuid, text, text, text, int, timestamptz, text, uuid, text), public.logistics_event(text, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.logistics_order_context(uuid), public.logistics_foody_context(uuid), public.logistics_save_foody_token(uuid, jsonb),
  public.logistics_test_result(uuid, boolean, text), public.logistics_hook_context(text),
  public.logistics_record(uuid, text, text, text, int, timestamptz, text, uuid, text), public.logistics_event(text, text, text, jsonb)
  to service_role;
revoke execute on function private.logistics_map(text, text) from public, anon, authenticated;
