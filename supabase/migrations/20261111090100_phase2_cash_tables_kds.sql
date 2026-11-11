-- =====================================================================
-- Domma Food · 013 · Fase 2: Caixa/PDV, Mesas e Comandas, KDS
-- =====================================================================
-- (os novos valores de payment_method são criados na migração anterior)

alter table public.products add column station text not null default 'cozinha' check (char_length(station) between 1 and 30);
alter table public.units
  add column kds_stations text[] not null default array['cozinha','bar'],
  add column service_fee_pct numeric(5,2) not null default 10 check (service_fee_pct between 0 and 30);
alter table public.order_items
  add column station text,
  add column kds_status text not null default 'pending' check (kds_status in ('pending','preparing','done')),
  add column kds_started_at timestamptz,
  add column kds_done_at timestamptz;

-- item herda o setor do produto
create or replace function private.set_item_station()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.station is null then
    select station into new.station from public.products where id = new.product_id;
    new.station := coalesce(new.station, 'cozinha');
  end if;
  return new;
end $$;
create trigger order_items_station before insert on public.order_items
  for each row execute function private.set_item_station();

-- ---------- Mesas e comandas ----------
create table public.dining_tables (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  unit_id uuid not null references public.units(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 30),
  area text not null default 'Salão',
  seats integer not null default 4 check (seats between 1 and 50),
  position integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (unit_id, name)
);
create table public.tabs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  unit_id uuid not null references public.units(id) on delete cascade,
  table_id uuid references public.dining_tables(id) on delete set null,
  label text not null default '',
  customer_name text,
  people integer not null default 1 check (people between 1 and 99),
  status text not null default 'open' check (status in ('open','closed','cancelled')),
  service_fee_pct numeric(5,2) not null default 0,
  subtotal_cents integer not null default 0,
  service_fee_cents integer not null default 0,
  discount_cents integer not null default 0,
  total_cents integer not null default 0,
  bill_requested_at timestamptz,
  opened_by uuid references auth.users(id) on delete set null,
  closed_by uuid references auth.users(id) on delete set null,
  opened_at timestamptz not null default now(),
  closed_at timestamptz
);
create index tabs_unit_open_idx on public.tabs(unit_id) where status = 'open';

-- ---------- Caixa ----------
create table public.cash_sessions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  unit_id uuid not null references public.units(id) on delete cascade,
  status text not null default 'open' check (status in ('open','closed')),
  opening_float_cents integer not null default 0 check (opening_float_cents >= 0),
  opened_by uuid references auth.users(id) on delete set null,
  opened_at timestamptz not null default now(),
  closed_by uuid references auth.users(id) on delete set null,
  closed_at timestamptz,
  expected jsonb, counted jsonb,
  difference_cents integer,
  notes text
);
create unique index cash_sessions_one_open on public.cash_sessions(unit_id) where status = 'open';
create table public.cash_moves (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  session_id uuid not null references public.cash_sessions(id) on delete cascade,
  kind text not null check (kind in ('sale','supply','withdrawal')),
  method public.payment_method not null,
  amount_cents integer not null check (amount_cents > 0),
  order_id uuid references public.orders(id) on delete set null,
  tab_id uuid references public.tabs(id) on delete set null,
  note text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index cash_moves_session_idx on public.cash_moves(session_id);

alter table public.orders
  add column tab_id uuid references public.tabs(id) on delete set null,
  add column cash_session_id uuid references public.cash_sessions(id) on delete set null;
create index orders_tab_idx on public.orders(tab_id) where tab_id is not null;
alter table public.payments alter column order_id drop not null;
alter table public.payments add column tab_id uuid references public.tabs(id) on delete cascade;
alter table public.payments add constraint payments_target_chk check (order_id is not null or tab_id is not null);

-- ---------- RLS ----------
do $$ declare t text; begin
  foreach t in array array['dining_tables','tabs','cash_sessions','cash_moves'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
end $$;
revoke insert, update, delete on public.tabs, public.cash_sessions, public.cash_moves from authenticated;
create policy dt_select on public.dining_tables for select to authenticated using (private.can_access_unit(unit_id));
create policy dt_write on public.dining_tables for all to authenticated
  using (private.can_manage(tenant_id) and private.can_access_unit(unit_id))
  with check (private.can_manage(tenant_id) and private.can_access_unit(unit_id)
    and exists (select 1 from public.units u where u.id = unit_id and u.tenant_id = dining_tables.tenant_id));
create policy tabs_select on public.tabs for select to authenticated using (private.can_access_unit(unit_id));
create policy cs_select on public.cash_sessions for select to authenticated
  using (private.can_access_unit(unit_id) and private.has_role(tenant_id, array['owner','manager','cashier']::public.member_role[]));
create policy cm_select on public.cash_moves for select to authenticated
  using (private.has_role(tenant_id, array['owner','manager','cashier']::public.member_role[]));
create trigger cash_sessions_audit after insert or update on public.cash_sessions for each row execute function private.audit_row();
create trigger cash_moves_audit after insert on public.cash_moves for each row execute function private.audit_row();
alter publication supabase_realtime add table public.tabs;

-- ---------- Preço dos itens (PDV e mesas) ----------
create or replace function private.price_items(p_unit_id uuid, p_items jsonb, p_channel text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  u public.units; it jsonb; opt jsonb; pr record; g record; v_qty int; v_unit_price int;
  v_opts jsonb; v_count int; v_prices int[]; v_group_total int; v_items jsonb := '[]'::jsonb; v_subtotal int := 0;
begin
  select * into u from public.units where id = p_unit_id;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then raise exception 'Adicione pelo menos um item.'; end if;
  if jsonb_array_length(p_items) > 80 then raise exception 'Itens demais.'; end if;
  for it in select * from jsonb_array_elements(p_items) loop
    v_qty := coalesce((it->>'quantity')::int, 1);
    if v_qty < 1 or v_qty > 99 then raise exception 'Quantidade inválida.'; end if;
    select pd.*, o.price_cents as ov_price, coalesce(o.available, true) as ov_available into pr
      from public.products pd left join public.product_unit_overrides o on o.product_id = pd.id and o.unit_id = u.id
     where pd.id = (it->>'product_id')::uuid and pd.tenant_id = u.tenant_id;
    if not found or not pr.active or not pr.ov_available or not (p_channel::public.order_channel = any (pr.channels)) then
      raise exception 'Um item não está disponível neste canal.';
    end if;
    if pr.paused_until is not null and pr.paused_until > now() then raise exception '"%" está esgotado.', pr.name; end if;
    v_unit_price := coalesce(pr.ov_price, pr.promo_price_cents, pr.price_cents);
    v_opts := '[]'::jsonb;
    for g in select og.* from public.product_option_groups pog join public.option_groups og on og.id = pog.group_id
             where pog.product_id = pr.id order by pog.position loop
      v_count := 0; v_prices := '{}'; v_group_total := 0;
      for opt in select * from jsonb_array_elements(coalesce(it->'options','[]'::jsonb)) loop
        declare o2 public.options; oq int := coalesce((opt->>'quantity')::int, 1);
        begin
          select * into o2 from public.options where id = (opt->>'option_id')::uuid and group_id = g.id and active;
          if found then
            if oq < 1 or oq > 20 or (oq > 1 and not g.allow_repeat) then raise exception 'Quantidade de complemento inválida.'; end if;
            v_count := v_count + oq;
            for i in 1..oq loop v_prices := v_prices || o2.price_cents; end loop;
            v_opts := v_opts || jsonb_build_object('group', g.name, 'option_id', o2.id, 'name', o2.name, 'price_cents', o2.price_cents, 'quantity', oq);
          end if;
        end;
      end loop;
      if v_count < g.min_select then raise exception 'Escolha pelo menos % em "%" (%).', g.min_select, g.name, pr.name; end if;
      if v_count > g.max_select then raise exception 'Escolha no máximo % em "%" (%).', g.max_select, g.name, pr.name; end if;
      if v_count > 0 then
        v_group_total := case g.price_rule when 'sum' then (select sum(x) from unnest(v_prices) x)
          when 'max' then (select max(x) from unnest(v_prices) x) else (select ceil(avg(x)) from unnest(v_prices) x)::int end;
      end if;
      v_unit_price := v_unit_price + coalesce(v_group_total, 0);
    end loop;
    if (select count(*) from jsonb_array_elements(coalesce(it->'options','[]'::jsonb))) > jsonb_array_length(v_opts) then
      raise exception 'Complemento inválido para "%".', pr.name;
    end if;
    v_items := v_items || jsonb_build_object('product_id', pr.id, 'name', pr.name, 'quantity', v_qty, 'station', pr.station,
      'unit_price_cents', v_unit_price, 'total_cents', v_unit_price * v_qty, 'options', v_opts,
      'notes', left(nullif(trim(it->>'notes'), ''), 300));
    v_subtotal := v_subtotal + v_unit_price * v_qty;
  end loop;
  return jsonb_build_object('items', v_items, 'subtotal_cents', v_subtotal);
end $$;

create or replace function private.insert_items(p_tenant uuid, p_order uuid, p_items jsonb)
returns void language sql security definer set search_path = '' as $$
  insert into public.order_items (tenant_id, order_id, product_id, name, quantity, unit_price_cents, total_cents, options, notes, station)
  select p_tenant, p_order, (i->>'product_id')::uuid, i->>'name', (i->>'quantity')::int, (i->>'unit_price_cents')::int,
         (i->>'total_cents')::int, i->'options', i->>'notes', i->>'station'
  from jsonb_array_elements(p_items) i;
$$;

create or replace function private.open_session(p_unit_id uuid)
returns uuid language sql stable security definer set search_path = '' as $$
  select id from public.cash_sessions where unit_id = p_unit_id and status = 'open';
$$;

-- registra pagamentos (vários por venda); devolve o troco
create or replace function private.register_payments(p_tenant uuid, p_session uuid, p_total int, p_payments jsonb, p_order uuid, p_tab uuid)
returns int language plpgsql security definer set search_path = '' as $$
declare pm jsonb; v_sum int := 0; v_cash int := 0; v_amt int; v_change int; v_m text;
begin
  if jsonb_typeof(p_payments) <> 'array' or jsonb_array_length(p_payments) = 0 then raise exception 'Informe a forma de pagamento.'; end if;
  for pm in select * from jsonb_array_elements(p_payments) loop
    v_amt := (pm->>'amount_cents')::int; v_m := pm->>'method';
    if v_amt is null or v_amt <= 0 then raise exception 'Valor de pagamento inválido.'; end if;
    if v_m not in ('cash','pix','credit_card','debit_card','voucher') then raise exception 'Forma de pagamento inválida.'; end if;
    v_sum := v_sum + v_amt; if v_m = 'cash' then v_cash := v_cash + v_amt; end if;
  end loop;
  if v_sum < p_total then raise exception 'Faltam R$ % para fechar a conta.', to_char((p_total - v_sum) / 100.0, 'FM999990D00'); end if;
  v_change := v_sum - p_total;
  if v_change > v_cash then raise exception 'Só é possível dar troco sobre o valor em dinheiro.'; end if;
  for pm in select * from jsonb_array_elements(p_payments) loop
    v_m := pm->>'method'; v_amt := (pm->>'amount_cents')::int;
    if v_m = 'cash' then v_amt := v_amt - least(v_change, v_amt); v_change := v_change - least(v_change, (pm->>'amount_cents')::int); end if;
    if v_amt > 0 then
      insert into public.payments (tenant_id, order_id, tab_id, method, gateway, amount_cents, status, confirmed_by)
      values (p_tenant, p_order, p_tab, v_m::public.payment_method, 'pdv', v_amt, 'paid', auth.uid());
      insert into public.cash_moves (tenant_id, session_id, kind, method, amount_cents, order_id, tab_id, created_by)
      values (p_tenant, p_session, 'sale', v_m::public.payment_method, v_amt, p_order, p_tab, auth.uid());
    end if;
  end loop;
  return v_sum - p_total;
end $$;

create or replace function private.max_discount(p_tenant uuid)
returns numeric language sql stable security definer set search_path = '' as $$
  select case when role in ('owner','manager') then 100 else max_discount_pct end
  from public.memberships where tenant_id = p_tenant and user_id = auth.uid();
$$;

-- ---------- Caixa ----------
create or replace function public.cash_open(p_unit_id uuid, p_float_cents integer)
returns uuid language plpgsql security definer set search_path = '' as $$
declare u public.units; v uuid;
begin
  select * into u from public.units where id = p_unit_id;
  if not found or not private.can_access_unit(u.id) or not private.has_role(u.tenant_id, array['owner','manager','cashier']::public.member_role[]) then
    raise exception 'Sem permissão.' using errcode = '42501'; end if;
  if private.open_session(u.id) is not null then raise exception 'Já existe um caixa aberto nesta loja.'; end if;
  insert into public.cash_sessions (tenant_id, unit_id, opening_float_cents, opened_by)
  values (u.tenant_id, u.id, greatest(coalesce(p_float_cents, 0), 0), auth.uid()) returning id into v;
  return v;
end $$;

create or replace function public.cash_move(p_unit_id uuid, p_kind text, p_amount_cents integer, p_note text)
returns void language plpgsql security definer set search_path = '' as $$
declare u public.units; s uuid;
begin
  select * into u from public.units where id = p_unit_id;
  if not found or not private.can_access_unit(u.id) or not private.has_role(u.tenant_id, array['owner','manager','cashier']::public.member_role[]) then
    raise exception 'Sem permissão.' using errcode = '42501'; end if;
  if p_kind not in ('supply','withdrawal') then raise exception 'Tipo inválido.'; end if;
  if coalesce(trim(p_note), '') = '' then raise exception 'Informe o motivo.'; end if;
  s := private.open_session(u.id);
  if s is null then raise exception 'Abra o caixa primeiro.'; end if;
  insert into public.cash_moves (tenant_id, session_id, kind, method, amount_cents, note, created_by)
  values (u.tenant_id, s, p_kind, 'cash', p_amount_cents, left(p_note, 200), auth.uid());
end $$;

create or replace function private.cash_expected(p_session uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'cash', s.opening_float_cents + coalesce(sum(case when m.method = 'cash' and m.kind in ('sale','supply') then m.amount_cents
                                                      when m.kind = 'withdrawal' then -m.amount_cents else 0 end), 0),
    'pix', coalesce(sum(m.amount_cents) filter (where m.kind = 'sale' and m.method = 'pix'), 0),
    'credit_card', coalesce(sum(m.amount_cents) filter (where m.kind = 'sale' and m.method = 'credit_card'), 0),
    'debit_card', coalesce(sum(m.amount_cents) filter (where m.kind = 'sale' and m.method = 'debit_card'), 0),
    'voucher', coalesce(sum(m.amount_cents) filter (where m.kind = 'sale' and m.method = 'voucher'), 0),
    'sales_total', coalesce(sum(m.amount_cents) filter (where m.kind = 'sale'), 0),
    'supply', coalesce(sum(m.amount_cents) filter (where m.kind = 'supply'), 0),
    'withdrawal', coalesce(sum(m.amount_cents) filter (where m.kind = 'withdrawal'), 0),
    'sales_count', count(*) filter (where m.kind = 'sale'))
  from public.cash_sessions s left join public.cash_moves m on m.session_id = s.id
  where s.id = p_session group by s.id;
$$;

create or replace function public.cash_status(p_unit_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare u public.units; s public.cash_sessions;
begin
  select * into u from public.units where id = p_unit_id;
  if not found or not private.can_access_unit(u.id) or not private.has_role(u.tenant_id, array['owner','manager','cashier']::public.member_role[]) then
    raise exception 'Sem permissão.' using errcode = '42501'; end if;
  select * into s from public.cash_sessions where unit_id = u.id and status = 'open';
  if not found then return jsonb_build_object('open', false,
    'last', (select to_jsonb(x) from (select id, opened_at, closed_at, expected, counted, difference_cents, notes
             from public.cash_sessions where unit_id = u.id and status = 'closed' order by closed_at desc limit 10) x limit 1),
    'history', coalesce((select jsonb_agg(to_jsonb(x)) from (select id, opened_at, closed_at, expected, counted, difference_cents, notes
             from public.cash_sessions where unit_id = u.id and status = 'closed' order by closed_at desc limit 10) x), '[]'::jsonb)); end if;
  return jsonb_build_object('open', true, 'id', s.id, 'opened_at', s.opened_at, 'opening_float_cents', s.opening_float_cents,
    'opened_by', (select coalesce(nullif(p.full_name, ''), au.email) from auth.users au left join public.profiles p on p.id = au.id where au.id = s.opened_by),
    'expected', private.cash_expected(s.id),
    'open_tabs', (select count(*) from public.tabs where unit_id = u.id and status = 'open'),
    'moves', coalesce((select jsonb_agg(to_jsonb(x)) from (select id, kind, method, amount_cents, note, created_at, order_id, tab_id
              from public.cash_moves where session_id = s.id order by id desc limit 60) x), '[]'::jsonb));
end $$;

-- Fechamento cego: o operador informa o que contou; o sistema calcula a diferença
create or replace function public.cash_close(p_unit_id uuid, p_counted jsonb, p_notes text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare u public.units; s uuid; e jsonb; d int; k text;
begin
  select * into u from public.units where id = p_unit_id;
  if not found or not private.can_access_unit(u.id) or not private.has_role(u.tenant_id, array['owner','manager','cashier']::public.member_role[]) then
    raise exception 'Sem permissão.' using errcode = '42501'; end if;
  s := private.open_session(u.id);
  if s is null then raise exception 'Não há caixa aberto.'; end if;
  if exists (select 1 from public.tabs where unit_id = u.id and status = 'open') and coalesce(trim(p_notes), '') = '' then
    raise exception 'Há mesas abertas. Feche-as ou escreva uma justificativa para fechar o caixa.';
  end if;
  e := private.cash_expected(s); d := 0;
  foreach k in array array['cash','pix','credit_card','debit_card','voucher'] loop
    d := d + coalesce((p_counted->>k)::int, 0) - (e->>k)::int;
  end loop;
  update public.cash_sessions set status = 'closed', closed_at = now(), closed_by = auth.uid(), expected = e,
         counted = p_counted, difference_cents = d, notes = left(p_notes, 500) where id = s;
  return jsonb_build_object('expected', e, 'counted', p_counted, 'difference_cents', d);
end $$;

-- ---------- PDV: venda de balcão ----------
create or replace function public.pos_sale(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  u public.units; s uuid; q jsonb; v_sub int; v_disc int := coalesce((p->>'discount_cents')::int, 0); v_total int;
  v_order uuid; v_n int; v_change int; v_phone text := private.only_digits(p->'customer'->>'phone'); v_cust uuid;
  v_name text := left(coalesce(nullif(trim(p->'customer'->>'name'), ''), 'Balcão'), 120);
begin
  select * into u from public.units where id = (p->>'unit_id')::uuid;
  if not found or not private.can_access_unit(u.id) or not private.has_role(u.tenant_id, array['owner','manager','cashier']::public.member_role[]) then
    raise exception 'Sem permissão.' using errcode = '42501'; end if;
  s := private.open_session(u.id);
  if s is null then raise exception 'Abra o caixa antes de vender.'; end if;
  if coalesce(p->'payments'->0->>'method', '') not in ('cash','pix','credit_card','debit_card','voucher') then raise exception 'Informe a forma de pagamento.'; end if;
  q := private.price_items(u.id, p->'items', 'counter'); v_sub := (q->>'subtotal_cents')::int;
  if v_disc < 0 or v_disc > v_sub then raise exception 'Desconto inválido.'; end if;
  if v_disc > 0 and v_disc * 100.0 / v_sub > private.max_discount(u.tenant_id) then
    raise exception 'Desconto acima do seu limite (% %%). Peça a um gerente.', private.max_discount(u.tenant_id);
  end if;
  v_total := v_sub - v_disc;
  if length(v_phone) between 10 and 13 then
    insert into public.customers (tenant_id, name, phone) values (u.tenant_id, v_name, v_phone)
    on conflict (tenant_id, phone) do update set name = case when excluded.name = 'Balcão' then public.customers.name else excluded.name end
    returning id into v_cust;
  end if;
  update public.units set order_counter = order_counter + 1 where id = u.id returning order_counter into v_n;
  insert into public.orders (tenant_id, unit_id, number, channel, type, status, customer_id, customer_name, customer_phone,
    subtotal_cents, discount_cents, total_cents, payment_method, payment_status, notes, accepted_at, paid_at, cash_session_id)
  values (u.tenant_id, u.id, v_n, 'counter', case when p->>'type' = 'dine_in' then 'dine_in'::public.order_type else 'pickup'::public.order_type end,
    'preparing', v_cust, v_name, coalesce(nullif(v_phone, ''), '00000000000'), v_sub, v_disc, v_total,
    (p->'payments'->0->>'method')::public.payment_method, 'paid', left(nullif(trim(p->>'notes'), ''), 500), now(), now(), s)
  returning id into v_order;
  perform private.insert_items(u.tenant_id, v_order, q->'items');
  v_change := private.register_payments(u.tenant_id, s, v_total, p->'payments', v_order, null);
  insert into public.order_events (tenant_id, order_id, to_status, note, actor_id) values (u.tenant_id, v_order, 'preparing', 'Venda no balcão (PDV)', auth.uid());
  if v_disc > 0 then
    insert into public.audit_logs (tenant_id, actor_id, action, entity, entity_id, after, ip)
    values (u.tenant_id, auth.uid(), 'discount', 'orders', v_order::text, jsonb_build_object('discount_cents', v_disc, 'subtotal_cents', v_sub), private.request_ip());
  end if;
  return jsonb_build_object('order_id', v_order, 'number', v_n, 'total_cents', v_total, 'change_cents', v_change);
end $$;

-- ---------- Mesas e comandas ----------
create or replace function private.can_serve(p_unit_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.can_access_unit(p_unit_id) and private.has_role((select tenant_id from public.units where id = p_unit_id),
    array['owner','manager','cashier','attendant','waiter']::public.member_role[]);
$$;

create or replace function public.tab_open(p_unit_id uuid, p_table_id uuid, p_label text, p_people integer, p_customer text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare u public.units; v uuid;
begin
  select * into u from public.units where id = p_unit_id;
  if not found or not private.can_serve(u.id) then raise exception 'Sem permissão.' using errcode = '42501'; end if;
  if p_table_id is not null and not exists (select 1 from public.dining_tables where id = p_table_id and unit_id = u.id and active) then
    raise exception 'Mesa inválida.'; end if;
  if p_table_id is null and coalesce(trim(p_label), '') = '' then raise exception 'Informe o número ou nome da comanda.'; end if;
  insert into public.tabs (tenant_id, unit_id, table_id, label, people, customer_name, service_fee_pct, opened_by)
  values (u.tenant_id, u.id, p_table_id, left(coalesce(trim(p_label), ''), 40), greatest(coalesce(p_people, 1), 1),
          left(nullif(trim(p_customer), ''), 80), u.service_fee_pct, auth.uid()) returning id into v;
  return v;
end $$;

create or replace function private.tab_recalc(p_tab uuid)
returns void language sql security definer set search_path = '' as $$
  update public.tabs t set subtotal_cents = coalesce((select sum(o.subtotal_cents) from public.orders o where o.tab_id = t.id and o.status <> 'cancelled'), 0)
  where t.id = p_tab;
$$;

create or replace function public.tab_add_items(p_tab_id uuid, p_items jsonb, p_notes text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare t public.tabs; q jsonb; v_order uuid; v_n int; v_tname text;
begin
  select * into t from public.tabs where id = p_tab_id for update;
  if not found or not private.can_serve(t.unit_id) then raise exception 'Sem permissão.' using errcode = '42501'; end if;
  if t.status <> 'open' then raise exception 'Esta comanda já foi fechada.'; end if;
  q := private.price_items(t.unit_id, p_items, 'table');
  select name into v_tname from public.dining_tables where id = t.table_id;
  update public.units set order_counter = order_counter + 1 where id = t.unit_id returning order_counter into v_n;
  insert into public.orders (tenant_id, unit_id, number, channel, type, status, customer_name, customer_phone,
    subtotal_cents, total_cents, payment_method, payment_status, notes, accepted_at, tab_id)
  values (t.tenant_id, t.unit_id, v_n, 'table', 'dine_in', 'preparing',
    coalesce(case when v_tname is not null then 'Mesa ' || v_tname end || coalesce(' · ' || nullif(t.label, ''), ''), 'Comanda ' || t.label),
    '00000000000', (q->>'subtotal_cents')::int, (q->>'subtotal_cents')::int, 'cash', 'pending', left(nullif(trim(p_notes), ''), 500), now(), t.id)
  returning id into v_order;
  perform private.insert_items(t.tenant_id, v_order, q->'items');
  insert into public.order_events (tenant_id, order_id, to_status, note, actor_id) values (t.tenant_id, v_order, 'preparing', 'Lançado na comanda', auth.uid());
  perform private.tab_recalc(t.id);
  update public.tabs set bill_requested_at = null where id = t.id;
  return jsonb_build_object('order_id', v_order, 'number', v_n);
end $$;

create or replace function public.tab_update(p_tab_id uuid, p_action text, p_table_id uuid default null)
returns void language plpgsql security definer set search_path = '' as $$
declare t public.tabs;
begin
  select * into t from public.tabs where id = p_tab_id for update;
  if not found or not private.can_serve(t.unit_id) then raise exception 'Sem permissão.' using errcode = '42501'; end if;
  if t.status <> 'open' then raise exception 'Esta comanda já foi fechada.'; end if;
  if p_action = 'request_bill' then update public.tabs set bill_requested_at = now() where id = t.id;
  elsif p_action = 'transfer' then
    if not exists (select 1 from public.dining_tables where id = p_table_id and unit_id = t.unit_id and active) then raise exception 'Mesa inválida.'; end if;
    update public.tabs set table_id = p_table_id where id = t.id;
  elsif p_action = 'cancel' then
    if exists (select 1 from public.orders where tab_id = t.id and status <> 'cancelled') then
      raise exception 'A comanda tem itens lançados. Cancele os pedidos antes ou feche a conta.'; end if;
    update public.tabs set status = 'cancelled', closed_at = now(), closed_by = auth.uid() where id = t.id;
  else raise exception 'Ação inválida.'; end if;
end $$;

create or replace function public.tab_close(p_tab_id uuid, p_payments jsonb, p_service_fee boolean default true, p_discount_cents integer default 0)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare t public.tabs; s uuid; v_sub int; v_fee int; v_disc int := coalesce(p_discount_cents, 0); v_total int; v_change int; r record; v_m public.payment_method;
begin
  select * into t from public.tabs where id = p_tab_id for update;
  if not found or not private.can_access_unit(t.unit_id) or not private.has_role(t.tenant_id, array['owner','manager','cashier']::public.member_role[]) then
    raise exception 'Só o caixa ou o gerente fecham a conta.' using errcode = '42501'; end if;
  if t.status <> 'open' then raise exception 'Esta comanda já foi fechada.'; end if;
  s := private.open_session(t.unit_id);
  if s is null then raise exception 'Abra o caixa antes de fechar a conta.'; end if;
  select coalesce(sum(subtotal_cents), 0) into v_sub from public.orders where tab_id = t.id and status <> 'cancelled';
  if v_sub = 0 then raise exception 'A comanda está vazia.'; end if;
  if v_disc < 0 or v_disc > v_sub then raise exception 'Desconto inválido.'; end if;
  if v_disc > 0 and v_disc * 100.0 / v_sub > private.max_discount(t.tenant_id) then
    raise exception 'Desconto acima do seu limite (% %%). Peça a um gerente.', private.max_discount(t.tenant_id); end if;
  v_fee := case when p_service_fee then round(v_sub * t.service_fee_pct / 100.0)::int else 0 end;
  v_total := v_sub + v_fee - v_disc;
  v_change := private.register_payments(t.tenant_id, s, v_total, p_payments, null, t.id);
  v_m := (p_payments->0->>'method')::public.payment_method;
  for r in select id, status from public.orders where tab_id = t.id and status <> 'cancelled' loop
    update public.orders set status = 'completed', completed_at = now(), payment_status = 'paid', paid_at = now(),
           payment_method = v_m, cash_session_id = s where id = r.id;
    if r.status <> 'completed' then
      insert into public.order_events (tenant_id, order_id, from_status, to_status, note, actor_id)
      values (t.tenant_id, r.id, r.status, 'completed', 'Conta da mesa fechada', auth.uid());
    end if;
  end loop;
  update public.tabs set status = 'closed', closed_at = now(), closed_by = auth.uid(), subtotal_cents = v_sub,
         service_fee_cents = v_fee, discount_cents = v_disc, total_cents = v_total where id = t.id;
  return jsonb_build_object('total_cents', v_total, 'service_fee_cents', v_fee, 'change_cents', v_change);
end $$;

-- ---------- KDS ----------
create or replace function public.kds_set_item(p_item_id uuid, p_status text)
returns void language plpgsql security definer set search_path = '' as $$
declare i public.order_items; o public.orders;
begin
  select * into i from public.order_items where id = p_item_id for update;
  if not found then raise exception 'Item não encontrado.'; end if;
  select * into o from public.orders where id = i.order_id for update;
  if not private.can_access_unit(o.unit_id) or not private.has_role(o.tenant_id,
      array['owner','manager','cashier','attendant','kitchen']::public.member_role[]) then
    raise exception 'Sem permissão.' using errcode = '42501'; end if;
  if p_status not in ('pending','preparing','done') then raise exception 'Status inválido.'; end if;
  update public.order_items set kds_status = p_status,
    kds_started_at = case when p_status = 'preparing' then now() when p_status = 'pending' then null else coalesce(kds_started_at, now()) end,
    kds_done_at = case when p_status = 'done' then now() else null end
  where id = i.id;
  -- regra: o pedido só fica "pronto" quando todos os setores concluem
  if p_status = 'done' and o.status = 'preparing'
     and not exists (select 1 from public.order_items where order_id = o.id and kds_status <> 'done') then
    update public.orders set status = 'ready', ready_at = now() where id = o.id;
    insert into public.order_events (tenant_id, order_id, from_status, to_status, note, actor_id)
    values (o.tenant_id, o.id, 'preparing', 'ready', 'Todos os itens concluídos no KDS', auth.uid());
  end if;
end $$;

-- ---------- set_order_status: pedidos de comanda só são pagos no fechamento da mesa ----------
create or replace function public.set_order_status(p_order_id uuid, p_status public.order_status, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare o public.orders; v_role public.member_role;
begin
  select * into o from public.orders where id = p_order_id for update;
  if not found or not private.can_access_unit(o.unit_id) then raise exception 'Pedido não encontrado.' using errcode = '42501'; end if;
  select role into v_role from public.memberships where tenant_id = o.tenant_id and user_id = auth.uid();
  if v_role = 'waiter' then raise exception 'Sem permissão.' using errcode = '42501'; end if;
  if v_role = 'kitchen' and not (o.status = 'preparing' and p_status = 'ready') then
    raise exception 'A cozinha só pode marcar pedidos como prontos.' using errcode = '42501';
  end if;
  if v_role = 'courier' and not (p_status in ('dispatched','completed') and o.type = 'delivery') then
    raise exception 'Sem permissão.' using errcode = '42501';
  end if;
  if not private.allowed_transition(o.status, p_status, o.type) then
    raise exception 'Mudança de status inválida.';
  end if;
  if p_status = 'cancelled' and coalesce(trim(p_reason), '') = '' then
    raise exception 'Informe o motivo do cancelamento.';
  end if;

  update public.orders set
    status = p_status,
    accepted_at = case when p_status = 'preparing' then now() else accepted_at end,
    ready_at = case when p_status = 'ready' then now() else ready_at end,
    dispatched_at = case when p_status = 'dispatched' then now() else dispatched_at end,
    completed_at = case when p_status = 'completed' then now() else completed_at end,
    cancelled_at = case when p_status = 'cancelled' then now() else cancelled_at end,
    cancel_reason = case when p_status = 'cancelled' then left(p_reason, 300) else cancel_reason end,
    payment_status = case when p_status = 'completed' and tab_id is null and payment_method in ('cash','card_on_delivery','voucher')
                          then 'paid'::public.payment_status else payment_status end,
    paid_at = case when p_status = 'completed' and tab_id is null and payment_status = 'pending' then now() else paid_at end
  where id = o.id;

  insert into public.order_events (tenant_id, order_id, from_status, to_status, note, actor_id)
  values (o.tenant_id, o.id, o.status, p_status, left(p_reason, 300), auth.uid());

  if p_status = 'completed' then
    update public.payments set status = 'paid' where order_id = o.id and status = 'pending';
    update public.customers set
      orders_count = orders_count + 1, total_spent_cents = total_spent_cents + o.total_cents,
      first_order_at = coalesce(first_order_at, o.created_at), last_order_at = o.created_at
    where id = o.customer_id;
  elsif p_status = 'cancelled' then
    if o.coupon_id is not null then
      update public.coupons set uses_count = greatest(uses_count - 1, 0) where id = o.coupon_id;
      delete from public.coupon_redemptions where order_id = o.id;
    end if;
    -- Pagamentos confirmados ficam marcados para estorno manual / via gateway
    update public.payments set status = case when status = 'paid' then 'refunded'::public.payment_status else 'failed'::public.payment_status end
     where order_id = o.id;
    insert into public.audit_logs (tenant_id, actor_id, action, entity, entity_id, before, after, ip)
    values (o.tenant_id, auth.uid(), 'cancel', 'orders', o.id::text,
            jsonb_build_object('status', o.status), jsonb_build_object('reason', p_reason), private.request_ip());
  end if;

  return jsonb_build_object('id', o.id, 'status', p_status);
end $$;


-- ---------- Permissões ----------
revoke execute on function public.cash_open(uuid, integer), public.cash_move(uuid, text, integer, text), public.cash_status(uuid),
  public.cash_close(uuid, jsonb, text), public.pos_sale(jsonb), public.tab_open(uuid, uuid, text, integer, text),
  public.tab_add_items(uuid, jsonb, text), public.tab_update(uuid, text, uuid), public.tab_close(uuid, jsonb, boolean, integer),
  public.kds_set_item(uuid, text) from public, anon;
grant execute on function public.cash_open(uuid, integer), public.cash_move(uuid, text, integer, text), public.cash_status(uuid),
  public.cash_close(uuid, jsonb, text), public.pos_sale(jsonb), public.tab_open(uuid, uuid, text, integer, text),
  public.tab_add_items(uuid, jsonb, text), public.tab_update(uuid, text, uuid), public.tab_close(uuid, jsonb, boolean, integer),
  public.kds_set_item(uuid, text) to authenticated;
revoke execute on all functions in schema private from authenticated;
grant execute on function private.is_platform_admin(), private.is_member(uuid), private.has_role(uuid, public.member_role[]),
  private.can_access_unit(uuid), private.can_manage(uuid), private.mfa_ok() to authenticated;
