-- =====================================================================
-- Domma Food · 018 · Estoque (insumos e ficha técnica), Financeiro
-- (contas a pagar/receber) e Fiado (conta do cliente)
-- =====================================================================

-- ---------- Estoque ----------
create table public.stock_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  unit_id uuid not null references public.units(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  unit text not null default 'un' check (unit in ('un','kg','g','l','ml','cx','pct')),
  qty numeric(14,3) not null default 0,
  min_qty numeric(14,3) not null default 0 check (min_qty >= 0),
  cost_cents numeric(14,4) not null default 0 check (cost_cents >= 0), -- custo médio por unidade de medida
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (unit_id, name)
);
create trigger stock_items_touch before update on public.stock_items
  for each row execute function private.touch_updated_at();

-- ficha técnica: quanto de cada insumo sai por unidade vendida do produto
create table public.product_recipes (
  product_id uuid not null references public.products(id) on delete cascade,
  stock_item_id uuid not null references public.stock_items(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  qty numeric(14,3) not null check (qty > 0),
  primary key (product_id, stock_item_id)
);
create index product_recipes_item_idx on public.product_recipes(stock_item_id);

create table public.stock_moves (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  item_id uuid not null references public.stock_items(id) on delete cascade,
  kind text not null check (kind in ('purchase','adjust','loss','sale','sale_reversal')),
  qty numeric(14,3) not null,
  unit_cost_cents numeric(14,4) not null default 0,
  balance_after numeric(14,3) not null,
  order_id uuid references public.orders(id) on delete set null,
  note text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index stock_moves_item_idx on public.stock_moves(item_id, id desc);
create index stock_moves_tenant_created_idx on public.stock_moves(tenant_id, created_at);
alter table public.order_items add column stock_deducted boolean not null default false;

-- ---------- Financeiro ----------
create table public.fin_entries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  unit_id uuid references public.units(id) on delete set null,
  kind text not null check (kind in ('payable','receivable')),
  description text not null check (char_length(description) between 1 and 160),
  category text not null default 'Outros' check (char_length(category) between 1 and 60),
  party text check (party is null or char_length(party) <= 120),
  amount_cents integer not null check (amount_cents > 0),
  due_date date not null,
  paid_at timestamptz,
  paid_method text check (paid_method is null or paid_method in ('cash','pix','card','transfer','boleto','other')),
  notes text check (notes is null or char_length(notes) <= 500),
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index fin_entries_tenant_due_idx on public.fin_entries(tenant_id, due_date);
create index fin_entries_tenant_paid_idx on public.fin_entries(tenant_id, paid_at) where paid_at is not null;
create trigger fin_entries_touch before update on public.fin_entries
  for each row execute function private.touch_updated_at();

-- ---------- Fiado ----------
alter table public.customers
  add column credit_limit_cents integer not null default 0 check (credit_limit_cents >= 0),
  add column credit_balance_cents integer not null default 0;
create table public.credit_ledger (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  kind text not null check (kind in ('charge','payment','adjust','reversal')),
  amount_cents integer not null check (amount_cents <> 0), -- positivo aumenta a dívida
  balance_after integer not null,
  order_id uuid references public.orders(id) on delete set null,
  tab_id uuid references public.tabs(id) on delete set null,
  method text,
  note text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index credit_ledger_customer_idx on public.credit_ledger(customer_id, id desc);
create index credit_ledger_order_idx on public.credit_ledger(order_id) where order_id is not null;
create index customers_credit_idx on public.customers(tenant_id) where credit_balance_cents > 0;

-- ---------- RLS e permissões ----------
do $$ declare t text; begin
  foreach t in array array['stock_items','product_recipes','stock_moves','fin_entries','credit_ledger'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
end $$;
-- saldo e custo médio só mudam por função; o cadastro é livre para gestores
revoke insert, update, delete on public.stock_moves, public.credit_ledger from authenticated;
revoke insert, update on public.stock_items from authenticated;
grant insert (tenant_id, unit_id, name, unit, min_qty) on public.stock_items to authenticated;
grant update (name, unit, min_qty, active) on public.stock_items to authenticated;
-- saldos do cliente (cashback, pontos, fiado) não podem ser editados direto pela API
revoke update on public.customers from authenticated;
grant update (name, phone, email, birthday, tags, opt_in_marketing) on public.customers to authenticated;
revoke insert on public.customers from authenticated;
grant insert (tenant_id, name, phone, email, birthday, tags, opt_in_marketing) on public.customers to authenticated;
create policy customers_insert on public.customers for insert to authenticated
  with check (private.has_role(tenant_id, array['owner','manager','cashier','attendant']::public.member_role[]));

create policy si_select on public.stock_items for select to authenticated
  using (private.can_access_unit(unit_id) and private.has_role(tenant_id, array['owner','manager','cashier','kitchen']::public.member_role[]));
create policy si_insert on public.stock_items for insert to authenticated
  with check (private.can_manage(tenant_id) and private.can_access_unit(unit_id)
    and exists (select 1 from public.units u where u.id = unit_id and u.tenant_id = stock_items.tenant_id));
create policy si_update on public.stock_items for update to authenticated
  using (private.can_manage(tenant_id) and private.can_access_unit(unit_id))
  with check (private.can_manage(tenant_id) and private.can_access_unit(unit_id));
create policy si_delete on public.stock_items for delete to authenticated
  using (private.can_manage(tenant_id) and private.can_access_unit(unit_id));
create policy pr_select on public.product_recipes for select to authenticated
  using (private.has_role(tenant_id, array['owner','manager','cashier','kitchen']::public.member_role[]));
create policy pr_write on public.product_recipes for all to authenticated
  using (private.can_manage(tenant_id))
  with check (private.can_manage(tenant_id)
    and exists (select 1 from public.products p where p.id = product_id and p.tenant_id = product_recipes.tenant_id)
    and exists (select 1 from public.stock_items s where s.id = stock_item_id and s.tenant_id = product_recipes.tenant_id));
create policy sm_select on public.stock_moves for select to authenticated
  using (private.has_role(tenant_id, array['owner','manager']::public.member_role[]));
create policy fe_all on public.fin_entries for all to authenticated
  using (private.can_manage(tenant_id))
  with check (private.can_manage(tenant_id)
    and (unit_id is null or exists (select 1 from public.units u where u.id = unit_id and u.tenant_id = fin_entries.tenant_id)));
create policy cl_select on public.credit_ledger for select to authenticated
  using (private.has_role(tenant_id, array['owner','manager','cashier']::public.member_role[]));
create trigger fin_entries_audit after insert or update or delete on public.fin_entries
  for each row execute function private.audit_row();
create trigger stock_items_audit after insert or delete on public.stock_items
  for each row execute function private.audit_row();

-- ---------- Estoque: baixa automática pela ficha técnica ----------
create or replace function private.stock_apply_item(p_item public.order_items, p_unit uuid, p_sign integer)
returns void language plpgsql security definer set search_path = '' as $$
declare r record; v_bal numeric; v_cost numeric;
begin
  if p_item.product_id is not null then
    for r in select pr.stock_item_id, pr.qty from public.product_recipes pr
             join public.stock_items si on si.id = pr.stock_item_id and si.unit_id = p_unit
             where pr.product_id = p_item.product_id loop
      update public.stock_items set qty = qty - p_sign * r.qty * p_item.quantity where id = r.stock_item_id
        returning qty, cost_cents into v_bal, v_cost;
      insert into public.stock_moves (tenant_id, item_id, kind, qty, unit_cost_cents, balance_after, order_id, created_by)
      values (p_item.tenant_id, r.stock_item_id, case when p_sign = 1 then 'sale' else 'sale_reversal' end,
              -p_sign * r.qty * p_item.quantity, v_cost, v_bal, p_item.order_id, auth.uid());
    end loop;
  end if;
  update public.order_items set stock_deducted = (p_sign = 1) where id = p_item.id;
end $$;

create or replace function private.stock_counts(s public.order_status)
returns boolean language sql immutable as $$
  select s in ('preparing','ready','dispatched','awaiting_pickup','completed');
$$;

-- item lançado em pedido já aceito (PDV, mesa) baixa na hora
create or replace function private.order_item_stock()
returns trigger language plpgsql security definer set search_path = '' as $$
declare o record;
begin
  select status, unit_id into o from public.orders where id = new.order_id;
  if private.stock_counts(o.status) then perform private.stock_apply_item(new, o.unit_id, 1); end if;
  return null;
end $$;
create trigger order_items_stock after insert on public.order_items
  for each row execute function private.order_item_stock();

-- pedido aceito baixa; pedido cancelado devolve
create or replace function private.order_stock()
returns trigger language plpgsql security definer set search_path = '' as $$
declare i public.order_items;
begin
  if private.stock_counts(new.status) and not private.stock_counts(old.status) then
    for i in select * from public.order_items where order_id = new.id and not stock_deducted loop
      perform private.stock_apply_item(i, new.unit_id, 1);
    end loop;
  elsif new.status = 'cancelled' and old.status <> 'cancelled' then
    for i in select * from public.order_items where order_id = new.id and stock_deducted loop
      perform private.stock_apply_item(i, new.unit_id, -1);
    end loop;
  end if;
  return null;
end $$;
create trigger orders_stock after update of status on public.orders
  for each row execute function private.order_stock();

-- entrada (compra), perda ou contagem (ajuste para a quantidade contada)
create or replace function public.stock_move(p_item_id uuid, p_kind text, p_qty numeric, p_total_cost_cents integer default null,
                                             p_note text default null, p_expense boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare i public.stock_items; v_delta numeric; v_cost numeric; v_move_cost numeric; v_new numeric;
begin
  select * into i from public.stock_items where id = p_item_id for update;
  if not found or not private.can_manage(i.tenant_id) or not private.can_access_unit(i.unit_id) then
    raise exception 'Sem permissão.' using errcode = '42501'; end if;
  if p_qty is null or p_qty < 0 or p_qty > 9999999 then raise exception 'Quantidade inválida.'; end if;
  v_cost := i.cost_cents; v_move_cost := i.cost_cents;
  if p_kind = 'purchase' then
    if p_qty = 0 then raise exception 'Informe a quantidade comprada.'; end if;
    v_delta := p_qty;
    if p_total_cost_cents is not null then
      if p_total_cost_cents < 0 then raise exception 'Valor inválido.'; end if;
      v_move_cost := p_total_cost_cents / p_qty;
      v_cost := case when i.qty > 0 then (i.qty * i.cost_cents + p_total_cost_cents) / (i.qty + p_qty) else v_move_cost end;
    end if;
  elsif p_kind = 'loss' then
    if p_qty = 0 then raise exception 'Informe a quantidade perdida.'; end if;
    if coalesce(trim(p_note), '') = '' then raise exception 'Informe o motivo da perda.'; end if;
    v_delta := -p_qty;
  elsif p_kind = 'adjust' then
    v_delta := p_qty - i.qty;
    if v_delta = 0 then return jsonb_build_object('qty', i.qty, 'cost_cents', i.cost_cents); end if;
  else raise exception 'Tipo de movimentação inválido.'; end if;
  update public.stock_items set qty = qty + v_delta, cost_cents = round(v_cost, 4) where id = i.id returning qty into v_new;
  insert into public.stock_moves (tenant_id, item_id, kind, qty, unit_cost_cents, balance_after, note, created_by)
  values (i.tenant_id, i.id, p_kind, v_delta, round(v_move_cost, 4), v_new, left(nullif(trim(p_note), ''), 200), auth.uid());
  if p_kind = 'purchase' and p_expense and coalesce(p_total_cost_cents, 0) > 0 then
    insert into public.fin_entries (tenant_id, unit_id, kind, description, category, amount_cents, due_date, paid_at, paid_method, created_by)
    values (i.tenant_id, i.unit_id, 'payable', left('Compra de ' || i.name, 160), 'Compras de insumos', p_total_cost_cents,
            (now() at time zone (select timezone from public.units where id = i.unit_id))::date, now(), 'other', auth.uid());
  end if;
  return jsonb_build_object('qty', v_new, 'cost_cents', round(v_cost, 4));
end $$;
grant execute on function public.stock_move(uuid, text, numeric, integer, text, boolean) to authenticated;
