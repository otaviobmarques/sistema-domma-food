-- =====================================================================
-- Domma Food · 001 · Esquema principal (multiempresa)
-- Hierarquia: tenant (empresa/rede) -> units (lojas) -> memberships (perfis)
-- Todas as tabelas de negócio carregam tenant_id e têm RLS ativo.
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;
create extension if not exists unaccent with schema extensions;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

-- ---------- Tipos ----------
create type public.member_role as enum
  ('owner','manager','cashier','attendant','kitchen','waiter','courier');

create type public.order_status as enum
  ('awaiting_payment','pending','preparing','ready','dispatched',
   'awaiting_pickup','completed','cancelled');

create type public.order_type as enum ('delivery','pickup','dine_in');

create type public.order_channel as enum
  ('web','whatsapp','ifood','counter','table','totem','phone');

create type public.payment_method as enum
  ('pix','cash','card_on_delivery','voucher','online_card');

create type public.payment_status as enum ('pending','paid','refunded','failed');

create type public.tenant_status as enum ('trial','active','past_due','suspended');

-- ---------- Utilitário: updated_at ----------
create or replace function private.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ---------- Planos (SaaS) ----------
create table public.plans (
  id text primary key,
  name text not null,
  price_cents integer not null check (price_cents >= 0),
  max_units integer not null default 1,
  max_users integer not null default 5,
  features text[] not null default '{}',
  active boolean not null default true,
  created_at timestamptz not null default now()
);

insert into public.plans (id, name, price_cents, max_units, max_users, features) values
  ('essencial','Essencial',14900,1,5, array['menu','orders','coupons','dashboard']),
  ('delivery','Delivery',22900,1,10, array['menu','orders','coupons','dashboard','delivery','crm','loyalty']),
  ('salao','Salão',22900,1,15, array['menu','orders','coupons','dashboard','tables','kds']),
  ('completo','Completo',38900,3,30, array['menu','orders','coupons','dashboard','delivery','crm','loyalty','tables','kds','inventory','finance','ai']);

-- ---------- Tenants ----------
create table public.tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 2 and 120),
  cnpj text check (cnpj is null or cnpj ~ '^[0-9]{14}$'),
  plan_id text not null default 'essencial' references public.plans(id),
  status public.tenant_status not null default 'trial',
  trial_ends_at timestamptz not null default (now() + interval '14 days'),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger tenants_touch before update on public.tenants
  for each row execute function private.touch_updated_at();

-- ---------- Unidades (lojas) ----------
create table public.units (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null check (char_length(name) between 2 and 120),
  slug text not null unique check (slug ~ '^[a-z0-9](?:[a-z0-9-]{1,48}[a-z0-9])$'),
  phone text,
  whatsapp text,
  street text, number text, complement text, neighborhood text,
  city text, state text check (state is null or state ~ '^[A-Z]{2}$'), zip text,
  lat double precision check (lat is null or lat between -90 and 90),
  lng double precision check (lng is null or lng between -180 and 180),
  timezone text not null default 'America/Sao_Paulo',
  -- {"mon":[["18:00","23:30"]],"tue":[...],...}
  opening_hours jsonb not null default
    '{"mon":[["18:00","23:00"]],"tue":[["18:00","23:00"]],"wed":[["18:00","23:00"]],"thu":[["18:00","23:00"]],"fri":[["18:00","23:59"]],"sat":[["18:00","23:59"]],"sun":[["18:00","23:00"]]}'::jsonb,
  is_open_override boolean,               -- null = segue horário; true/false = forçado
  accepts_delivery boolean not null default true,
  accepts_pickup boolean not null default true,
  accepts_scheduling boolean not null default false,
  auto_accept boolean not null default false,
  min_order_cents integer not null default 0 check (min_order_cents >= 0),
  prep_time_min integer not null default 20 check (prep_time_min between 0 and 600),
  pickup_time_min integer not null default 20 check (pickup_time_min between 0 and 600),
  accepted_payments public.payment_method[] not null default array['pix','cash','card_on_delivery']::public.payment_method[],
  pix_key text,
  pix_merchant_name text,
  pix_merchant_city text,
  pix_expires_min integer not null default 30 check (pix_expires_min between 5 and 1440),
  logo_url text,
  cover_url text,
  primary_color text not null default '#6D28D9' check (primary_color ~ '^#[0-9A-Fa-f]{6}$'),
  description text,
  order_counter integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index units_tenant_idx on public.units(tenant_id);
create trigger units_touch before update on public.units
  for each row execute function private.touch_updated_at();

-- Slugs reservados (rotas do sistema)
create or replace function private.check_unit_slug()
returns trigger language plpgsql as $$
begin
  if new.slug = any (array['admin','api','app','painel','login','cadastro','auth',
     'pedido','loja','www','suporte','ajuda','status','onboarding','domma']) then
    raise exception 'slug reservado: %', new.slug using errcode = '23514';
  end if;
  return new;
end $$;
create trigger units_slug_check before insert or update of slug on public.units
  for each row execute function private.check_unit_slug();

-- ---------- Perfis e vínculos ----------
create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  phone text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger profiles_touch before update on public.profiles
  for each row execute function private.touch_updated_at();

create table public.memberships (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.member_role not null,
  unit_ids uuid[],                      -- null = todas as unidades
  max_discount_pct numeric(5,2) not null default 0 check (max_discount_pct between 0 and 100),
  created_at timestamptz not null default now(),
  unique (tenant_id, user_id)
);
create index memberships_user_idx on public.memberships(user_id);

create table public.platform_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

-- Cria profile automaticamente no cadastro
create or replace function private.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, full_name, phone)
  values (new.id,
          left(coalesce(new.raw_user_meta_data->>'full_name', ''), 120),
          left(coalesce(new.raw_user_meta_data->>'phone', ''), 20));
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function private.handle_new_user();

-- ---------- Funções de autorização (usadas pelo RLS) ----------
create or replace function private.is_platform_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.platform_admins where user_id = (select auth.uid()));
$$;

create or replace function private.is_member(t uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.memberships m
    where m.tenant_id = t and m.user_id = (select auth.uid())
  );
$$;

create or replace function private.has_role(t uuid, roles public.member_role[])
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.memberships m
    where m.tenant_id = t and m.user_id = (select auth.uid()) and m.role = any (roles)
  );
$$;

-- Acesso a uma unidade específica (respeita unit_ids do vínculo)
create or replace function private.can_access_unit(u uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.units un
    join public.memberships m on m.tenant_id = un.tenant_id
    where un.id = u and m.user_id = (select auth.uid())
      and (m.unit_ids is null or u = any (m.unit_ids))
  );
$$;

create or replace function private.can_manage(t uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.has_role(t, array['owner','manager']::public.member_role[]);
$$;

-- ---------- Catálogo ----------
create table public.categories (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  description text,
  position integer not null default 0,
  active boolean not null default true,
  available_days smallint[],            -- 0=dom ... 6=sáb; null = todos
  available_from time,
  available_to time,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index categories_tenant_idx on public.categories(tenant_id, position);
create trigger categories_touch before update on public.categories
  for each row execute function private.touch_updated_at();

create table public.products (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  category_id uuid not null references public.categories(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  description text check (description is null or char_length(description) <= 1000),
  image_url text,
  price_cents integer not null check (price_cents >= 0),
  promo_price_cents integer check (promo_price_cents is null or promo_price_cents >= 0),
  position integer not null default 0,
  active boolean not null default true,
  paused_until timestamptz,             -- "esgotado até"
  featured boolean not null default false,
  tags text[] not null default '{}',    -- novo, vegano, picante...
  channels public.order_channel[] not null default array['web','whatsapp','counter','table','totem','phone']::public.order_channel[],
  sku text, barcode text,
  ncm text, cfop text, cest text, csosn text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index products_tenant_idx on public.products(tenant_id, category_id, position);
create trigger products_touch before update on public.products
  for each row execute function private.touch_updated_at();

-- Preço/disponibilidade por unidade (redes)
create table public.product_unit_overrides (
  product_id uuid not null references public.products(id) on delete cascade,
  unit_id uuid not null references public.units(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  price_cents integer check (price_cents is null or price_cents >= 0),
  available boolean not null default true,
  primary key (product_id, unit_id)
);

create table public.option_groups (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  min_select integer not null default 0 check (min_select >= 0),
  max_select integer not null default 1 check (max_select >= 1),
  allow_repeat boolean not null default false,       -- ex.: 2x bacon
  price_rule text not null default 'sum' check (price_rule in ('sum','max','avg')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (max_select >= min_select)
);
create index option_groups_tenant_idx on public.option_groups(tenant_id);
create trigger option_groups_touch before update on public.option_groups
  for each row execute function private.touch_updated_at();

create table public.options (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  group_id uuid not null references public.option_groups(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  description text,
  price_cents integer not null default 0 check (price_cents >= 0),
  active boolean not null default true,
  position integer not null default 0
);
create index options_group_idx on public.options(group_id, position);

create table public.product_option_groups (
  product_id uuid not null references public.products(id) on delete cascade,
  group_id uuid not null references public.option_groups(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  position integer not null default 0,
  primary key (product_id, group_id)
);

-- Garante que vínculos de catálogo não cruzem tenants
create or replace function private.check_same_tenant()
returns trigger language plpgsql security definer set search_path = '' as $$
declare t1 uuid; t2 uuid;
begin
  if tg_table_name = 'products' then
    select tenant_id into t1 from public.categories where id = new.category_id;
    if t1 is distinct from new.tenant_id then raise exception 'categoria de outro tenant'; end if;
  elsif tg_table_name = 'options' then
    select tenant_id into t1 from public.option_groups where id = new.group_id;
    if t1 is distinct from new.tenant_id then raise exception 'grupo de outro tenant'; end if;
  elsif tg_table_name = 'product_option_groups' then
    select tenant_id into t1 from public.products where id = new.product_id;
    select tenant_id into t2 from public.option_groups where id = new.group_id;
    if t1 is distinct from new.tenant_id or t2 is distinct from new.tenant_id then
      raise exception 'vínculo entre tenants diferentes'; end if;
  elsif tg_table_name = 'product_unit_overrides' then
    select tenant_id into t1 from public.products where id = new.product_id;
    select tenant_id into t2 from public.units where id = new.unit_id;
    if t1 is distinct from new.tenant_id or t2 is distinct from new.tenant_id then
      raise exception 'vínculo entre tenants diferentes'; end if;
  end if;
  return new;
end $$;
create trigger products_tenant_chk before insert or update on public.products
  for each row execute function private.check_same_tenant();
create trigger options_tenant_chk before insert or update on public.options
  for each row execute function private.check_same_tenant();
create trigger pog_tenant_chk before insert or update on public.product_option_groups
  for each row execute function private.check_same_tenant();
create trigger puo_tenant_chk before insert or update on public.product_unit_overrides
  for each row execute function private.check_same_tenant();

-- ---------- Entregas ----------
create table public.delivery_zones (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  unit_id uuid not null references public.units(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  kind text not null check (kind in ('radius','neighborhood')),
  radius_km numeric(6,2) check (radius_km is null or radius_km > 0),
  neighborhoods text[] not null default '{}',
  fee_cents integer not null default 0 check (fee_cents >= 0),
  min_order_cents integer not null default 0 check (min_order_cents >= 0),
  free_above_cents integer check (free_above_cents is null or free_above_cents > 0),
  eta_min integer not null default 45 check (eta_min between 0 and 600),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  check (kind <> 'radius' or radius_km is not null)
);
create index delivery_zones_unit_idx on public.delivery_zones(unit_id);

-- ---------- Clientes (CRM básico) ----------
create table public.customers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  phone text not null check (phone ~ '^[0-9]{10,13}$'),
  email text,
  birthday date,
  tags text[] not null default '{}',
  opt_in_marketing boolean not null default false,
  orders_count integer not null default 0,
  total_spent_cents bigint not null default 0,
  first_order_at timestamptz,
  last_order_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, phone)
);
create trigger customers_touch before update on public.customers
  for each row execute function private.touch_updated_at();

create table public.customer_addresses (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  street text not null, number text, complement text, neighborhood text,
  city text, state text, zip text, reference text,
  lat double precision, lng double precision,
  created_at timestamptz not null default now()
);
create index customer_addresses_customer_idx on public.customer_addresses(customer_id);

-- ---------- Cupons ----------
create table public.coupons (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  code text not null check (code ~ '^[A-Z0-9_-]{3,30}$'),
  description text,
  kind text not null check (kind in ('percent','fixed','free_delivery')),
  value integer not null default 0 check (value >= 0),  -- % (0-100) ou centavos
  min_order_cents integer not null default 0 check (min_order_cents >= 0),
  max_discount_cents integer check (max_discount_cents is null or max_discount_cents > 0),
  max_uses integer check (max_uses is null or max_uses > 0),
  uses_count integer not null default 0,
  max_uses_per_customer integer check (max_uses_per_customer is null or max_uses_per_customer > 0),
  first_order_only boolean not null default false,
  starts_at timestamptz,
  ends_at timestamptz,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, code),
  check (kind <> 'percent' or value between 1 and 100)
);
create trigger coupons_touch before update on public.coupons
  for each row execute function private.touch_updated_at();

-- ---------- Pedidos ----------
create table public.orders (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  unit_id uuid not null references public.units(id) on delete cascade,
  number integer not null,
  public_token text not null unique
    default encode(extensions.gen_random_bytes(18), 'hex'),
  channel public.order_channel not null default 'web',
  type public.order_type not null,
  status public.order_status not null default 'pending',
  customer_id uuid references public.customers(id) on delete set null,
  customer_name text not null,
  customer_phone text not null,
  address jsonb,
  zone_id uuid references public.delivery_zones(id) on delete set null,
  scheduled_for timestamptz,
  subtotal_cents integer not null check (subtotal_cents >= 0),
  discount_cents integer not null default 0 check (discount_cents >= 0),
  delivery_fee_cents integer not null default 0 check (delivery_fee_cents >= 0),
  total_cents integer not null check (total_cents >= 0),
  payment_method public.payment_method not null,
  payment_status public.payment_status not null default 'pending',
  change_for_cents integer check (change_for_cents is null or change_for_cents >= 0),
  coupon_id uuid references public.coupons(id) on delete set null,
  coupon_code text,
  notes text check (notes is null or char_length(notes) <= 500),
  cancel_reason text,
  estimated_ready_at timestamptz,
  accepted_at timestamptz, ready_at timestamptz, dispatched_at timestamptz,
  completed_at timestamptz, cancelled_at timestamptz, paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (unit_id, number)
);
create index orders_unit_status_idx on public.orders(unit_id, status, created_at desc);
create index orders_tenant_created_idx on public.orders(tenant_id, created_at desc);
create index orders_customer_idx on public.orders(customer_id);
create trigger orders_touch before update on public.orders
  for each row execute function private.touch_updated_at();

create table public.order_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  order_id uuid not null references public.orders(id) on delete cascade,
  product_id uuid references public.products(id) on delete set null,
  name text not null,
  quantity integer not null check (quantity between 1 and 99),
  unit_price_cents integer not null check (unit_price_cents >= 0),
  total_cents integer not null check (total_cents >= 0),
  options jsonb not null default '[]',
  notes text check (notes is null or char_length(notes) <= 300)
);
create index order_items_order_idx on public.order_items(order_id);

create table public.order_events (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  order_id uuid not null references public.orders(id) on delete cascade,
  from_status public.order_status,
  to_status public.order_status not null,
  note text,
  actor_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index order_events_order_idx on public.order_events(order_id, created_at);

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  order_id uuid not null references public.orders(id) on delete cascade,
  method public.payment_method not null,
  gateway text not null default 'manual',
  amount_cents integer not null check (amount_cents >= 0),
  fee_cents integer not null default 0,
  status public.payment_status not null default 'pending',
  txid text,
  confirmed_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index payments_order_idx on public.payments(order_id);
create trigger payments_touch before update on public.payments
  for each row execute function private.touch_updated_at();

create table public.coupon_redemptions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  coupon_id uuid not null references public.coupons(id) on delete cascade,
  customer_id uuid references public.customers(id) on delete set null,
  order_id uuid not null references public.orders(id) on delete cascade,
  discount_cents integer not null,
  created_at timestamptz not null default now()
);
create index coupon_redemptions_idx on public.coupon_redemptions(coupon_id, customer_id);

-- ---------- Auditoria ----------
create table public.audit_logs (
  id bigint generated always as identity primary key,
  tenant_id uuid references public.tenants(id) on delete cascade,
  actor_id uuid,
  action text not null,
  entity text not null,
  entity_id text,
  before jsonb,
  after jsonb,
  ip text,
  created_at timestamptz not null default now()
);
create index audit_logs_tenant_idx on public.audit_logs(tenant_id, created_at desc);
