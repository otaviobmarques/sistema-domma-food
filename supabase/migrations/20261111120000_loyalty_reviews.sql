-- =====================================================================
-- Domma Food · 014 · Fidelidade (cashback e pontos) e avaliações
-- Segurança do cashback: só pode ser USADO em um aparelho que já fez um
-- pedido com aquele telefone (token do aparelho), para ninguém gastar o
-- saldo de outra pessoa só digitando o número dela.
-- =====================================================================
create table public.loyalty_settings (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  cashback_enabled boolean not null default false,
  cashback_pct numeric(5,2) not null default 5 check (cashback_pct between 0 and 50),
  cashback_pct_by_dow numeric(5,2)[] check (cashback_pct_by_dow is null or array_length(cashback_pct_by_dow, 1) = 7),
  cashback_expires_days integer not null default 30 check (cashback_expires_days between 1 and 730),
  cashback_max_use_pct integer not null default 50 check (cashback_max_use_pct between 1 and 90),
  cashback_min_order_cents integer not null default 0 check (cashback_min_order_cents >= 0),
  stack_with_coupon boolean not null default false,
  points_enabled boolean not null default false,
  points_per_real numeric(6,2) not null default 1 check (points_per_real between 0 and 100),
  updated_at timestamptz not null default now()
);
create trigger loyalty_settings_touch before update on public.loyalty_settings for each row execute function private.touch_updated_at();

create table public.rewards (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  description text,
  points_cost integer not null check (points_cost > 0),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.loyalty_ledger (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  kind text not null check (kind in ('cashback','points')),
  amount integer not null check (amount <> 0),          -- centavos (cashback) ou pontos; negativo = uso
  reason text not null check (reason in ('earn','redeem','refund','expire','manual','reward')),
  order_id uuid references public.orders(id) on delete set null,
  reward_id uuid references public.rewards(id) on delete set null,
  note text,
  expires_at timestamptz,
  expired boolean not null default false,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index loyalty_ledger_customer_idx on public.loyalty_ledger(customer_id, created_at desc);
create index loyalty_ledger_expiry_idx on public.loyalty_ledger(expires_at) where amount > 0 and not expired and expires_at is not null;

alter table public.customers
  add column cashback_cents integer not null default 0,
  add column points_balance integer not null default 0;
alter table public.orders add column cashback_used_cents integer not null default 0 check (cashback_used_cents >= 0);

create table public.customer_devices (
  token_hash text primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index customer_devices_customer_idx on public.customer_devices(customer_id);

create table public.reviews (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  unit_id uuid not null references public.units(id) on delete cascade,
  order_id uuid not null unique references public.orders(id) on delete cascade,
  customer_id uuid references public.customers(id) on delete set null,
  customer_name text not null,
  rating smallint not null check (rating between 1 and 5),
  comment text check (comment is null or char_length(comment) <= 1000),
  reply text check (reply is null or char_length(reply) <= 1000),
  replied_at timestamptz,
  is_public boolean not null default true,
  created_at timestamptz not null default now()
);
create index reviews_unit_idx on public.reviews(unit_id, created_at desc);

-- ---------- RLS ----------
do $$ declare t text; begin
  foreach t in array array['loyalty_settings','rewards','loyalty_ledger','customer_devices','reviews'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
end $$;
revoke all on public.customer_devices from authenticated;
revoke insert, update, delete on public.loyalty_ledger from authenticated;
revoke insert, update, delete on public.reviews from authenticated;
grant update (reply, replied_at, is_public) on public.reviews to authenticated;
create policy ls_select on public.loyalty_settings for select to authenticated using (private.is_member(tenant_id));
create policy ls_write on public.loyalty_settings for all to authenticated using (private.can_manage(tenant_id)) with check (private.can_manage(tenant_id));
create policy rw_select on public.rewards for select to authenticated using (private.is_member(tenant_id));
create policy rw_write on public.rewards for all to authenticated using (private.can_manage(tenant_id)) with check (private.can_manage(tenant_id));
create policy ll_select on public.loyalty_ledger for select to authenticated
  using (private.has_role(tenant_id, array['owner','manager','cashier','attendant']::public.member_role[]));
create policy rv_select on public.reviews for select to authenticated using (private.is_member(tenant_id));
create policy rv_update on public.reviews for update to authenticated using (private.can_manage(tenant_id)) with check (private.can_manage(tenant_id));
create trigger loyalty_settings_audit after insert or update on public.loyalty_settings for each row execute function private.audit_row();

-- ---------- Saldo em cache no cliente ----------
create or replace function private.ledger_apply()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.kind = 'cashback' then
    update public.customers set cashback_cents = greatest(cashback_cents + new.amount, 0) where id = new.customer_id;
  else
    update public.customers set points_balance = greatest(points_balance + new.amount, 0) where id = new.customer_id;
  end if;
  return new;
end $$;
create trigger loyalty_ledger_apply after insert on public.loyalty_ledger for each row execute function private.ledger_apply();

-- ---------- Cotação de fidelidade (quanto pode usar / vai ganhar) ----------
create or replace function private.loyalty_quote(p jsonb, q jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  s public.loyalty_settings; v_cust uuid; v_bal int := 0; v_applied int := 0; v_blocked text; v_base int;
  v_pct numeric; v_earn int := 0; v_points int := 0; v_tz text; v_dow int;
begin
  select * into s from public.loyalty_settings where tenant_id = (q->>'tenant_id')::uuid;
  if not found or (not s.cashback_enabled and not s.points_enabled) then
    return jsonb_build_object('cashback_available', 0, 'cashback_applied', 0, 'cashback_earn', 0, 'points_earn', 0);
  end if;
  v_base := least((q->>'subtotal_cents')::int, (q->>'total_cents')::int);
  if s.cashback_enabled then
    select c.id, c.cashback_cents into v_cust, v_bal from public.customers c
     where c.tenant_id = s.tenant_id and c.phone = private.only_digits(p->'customer'->>'phone');
    if v_cust is null or coalesce(p->>'device_token', '') = '' or not exists (
        select 1 from public.customer_devices d where d.customer_id = v_cust
           and d.token_hash = encode(extensions.digest(p->>'device_token', 'sha256'), 'hex')) then
      v_bal := 0;
    end if;
    if coalesce((p->>'use_cashback')::boolean, false) and v_bal > 0 then
      if q->>'coupon_id' is not null and not s.stack_with_coupon then v_blocked := 'coupon';
      else v_applied := least(v_bal, floor(v_base * s.cashback_max_use_pct / 100.0)::int); end if;
    end if;
    select timezone into v_tz from public.units where id = (q->>'unit_id')::uuid;
    v_dow := extract(dow from now() at time zone coalesce(v_tz, 'America/Sao_Paulo'))::int;
    v_pct := coalesce(s.cashback_pct_by_dow[v_dow + 1], s.cashback_pct);
    if v_base - v_applied >= s.cashback_min_order_cents then v_earn := floor((v_base - v_applied) * v_pct / 100.0)::int; end if;
  end if;
  if s.points_enabled then v_points := floor((v_base - v_applied) / 100.0 * s.points_per_real)::int; end if;
  return jsonb_build_object('cashback_available', v_bal, 'cashback_applied', v_applied, 'cashback_blocked', v_blocked,
    'cashback_earn', v_earn, 'points_earn', v_points, 'cashback_max_use_pct', s.cashback_max_use_pct);
end $$;

create or replace function public.quote_order(p jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare r jsonb; l jsonb;
begin
  r := private.compute_order(p);
  l := private.loyalty_quote(p, r);
  return (r - 'tenant_id' - 'auto_accept') || l
      || jsonb_build_object('total_cents', (r->>'total_cents')::int - (l->>'cashback_applied')::int);
end $$;

-- ---------- place_order: o núcleo antigo vira interno; o novo aplica cashback ----------
alter function public.place_order(jsonb) set schema private;
alter function private.place_order(jsonb) rename to place_order_core;
revoke execute on function private.place_order_core(jsonb) from public, anon, authenticated;

create or replace function public.place_order(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  q jsonb; l jsonb; r jsonb; v_applied int; v_order uuid; v_total int; v_cust uuid; v_tenant uuid; v_token text;
  v_change int := (p->>'change_for_cents')::int;
begin
  q := private.compute_order(p);
  l := private.loyalty_quote(p, q);
  v_applied := (l->>'cashback_applied')::int;
  r := private.place_order_core(p - 'change_for_cents');
  v_order := (r->>'order_id')::uuid;
  v_total := (r->>'total_cents')::int - v_applied;
  select customer_id, tenant_id into v_cust, v_tenant from public.orders where id = v_order;
  if p->>'payment_method' = 'cash' and v_change is not null and v_change < v_total then
    raise exception 'O troco deve ser para um valor maior que o total.';
  end if;
  update public.orders set cashback_used_cents = v_applied, total_cents = v_total,
         change_for_cents = case when payment_method = 'cash' then v_change end where id = v_order;
  if v_applied > 0 then
    update public.payments set amount_cents = v_total where order_id = v_order;
    insert into public.loyalty_ledger (tenant_id, customer_id, kind, amount, reason, order_id)
    values (v_tenant, v_cust, 'cashback', -v_applied, 'redeem', v_order);
  end if;
  -- token do aparelho: libera o uso do cashback neste aparelho nos próximos pedidos
  v_token := encode(extensions.gen_random_bytes(24), 'hex');
  insert into public.customer_devices (token_hash, tenant_id, customer_id)
  values (encode(extensions.digest(v_token, 'sha256'), 'hex'), v_tenant, v_cust);
  delete from public.customer_devices d where d.customer_id = v_cust and d.token_hash not in (
    select token_hash from public.customer_devices where customer_id = v_cust order by created_at desc limit 5);
  return r || jsonb_build_object('total_cents', v_total, 'cashback_used_cents', v_applied, 'device_token', v_token);
end $$;

-- ---------- Crédito ao concluir; devolução ao cancelar ----------
create or replace function private.loyalty_on_order()
returns trigger language plpgsql security definer set search_path = '' as $$
declare s public.loyalty_settings; v_base int; v_pct numeric; v_tz text; v_dow int; v_amt int;
begin
  if new.customer_id is null or new.status = old.status then return new; end if;
  select * into s from public.loyalty_settings where tenant_id = new.tenant_id;
  if not found then return new; end if;
  if new.status = 'cancelled' and new.cashback_used_cents > 0 then
    insert into public.loyalty_ledger (tenant_id, customer_id, kind, amount, reason, order_id, expires_at, note)
    values (new.tenant_id, new.customer_id, 'cashback', new.cashback_used_cents, 'refund', new.id,
            now() + make_interval(days => s.cashback_expires_days), 'Pedido cancelado');
  elsif new.status = 'completed' and new.connection_id is null then
    v_base := greatest(least(new.subtotal_cents, new.total_cents), 0);
    if s.cashback_enabled and v_base >= s.cashback_min_order_cents then
      select timezone into v_tz from public.units where id = new.unit_id;
      v_dow := extract(dow from now() at time zone coalesce(v_tz, 'America/Sao_Paulo'))::int;
      v_pct := coalesce(s.cashback_pct_by_dow[v_dow + 1], s.cashback_pct);
      v_amt := floor(v_base * v_pct / 100.0)::int;
      if v_amt > 0 then
        insert into public.loyalty_ledger (tenant_id, customer_id, kind, amount, reason, order_id, expires_at)
        values (new.tenant_id, new.customer_id, 'cashback', v_amt, 'earn', new.id, now() + make_interval(days => s.cashback_expires_days));
      end if;
    end if;
    if s.points_enabled then
      v_amt := floor(v_base / 100.0 * s.points_per_real)::int;
      if v_amt > 0 then
        insert into public.loyalty_ledger (tenant_id, customer_id, kind, amount, reason, order_id)
        values (new.tenant_id, new.customer_id, 'points', v_amt, 'earn', new.id);
      end if;
    end if;
  end if;
  return new;
end $$;
create trigger orders_loyalty after update of status on public.orders for each row execute function private.loyalty_on_order();

-- ---------- Expiração diária do cashback ----------
create or replace function private.loyalty_expire()
returns integer language plpgsql security definer set search_path = '' as $$
declare r record; v_bal int; v_amt int; n int := 0;
begin
  for r in select * from public.loyalty_ledger where kind = 'cashback' and amount > 0 and not expired
             and expires_at is not null and expires_at < now() order by expires_at for update skip locked loop
    select cashback_cents into v_bal from public.customers where id = r.customer_id;
    v_amt := least(r.amount, coalesce(v_bal, 0));
    update public.loyalty_ledger set expired = true where id = r.id;
    if v_amt > 0 then
      insert into public.loyalty_ledger (tenant_id, customer_id, kind, amount, reason, note)
      values (r.tenant_id, r.customer_id, 'cashback', -v_amt, 'expire', 'Saldo expirado');
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;

-- ---------- RPCs públicas (cliente final) ----------
create or replace function public.loyalty_info(p_slug text, p_phone text default null, p_device_token text default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare u public.units; s public.loyalty_settings; v_dow int; c public.customers; v_ok boolean := false;
begin
  select * into u from public.units where slug = lower(p_slug) and active;
  if not found then return null; end if;
  select * into s from public.loyalty_settings where tenant_id = u.tenant_id;
  if not found then return jsonb_build_object('cashback_enabled', false, 'points_enabled', false); end if;
  v_dow := extract(dow from now() at time zone u.timezone)::int;
  if coalesce(p_device_token, '') <> '' then
    select cu.* into c from public.customers cu where cu.tenant_id = u.tenant_id and cu.phone = private.only_digits(p_phone);
    v_ok := c.id is not null and exists (select 1 from public.customer_devices d where d.customer_id = c.id
              and d.token_hash = encode(extensions.digest(p_device_token, 'sha256'), 'hex'));
  end if;
  return jsonb_build_object(
    'cashback_enabled', s.cashback_enabled,
    'cashback_pct_today', case when s.cashback_enabled then coalesce(s.cashback_pct_by_dow[v_dow + 1], s.cashback_pct) else 0 end,
    'cashback_expires_days', s.cashback_expires_days, 'cashback_max_use_pct', s.cashback_max_use_pct,
    'points_enabled', s.points_enabled, 'points_per_real', s.points_per_real,
    'known_device', v_ok,
    'cashback_cents', case when v_ok then c.cashback_cents end,
    'points', case when v_ok then c.points_balance end,
    'rewards', case when s.points_enabled then coalesce((select jsonb_agg(jsonb_build_object('name', r.name, 'description', r.description, 'points_cost', r.points_cost) order by r.points_cost)
                 from public.rewards r where r.tenant_id = u.tenant_id and r.active), '[]'::jsonb) else '[]'::jsonb end);
end $$;

create or replace function public.order_extras(p_token text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'can_review', o.status = 'completed' and o.completed_at > now() - interval '30 days'
                  and not exists (select 1 from public.reviews r where r.order_id = o.id),
    'review', (select jsonb_build_object('rating', r.rating, 'comment', r.comment, 'reply', r.reply) from public.reviews r where r.order_id = o.id),
    'cashback_used_cents', o.cashback_used_cents,
    'cashback_earned_cents', coalesce((select sum(l.amount) from public.loyalty_ledger l where l.order_id = o.id and l.kind = 'cashback' and l.reason = 'earn'), 0),
    'points_earned', coalesce((select sum(l.amount) from public.loyalty_ledger l where l.order_id = o.id and l.kind = 'points' and l.reason = 'earn'), 0))
  from public.orders o where o.public_token = p_token and length(p_token) = 36;
$$;

create or replace function public.submit_review(p_token text, p_rating integer, p_comment text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare o public.orders;
begin
  select * into o from public.orders where public_token = p_token and length(p_token) = 36;
  if not found then raise exception 'Pedido não encontrado.'; end if;
  if o.status <> 'completed' or o.completed_at < now() - interval '30 days' then raise exception 'Este pedido não pode ser avaliado.'; end if;
  if p_rating is null or p_rating < 1 or p_rating > 5 then raise exception 'Escolha uma nota de 1 a 5.'; end if;
  if exists (select 1 from public.reviews where order_id = o.id) then raise exception 'Este pedido já foi avaliado. Obrigado!'; end if;
  insert into public.reviews (tenant_id, unit_id, order_id, customer_id, customer_name, rating, comment)
  values (o.tenant_id, o.unit_id, o.id, o.customer_id, split_part(o.customer_name, ' ', 1), p_rating, left(nullif(trim(p_comment), ''), 1000));
end $$;

create or replace function public.store_reviews(p_slug text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'average', (select round(avg(r.rating)::numeric, 1) from public.reviews r where r.unit_id = u.id),
    'count', (select count(*) from public.reviews r where r.unit_id = u.id),
    'recent', coalesce((select jsonb_agg(to_jsonb(x)) from (
        select r.customer_name as name, r.rating, r.comment, r.reply, r.created_at from public.reviews r
        where r.unit_id = u.id and r.is_public and r.comment is not null order by r.created_at desc limit 8) x), '[]'::jsonb))
  from public.units u where u.slug = lower(p_slug) and u.active;
$$;

-- ---------- RPCs do painel ----------
create or replace function public.loyalty_adjust(p_customer_id uuid, p_kind text, p_amount integer, p_note text)
returns void language plpgsql security definer set search_path = '' as $$
declare c public.customers; s public.loyalty_settings;
begin
  select * into c from public.customers where id = p_customer_id;
  if not found or not private.can_manage(c.tenant_id) then raise exception 'Sem permissão.' using errcode = '42501'; end if;
  if p_kind not in ('cashback','points') or coalesce(p_amount, 0) = 0 then raise exception 'Valor inválido.'; end if;
  if coalesce(trim(p_note), '') = '' then raise exception 'Informe o motivo do ajuste.'; end if;
  if p_amount < 0 and -p_amount > (case when p_kind = 'cashback' then c.cashback_cents else c.points_balance end) then
    raise exception 'O cliente não tem saldo suficiente.'; end if;
  select * into s from public.loyalty_settings where tenant_id = c.tenant_id;
  insert into public.loyalty_ledger (tenant_id, customer_id, kind, amount, reason, note, expires_at, created_by)
  values (c.tenant_id, c.id, p_kind, p_amount, 'manual', left(p_note, 200),
          case when p_kind = 'cashback' and p_amount > 0 then now() + make_interval(days => coalesce(s.cashback_expires_days, 30)) end, auth.uid());
end $$;

create or replace function public.redeem_reward(p_customer_id uuid, p_reward_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare c public.customers; r public.rewards;
begin
  select * into c from public.customers where id = p_customer_id for update;
  if not found or not private.has_role(c.tenant_id, array['owner','manager','cashier','attendant']::public.member_role[]) then
    raise exception 'Sem permissão.' using errcode = '42501'; end if;
  select * into r from public.rewards where id = p_reward_id and tenant_id = c.tenant_id and active;
  if not found then raise exception 'Recompensa indisponível.'; end if;
  if c.points_balance < r.points_cost then raise exception 'Faltam % pontos para esta recompensa.', r.points_cost - c.points_balance; end if;
  insert into public.loyalty_ledger (tenant_id, customer_id, kind, amount, reason, reward_id, note, created_by)
  values (c.tenant_id, c.id, 'points', -r.points_cost, 'reward', r.id, r.name, auth.uid());
end $$;

revoke execute on function public.quote_order(jsonb), public.place_order(jsonb), public.loyalty_info(text, text, text),
  public.order_extras(text), public.submit_review(text, integer, text), public.store_reviews(text),
  public.loyalty_adjust(uuid, text, integer, text), public.redeem_reward(uuid, uuid) from public, anon, authenticated;
grant execute on function public.quote_order(jsonb), public.place_order(jsonb), public.loyalty_info(text, text, text),
  public.order_extras(text), public.submit_review(text, integer, text), public.store_reviews(text) to anon, authenticated;
grant execute on function public.loyalty_adjust(uuid, text, integer, text), public.redeem_reward(uuid, uuid) to authenticated;
