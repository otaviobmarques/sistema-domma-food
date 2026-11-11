-- =====================================================================
-- Domma Food · 042 · Pixel do Meta, Google Analytics 4 e funil de conversão
-- Cada loja informa os IDs das próprias contas (Meta Pixel, GA4 e, se quiser,
-- a conversão do Google Ads). O cardápio só carrega essas ferramentas depois
-- que o cliente aceita os cookies (LGPD).
-- O funil do Domma é próprio e anônimo: sem cookies e sem dado pessoal, conta
-- visitas → produto → sacola → checkout → pedido por sessão do navegador.
-- =====================================================================
create table public.unit_tracking (
  unit_id uuid primary key references public.units(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  meta_pixel_id text check (meta_pixel_id ~ '^[0-9]{8,20}$'),
  ga4_id text check (ga4_id ~ '^G-[A-Z0-9]{4,16}$'),
  ads_id text check (ads_id ~ '^AW-[0-9]{6,15}$'),
  ads_label text check (ads_label ~ '^[A-Za-z0-9_-]{4,40}$'),
  updated_at timestamptz not null default now()
);
alter table public.unit_tracking enable row level security;
alter table public.unit_tracking force row level security;
create policy unit_tracking_select on public.unit_tracking for select to authenticated
  using (private.can_manage(tenant_id) and private.can_access_unit(unit_id));
revoke all on public.unit_tracking from anon;
revoke insert, update, delete on public.unit_tracking from authenticated;

create table public.store_funnel (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  unit_id uuid not null references public.units(id) on delete cascade,
  sid uuid not null,
  step text not null check (step in ('visit','view_item','add_to_cart','checkout','order')),
  source text not null default 'direto' check (char_length(source) between 1 and 40),
  value_cents int check (value_cents between 0 and 10000000),
  created_at timestamptz not null default now(),
  unique (unit_id, sid, step)
);
create index store_funnel_unit_time on public.store_funnel (unit_id, created_at);
alter table public.store_funnel enable row level security;
alter table public.store_funnel force row level security;
revoke all on public.store_funnel from anon, authenticated;

-- IDs públicos que o cardápio precisa (são públicos por natureza: aparecem no HTML)
create or replace function private.tracking_store_info(p_unit_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select case when t.unit_id is null or (t.meta_pixel_id is null and t.ga4_id is null and t.ads_id is null) then null
    else jsonb_build_object('meta_pixel_id', t.meta_pixel_id, 'ga4_id', t.ga4_id, 'ads_id', t.ads_id,
      'ads_label', case when t.ads_id is not null then t.ads_label end) end
  from (select p_unit_id as id) x left join public.unit_tracking t on t.unit_id = x.id;
$$;
revoke execute on function private.tracking_store_info(uuid) from public, anon, authenticated;

do $$
declare d text := pg_get_functiondef('public.get_store(text)'::regprocedure);
begin
  if position('''gateway'', private.gateway_store_info(u.id),' in d) = 0 then raise exception 'get_store mudou'; end if;
  d := replace(d, '''gateway'', private.gateway_store_info(u.id),',
    '''gateway'', private.gateway_store_info(u.id), ''tracking'', private.tracking_store_info(u.id),');
  execute d;
end $$;

-- ---------- Painel ----------
create or replace function public.tracking_get(p_unit_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare u public.units; t public.unit_tracking;
begin
  select * into u from public.units where id = p_unit_id;
  if not found or not private.can_manage(u.tenant_id) or not private.can_access_unit(u.id) then raise exception 'Sem permissão.' using errcode = '42501'; end if;
  select * into t from public.unit_tracking where unit_id = u.id;
  return jsonb_build_object('meta_pixel_id', t.meta_pixel_id, 'ga4_id', t.ga4_id, 'ads_id', t.ads_id, 'ads_label', t.ads_label, 'updated_at', t.updated_at);
end $$;

create or replace function public.tracking_save(p_unit_id uuid, p jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare u public.units;
  v_meta text := nullif(regexp_replace(coalesce(p->>'meta_pixel_id', ''), '\s', '', 'g'), '');
  v_ga text := upper(nullif(regexp_replace(coalesce(p->>'ga4_id', ''), '\s', '', 'g'), ''));
  v_ads text := upper(nullif(regexp_replace(coalesce(p->>'ads_id', ''), '\s', '', 'g'), ''));
  v_label text := nullif(regexp_replace(coalesce(p->>'ads_label', ''), '\s', '', 'g'), '');
begin
  select * into u from public.units where id = p_unit_id;
  if not found or not private.can_manage(u.tenant_id) or not private.can_access_unit(u.id) then raise exception 'Sem permissão.' using errcode = '42501'; end if;
  if v_meta is not null and v_meta !~ '^[0-9]{8,20}$' then raise exception 'ID do Pixel inválido: use só os números (ex.: 1234567890123456).'; end if;
  if v_ga is not null and v_ga !~ '^G-[A-Z0-9]{4,16}$' then raise exception 'ID de métricas do GA4 inválido: começa com G- (ex.: G-AB12CD34EF).'; end if;
  if v_ads is not null and v_ads !~ '^AW-[0-9]{6,15}$' then raise exception 'ID do Google Ads inválido: começa com AW- (ex.: AW-123456789).'; end if;
  if v_label is not null and v_label !~ '^[A-Za-z0-9_-]{4,40}$' then raise exception 'Rótulo de conversão do Google Ads inválido.'; end if;
  if v_label is not null and v_ads is null then raise exception 'Informe o ID do Google Ads junto com o rótulo de conversão.'; end if;
  insert into public.unit_tracking (unit_id, tenant_id, meta_pixel_id, ga4_id, ads_id, ads_label, updated_at)
  values (u.id, u.tenant_id, v_meta, v_ga, v_ads, v_label, now())
  on conflict (unit_id) do update set meta_pixel_id = excluded.meta_pixel_id, ga4_id = excluded.ga4_id,
    ads_id = excluded.ads_id, ads_label = excluded.ads_label, updated_at = now();
end $$;

-- ---------- Cardápio (público, anônimo) ----------
create or replace function public.funnel_track(p_slug text, p_sid uuid, p_step text, p_source text default null, p_value_cents int default null)
returns void language plpgsql security definer set search_path = '' as $$
declare u public.units;
  v_src text := left(nullif(lower(regexp_replace(coalesce(p_source, ''), '[^A-Za-z0-9._-]', '', 'g')), ''), 40);
begin
  if p_sid is null or p_step not in ('visit','view_item','add_to_cart','checkout','order') then return; end if;
  if p_slug is null or p_slug !~ '^[a-z0-9-]{3,50}$' then return; end if;
  select * into u from public.units where slug = p_slug and active;
  if not found then return; end if;
  if (select status from public.tenants where id = u.tenant_id) = 'suspended' then return; end if;
  insert into public.store_funnel (tenant_id, unit_id, sid, step, source, value_cents)
  values (u.tenant_id, u.id, p_sid, p_step, coalesce(v_src, 'direto'),
    case when p_step = 'order' and p_value_cents between 0 and 10000000 then p_value_cents end)
  on conflict (unit_id, sid, step) do nothing;
end $$;

-- ---------- Relatório ----------
create or replace function public.funnel_report(p_unit_id uuid, p_days int default 30)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare u public.units; v_from timestamptz; v_days int := greatest(1, least(coalesce(p_days, 30), 180));
begin
  select * into u from public.units where id = p_unit_id;
  if not found or not private.can_manage(u.tenant_id) or not private.can_access_unit(u.id) then raise exception 'Sem permissão.' using errcode = '42501'; end if;
  v_from := (date_trunc('day', now() at time zone u.timezone) - make_interval(days => v_days - 1)) at time zone u.timezone;
  return jsonb_build_object(
    'days', v_days,
    'steps', (select jsonb_build_object(
        'visit', count(*) filter (where step = 'visit'),
        'view_item', count(*) filter (where step = 'view_item'),
        'add_to_cart', count(*) filter (where step = 'add_to_cart'),
        'checkout', count(*) filter (where step = 'checkout'),
        'order', count(*) filter (where step = 'order'),
        'order_value_cents', coalesce(sum(value_cents) filter (where step = 'order'), 0))
      from public.store_funnel where unit_id = u.id and created_at >= v_from),
    'sources', coalesce((select jsonb_agg(s order by s.visits desc, s.source) from (
        select source, count(*) filter (where step = 'visit') as visits, count(*) filter (where step = 'order') as orders,
          coalesce(sum(value_cents) filter (where step = 'order'), 0) as value_cents
        from public.store_funnel where unit_id = u.id and created_at >= v_from
        group by source order by 2 desc limit 15) s), '[]'::jsonb),
    'daily', coalesce((select jsonb_agg(d order by d.day) from (
        select (created_at at time zone u.timezone)::date as day,
          count(*) filter (where step = 'visit') as visits, count(*) filter (where step = 'order') as orders
        from public.store_funnel where unit_id = u.id and created_at >= v_from group by 1) d), '[]'::jsonb),
    'web_orders', (select count(*) from public.orders where unit_id = u.id and channel = 'web' and created_at >= v_from and status <> 'cancelled'));
end $$;

-- guarda 180 dias de funil
select cron.schedule('domma-funnel-purge', '41 6 * * *', $$delete from public.store_funnel where created_at < now() - interval '180 days'$$);

grant execute on function public.funnel_track(text, uuid, text, text, int) to anon, authenticated;
grant execute on function public.tracking_get(uuid), public.tracking_save(uuid, jsonb), public.funnel_report(uuid, int) to authenticated;
revoke execute on function public.tracking_get(uuid), public.tracking_save(uuid, jsonb), public.funnel_report(uuid, int) from public, anon;
