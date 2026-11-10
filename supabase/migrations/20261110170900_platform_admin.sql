-- =====================================================================
-- Domma Food · 010 · Super Admin da plataforma
-- =====================================================================
create or replace function public.admin_overview()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_platform_admin() then raise exception 'Sem permissão.' using errcode = '42501'; end if;
  return jsonb_build_object(
    'totals', jsonb_build_object(
      'tenants', (select count(*) from public.tenants),
      'active', (select count(*) from public.tenants where status = 'active'),
      'trial', (select count(*) from public.tenants where status = 'trial'),
      'units', (select count(*) from public.units),
      'orders_30d', (select count(*) from public.orders where created_at > now() - interval '30 days' and status <> 'cancelled'),
      'gmv_30d_cents', (select coalesce(sum(total_cents), 0) from public.orders where created_at > now() - interval '30 days' and status <> 'cancelled'),
      'mrr_cents', (select coalesce(sum(p.price_cents), 0) from public.tenants t join public.plans p on p.id = t.plan_id where t.status = 'active'),
      'marketplace_connections', (select count(*) from public.marketplace_connections where active)),
    'plans', (select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'price_cents', price_cents) order by price_cents) from public.plans where active),
    'tenants', coalesce((select jsonb_agg(x order by x->>'created_at' desc) from (
      select jsonb_build_object(
        'id', t.id, 'name', t.name, 'cnpj', t.cnpj, 'plan_id', t.plan_id, 'status', t.status,
        'trial_ends_at', t.trial_ends_at, 'created_at', t.created_at,
        'owner_email', (select u.email from auth.users u where u.id = t.created_by),
        'units', (select coalesce(jsonb_agg(jsonb_build_object('name', un.name, 'slug', un.slug)), '[]') from public.units un where un.tenant_id = t.id),
        'orders_30d', (select count(*) from public.orders o where o.tenant_id = t.id and o.created_at > now() - interval '30 days' and o.status <> 'cancelled'),
        'gmv_30d_cents', (select coalesce(sum(o.total_cents), 0) from public.orders o where o.tenant_id = t.id and o.created_at > now() - interval '30 days' and o.status <> 'cancelled'),
        'last_order_at', (select max(o.created_at) from public.orders o where o.tenant_id = t.id)) x
      from public.tenants t) s), '[]'::jsonb));
end $$;

create or replace function public.admin_set_tenant(p_tenant_id uuid, p_plan_id text, p_status public.tenant_status, p_trial_days integer default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_platform_admin() then raise exception 'Sem permissão.' using errcode = '42501'; end if;
  update public.tenants set plan_id = p_plan_id, status = p_status,
    trial_ends_at = case when p_trial_days is not null then now() + make_interval(days => p_trial_days) else trial_ends_at end
  where id = p_tenant_id;
  if not found then raise exception 'Empresa não encontrada.'; end if;
end $$;

revoke execute on function public.admin_overview(), public.admin_set_tenant(uuid, text, public.tenant_status, integer) from public, anon;
grant execute on function public.admin_overview(), public.admin_set_tenant(uuid, text, public.tenant_status, integer) to authenticated;
