-- =====================================================================
-- Domma Food · 012 · Equipe: listar membros e convidar por e-mail
-- Se a pessoa já tem conta, entra na hora; senão fica um convite pendente
-- que é aceito automaticamente quando ela criar a conta com aquele e-mail.
-- =====================================================================
create table public.invitations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  email text not null check (email = lower(email) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  role public.member_role not null check (role <> 'owner'),
  unit_ids uuid[],
  invited_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (tenant_id, email)
);
alter table public.invitations enable row level security;
alter table public.invitations force row level security;
revoke all on public.invitations from anon;
revoke insert, update on public.invitations from authenticated;
create policy invitations_select on public.invitations for select to authenticated
  using (private.has_role(tenant_id, array['owner']::public.member_role[]));
create policy invitations_delete on public.invitations for delete to authenticated
  using (private.has_role(tenant_id, array['owner']::public.member_role[]));
create trigger invitations_audit after insert or delete on public.invitations
  for each row execute function private.audit_row();

create or replace function public.list_members(p_tenant_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.can_manage(p_tenant_id) then raise exception 'Sem permissão.' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', m.id, 'user_id', m.user_id, 'role', m.role, 'unit_ids', m.unit_ids,
      'email', u.email, 'name', p.full_name, 'created_at', m.created_at,
      'has_2fa', exists (select 1 from auth.mfa_factors f where f.user_id = m.user_id and f.status = 'verified'),
      'is_me', m.user_id = auth.uid()) order by m.created_at)
    from public.memberships m join auth.users u on u.id = m.user_id
    left join public.profiles p on p.id = m.user_id
    where m.tenant_id = p_tenant_id), '[]'::jsonb);
end $$;

create or replace function public.invite_member(p_tenant_id uuid, p_email text, p_role public.member_role, p_unit_ids uuid[] default null)
returns text language plpgsql security definer set search_path = '' as $$
declare v_email text := lower(trim(p_email)); v_user uuid; v_max int; v_count int;
begin
  if not private.has_role(p_tenant_id, array['owner']::public.member_role[]) then
    raise exception 'Só o dono pode convidar pessoas.' using errcode = '42501';
  end if;
  if p_role = 'owner' then raise exception 'Não é possível convidar outro dono.'; end if;
  if p_unit_ids is not null and exists (select 1 from unnest(p_unit_ids) x
      where x not in (select id from public.units where tenant_id = p_tenant_id)) then
    raise exception 'Loja inválida.';
  end if;
  select pl.max_users into v_max from public.tenants t join public.plans pl on pl.id = t.plan_id where t.id = p_tenant_id;
  select (select count(*) from public.memberships where tenant_id = p_tenant_id)
       + (select count(*) from public.invitations where tenant_id = p_tenant_id) into v_count;
  if v_count >= v_max then raise exception 'Seu plano permite até % usuários.', v_max; end if;

  select id into v_user from auth.users where lower(email) = v_email and email_confirmed_at is not null;
  if v_user is not null then
    if exists (select 1 from public.memberships where tenant_id = p_tenant_id and user_id = v_user) then
      raise exception 'Esta pessoa já faz parte da equipe.';
    end if;
    insert into public.memberships (tenant_id, user_id, role, unit_ids) values (p_tenant_id, v_user, p_role, p_unit_ids);
    return 'added';
  end if;
  insert into public.invitations (tenant_id, email, role, unit_ids, invited_by)
  values (p_tenant_id, v_email, p_role, p_unit_ids, auth.uid())
  on conflict (tenant_id, email) do update set role = excluded.role, unit_ids = excluded.unit_ids;
  return 'invited';
end $$;

-- Chamado no login: transforma convites pendentes do e-mail (confirmado) em acessos
create or replace function public.accept_invitations()
returns integer language plpgsql security definer set search_path = '' as $$
declare v_email text; n int := 0; r record;
begin
  select lower(email) into v_email from auth.users where id = auth.uid() and email_confirmed_at is not null;
  if v_email is null then return 0; end if;
  for r in delete from public.invitations where email = v_email returning * loop
    insert into public.memberships (tenant_id, user_id, role, unit_ids)
    values (r.tenant_id, auth.uid(), r.role, r.unit_ids) on conflict (tenant_id, user_id) do nothing;
    n := n + 1;
  end loop;
  return n;
end $$;

revoke execute on function public.list_members(uuid), public.invite_member(uuid, text, public.member_role, uuid[]), public.accept_invitations() from public, anon;
grant execute on function public.list_members(uuid), public.invite_member(uuid, text, public.member_role, uuid[]), public.accept_invitations() to authenticated;
