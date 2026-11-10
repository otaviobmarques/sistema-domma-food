-- =====================================================================
-- Domma Food · 002 · Segurança: RLS por tenant, auditoria e storage
-- Regra geral: anon NÃO acessa tabelas diretamente; o cardápio público
-- e o checkout passam por funções RPC que validam tudo no servidor.
-- =====================================================================

-- ---------- Ativa RLS em todas as tabelas ----------
do $$
declare r record;
begin
  for r in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', r.tablename);
    execute format('alter table public.%I force row level security', r.tablename);
    execute format('revoke all on public.%I from anon', r.tablename);
  end loop;
end $$;

-- ---------- plans: leitura para logados ----------
create policy plans_read on public.plans for select to authenticated using (true);

-- ---------- tenants ----------
create policy tenants_select on public.tenants for select to authenticated
  using (private.is_member(id) or private.is_platform_admin());
create policy tenants_update on public.tenants for update to authenticated
  using (private.has_role(id, array['owner']::public.member_role[]))
  with check (private.has_role(id, array['owner']::public.member_role[]));
-- plano e status só mudam pelo super admin / billing (coluna protegida via trigger)
create or replace function private.protect_tenant_billing()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if (new.plan_id is distinct from old.plan_id or new.status is distinct from old.status
      or new.trial_ends_at is distinct from old.trial_ends_at)
     and not private.is_platform_admin()
     and current_user not in ('postgres','service_role','supabase_admin') then
    raise exception 'plano/status só podem ser alterados pelo billing' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger tenants_protect_billing before update on public.tenants
  for each row execute function private.protect_tenant_billing();

-- ---------- units ----------
create policy units_select on public.units for select to authenticated
  using (private.can_access_unit(id) or private.is_platform_admin());
create policy units_insert on public.units for insert to authenticated
  with check (private.has_role(tenant_id, array['owner']::public.member_role[]));
create policy units_update on public.units for update to authenticated
  using (private.can_manage(tenant_id) and private.can_access_unit(id))
  with check (private.can_manage(tenant_id));
create policy units_delete on public.units for delete to authenticated
  using (private.has_role(tenant_id, array['owner']::public.member_role[]));
-- order_counter é controlado só pelo servidor
create or replace function private.protect_unit_counter()
returns trigger language plpgsql as $$
begin
  if new.order_counter is distinct from old.order_counter
     and current_user = 'authenticated' then
    new.order_counter := old.order_counter;
  end if;
  if new.tenant_id is distinct from old.tenant_id then
    raise exception 'tenant_id é imutável';
  end if;
  return new;
end $$;
create trigger units_protect_counter before update on public.units
  for each row execute function private.protect_unit_counter();

-- ---------- profiles ----------
create policy profiles_self on public.profiles for select to authenticated
  using (id = (select auth.uid()) or exists (
    select 1 from public.memberships a join public.memberships b on a.tenant_id = b.tenant_id
    where a.user_id = (select auth.uid()) and b.user_id = profiles.id));
create policy profiles_update_self on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- ---------- memberships ----------
create policy memberships_select on public.memberships for select to authenticated
  using (user_id = (select auth.uid()) or private.can_manage(tenant_id));
create policy memberships_write on public.memberships for all to authenticated
  using (private.has_role(tenant_id, array['owner']::public.member_role[]) and user_id <> (select auth.uid()))
  with check (private.has_role(tenant_id, array['owner']::public.member_role[]) and user_id <> (select auth.uid()));

-- ---------- platform_admins: somente leitura própria ----------
create policy platform_admins_self on public.platform_admins for select to authenticated
  using (user_id = (select auth.uid()));

-- ---------- Catálogo: membros leem, gestores escrevem ----------
do $$
declare t text;
begin
  foreach t in array array['categories','products','option_groups','options',
                           'product_option_groups','product_unit_overrides'] loop
    execute format($f$create policy %1$s_select on public.%1$I for select to authenticated
      using (private.is_member(tenant_id))$f$, t);
    execute format($f$create policy %1$s_insert on public.%1$I for insert to authenticated
      with check (private.can_manage(tenant_id))$f$, t);
    execute format($f$create policy %1$s_update on public.%1$I for update to authenticated
      using (private.can_manage(tenant_id)) with check (private.can_manage(tenant_id))$f$, t);
    execute format($f$create policy %1$s_delete on public.%1$I for delete to authenticated
      using (private.can_manage(tenant_id))$f$, t);
  end loop;
end $$;

-- ---------- Zonas de entrega ----------
create policy zones_select on public.delivery_zones for select to authenticated
  using (private.can_access_unit(unit_id));
create policy zones_write on public.delivery_zones for all to authenticated
  using (private.can_manage(tenant_id) and private.can_access_unit(unit_id))
  with check (private.can_manage(tenant_id) and private.can_access_unit(unit_id)
              and exists (select 1 from public.units u where u.id = unit_id and u.tenant_id = delivery_zones.tenant_id));

-- ---------- Clientes ----------
create policy customers_select on public.customers for select to authenticated
  using (private.has_role(tenant_id, array['owner','manager','cashier','attendant']::public.member_role[]));
create policy customers_update on public.customers for update to authenticated
  using (private.has_role(tenant_id, array['owner','manager','attendant']::public.member_role[]))
  with check (private.has_role(tenant_id, array['owner','manager','attendant']::public.member_role[]));
create policy customers_delete on public.customers for delete to authenticated
  using (private.has_role(tenant_id, array['owner']::public.member_role[]));
create policy customer_addresses_select on public.customer_addresses for select to authenticated
  using (private.has_role(tenant_id, array['owner','manager','cashier','attendant','courier']::public.member_role[]));

-- ---------- Cupons ----------
create policy coupons_select on public.coupons for select to authenticated
  using (private.is_member(tenant_id));
create policy coupons_write on public.coupons for all to authenticated
  using (private.can_manage(tenant_id)) with check (private.can_manage(tenant_id));
create policy coupon_redemptions_select on public.coupon_redemptions for select to authenticated
  using (private.can_manage(tenant_id));

-- ---------- Pedidos: leitura por unidade; escrita só via RPC ----------
create policy orders_select on public.orders for select to authenticated
  using (private.can_access_unit(unit_id));
create policy order_items_select on public.order_items for select to authenticated
  using (exists (select 1 from public.orders o where o.id = order_id and private.can_access_unit(o.unit_id)));
create policy order_events_select on public.order_events for select to authenticated
  using (exists (select 1 from public.orders o where o.id = order_id and private.can_access_unit(o.unit_id)));
create policy payments_select on public.payments for select to authenticated
  using (private.has_role(tenant_id, array['owner','manager','cashier']::public.member_role[]));

-- ---------- Auditoria: só leitura para dono/gerente ----------
create policy audit_select on public.audit_logs for select to authenticated
  using (private.can_manage(tenant_id) or private.is_platform_admin());

-- ---------- Gatilho genérico de auditoria ----------
create or replace function private.request_ip()
returns text language sql stable as $$
  select nullif(split_part(coalesce(
    (current_setting('request.headers', true)::json ->> 'x-forwarded-for'), ''), ',', 1), '');
$$;

create or replace function private.audit_row()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_old jsonb := case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end;
  v_new jsonb := case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) end;
  v_tenant uuid := coalesce((v_new->>'tenant_id')::uuid, (v_old->>'tenant_id')::uuid,
                            case when tg_table_name = 'tenants' then coalesce((v_new->>'id')::uuid,(v_old->>'id')::uuid) end);
begin
  if tg_op = 'UPDATE' and v_old - 'updated_at' = v_new - 'updated_at' then
    return new;
  end if;
  insert into public.audit_logs (tenant_id, actor_id, action, entity, entity_id, before, after, ip)
  values (v_tenant, auth.uid(), lower(tg_op), tg_table_name,
          coalesce(v_new->>'id', v_old->>'id', v_new->>'product_id', v_old->>'product_id'),
          v_old, v_new, private.request_ip());
  return coalesce(new, old);
end $$;

do $$
declare t text;
begin
  foreach t in array array['tenants','units','memberships','products','categories',
                           'option_groups','options','coupons','delivery_zones',
                           'product_unit_overrides','payments'] loop
    execute format('create trigger %1$s_audit after insert or update or delete on public.%1$I
                    for each row execute function private.audit_row()', t);
  end loop;
end $$;

-- ---------- Storage: mídias públicas (fotos), escrita só por gestores do tenant ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('media', 'media', true, 5242880, array['image/jpeg','image/png','image/webp','image/avif'])
on conflict (id) do nothing;

create policy media_read on storage.objects for select to anon, authenticated
  using (bucket_id = 'media');
create policy media_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'media'
    and (storage.foldername(name))[1] ~ '^[0-9a-f-]{36}$'
    and private.can_manage(((storage.foldername(name))[1])::uuid));
create policy media_update on storage.objects for update to authenticated
  using (bucket_id = 'media' and (storage.foldername(name))[1] ~ '^[0-9a-f-]{36}$'
    and private.can_manage(((storage.foldername(name))[1])::uuid));
create policy media_delete on storage.objects for delete to authenticated
  using (bucket_id = 'media' and (storage.foldername(name))[1] ~ '^[0-9a-f-]{36}$'
    and private.can_manage(((storage.foldername(name))[1])::uuid));

-- ---------- Tempo real: gestor de pedidos ----------
alter publication supabase_realtime add table public.orders;

-- private.* precisa ser executável pelas políticas
grant usage on schema private to authenticated;
grant execute on all functions in schema private to authenticated;
