-- =====================================================================
-- Domma Food · 028 · Entregadores e rotas: cadastro, despacho em rota,
-- app do entregador por link (sem login) e acerto do dia
-- =====================================================================
create table public.couriers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  unit_id uuid not null references public.units(id) on delete cascade,
  name text not null check (char_length(name) between 2 and 80),
  phone text check (phone is null or phone ~ '^[0-9]{10,13}$'),
  vehicle text not null default 'moto' check (vehicle in ('moto','bike','carro','a_pe')),
  pix_key text check (pix_key is null or char_length(pix_key) <= 120),
  fee_mode text not null default 'fixed' check (fee_mode in ('fixed','delivery_fee','percent')),
  fee_value integer not null default 500 check (fee_value between 0 and 100000), -- centavos (fixo) ou % x100 (percentual)
  access_token text not null default encode(extensions.gen_random_bytes(16), 'hex'),
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index couriers_token_key on public.couriers(access_token);
create index couriers_unit_idx on public.couriers(unit_id) where active;

create table public.courier_settlements (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  unit_id uuid not null references public.units(id) on delete cascade,
  courier_id uuid not null references public.couriers(id) on delete cascade,
  deliveries integer not null,
  fees_cents integer not null,
  cash_expected_cents integer not null,
  cash_received_cents integer not null,
  difference_cents integer not null,
  paid_from_cash boolean not null default false,
  note text,
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.deliveries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  unit_id uuid not null references public.units(id) on delete cascade,
  order_id uuid not null references public.orders(id) on delete cascade,
  courier_id uuid not null references public.couriers(id) on delete restrict,
  batch_id uuid not null,
  seq integer not null default 1,
  status text not null default 'assigned' check (status in ('assigned','picked_up','delivered','returned','cancelled')),
  fee_cents integer not null default 0 check (fee_cents >= 0),
  collect_cents integer not null default 0,          -- valor a receber do cliente na entrega
  collect_method text,                               -- forma prevista (dinheiro, cartão na entrega, vale)
  collected_method text,                             -- forma que o cliente usou de fato
  change_for_cents integer,
  fail_reason text,
  assigned_at timestamptz not null default now(),
  picked_up_at timestamptz, delivered_at timestamptz,
  settlement_id uuid references public.courier_settlements(id) on delete set null,
  created_by uuid default auth.uid() references auth.users(id) on delete set null
);
create unique index deliveries_one_active on public.deliveries(order_id) where status in ('assigned','picked_up','delivered');
create index deliveries_courier_idx on public.deliveries(courier_id, status);
create index deliveries_unit_idx on public.deliveries(unit_id, assigned_at desc);

do $$ declare t text; begin
  foreach t in array array['couriers','courier_settlements','deliveries'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
  end loop;
end $$;
create policy co_select on public.couriers for select to authenticated
  using (private.can_access_unit(unit_id) and private.has_role(tenant_id, array['owner','manager','cashier','attendant']::public.member_role[]));
create policy cs_select on public.courier_settlements for select to authenticated
  using (private.can_access_unit(unit_id) and private.has_role(tenant_id, array['owner','manager','cashier']::public.member_role[]));
create policy dl_select on public.deliveries for select to authenticated
  using (private.can_access_unit(unit_id) and private.has_role(tenant_id, array['owner','manager','cashier','attendant']::public.member_role[]));
create trigger couriers_audit after insert or update or delete on public.couriers for each row execute function private.audit_row();
-- o link do entregador funciona como senha: só a gerência lê, por função
revoke select on public.couriers from authenticated;
grant select (id, tenant_id, unit_id, name, phone, vehicle, pix_key, fee_mode, fee_value, active, created_at) on public.couriers to authenticated;
alter publication supabase_realtime add table public.deliveries;

alter table public.cash_moves drop constraint cash_moves_kind_check;
alter table public.cash_moves add constraint cash_moves_kind_check check (kind in ('sale','supply','withdrawal','credit_payment','courier_cash'));
-- dinheiro trazido pelo entregador entra no dinheiro esperado do caixa
do $$ declare d text; begin
  d := pg_get_functiondef('private.cash_expected(uuid)'::regprocedure);
  if position($x$m.kind in ('sale','supply','credit_payment')$x$ in d) = 0 then raise exception 'cash_expected mudou'; end if;
  execute replace(replace(d, $x$m.kind in ('sale','supply','credit_payment')$x$, $x$m.kind in ('sale','supply','credit_payment','courier_cash')$x$),
    $x$'supply', coalesce(sum(m.amount_cents) filter (where m.kind = 'supply'), 0),$x$,
    $x$'supply', coalesce(sum(m.amount_cents) filter (where m.kind = 'supply'), 0),
    'courier_cash', coalesce(sum(m.amount_cents) filter (where m.kind = 'courier_cash'), 0),$x$);
end $$;

-- ---------- Mudança de status pelo sistema (entregador sem login) ----------
create or replace function private.order_status_system(p_order uuid, p_status public.order_status, p_note text)
returns void language plpgsql security definer set search_path = '' as $$
declare o public.orders;
begin
  select * into o from public.orders where id = p_order for update;
  if o.status = p_status then return; end if;
  update public.orders set status = p_status,
    ready_at = case when p_status = 'ready' then coalesce(ready_at, now()) else ready_at end,
    dispatched_at = case when p_status = 'dispatched' then now() when p_status = 'ready' then null else dispatched_at end,
    completed_at = case when p_status = 'completed' then now() else completed_at end,
    payment_status = case when p_status = 'completed' and payment_method in ('cash','card_on_delivery','voucher')
                          then 'paid'::public.payment_status else payment_status end,
    paid_at = case when p_status = 'completed' and payment_status = 'pending' and payment_method in ('cash','card_on_delivery','voucher') then now() else paid_at end
  where id = o.id;
  insert into public.order_events (tenant_id, order_id, from_status, to_status, note) values (o.tenant_id, o.id, o.status, p_status, left(p_note, 300));
  if p_status = 'completed' then
    update public.payments set status = 'paid' where order_id = o.id and status = 'pending' and method in ('cash','card_on_delivery','voucher');
    update public.customers set orders_count = orders_count + 1, total_spent_cents = total_spent_cents + o.total_cents,
      first_order_at = coalesce(first_order_at, o.created_at), last_order_at = o.created_at where id = o.customer_id;
  end if;
end $$;

-- taxa do entregador para um pedido
create or replace function private.courier_fee(c public.couriers, o public.orders)
returns integer language sql immutable as $$
  select case c.fee_mode when 'fixed' then c.fee_value when 'delivery_fee' then o.delivery_fee_cents
    else round(o.delivery_fee_cents * c.fee_value / 10000.0)::int end;
$$;

-- ---------- Despacho ----------
create or replace function public.courier_assign(p_order_ids uuid[], p_courier_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare c public.couriers; u public.units; o public.orders; v_batch uuid := gen_random_uuid(); v_lat float8; v_lng float8;
  v_left uuid[]; v_next uuid; v_seq int := 0; d public.deliveries;
begin
  select * into c from public.couriers where id = p_courier_id;
  if not found or not c.active then raise exception 'Entregador inválido.'; end if;
  if not private.can_access_unit(c.unit_id) or not private.has_role(c.tenant_id, array['owner','manager','cashier','attendant']::public.member_role[]) then
    raise exception 'Sem permissão.' using errcode = '42501'; end if;
  if coalesce(array_length(p_order_ids, 1), 0) = 0 or array_length(p_order_ids, 1) > 15 then raise exception 'Escolha de 1 a 15 pedidos.'; end if;
  select * into u from public.units where id = c.unit_id;
  for o in select * from public.orders where id = any (p_order_ids) for update loop
    if o.unit_id <> c.unit_id or o.type <> 'delivery' then raise exception 'O pedido #% não é uma entrega desta loja.', o.number; end if;
    if o.status not in ('preparing','ready') then raise exception 'O pedido #% precisa estar aceito (em preparo ou pronto) para despachar.', o.number; end if;
    select * into d from public.deliveries where order_id = o.id and status in ('assigned','picked_up','delivered');
    if found then
      if d.status <> 'assigned' then raise exception 'O pedido #% já saiu para entrega.', o.number; end if;
      update public.deliveries set status = 'cancelled' where id = d.id;   -- troca de entregador
    end if;
  end loop;
  if (select count(*) from public.orders where id = any (p_order_ids)) <> array_length(p_order_ids, 1) then raise exception 'Pedido não encontrado.'; end if;
  -- rota: vizinho mais próximo a partir da loja (pedidos sem coordenada vão para o fim)
  v_lat := u.lat; v_lng := u.lng; v_left := p_order_ids;
  while coalesce(array_length(v_left, 1), 0) > 0 loop
    select id into v_next from public.orders where id = any (v_left)
      order by case when (address->>'lat') is null or v_lat is null then 1 else 0 end,
               power(coalesce((address->>'lat')::float8, 0) - coalesce(v_lat, 0), 2)
               + power((coalesce((address->>'lng')::float8, 0) - coalesce(v_lng, 0)) * cos(radians(coalesce(v_lat, 0))), 2), number
      limit 1;
    select * into o from public.orders where id = v_next;
    v_seq := v_seq + 1;
    insert into public.deliveries (tenant_id, unit_id, order_id, courier_id, batch_id, seq, fee_cents, collect_cents, collect_method, change_for_cents)
    values (o.tenant_id, o.unit_id, o.id, c.id, v_batch, v_seq, private.courier_fee(c, o),
      case when o.payment_status = 'paid' then 0 else o.total_cents end,
      case when o.payment_status = 'paid' then null else o.payment_method::text end, o.change_for_cents);
    insert into public.order_events (tenant_id, order_id, from_status, to_status, note, actor_id)
    values (o.tenant_id, o.id, o.status, o.status, 'Entrega atribuída a ' || c.name, auth.uid());
    if (o.address->>'lat') is not null then v_lat := (o.address->>'lat')::float8; v_lng := (o.address->>'lng')::float8; end if;
    v_left := array_remove(v_left, v_next);
  end loop;
  return v_batch;
end $$;

create or replace function public.courier_unassign(p_delivery_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare d public.deliveries;
begin
  select * into d from public.deliveries where id = p_delivery_id for update;
  if not found or not private.can_access_unit(d.unit_id) or not private.has_role(d.tenant_id, array['owner','manager','cashier','attendant']::public.member_role[]) then
    raise exception 'Sem permissão.' using errcode = '42501'; end if;
  if d.status <> 'assigned' then raise exception 'Esta entrega já saiu; marque como devolvida pelo app do entregador.'; end if;
  update public.deliveries set status = 'cancelled' where id = d.id;
end $$;

-- pedido cancelado: entrega pendente é cancelada junto
create or replace function private.delivery_on_cancel()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.deliveries set status = 'cancelled' where order_id = new.id and status in ('assigned','picked_up');
  return null;
end $$;
create trigger orders_delivery_cancel after update of status on public.orders
  for each row when (new.status = 'cancelled' and old.status <> 'cancelled') execute function private.delivery_on_cancel();

-- ---------- Cadastro ----------
create or replace function public.courier_save(p_id uuid, p_unit_id uuid, p jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare u public.units; v uuid := p_id; v_phone text := nullif(private.only_digits(p->>'phone'), '');
begin
  select * into u from public.units where id = p_unit_id;
  if not found or not private.can_access_unit(u.id) or not private.can_manage(u.tenant_id) then raise exception 'Sem permissão.' using errcode = '42501'; end if;
  if v is null then
    insert into public.couriers (tenant_id, unit_id, name, phone, vehicle, pix_key, fee_mode, fee_value)
    values (u.tenant_id, u.id, trim(p->>'name'), v_phone, coalesce(p->>'vehicle', 'moto'), nullif(trim(p->>'pix_key'), ''),
            coalesce(p->>'fee_mode', 'fixed'), coalesce((p->>'fee_value')::int, 500)) returning id into v;
  else
    update public.couriers set name = coalesce(nullif(trim(p->>'name'), ''), name), phone = case when p ? 'phone' then v_phone else phone end,
      vehicle = coalesce(p->>'vehicle', vehicle), pix_key = case when p ? 'pix_key' then nullif(trim(p->>'pix_key'), '') else pix_key end,
      fee_mode = coalesce(p->>'fee_mode', fee_mode), fee_value = coalesce((p->>'fee_value')::int, fee_value),
      active = coalesce((p->>'active')::boolean, active)
    where id = v and unit_id = u.id;
    if not found then raise exception 'Entregador não encontrado.'; end if;
  end if;
  return v;
end $$;

create or replace function public.courier_rotate_link(p_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare c public.couriers; v text := encode(extensions.gen_random_bytes(16), 'hex');
begin
  select * into c from public.couriers where id = p_id for update;
  if not found or not private.can_access_unit(c.unit_id) or not private.can_manage(c.tenant_id) then raise exception 'Sem permissão.' using errcode = '42501'; end if;
  update public.couriers set access_token = v where id = c.id;
  return v;
end $$;
