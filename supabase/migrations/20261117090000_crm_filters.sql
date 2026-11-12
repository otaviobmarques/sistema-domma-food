-- =====================================================================
-- Domma Food · 044 · CRM com filtros avançados
-- Filtros combináveis sobre a base de clientes (frequência, gasto, ticket,
-- recência, aniversário, bairro, canal, produto comprado, forma de pagamento,
-- loja, cashback, fiado, etiquetas e marketing), filtros salvos, etiquetas em
-- massa e uso do filtro como público das campanhas.
-- =====================================================================
create table public.crm_segments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  filter jsonb not null default '{}' check (jsonb_typeof(filter) = 'object' and pg_column_size(filter) < 8000),
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, name)
);
alter table public.crm_segments enable row level security;
alter table public.crm_segments force row level security;
create policy crm_segments_select on public.crm_segments for select to authenticated using (private.can_manage(tenant_id));
revoke all on public.crm_segments from anon;
revoke insert, update, delete on public.crm_segments from authenticated;
create index customers_tags_gin on public.customers using gin (tags);

-- lista de texto de um jsonb (array) → text[] (ignora o que não for texto)
create or replace function private.jtext(j jsonb)
returns text[] language sql immutable set search_path = '' as $$
  select case when jsonb_typeof(j) = 'array' then coalesce((select array_agg(x) from jsonb_array_elements_text(j) x where x <> ''), '{}') end;
$$;
create or replace function private.jint(j jsonb)
returns int language sql immutable set search_path = '' as $$
  select case when jsonb_typeof(j) = 'number' then least(greatest(j::text::numeric, -2000000000), 2000000000)::int
              when jsonb_typeof(j) = 'string' and j #>> '{}' ~ '^-?[0-9]{1,9}$' then (j #>> '{}')::int end;
$$;

-- Segmento de relacionamento (mesma regra da tela)
create or replace function private.crm_segment(c public.customers)
returns text language sql stable set search_path = '' as $$
  select case
    when c.orders_count = 0 or c.last_order_at is null then 'no_orders'
    when c.last_order_at < now() - interval '60 days' then 'inactive'
    when c.last_order_at < now() - interval '30 days' then 'at_risk'
    when c.orders_count >= 5 then 'loyal'
    when c.orders_count = 1 then 'new'
    else 'recurring' end;
$$;

-- Clientes da conta que atendem ao filtro (todas as condições somam com "E")
create or replace function private.crm_match(p_tenant uuid, f jsonb)
returns setof uuid language sql stable security definer set search_path = '' as $$
  with p as (
    select nullif(trim(f->>'q'), '') as q, nullif(regexp_replace(coalesce(f->>'q', ''), '\D', '', 'g'), '') as qd,
      private.jtext(f->'segments') as segs,
      private.jint(f->'orders_min') as omin, private.jint(f->'orders_max') as omax,
      private.jint(f->'spent_min') as smin, private.jint(f->'spent_max') as smax,
      private.jint(f->'ticket_min') as tmin, private.jint(f->'ticket_max') as tmax,
      private.jint(f->'inactive_days') as idays, private.jint(f->'active_days') as adays,
      private.jint(f->'first_days') as fdays, f->>'birthday' as bday, f->>'marketing' as mkt,
      private.jtext(f->'tags') as tags, private.jtext(f->'channels') as chans,
      private.jtext(f->'products') as prods, private.jtext(f->'neighborhoods') as hoods,
      private.jtext(f->'payments') as pays, nullif(f->>'unit_id', '') as unit,
      private.jint(f->'cashback_min') as cbmin, coalesce((f->>'has_credit')::boolean, false) as credit,
      private.jint(f->'period_days') as pdays
  )
  select c.id from public.customers c, p
  where c.tenant_id = p_tenant
    and (p.q is null or c.name ilike '%' || p.q || '%' or c.email ilike '%' || p.q || '%' or (length(p.qd) >= 3 and c.phone like '%' || p.qd || '%'))
    and (p.segs is null or cardinality(p.segs) = 0 or private.crm_segment(c) = any (p.segs))
    and (p.omin is null or c.orders_count >= p.omin) and (p.omax is null or c.orders_count <= p.omax)
    and (p.smin is null or c.total_spent_cents >= p.smin) and (p.smax is null or c.total_spent_cents <= p.smax)
    and (p.tmin is null or (c.orders_count > 0 and c.total_spent_cents / c.orders_count >= p.tmin))
    and (p.tmax is null or (c.orders_count > 0 and c.total_spent_cents / c.orders_count <= p.tmax))
    and (p.idays is null or c.last_order_at < now() - make_interval(days => greatest(p.idays, 0)))
    and (p.adays is null or c.last_order_at >= now() - make_interval(days => greatest(p.adays, 0)))
    and (p.fdays is null or c.first_order_at >= now() - make_interval(days => greatest(p.fdays, 0)))
    and (p.bday is null or p.bday = '' or (c.birthday is not null and case p.bday
      when 'today' then to_char(c.birthday, 'MM-DD') = to_char(now() at time zone 'America/Sao_Paulo', 'MM-DD')
      when 'week' then exists (select 1 from generate_series(0, 6) g
        where to_char(c.birthday, 'MM-DD') = to_char((now() at time zone 'America/Sao_Paulo')::date + g, 'MM-DD'))
      when 'month' then extract(month from c.birthday) = extract(month from now() at time zone 'America/Sao_Paulo')
      when 'next_month' then extract(month from c.birthday) = extract(month from (now() at time zone 'America/Sao_Paulo') + interval '1 month')
      when 'any' then true else true end))
    and (p.mkt is null or p.mkt = '' or case p.mkt
      when 'opt_in' then c.opt_in_marketing and c.marketing_opt_out_at is null
      when 'not' then not c.opt_in_marketing and c.marketing_opt_out_at is null
      when 'opt_out' then c.marketing_opt_out_at is not null else true end)
    and (p.tags is null or cardinality(p.tags) = 0 or c.tags && p.tags)
    and (p.cbmin is null or c.cashback_cents >= p.cbmin)
    and (not p.credit or c.credit_balance_cents > 0)
    -- condições sobre os pedidos (não cancelados), opcionalmente num período
    and (coalesce(cardinality(p.chans), 0) = 0 and coalesce(cardinality(p.prods), 0) = 0 and coalesce(cardinality(p.hoods), 0) = 0
         and coalesce(cardinality(p.pays), 0) = 0 and p.unit is null
      or exists (
        select 1 from public.orders o
        where o.customer_id = c.id and o.status <> 'cancelled'
          and (p.pdays is null or o.created_at >= now() - make_interval(days => greatest(p.pdays, 0)))
          and (coalesce(cardinality(p.chans), 0) = 0 or o.channel::text = any (p.chans))
          and (coalesce(cardinality(p.pays), 0) = 0 or o.payment_method::text = any (p.pays))
          and (p.unit is null or o.unit_id::text = p.unit)
          and (coalesce(cardinality(p.hoods), 0) = 0 or lower(o.address->>'neighborhood') = any (select lower(h) from unnest(p.hoods) h))
          and (coalesce(cardinality(p.prods), 0) = 0 or exists (select 1 from public.order_items i where i.order_id = o.id and i.product_id::text = any (p.prods)))));
$$;

-- ---------- Busca (dono e gerência) ----------
create or replace function public.crm_search(p_tenant_id uuid, p_filter jsonb default '{}', p_sort text default 'recent',
  p_limit int default 50, p_offset int default 0)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_ids uuid[]; v_lim int := least(greatest(coalesce(p_limit, 50), 1), 5000); v_off int := greatest(coalesce(p_offset, 0), 0);
begin
  if not private.can_manage(p_tenant_id) then raise exception 'Sem permissão.' using errcode = '42501'; end if;
  select coalesce(array_agg(id), '{}') into v_ids from private.crm_match(p_tenant_id, coalesce(p_filter, '{}')) id;
  return jsonb_build_object(
    'total', cardinality(v_ids),
    'summary', (select jsonb_build_object('spent_cents', coalesce(sum(total_spent_cents), 0), 'orders', coalesce(sum(orders_count), 0),
        'opted_in', count(*) filter (where opt_in_marketing and marketing_opt_out_at is null),
        'cashback_cents', coalesce(sum(cashback_cents), 0))
      from public.customers where id = any (v_ids)),
    'rows', coalesce((select jsonb_agg(to_jsonb(r) order by r.ord) from (
      select row_number() over (order by
          case when p_sort = 'spent' then c.total_spent_cents end desc nulls last,
          case when p_sort = 'orders' then c.orders_count end desc nulls last,
          case when p_sort = 'ticket' then case when c.orders_count > 0 then c.total_spent_cents / c.orders_count end end desc nulls last,
          case when p_sort = 'oldest' then c.last_order_at end asc nulls last,
          case when p_sort = 'name' then lower(c.name) end asc,
          case when p_sort = 'cashback' then c.cashback_cents end desc nulls last,
          c.last_order_at desc nulls last, c.created_at desc) as ord,
        c.id, c.name, c.phone, c.email, c.birthday, c.tags, c.orders_count, c.total_spent_cents, c.first_order_at, c.last_order_at,
        c.opt_in_marketing, c.marketing_opt_out_at, c.cashback_cents, c.points_balance, c.credit_balance_cents,
        private.crm_segment(c) as segment
      from public.customers c where c.id = any (v_ids)
      order by 1 limit v_lim offset v_off) r), '[]'::jsonb));
end $$;

create or replace function public.crm_options(p_tenant_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.can_manage(p_tenant_id) then raise exception 'Sem permissão.' using errcode = '42501'; end if;
  return jsonb_build_object(
    'tags', coalesce((select jsonb_agg(t order by n desc, t) from (select t, count(*) n from public.customers c, unnest(c.tags) t
      where c.tenant_id = p_tenant_id group by t limit 100) x), '[]'::jsonb),
    'neighborhoods', coalesce((select jsonb_agg(h order by n desc) from (
      select initcap(lower(trim(o.address->>'neighborhood'))) h, count(*) n from public.orders o
      where o.tenant_id = p_tenant_id and coalesce(trim(o.address->>'neighborhood'), '') <> '' and o.created_at > now() - interval '365 days'
      group by 1 order by 2 desc limit 150) x), '[]'::jsonb),
    'products', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name) order by p.name)
      from public.products p where p.tenant_id = p_tenant_id and p.active), '[]'::jsonb),
    'units', coalesce((select jsonb_agg(jsonb_build_object('id', u.id, 'name', u.name) order by u.name)
      from public.units u where u.tenant_id = p_tenant_id), '[]'::jsonb),
    'segments', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'filter', s.filter) order by s.name)
      from public.crm_segments s where s.tenant_id = p_tenant_id), '[]'::jsonb));
end $$;

-- ---------- Filtros salvos ----------
create or replace function public.crm_segment_save(p_tenant_id uuid, p_name text, p_filter jsonb, p_id uuid default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v uuid; v_name text := left(nullif(trim(p_name), ''), 60);
begin
  if not private.can_manage(p_tenant_id) then raise exception 'Sem permissão.' using errcode = '42501'; end if;
  if v_name is null then raise exception 'Dê um nome ao filtro.'; end if;
  if jsonb_typeof(p_filter) <> 'object' then raise exception 'Filtro inválido.'; end if;
  if (select count(*) from public.crm_segments where tenant_id = p_tenant_id) >= 50 and p_id is null then raise exception 'Limite de 50 filtros salvos.'; end if;
  if p_id is null then
    insert into public.crm_segments (tenant_id, name, filter, created_by) values (p_tenant_id, v_name, p_filter - 'q', auth.uid())
    on conflict (tenant_id, name) do update set filter = excluded.filter, updated_at = now() returning id into v;
  else
    update public.crm_segments set name = v_name, filter = p_filter - 'q', updated_at = now() where id = p_id and tenant_id = p_tenant_id returning id into v;
    if v is null then raise exception 'Filtro não encontrado.'; end if;
  end if;
  return v;
exception when unique_violation then raise exception 'Já existe um filtro com esse nome.';
end $$;
create or replace function public.crm_segment_delete(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare t uuid;
begin
  select tenant_id into t from public.crm_segments where id = p_id;
  if t is null or not private.can_manage(t) then raise exception 'Sem permissão.' using errcode = '42501'; end if;
  delete from public.crm_segments where id = p_id;
end $$;

-- ---------- Etiquetas ----------
create or replace function private.crm_clean_tag(p text)
returns text language sql immutable set search_path = '' as $$
  select nullif(left(regexp_replace(lower(trim(coalesce(p, ''))), '\s+', ' ', 'g'), 30), '');
$$;
create or replace function public.crm_set_tags(p_customer_id uuid, p_tags text[])
returns text[] language plpgsql security definer set search_path = '' as $$
declare c public.customers; v text[];
begin
  select * into c from public.customers where id = p_customer_id;
  if not found or not private.can_manage(c.tenant_id) then raise exception 'Sem permissão.' using errcode = '42501'; end if;
  select coalesce(array_agg(distinct t order by t), '{}') into v from (select private.crm_clean_tag(x) t from unnest(coalesce(p_tags, '{}')) x) s where t is not null;
  if cardinality(v) > 20 then raise exception 'Use no máximo 20 etiquetas por cliente.'; end if;
  update public.customers set tags = v where id = c.id;
  return v;
end $$;
-- aplica (ou tira) uma etiqueta de todos os clientes do filtro
create or replace function public.crm_bulk_tag(p_tenant_id uuid, p_filter jsonb, p_tag text, p_add boolean default true)
returns int language plpgsql security definer set search_path = '' as $$
declare v_tag text := private.crm_clean_tag(p_tag); n int;
begin
  if not private.can_manage(p_tenant_id) then raise exception 'Sem permissão.' using errcode = '42501'; end if;
  if v_tag is null then raise exception 'Escreva a etiqueta.'; end if;
  if p_add then
    update public.customers set tags = array(select distinct t from unnest(tags || v_tag) t order by t)
     where id in (select private.crm_match(p_tenant_id, coalesce(p_filter, '{}'))) and not (v_tag = any (tags)) and cardinality(tags) < 20;
  else
    update public.customers set tags = array_remove(tags, v_tag)
     where id in (select private.crm_match(p_tenant_id, coalesce(p_filter, '{}'))) and v_tag = any (tags);
  end if;
  get diagnostics n = row_count;
  return n;
end $$;

-- ---------- Campanhas: público pelo filtro do CRM ----------
create or replace function private.campaign_audience(p_tenant uuid, p_segment jsonb, p_freq_days integer)
returns table (customer_id uuid) language sql stable security definer set search_path = '' as $$
  select c.id from public.customers c
  where c.tenant_id = p_tenant and c.opt_in_marketing and c.marketing_opt_out_at is null and c.phone ~ '^[0-9]{10,13}$'
    and not exists (select 1 from public.campaign_messages m where m.customer_id = c.id
                    and m.created_at > now() - make_interval(days => p_freq_days) and m.status <> 'skipped')
    and case coalesce(p_segment->>'type', 'all')
      when 'all' then true
      when 'inactive' then c.last_order_at < now() - make_interval(days => coalesce((p_segment->>'days')::int, 30))
      when 'new' then c.first_order_at > now() - make_interval(days => coalesce((p_segment->>'days')::int, 30)) and c.orders_count <= 2
      when 'top' then c.orders_count >= coalesce((p_segment->>'min_orders')::int, 5)
      when 'birthday_month' then extract(month from c.birthday) = extract(month from now())
      when 'birthday_today' then to_char(c.birthday, 'MM-DD') = to_char(now() at time zone 'America/Sao_Paulo', 'MM-DD')
      when 'crm' then c.id in (select private.crm_match(p_tenant, coalesce(p_segment->'filter', '{}') - 'marketing'))
      else false end;
$$;

grant execute on function public.crm_search(uuid, jsonb, text, int, int), public.crm_options(uuid),
  public.crm_segment_save(uuid, text, jsonb, uuid), public.crm_segment_delete(uuid),
  public.crm_set_tags(uuid, text[]), public.crm_bulk_tag(uuid, jsonb, text, boolean) to authenticated;
revoke execute on function public.crm_search(uuid, jsonb, text, int, int), public.crm_options(uuid),
  public.crm_segment_save(uuid, text, jsonb, uuid), public.crm_segment_delete(uuid),
  public.crm_set_tags(uuid, text[]), public.crm_bulk_tag(uuid, jsonb, text, boolean) from public, anon;
revoke execute on function private.crm_match(uuid, jsonb), private.crm_segment(public.customers) from public, anon, authenticated;
