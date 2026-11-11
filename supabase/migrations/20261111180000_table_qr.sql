-- =====================================================================
-- Domma Food · 021 · QR Code na mesa: o cliente abre o cardápio pela
-- mesa, pede direto na comanda, chama o garçom e pede a conta.
-- =====================================================================
alter table public.units
  add column table_qr_enabled boolean not null default true,
  add column table_qr_auto_accept boolean not null default false;
alter table public.dining_tables
  add column qr_token text not null default encode(extensions.gen_random_bytes(12), 'hex');
create unique index dining_tables_qr_token_key on public.dining_tables(qr_token);
alter table public.tabs
  add column waiter_called_at timestamptz,
  add column opened_via text not null default 'staff' check (opened_via in ('staff','qr'));
alter table public.orders add column via_qr boolean not null default false;
create index orders_table_qr_idx on public.orders(tab_id, created_at) where via_qr;
-- o token não é editável pela API; só por função
revoke insert, update on public.dining_tables from authenticated;
grant insert (tenant_id, unit_id, name, area, seats, position, active) on public.dining_tables to authenticated;
grant update (name, area, seats, position, active) on public.dining_tables to authenticated;

-- mesa a partir do token do QR (somente mesas ativas)
create or replace function private.table_by_token(p_token text)
returns public.dining_tables language sql stable security definer set search_path = '' as $$
  select * from public.dining_tables where qr_token = p_token and active and p_token ~ '^[0-9a-f]{24}$';
$$;

create or replace function private.table_tab_json(p_tab uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'opened_at', t.opened_at, 'bill_requested_at', t.bill_requested_at, 'waiter_called_at', t.waiter_called_at,
    'service_fee_pct', t.service_fee_pct,
    'subtotal_cents', coalesce((select sum(o.subtotal_cents) from public.orders o where o.tab_id = t.id and o.status <> 'cancelled'), 0),
    'orders', coalesce((select jsonb_agg(jsonb_build_object('number', o.number, 'status', o.status, 'created_at', o.created_at, 'via_qr', o.via_qr,
        'subtotal_cents', o.subtotal_cents,
        'items', (select coalesce(jsonb_agg(jsonb_build_object('name', i.name, 'quantity', i.quantity, 'total_cents', i.total_cents,
                    'options', i.options, 'notes', i.notes) order by i.id), '[]'::jsonb) from public.order_items i where i.order_id = o.id))
        order by o.created_at) from public.orders o where o.tab_id = t.id), '[]'::jsonb))
  from public.tabs t where t.id = p_tab;
$$;

create or replace function public.table_info(p_token text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare d public.dining_tables; u public.units; v_tab uuid;
begin
  d := private.table_by_token(p_token);
  if d.id is null then return null; end if;
  select * into u from public.units where id = d.unit_id;
  select id into v_tab from public.tabs where table_id = d.id and status = 'open' order by opened_at limit 1;
  return jsonb_build_object('slug', u.slug, 'unit_name', u.name, 'table', d.name, 'area', d.area,
    'enabled', u.table_qr_enabled, 'is_open', private.unit_is_open_at(u, now()),
    'auto_accept', u.table_qr_auto_accept, 'service_fee_pct', u.service_fee_pct,
    'tab', case when v_tab is null then null else private.table_tab_json(v_tab) end);
end $$;

create or replace function public.table_order(p_token text, p_items jsonb, p_name text default null, p_notes text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare d public.dining_tables; u public.units; t public.tabs; q jsonb; v_order uuid; v_n int; v_status public.order_status;
  v_name text := left(nullif(trim(p_name), ''), 60);
begin
  d := private.table_by_token(p_token);
  if d.id is null then raise exception 'QR Code inválido. Peça ajuda ao garçom.'; end if;
  select * into u from public.units where id = d.unit_id;
  if not u.table_qr_enabled then raise exception 'Os pedidos pelo QR Code estão desativados. Chame o garçom.'; end if;
  if not private.unit_is_open_at(u, now()) then raise exception 'A loja não está recebendo pedidos agora.'; end if;
  perform 1 from public.dining_tables where id = d.id for update;  -- serializa pedidos da mesma mesa
  select * into t from public.tabs where table_id = d.id and status = 'open' order by opened_at limit 1 for update;
  -- antiabuso: limites por mesa
  if t.id is not null then
    if (select count(*) from public.orders where tab_id = t.id and via_qr and status = 'pending') >= 3 then
      raise exception 'Aguarde a equipe confirmar os pedidos anteriores.'; end if;
    if (select count(*) from public.orders where tab_id = t.id and via_qr and created_at > now() - interval '10 minutes') >= 8 then
      raise exception 'Muitos pedidos em pouco tempo. Chame o garçom.'; end if;
  end if;
  q := private.price_items(u.id, p_items, 'table');
  if (q->>'subtotal_cents')::int > 500000 then raise exception 'Pedido acima do limite do QR Code. Chame o garçom.'; end if;
  if t.id is null then
    insert into public.tabs (tenant_id, unit_id, table_id, label, people, customer_name, service_fee_pct, opened_via)
    values (u.tenant_id, u.id, d.id, '', 1, v_name, u.service_fee_pct, 'qr') returning * into t;
  end if;
  v_status := case when u.table_qr_auto_accept then 'preparing' else 'pending' end;
  update public.units set order_counter = order_counter + 1 where id = u.id returning order_counter into v_n;
  insert into public.orders (tenant_id, unit_id, number, channel, type, status, customer_name, customer_phone,
    subtotal_cents, total_cents, payment_method, payment_status, notes, accepted_at, tab_id, via_qr)
  values (u.tenant_id, u.id, v_n, 'table', 'dine_in', v_status,
    'Mesa ' || d.name || coalesce(' · ' || v_name, ''), '00000000000',
    (q->>'subtotal_cents')::int, (q->>'subtotal_cents')::int, 'cash', 'pending', left(nullif(trim(p_notes), ''), 500),
    case when v_status = 'preparing' then now() end, t.id, true)
  returning id into v_order;
  perform private.insert_items(u.tenant_id, v_order, q->'items');
  insert into public.order_events (tenant_id, order_id, to_status, note) values (u.tenant_id, v_order, v_status, 'Pedido pelo QR Code da mesa');
  perform private.tab_recalc(t.id);
  update public.tabs set bill_requested_at = null where id = t.id;
  return jsonb_build_object('number', v_n, 'status', v_status, 'subtotal_cents', (q->>'subtotal_cents')::int);
end $$;

create or replace function public.table_call(p_token text, p_kind text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare d public.dining_tables; u public.units; t public.tabs;
begin
  d := private.table_by_token(p_token);
  if d.id is null then raise exception 'QR Code inválido.'; end if;
  select * into u from public.units where id = d.unit_id;
  if not u.table_qr_enabled then raise exception 'Chame o garçom pessoalmente.'; end if;
  select * into t from public.tabs where table_id = d.id and status = 'open' order by opened_at limit 1 for update;
  if p_kind = 'waiter' then
    if t.id is null then
      insert into public.tabs (tenant_id, unit_id, table_id, label, people, service_fee_pct, opened_via, waiter_called_at)
      values (u.tenant_id, u.id, d.id, '', 1, u.service_fee_pct, 'qr', now());
    elsif t.waiter_called_at is null or t.waiter_called_at < now() - interval '1 minute' then
      update public.tabs set waiter_called_at = now() where id = t.id;
    end if;
  elsif p_kind = 'bill' then
    if t.id is null or not exists (select 1 from public.orders where tab_id = t.id and status <> 'cancelled') then
      raise exception 'Ainda não há consumo nesta mesa.'; end if;
    update public.tabs set bill_requested_at = coalesce(bill_requested_at, now()) where id = t.id;
  else raise exception 'Ação inválida.'; end if;
  return jsonb_build_object('ok', true);
end $$;

-- equipe: atender chamado, gerar novo QR
create or replace function public.tab_ack_call(p_tab_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare t public.tabs;
begin
  select * into t from public.tabs where id = p_tab_id;
  if not found or not private.can_serve(t.unit_id) then raise exception 'Sem permissão.' using errcode = '42501'; end if;
  update public.tabs set waiter_called_at = null where id = t.id;
end $$;

create or replace function public.table_qr_rotate(p_table_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare d public.dining_tables; v text;
begin
  select * into d from public.dining_tables where id = p_table_id for update;
  if not found or not private.can_manage(d.tenant_id) or not private.can_access_unit(d.unit_id) then
    raise exception 'Sem permissão.' using errcode = '42501'; end if;
  v := encode(extensions.gen_random_bytes(12), 'hex');
  update public.dining_tables set qr_token = v where id = d.id;
  return v;
end $$;

grant execute on function public.table_info(text), public.table_order(text, jsonb, text, text), public.table_call(text, text) to anon, authenticated;
grant execute on function public.tab_ack_call(uuid), public.table_qr_rotate(uuid) to authenticated;

-- a conta não fecha com pedido do QR esperando aceite
create or replace function private.tab_close_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.orders where tab_id = new.id and status = 'pending') then
    raise exception 'Há pedido do QR Code aguardando aceite nesta mesa. Aceite ou cancele antes de fechar a conta.';
  end if;
  new.waiter_called_at := null;
  return new;
end $$;
create trigger tabs_close_guard before update of status on public.tabs
  for each row when (new.status = 'closed' and old.status = 'open') execute function private.tab_close_guard();
