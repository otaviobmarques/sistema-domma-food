-- =====================================================================
-- Domma Food · 047 · Redes e multiunidade
--   - Nova loja pelo painel (copiando configurações, áreas de entrega e preços de outra)
--   - Limite de lojas do plano aplicado no banco (também para inserts diretos)
--   - Visão consolidada da rede (lojas lado a lado, totais, canais, campeões)
--   - Preço e disponibilidade por loja: só quem acessa a loja altera
-- =====================================================================

-- ---------- Limite de lojas do plano ----------
create or replace function private.unit_limit(p_tenant uuid)
returns int language sql stable security definer set search_path = '' as $$
  select case when t.billing_exempt then null else coalesce(p.max_units, 1) end
  from public.tenants t left join public.plans p on p.id = t.plan_id where t.id = p_tenant;
$$;
create or replace function private.enforce_unit_limit()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_max int := private.unit_limit(new.tenant_id);
begin
  if v_max is not null and (select count(*) from public.units where tenant_id = new.tenant_id and active) >= v_max
     and not private.is_platform_admin() then
    raise exception 'Seu plano permite % loja(s). Para abrir outra, mude de plano em Assinatura.', v_max using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger units_enforce_limit before insert on public.units for each row execute function private.enforce_unit_limit();
-- reativar uma loja também conta no limite
create or replace function private.enforce_unit_limit_reactivate()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_max int := private.unit_limit(new.tenant_id);
begin
  if new.active and not old.active and v_max is not null
     and (select count(*) from public.units where tenant_id = new.tenant_id and active and id <> new.id) >= v_max
     and not private.is_platform_admin() then
    raise exception 'Seu plano permite % loja(s) ativa(s). Desative outra ou mude de plano.', v_max using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger units_enforce_limit_reactivate before update of active on public.units for each row execute function private.enforce_unit_limit_reactivate();

-- ---------- Preço por loja: precisa ter acesso à loja ----------
drop policy if exists product_unit_overrides_insert on public.product_unit_overrides;
drop policy if exists product_unit_overrides_update on public.product_unit_overrides;
drop policy if exists product_unit_overrides_delete on public.product_unit_overrides;
create policy product_unit_overrides_insert on public.product_unit_overrides for insert to authenticated
  with check (private.can_manage(tenant_id) and private.can_access_unit(unit_id)
    and exists (select 1 from public.units u where u.id = unit_id and u.tenant_id = product_unit_overrides.tenant_id)
    and exists (select 1 from public.products p where p.id = product_id and p.tenant_id = product_unit_overrides.tenant_id));
create policy product_unit_overrides_update on public.product_unit_overrides for update to authenticated
  using (private.can_manage(tenant_id) and private.can_access_unit(unit_id))
  with check (private.can_manage(tenant_id) and private.can_access_unit(unit_id));
create policy product_unit_overrides_delete on public.product_unit_overrides for delete to authenticated
  using (private.can_manage(tenant_id) and private.can_access_unit(unit_id));

-- ---------- Nova loja (dono) ----------
create or replace function public.unit_create(p_tenant_id uuid, p_name text, p_slug text, p_copy_from uuid default null,
  p_copy_zones boolean default true, p_copy_prices boolean default true)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_slug text := lower(trim(coalesce(p_slug, ''))); v_name text := left(nullif(trim(p_name), ''), 120);
  src public.units; v_id uuid; v_max int := private.unit_limit(p_tenant_id);
begin
  if not private.has_role(p_tenant_id, array['owner']::public.member_role[]) then
    raise exception 'Só o dono da conta abre novas lojas.' using errcode = '42501'; end if;
  if v_name is null then raise exception 'Dê um nome à loja.'; end if;
  if v_slug !~ '^[a-z0-9](?:[a-z0-9-]{1,48}[a-z0-9])$' then
    raise exception 'Endereço inválido: use letras minúsculas, números e hífen (3 a 50 caracteres).'; end if;
  if exists (select 1 from public.units where slug = v_slug) then raise exception 'Este endereço (%) já está em uso.', v_slug; end if;
  if p_copy_from is not null then
    select * into src from public.units where id = p_copy_from and tenant_id = p_tenant_id;
    if not found then raise exception 'Loja de origem inválida.'; end if;
  end if;
  if v_max is not null and (select count(*) from public.units where tenant_id = p_tenant_id and active) >= v_max then
    raise exception 'Seu plano permite % loja(s). Para abrir outra, mude de plano em Assinatura.', v_max; end if;

  insert into public.units (tenant_id, name, slug) values (p_tenant_id, v_name, v_slug) returning id into v_id;
  if src.id is not null then
    update public.units set timezone = src.timezone, opening_hours = src.opening_hours, accepts_delivery = src.accepts_delivery,
      accepts_pickup = src.accepts_pickup, accepts_scheduling = src.accepts_scheduling, auto_accept = src.auto_accept,
      min_order_cents = src.min_order_cents, prep_time_min = src.prep_time_min, pickup_time_min = src.pickup_time_min,
      accepted_payments = src.accepted_payments, primary_color = src.primary_color, logo_url = src.logo_url, cover_url = src.cover_url,
      description = src.description, kds_stations = src.kds_stations, service_fee_pct = src.service_fee_pct,
      pix_merchant_name = src.pix_merchant_name, city = src.city, state = src.state
    where id = v_id;
  end if;

  if src.id is not null and p_copy_zones then
    insert into public.delivery_zones (tenant_id, unit_id, name, kind, radius_km, neighborhoods, fee_cents, min_order_cents, free_above_cents, eta_min, active)
    select tenant_id, v_id, name, kind, radius_km, neighborhoods, fee_cents, min_order_cents, free_above_cents, eta_min, active
    from public.delivery_zones where unit_id = src.id;
  end if;
  if src.id is not null and p_copy_prices then
    insert into public.product_unit_overrides (product_id, unit_id, tenant_id, price_cents, available)
    select product_id, v_id, tenant_id, price_cents, available from public.product_unit_overrides where unit_id = src.id;
  end if;
  insert into public.audit_logs (tenant_id, actor_id, action, entity, entity_id, after, ip)
  values (p_tenant_id, auth.uid(), 'unit_create', 'units', v_id::text, jsonb_build_object('name', v_name, 'slug', v_slug, 'copy_from', p_copy_from), private.request_ip());
  return jsonb_build_object('unit_id', v_id, 'slug', v_slug);
end $$;

create or replace function public.unit_set_active(p_unit_id uuid, p_active boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare u public.units;
begin
  select * into u from public.units where id = p_unit_id;
  if not found or not private.has_role(u.tenant_id, array['owner']::public.member_role[]) then raise exception 'Sem permissão.' using errcode = '42501'; end if;
  if not p_active and (select count(*) from public.units where tenant_id = u.tenant_id and active and id <> u.id) = 0 then
    raise exception 'A conta precisa de pelo menos uma loja ativa.'; end if;
  update public.units set active = p_active where id = u.id;
end $$;

-- ---------- Visão da rede ----------
create or replace function public.network_overview(p_tenant_id uuid, p_from timestamptz, p_to timestamptz)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_units uuid[];
begin
  if not private.has_role(p_tenant_id, array['owner','manager']::public.member_role[]) then raise exception 'Sem permissão.' using errcode = '42501'; end if;
  if p_to - p_from > interval '400 days' or p_to <= p_from then raise exception 'Período inválido.'; end if;
  select coalesce(array_agg(id order by name), '{}') into v_units from public.units where tenant_id = p_tenant_id and private.can_access_unit(id);
  return (
    with o as (select * from public.orders where unit_id = any (v_units) and created_at >= p_from and created_at < p_to),
         ok as (select * from o where status <> 'cancelled')
    select jsonb_build_object(
      'limit', private.unit_limit(p_tenant_id),
      'units_total', (select count(*) from public.units where tenant_id = p_tenant_id and active),
      'totals', jsonb_build_object('revenue_cents', coalesce((select sum(total_cents) from ok), 0), 'orders', (select count(*) from ok),
        'avg_ticket_cents', coalesce((select round(avg(total_cents)) from ok), 0), 'cancelled', (select count(*) from o where status = 'cancelled')),
      'units', coalesce((select jsonb_agg(x order by x.revenue_cents desc, x.name) from (
          select u.id, u.name, u.slug, u.active, u.city, private.unit_is_open_at(u, now()) as is_open,
            coalesce(sum(ok.total_cents), 0) as revenue_cents, count(ok.id) as orders,
            coalesce(round(avg(ok.total_cents)), 0) as avg_ticket_cents,
            (select count(*) from o where o.unit_id = u.id and o.status = 'cancelled') as cancelled,
            round(avg(extract(epoch from ok.ready_at - ok.accepted_at) / 60) filter (where ok.ready_at is not null and ok.accepted_at is not null)) as avg_prep_min,
            (select count(*) from public.orders a where a.unit_id = u.id and a.status in ('pending','preparing','ready','dispatched','awaiting_pickup')) as open_orders
          from public.units u left join ok on ok.unit_id = u.id
          where u.id = any (v_units) group by u.id) x), '[]'::jsonb),
      'by_channel', coalesce((select jsonb_agg(jsonb_build_object('channel', c, 'orders', n, 'revenue_cents', r) order by r desc)
          from (select channel::text c, count(*) n, sum(total_cents) r from ok group by 1) y), '[]'::jsonb),
      'by_day', coalesce((select jsonb_agg(jsonb_build_object('day', d, 'orders', n, 'revenue_cents', r) order by d)
          from (select (created_at at time zone 'America/Sao_Paulo')::date d, count(*) n, sum(total_cents) r from ok group by 1) z), '[]'::jsonb),
      'top_products', coalesce((select jsonb_agg(jsonb_build_object('name', name, 'quantity', q, 'revenue_cents', r) order by q desc)
          from (select i.name, sum(i.quantity) q, sum(i.total_cents) r from public.order_items i join ok on ok.id = i.order_id
                group by i.name order by 2 desc limit 10) w), '[]'::jsonb)));
end $$;

grant execute on function public.unit_create(uuid, text, text, uuid, boolean, boolean), public.unit_set_active(uuid, boolean),
  public.network_overview(uuid, timestamptz, timestamptz) to authenticated;
revoke execute on function public.unit_create(uuid, text, text, uuid, boolean, boolean), public.unit_set_active(uuid, boolean),
  public.network_overview(uuid, timestamptz, timestamptz) from public, anon;
revoke execute on function private.unit_limit(uuid), private.enforce_unit_limit(), private.enforce_unit_limit_reactivate() from public, anon, authenticated;
