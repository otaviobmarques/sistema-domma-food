-- =====================================================================
-- Domma Food · 005 · 2FA aplicado no banco
-- Quem tem um fator TOTP verificado só acessa dados do painel com sessão AAL2.
-- (Proteção real: não depende do front-end.)
-- =====================================================================
create or replace function private.mfa_ok()
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select auth.jwt()) ->> 'aal', 'aal1') = 'aal2'
      or not exists (select 1 from auth.mfa_factors f
                     where f.user_id = (select auth.uid()) and f.status = 'verified');
$$;

create or replace function private.is_member(t uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.mfa_ok() and exists (
    select 1 from public.memberships m
    where m.tenant_id = t and m.user_id = (select auth.uid()));
$$;

create or replace function private.has_role(t uuid, roles public.member_role[])
returns boolean language sql stable security definer set search_path = '' as $$
  select private.mfa_ok() and exists (
    select 1 from public.memberships m
    where m.tenant_id = t and m.user_id = (select auth.uid()) and m.role = any (roles));
$$;

create or replace function private.can_access_unit(u uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.mfa_ok() and exists (
    select 1 from public.units un
    join public.memberships m on m.tenant_id = un.tenant_id
    where un.id = u and m.user_id = (select auth.uid())
      and (m.unit_ids is null or u = any (m.unit_ids)));
$$;

create or replace function private.is_platform_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select private.mfa_ok() and exists (select 1 from public.platform_admins where user_id = (select auth.uid()));
$$;

grant execute on function private.mfa_ok() to authenticated;
