-- =====================================================================
-- Domma Food · 007 · Marketplaces via padrão Open Delivery (Abrasel) v1.7
-- 99Food, Keeta, aiqfome e qualquer outro aplicativo aderente.
-- Domma Food = "Software Service": expõe GET /merchant e recebe o webhook
-- /newEvent; chama a API do marketplace para buscar e atualizar pedidos.
-- Segredos (client_secret) ficam no Supabase Vault (criptografado).
-- =====================================================================
create extension if not exists pg_net;

alter type public.order_channel add value if not exists 'keeta';
alter type public.order_channel add value if not exists '99food';
alter type public.order_channel add value if not exists 'aiqfome';
alter type public.order_channel add value if not exists 'marketplace';

-- ---------- Conexões (uma por loja e por marketplace) ----------
create table public.marketplace_connections (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  unit_id uuid not null references public.units(id) on delete cascade,
  provider text not null check (provider in ('99food','keeta','aiqfome','other')),
  display_name text not null default '',
  -- Gerado pelo Domma Food (Software Service). Formato recomendado: documento + UUID
  merchant_id text not null unique default gen_random_uuid()::text,
  -- Fornecido pelo marketplace (Ordering Application)
  app_id text,
  client_id text,
  client_secret_id uuid,                 -- referência ao vault.secrets
  auth_base_url text check (auth_base_url is null or auth_base_url ~ '^https://'),
  api_base_url text check (api_base_url is null or api_base_url ~ '^https://'),
  -- Chave que o marketplace usa para ler GET /merchant (guardamos só o hash)
  merchant_api_key_hash text,
  polling_enabled boolean not null default true,
  auto_confirm boolean not null default false,
  active boolean not null default false,
  last_event_at timestamptz,
  last_sync_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (unit_id, provider)
);
create trigger marketplace_connections_touch before update on public.marketplace_connections
  for each row execute function private.touch_updated_at();

-- ---------- Pedidos externos ----------
alter table public.orders
  add column external_id text,
  add column external_display_id text,
  add column connection_id uuid references public.marketplace_connections(id) on delete set null,
  add column marketplace_cancel_requested boolean not null default false,
  add column external_flags jsonb;
create unique index orders_external_uq on public.orders(connection_id, external_id) where external_id is not null;

-- ---------- Log de eventos recebidos (idempotência) ----------
create table public.marketplace_events (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  connection_id uuid not null references public.marketplace_connections(id) on delete cascade,
  event_id text not null,
  event_type text not null,
  external_order_id text,
  payload jsonb not null,
  source text not null check (source in ('webhook','polling')),
  processed_at timestamptz,
  error text,
  created_at timestamptz not null default now(),
  unique (connection_id, event_id)
);
create index marketplace_events_conn_idx on public.marketplace_events(connection_id, created_at desc);

-- ---------- Fila de saída (atualizações para o marketplace, com retentativa) ----------
create table public.integration_outbox (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  connection_id uuid not null references public.marketplace_connections(id) on delete cascade,
  order_id uuid not null references public.orders(id) on delete cascade,
  action text not null check (action in ('confirm','preparing','readyForPickup','dispatch','pickedUp','delivered',
                                         'requestCancellation','acceptCancellation','denyCancellation')),
  payload jsonb not null default '{}',
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  done_at timestamptz,
  last_error text,
  created_at timestamptz not null default now()
);
create index integration_outbox_pending_idx on public.integration_outbox(next_attempt_at) where done_at is null;

-- ---------- RLS ----------
alter table public.marketplace_connections enable row level security;
alter table public.marketplace_connections force row level security;
alter table public.marketplace_events enable row level security;
alter table public.marketplace_events force row level security;
alter table public.integration_outbox enable row level security;
alter table public.integration_outbox force row level security;
revoke all on public.marketplace_connections, public.marketplace_events, public.integration_outbox from anon;
-- escrita das conexões só via RPC (o segredo nunca passa pelo PostgREST em texto puro de volta)
revoke insert, update, delete on public.marketplace_connections from authenticated;
revoke insert, update, delete on public.marketplace_events, public.integration_outbox from authenticated;

create policy mc_select on public.marketplace_connections for select to authenticated
  using (private.can_manage(tenant_id) and private.can_access_unit(unit_id));
create policy me_select on public.marketplace_events for select to authenticated
  using (private.can_manage(tenant_id));
create policy io_select on public.integration_outbox for select to authenticated
  using (private.can_manage(tenant_id));

create trigger marketplace_connections_audit after insert or update or delete on public.marketplace_connections
  for each row execute function private.audit_row();

-- ---------- Salvar conexão (dono/gerente) ----------
create or replace function public.save_marketplace_connection(
  p_unit_id uuid, p_provider text, p_display_name text, p_app_id text, p_client_id text,
  p_client_secret text, p_auth_base_url text, p_api_base_url text,
  p_polling boolean, p_auto_confirm boolean, p_active boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  u public.units; t public.tenants; c public.marketplace_connections; v_secret uuid; v_key text; v_doc text;
begin
  select * into u from public.units where id = p_unit_id;
  if not found or not private.can_manage(u.tenant_id) or not private.can_access_unit(u.id) then
    raise exception 'Sem permissão.' using errcode = '42501';
  end if;
  if p_provider not in ('99food','keeta','aiqfome','other') then raise exception 'Marketplace inválido.'; end if;
  select * into t from public.tenants where id = u.tenant_id;
  select * into c from public.marketplace_connections where unit_id = u.id and provider = p_provider;

  if coalesce(p_client_secret, '') <> '' then
    if c.client_secret_id is not null then
      perform vault.update_secret(c.client_secret_id, p_client_secret);
      v_secret := c.client_secret_id;
    else
      v_secret := vault.create_secret(p_client_secret, 'od_' || u.id || '_' || p_provider, 'Open Delivery client secret');
    end if;
  else
    v_secret := c.client_secret_id;
  end if;
  if p_active and (coalesce(p_client_id,'') = '' or v_secret is null or coalesce(p_api_base_url,'') = '') then
    raise exception 'Para ativar, informe Client ID, Client Secret e a URL da API do marketplace.';
  end if;

  if c.id is null then
    v_doc := coalesce(t.cnpj, '');
    v_key := encode(extensions.gen_random_bytes(24), 'hex');
    insert into public.marketplace_connections (tenant_id, unit_id, provider, display_name, merchant_id, app_id, client_id,
        client_secret_id, auth_base_url, api_base_url, merchant_api_key_hash, polling_enabled, auto_confirm, active)
    values (u.tenant_id, u.id, p_provider, coalesce(p_display_name,''),
        case when v_doc <> '' then v_doc || '-' || gen_random_uuid() else gen_random_uuid()::text end,
        nullif(trim(p_app_id),''), nullif(trim(p_client_id),''), v_secret,
        nullif(rtrim(trim(p_auth_base_url),'/'),''), nullif(rtrim(trim(p_api_base_url),'/'),''),
        encode(extensions.digest(v_key, 'sha256'), 'hex'), p_polling, p_auto_confirm, p_active)
    returning * into c;
    return jsonb_build_object('id', c.id, 'merchant_id', c.merchant_id, 'api_key', v_key);
  end if;

  update public.marketplace_connections set
    display_name = coalesce(p_display_name, display_name), app_id = nullif(trim(p_app_id),''),
    client_id = nullif(trim(p_client_id),''), client_secret_id = v_secret,
    auth_base_url = nullif(rtrim(trim(p_auth_base_url),'/'),''), api_base_url = nullif(rtrim(trim(p_api_base_url),'/'),''),
    polling_enabled = p_polling, auto_confirm = p_auto_confirm, active = p_active, last_error = null
  where id = c.id;
  return jsonb_build_object('id', c.id, 'merchant_id', c.merchant_id);
end $$;

create or replace function public.rotate_marketplace_api_key(p_connection_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare c public.marketplace_connections; v_key text := encode(extensions.gen_random_bytes(24), 'hex');
begin
  select * into c from public.marketplace_connections where id = p_connection_id;
  if not found or not private.can_manage(c.tenant_id) then raise exception 'Sem permissão.' using errcode = '42501'; end if;
  update public.marketplace_connections set merchant_api_key_hash = encode(extensions.digest(v_key, 'sha256'), 'hex') where id = c.id;
  return v_key;
end $$;

create or replace function public.delete_marketplace_connection(p_connection_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare c public.marketplace_connections;
begin
  select * into c from public.marketplace_connections where id = p_connection_id;
  if not found or not private.can_manage(c.tenant_id) then raise exception 'Sem permissão.' using errcode = '42501'; end if;
  if c.client_secret_id is not null then delete from vault.secrets where id = c.client_secret_id; end if;
  delete from public.marketplace_connections where id = c.id;
end $$;

-- ---------- Uso exclusivo do servidor (Edge Function com service_role) ----------
create or replace function public.od_connection_secret(p_connection_id uuid)
returns text language sql stable security definer set search_path = '' as $$
  select ds.decrypted_secret from public.marketplace_connections c
  join vault.decrypted_secrets ds on ds.id = c.client_secret_id
  where c.id = p_connection_id;
$$;

-- Cria/atualiza o pedido vindo do marketplace (formato Order do Open Delivery)
create or replace function public.od_ingest_order(p_connection_id uuid, o jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  c public.marketplace_connections; u public.units; v_order uuid; v_number int; v_customer uuid;
  v_phone text; v_name text; v_type public.order_type; v_pm public.payment_method := 'online_card';
  v_paid boolean; v_pending numeric; it jsonb; m jsonb; v_channel public.order_channel; v_fee int := 0; v_total int;
  v_status public.order_status;
begin
  select * into c from public.marketplace_connections where id = p_connection_id;
  select * into u from public.units where id = c.unit_id;
  select id into v_order from public.orders where connection_id = c.id and external_id = o->>'id';
  if v_order is not null then return v_order; end if;

  v_channel := case c.provider when 'keeta' then 'keeta'::public.order_channel
                               when '99food' then '99food'::public.order_channel
                               when 'aiqfome' then 'aiqfome'::public.order_channel else 'marketplace'::public.order_channel end;
  v_type := case o->>'type' when 'DELIVERY' then 'delivery'::public.order_type
                            when 'INDOOR' then 'dine_in'::public.order_type else 'pickup'::public.order_type end;
  v_phone := left(private.only_digits(o->'customer'->'phone'->>'number'), 13);
  v_name := left(coalesce(nullif(trim(o->'customer'->>'name'), ''), 'Cliente ' || c.provider), 120);
  v_pending := coalesce((o->'payments'->>'pending')::numeric, 0);
  v_paid := v_pending = 0;
  if not v_paid then
    select m2 into m from jsonb_array_elements(coalesce(o->'payments'->'methods','[]'::jsonb)) m2
     where m2->>'type' = 'PENDING' limit 1;
    v_pm := case m->>'method' when 'CASH' then 'cash'::public.payment_method when 'PIX' then 'pix'::public.payment_method
              when 'MEAL_VOUCHER' then 'voucher'::public.payment_method when 'FOOD_VOUCHER' then 'voucher'::public.payment_method
              else 'card_on_delivery'::public.payment_method end;
  end if;
  select coalesce(sum(round((f->'price'->>'value')::numeric * 100)), 0)::int into v_fee
    from jsonb_array_elements(coalesce(o->'otherFees','[]'::jsonb)) f where f->>'type' = 'DELIVERY_FEE';
  v_total := round((o->'total'->'orderAmount'->>'value')::numeric * 100)::int;
  v_status := case when c.auto_confirm then 'preparing'::public.order_status else 'pending'::public.order_status end;

  if length(v_phone) >= 10 then
    insert into public.customers (tenant_id, name, phone) values (c.tenant_id, v_name, v_phone)
    on conflict (tenant_id, phone) do update set name = excluded.name returning id into v_customer;
  end if;

  update public.units set order_counter = order_counter + 1 where id = u.id returning order_counter into v_number;

  insert into public.orders (tenant_id, unit_id, number, channel, type, status, customer_id, customer_name, customer_phone,
     address, scheduled_for, subtotal_cents, discount_cents, delivery_fee_cents, total_cents, payment_method, payment_status,
     change_for_cents, notes, accepted_at, estimated_ready_at, paid_at,
     external_id, external_display_id, connection_id, external_flags)
  values (c.tenant_id, u.id, v_number, v_channel, v_type, v_status, v_customer, v_name, coalesce(nullif(v_phone,''), '00000000000'),
     case when o ? 'delivery' then jsonb_build_object(
        'street', o->'delivery'->'deliveryAddress'->>'street', 'number', o->'delivery'->'deliveryAddress'->>'number',
        'complement', o->'delivery'->'deliveryAddress'->>'complement', 'neighborhood', o->'delivery'->'deliveryAddress'->>'district',
        'city', o->'delivery'->'deliveryAddress'->>'city', 'reference', o->'delivery'->'deliveryAddress'->>'reference',
        'lat', (o->'delivery'->'deliveryAddress'->'coordinates'->>'latitude')::float8,
        'lng', (o->'delivery'->'deliveryAddress'->'coordinates'->>'longitude')::float8,
        'delivered_by', o->'delivery'->>'deliveredBy', 'pickup_code', o->'delivery'->>'pickupCode') end,
     (o->'schedule'->>'scheduledDateTimeStart')::timestamptz,
     round((o->'total'->'itemsPrice'->>'value')::numeric * 100)::int,
     round(coalesce((o->'total'->'discount'->>'value')::numeric, 0) * 100)::int,
     v_fee, v_total, v_pm, case when v_paid then 'paid'::public.payment_status else 'pending'::public.payment_status end,
     case when v_pm = 'cash' then round((m->>'changeFor')::numeric * 100)::int end,
     left(o->>'extraInfo', 500),
     case when v_status = 'preparing' then now() end,
     coalesce((o->'delivery'->>'estimatedDeliveryDateTime')::timestamptz, (o->'takeout'->>'takeoutDateTime')::timestamptz),
     case when v_paid then now() end,
     o->>'id', o->>'displayId', c.id,
     jsonb_build_object('sendPreparing', coalesce((o->>'sendPreparing')::boolean, false),
                        'sendDelivered', coalesce((o->>'sendDelivered')::boolean, false),
                        'sendPickedUp', coalesce((o->>'sendPickedUp')::boolean, false),
                        'deliveredBy', o->'delivery'->>'deliveredBy'))
  returning id into v_order;

  for it in select * from jsonb_array_elements(coalesce(o->'items','[]'::jsonb)) loop
    insert into public.order_items (tenant_id, order_id, product_id, name, quantity, unit_price_cents, total_cents, options, notes)
    values (c.tenant_id, v_order,
      (select p.id from public.products p where p.tenant_id = c.tenant_id and p.id::text = it->>'externalCode'),
      left(it->>'name', 200), greatest(1, least(99, round((it->>'quantity')::numeric)::int)),
      round((it->'unitPrice'->>'value')::numeric * 100)::int, round((it->'totalPrice'->>'value')::numeric * 100)::int,
      coalesce((select jsonb_agg(jsonb_build_object('name', op->>'name', 'quantity', (op->>'quantity')::numeric,
                 'price_cents', round((op->'unitPrice'->>'value')::numeric * 100)::int))
                from jsonb_array_elements(coalesce(it->'options','[]'::jsonb)) op), '[]'::jsonb),
      left(it->>'specialInstructions', 300));
  end loop;

  insert into public.payments (tenant_id, order_id, method, gateway, amount_cents, status)
  values (c.tenant_id, v_order, v_pm, c.provider, v_total, case when v_paid then 'paid'::public.payment_status else 'pending'::public.payment_status end);
  insert into public.order_events (tenant_id, order_id, from_status, to_status, note)
  values (c.tenant_id, v_order, null, v_status, 'Pedido recebido de ' || c.provider || ' #' || coalesce(o->>'displayId', o->>'id'));
  if v_status = 'preparing' then
    insert into public.integration_outbox (tenant_id, connection_id, order_id, action, payload)
    values (c.tenant_id, c.id, v_order, 'confirm', jsonb_build_object('orderExternalCode', v_number::text, 'createdAt', now()));
  end if;
  update public.marketplace_connections set last_event_at = now(), last_error = null where id = c.id;
  return v_order;
end $$;

-- Aplica eventos do marketplace a um pedido já existente
create or replace function public.od_apply_event(p_connection_id uuid, p_external_id text, p_event text)
returns void language plpgsql security definer set search_path = '' as $$
declare o public.orders;
begin
  select * into o from public.orders where connection_id = p_connection_id and external_id = p_external_id for update;
  if not found then return; end if;
  if p_event = 'CANCELLED' and o.status not in ('cancelled','completed') then
    update public.orders set status = 'cancelled', cancelled_at = now(), cancel_reason = 'Cancelado pelo marketplace',
           marketplace_cancel_requested = false where id = o.id;
    insert into public.order_events (tenant_id, order_id, from_status, to_status, note)
    values (o.tenant_id, o.id, o.status, 'cancelled', 'Cancelado pelo marketplace');
  elsif p_event = 'ORDER_CANCELLATION_REQUEST' and o.status not in ('cancelled','completed') then
    update public.orders set marketplace_cancel_requested = true where id = o.id;
  elsif p_event in ('CONCLUDED','DELIVERED','PICKED_UP') and o.status not in ('cancelled','completed') then
    update public.orders set status = 'completed', completed_at = now(),
           payment_status = 'paid', paid_at = coalesce(paid_at, now()) where id = o.id;
    insert into public.order_events (tenant_id, order_id, from_status, to_status, note)
    values (o.tenant_id, o.id, o.status, 'completed', 'Concluído no marketplace');
  elsif p_event = 'DISPATCHED' and o.status in ('ready','preparing') and o.type = 'delivery' then
    update public.orders set status = 'dispatched', dispatched_at = now() where id = o.id;
    insert into public.order_events (tenant_id, order_id, from_status, to_status, note)
    values (o.tenant_id, o.id, o.status, 'dispatched', 'Entregador do marketplace saiu com o pedido');
  end if;
end $$;

-- ---------- Status do Domma Food -> ação no marketplace (fila) ----------
create or replace function private.enqueue_marketplace_update()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_action text; v_payload jsonb := '{}';
begin
  if new.connection_id is null or new.status = old.status then return new; end if;
  if new.status = 'cancelled' and old.marketplace_cancel_requested then return new; end if; -- tratado pela RPC de resposta
  if new.cancel_reason = 'Cancelado pelo marketplace' then return new; end if;
  v_action := case
    when old.status = 'pending' and new.status = 'preparing' then 'confirm'
    when new.status = 'ready' then 'readyForPickup'
    when new.status = 'dispatched' and coalesce(new.external_flags->>'deliveredBy','MERCHANT') = 'MERCHANT' then 'dispatch'
    when new.status = 'completed' and new.type = 'delivery' and (new.external_flags->>'sendDelivered')::boolean then 'delivered'
    when new.status = 'completed' and new.type <> 'delivery' and (new.external_flags->>'sendPickedUp')::boolean then 'pickedUp'
    when new.status = 'cancelled' then 'requestCancellation'
  end;
  if v_action is null then return new; end if;
  if v_action = 'confirm' then
    v_payload := jsonb_build_object('orderExternalCode', new.number::text, 'createdAt', now());
  elsif v_action = 'requestCancellation' then
    v_payload := jsonb_build_object('reason', coalesce(new.cancel_reason, 'Cancelado pela loja'),
                                    'code', 'INTERNAL_DIFFICULTIES_OF_THE_RESTAURANT', 'mode', 'MANUAL');
  end if;
  insert into public.integration_outbox (tenant_id, connection_id, order_id, action, payload)
  values (new.tenant_id, new.connection_id, new.id, v_action, v_payload);
  if v_action = 'confirm' and (new.external_flags->>'sendPreparing')::boolean then
    insert into public.integration_outbox (tenant_id, connection_id, order_id, action) values (new.tenant_id, new.connection_id, new.id, 'preparing');
  end if;
  perform private.kick_od_worker();
  return new;
end $$;

-- Acorda a Edge Function na hora (assíncrono via pg_net); o cron é a rede de segurança.
create or replace function private.kick_od_worker()
returns void language plpgsql security definer set search_path = '' as $$
declare v_url text; v_secret text;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'od_worker_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'od_worker_secret';
  if v_url is null or v_secret is null then return; end if;
  perform net.http_post(url := v_url, body := '{"job":"outbox"}'::jsonb,
                        headers := jsonb_build_object('Content-Type','application/json','x-worker-secret', v_secret),
                        timeout_milliseconds := 5000);
exception when others then
  null; -- nunca bloquear a operação da loja por causa da integração
end $$;

create trigger orders_marketplace_sync after update of status on public.orders
  for each row execute function private.enqueue_marketplace_update();

-- Resposta da loja a um pedido de cancelamento vindo do marketplace
create or replace function public.respond_marketplace_cancellation(p_order_id uuid, p_accept boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare o public.orders;
begin
  select * into o from public.orders where id = p_order_id for update;
  if not found or not private.can_access_unit(o.unit_id)
     or not private.has_role(o.tenant_id, array['owner','manager','cashier','attendant']::public.member_role[]) then
    raise exception 'Sem permissão.' using errcode = '42501';
  end if;
  if not o.marketplace_cancel_requested then raise exception 'Não há pedido de cancelamento pendente.'; end if;
  if p_accept then
    update public.orders set status = 'cancelled', cancelled_at = now(), cancel_reason = 'Cancelamento solicitado pelo marketplace',
           marketplace_cancel_requested = false where id = o.id;
    insert into public.order_events (tenant_id, order_id, from_status, to_status, note, actor_id)
    values (o.tenant_id, o.id, o.status, 'cancelled', 'Cancelamento do marketplace aceito', auth.uid());
    insert into public.integration_outbox (tenant_id, connection_id, order_id, action) values (o.tenant_id, o.connection_id, o.id, 'acceptCancellation');
  else
    update public.orders set marketplace_cancel_requested = false where id = o.id;
    insert into public.integration_outbox (tenant_id, connection_id, order_id, action, payload)
    values (o.tenant_id, o.connection_id, o.id, 'denyCancellation',
            jsonb_build_object('reason', 'O pedido já está em preparo', 'code', 'DISH_ALREADY_DONE'));
  end if;
  perform private.kick_od_worker();
end $$;

-- ---------- Permissões ----------
revoke execute on function public.od_connection_secret(uuid), public.od_ingest_order(uuid, jsonb),
  public.od_apply_event(uuid, text, text) from public, anon, authenticated;
grant execute on function public.od_connection_secret(uuid), public.od_ingest_order(uuid, jsonb),
  public.od_apply_event(uuid, text, text) to service_role;
revoke execute on function public.save_marketplace_connection(uuid, text, text, text, text, text, text, text, boolean, boolean, boolean),
  public.rotate_marketplace_api_key(uuid), public.delete_marketplace_connection(uuid),
  public.respond_marketplace_cancellation(uuid, boolean) from public, anon;
grant execute on function public.save_marketplace_connection(uuid, text, text, text, text, text, text, text, boolean, boolean, boolean),
  public.rotate_marketplace_api_key(uuid), public.delete_marketplace_connection(uuid),
  public.respond_marketplace_cancellation(uuid, boolean) to authenticated;
revoke execute on function private.kick_od_worker(), private.enqueue_marketplace_update() from authenticated;
grant select, insert, update on public.marketplace_events, public.integration_outbox to service_role;
grant select, update on public.marketplace_connections to service_role;
