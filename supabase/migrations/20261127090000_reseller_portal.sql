-- Portal de revendas
-- Revendas (parceiros comerciais) indicam lojas e recebem comissão sobre a assinatura paga por elas.
-- - O admin da plataforma cria a revenda, define a comissão e convida o responsável pelo e-mail.
-- - Cada revenda tem um link de indicação (/r/<código>). A loja criada a partir dele fica ligada à revenda;
--   o admin também pode ligar ou desligar uma loja manualmente.
-- - O cliente continua dono da loja. A revenda vê os seus clientes (plano, situação, uso) e as comissões,
--   mas não entra no painel da loja.
-- - Comissão: % sobre o valor líquido das faturas pagas da assinatura (billing_invoices), a partir da data
--   em que a loja foi ligada à revenda. O admin registra os repasses; o portal mostra o saldo.

create table public.resellers (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) between 2 and 120),
  code text not null unique check (code ~ '^[a-z0-9][a-z0-9-]{2,29}$'),
  document text check (document is null or char_length(document) <= 20),
  contact_email text check (contact_email is null or contact_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  phone text check (phone is null or char_length(phone) <= 20),
  commission_pct numeric(5,2) not null default 20 check (commission_pct >= 0 and commission_pct <= 80),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.reseller_members (
  reseller_id uuid not null references public.resellers(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'staff' check (role in ('owner','staff')),
  created_at timestamptz not null default now(),
  primary key (reseller_id, user_id)
);
create index reseller_members_user_idx on public.reseller_members(user_id);

create table public.reseller_invites (
  reseller_id uuid not null references public.resellers(id) on delete cascade,
  email text not null check (email = lower(email) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  role text not null default 'staff' check (role in ('owner','staff')),
  invited_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (reseller_id, email)
);
create index reseller_invites_email_idx on public.reseller_invites(email);

create table public.reseller_payouts (
  id uuid primary key default gen_random_uuid(),
  reseller_id uuid not null references public.resellers(id) on delete cascade,
  month date not null check (month = date_trunc('month', month)::date),
  amount_cents integer not null check (amount_cents > 0 and amount_cents <= 100000000),
  note text check (note is null or char_length(note) <= 300),
  paid_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null
);
create index reseller_payouts_idx on public.reseller_payouts(reseller_id, month desc);

alter table public.tenants add column reseller_id uuid references public.resellers(id) on delete set null;
alter table public.tenants add column reseller_since timestamptz;
create index tenants_reseller_idx on public.tenants(reseller_id) where reseller_id is not null;

-- tudo pelas funções abaixo; nenhuma leitura ou escrita direta
alter table public.resellers enable row level security;
alter table public.resellers force row level security;
alter table public.reseller_members enable row level security;
alter table public.reseller_members force row level security;
alter table public.reseller_invites enable row level security;
alter table public.reseller_invites force row level security;
alter table public.reseller_payouts enable row level security;
alter table public.reseller_payouts force row level security;
revoke all on public.resellers, public.reseller_members, public.reseller_invites, public.reseller_payouts from anon, authenticated;

-- o lojista não muda a revenda da própria loja (comissão)
create or replace function private.protect_tenant_billing()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if (new.plan_id is distinct from old.plan_id or new.status is distinct from old.status
      or new.trial_ends_at is distinct from old.trial_ends_at or new.billing_exempt is distinct from old.billing_exempt
      or new.past_due_since is distinct from old.past_due_since or new.paid_until is distinct from old.paid_until
      or new.cancel_at is distinct from old.cancel_at or new.suspended_reason is distinct from old.suspended_reason
      or new.reseller_id is distinct from old.reseller_id or new.reseller_since is distinct from old.reseller_since)
     and not private.is_platform_admin()
     and current_user not in ('postgres','service_role','supabase_admin') then
    raise exception 'plano/status só podem ser alterados pelo billing' using errcode = '42501';
  end if;
  return new;
end $$;

create or replace function private.reseller_role(p_reseller uuid)
returns text language sql stable security definer set search_path = '' as $$
  select m.role from public.reseller_members m join public.resellers r on r.id = m.reseller_id
   where m.reseller_id = p_reseller and m.user_id = (select auth.uid()) and private.mfa_ok();
$$;

create or replace function private.norm_code(p text)
returns text language sql immutable as $$ select lower(trim(coalesce(p, ''))) $$;

-- ---------- Indicação (cadastro de loja) ----------
-- nome da revenda para mostrar "indicado por" no cadastro
create or replace function public.reseller_public(p_code text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('name', name, 'code', code) from public.resellers where code = private.norm_code(p_code) and active;
$$;

-- liga a loja recém-criada à revenda do link (só o dono, só nos primeiros 30 dias, só uma vez)
create or replace function public.reseller_claim(p_tenant_id uuid, p_code text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare t public.tenants; r public.resellers;
begin
  select * into t from public.tenants where id = p_tenant_id for update;
  if not found or not private.has_role(t.id, array['owner']::public.member_role[]) then
    raise exception 'Sem permissão.' using errcode = '42501'; end if;
  select * into r from public.resellers where code = private.norm_code(p_code) and active;
  if not found then raise exception 'Link de indicação inválido.'; end if;
  if t.reseller_id is not null then
    if t.reseller_id = r.id then return jsonb_build_object('name', r.name, 'already', true); end if;
    raise exception 'Esta loja já está ligada a uma revenda.';
  end if;
  if t.created_at < now() - interval '30 days' then raise exception 'A indicação vale só para lojas criadas nos últimos 30 dias.'; end if;
  if exists (select 1 from public.reseller_members where reseller_id = r.id and user_id = auth.uid()) then
    raise exception 'A revenda não pode indicar a própria loja.'; end if;
  update public.tenants set reseller_id = r.id, reseller_since = now() where id = t.id;
  insert into public.audit_logs (tenant_id, actor_id, action, entity, entity_id, after, ip)
  values (t.id, auth.uid(), 'reseller_claim', 'tenants', t.id::text, jsonb_build_object('reseller_id', r.id, 'code', r.code), private.request_ip());
  return jsonb_build_object('name', r.name);
end $$;

-- ---------- Acesso ao portal ----------
create or replace function public.reseller_accept_invites()
returns integer language plpgsql security definer set search_path = '' as $$
declare v_email text; n int := 0; r record;
begin
  select lower(email) into v_email from auth.users where id = auth.uid() and email_confirmed_at is not null;
  if v_email is null then return 0; end if;
  for r in delete from public.reseller_invites where email = v_email returning * loop
    insert into public.reseller_members (reseller_id, user_id, role) values (r.reseller_id, auth.uid(), r.role)
    on conflict (reseller_id, user_id) do update set role = case when excluded.role = 'owner' then 'owner' else public.reseller_members.role end;
    n := n + 1;
  end loop;
  return n;
end $$;

create or replace function public.reseller_my()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'name', r.name, 'code', r.code, 'role', m.role, 'active', r.active) order by r.name), '[]'::jsonb)
  from public.reseller_members m join public.resellers r on r.id = m.reseller_id
  where m.user_id = auth.uid() and private.mfa_ok();
$$;

-- relatório da revenda (usado pelo portal e pelo admin)
create or replace function private.reseller_report(p_reseller uuid, p_full boolean)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare r public.resellers; v_months jsonb; v_total int; v_paid int;
begin
  select * into r from public.resellers where id = p_reseller;
  if not found then raise exception 'Revenda não encontrada.'; end if;

  with m as (
    select generate_series(date_trunc('month', now()) - interval '11 months', date_trunc('month', now()), interval '1 month')::date as month
  ), inv as (
    select date_trunc('month', i.paid_at)::date as month, sum(coalesce(i.net_cents, i.value_cents))::bigint as received
    from public.billing_invoices i join public.tenants t on t.id = i.tenant_id
    where t.reseller_id = r.id and i.status in ('RECEIVED','CONFIRMED','RECEIVED_IN_CASH')
      and i.paid_at is not null and i.paid_at >= t.reseller_since
    group by 1
  ), pay as (
    select month, sum(amount_cents)::bigint as paid from public.reseller_payouts where reseller_id = r.id group by 1
  )
  select jsonb_agg(jsonb_build_object('month', m.month, 'received_cents', coalesce(inv.received, 0),
           'commission_cents', round(coalesce(inv.received, 0) * r.commission_pct / 100)::bigint,
           'paid_cents', coalesce(pay.paid, 0)) order by m.month desc)
    into v_months
  from m left join inv using (month) left join pay using (month);

  select coalesce(sum(round(x.received * r.commission_pct / 100)), 0)::int into v_total from (
    select sum(coalesce(i.net_cents, i.value_cents)) as received
    from public.billing_invoices i join public.tenants t on t.id = i.tenant_id
    where t.reseller_id = r.id and i.status in ('RECEIVED','CONFIRMED','RECEIVED_IN_CASH')
      and i.paid_at is not null and i.paid_at >= t.reseller_since
    group by date_trunc('month', i.paid_at)) x;
  select coalesce(sum(amount_cents), 0)::int into v_paid from public.reseller_payouts where reseller_id = r.id;

  return jsonb_build_object(
    'reseller', jsonb_build_object('id', r.id, 'name', r.name, 'code', r.code, 'commission_pct', r.commission_pct, 'active', r.active,
      'document', r.document, 'contact_email', r.contact_email, 'phone', r.phone, 'created_at', r.created_at),
    'totals', (select jsonb_build_object(
        'clients', count(*), 'active', count(*) filter (where t.status = 'active'), 'trial', count(*) filter (where t.status = 'trial'),
        'past_due', count(*) filter (where t.status = 'past_due'), 'suspended', count(*) filter (where t.status = 'suspended'),
        'mrr_cents', coalesce(sum(p.price_cents) filter (where t.status = 'active' and not t.billing_exempt), 0))
      from public.tenants t join public.plans p on p.id = t.plan_id where t.reseller_id = r.id),
    'commission_total_cents', v_total, 'paid_total_cents', v_paid, 'balance_cents', v_total - v_paid,
    'months', coalesce(v_months, '[]'::jsonb),
    'clients', coalesce((select jsonb_agg(jsonb_build_object(
        'id', t.id, 'name', t.name, 'plan_id', t.plan_id, 'plan_name', p.name, 'price_cents', p.price_cents, 'status', t.status,
        'billing_exempt', t.billing_exempt, 'trial_ends_at', t.trial_ends_at, 'paid_until', t.paid_until, 'cancel_at', t.cancel_at,
        'created_at', t.created_at, 'reseller_since', t.reseller_since,
        'owner_email', (select u.email from public.memberships mm join auth.users u on u.id = mm.user_id
                         where mm.tenant_id = t.id and mm.role = 'owner' order by mm.created_at limit 1),
        'store_slug', (select slug from public.units where tenant_id = t.id order by created_at limit 1),
        'units', (select count(*) from public.units where tenant_id = t.id),
        'orders_30d', (select count(*) from public.orders o where o.tenant_id = t.id and o.created_at > now() - interval '30 days' and o.status <> 'cancelled'),
        'last_paid_at', (select max(i.paid_at) from public.billing_invoices i where i.tenant_id = t.id and i.status in ('RECEIVED','CONFIRMED','RECEIVED_IN_CASH')))
        order by t.created_at desc)
      from public.tenants t join public.plans p on p.id = t.plan_id where t.reseller_id = r.id), '[]'::jsonb),
    'payouts', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'month', month, 'amount_cents', amount_cents, 'note', note, 'paid_at', paid_at)
        order by month desc, paid_at desc) from public.reseller_payouts where reseller_id = r.id), '[]'::jsonb),
    'members', case when p_full then coalesce((select jsonb_agg(jsonb_build_object('user_id', m.user_id, 'email', u.email, 'role', m.role) order by m.role, u.email)
        from public.reseller_members m join auth.users u on u.id = m.user_id where m.reseller_id = r.id), '[]'::jsonb) else null end,
    'invites', case when p_full then coalesce((select jsonb_agg(jsonb_build_object('email', email, 'role', role) order by email)
        from public.reseller_invites where reseller_id = r.id), '[]'::jsonb) else null end
  );
end $$;

create or replace function public.reseller_overview(p_reseller_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_role text := private.reseller_role(p_reseller_id);
begin
  if v_role is null then raise exception 'Sem permissão.' using errcode = '42501'; end if;
  return private.reseller_report(p_reseller_id, v_role = 'owner') || jsonb_build_object('my_role', v_role);
end $$;

-- equipe da revenda (só o responsável)
create or replace function public.reseller_invite(p_reseller_id uuid, p_email text, p_role text default 'staff')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_email text := lower(trim(coalesce(p_email, ''))); v_uid uuid;
begin
  if private.reseller_role(p_reseller_id) is distinct from 'owner' then raise exception 'Só o responsável pela revenda convida.' using errcode = '42501'; end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'E-mail inválido.'; end if;
  if p_role not in ('owner','staff') then raise exception 'Papel inválido.'; end if;
  if (select count(*) from public.reseller_members where reseller_id = p_reseller_id)
     + (select count(*) from public.reseller_invites where reseller_id = p_reseller_id) >= 20 then
    raise exception 'Limite de 20 pessoas por revenda.'; end if;
  select id into v_uid from auth.users where lower(email) = v_email and email_confirmed_at is not null;
  if v_uid is not null then
    insert into public.reseller_members (reseller_id, user_id, role) values (p_reseller_id, v_uid, p_role)
    on conflict (reseller_id, user_id) do update set role = excluded.role;
    return jsonb_build_object('added', true);
  end if;
  insert into public.reseller_invites (reseller_id, email, role, invited_by) values (p_reseller_id, v_email, p_role, auth.uid())
  on conflict (reseller_id, email) do update set role = excluded.role;
  return jsonb_build_object('invited', true);
end $$;

create or replace function public.reseller_remove(p_reseller_id uuid, p_user_id uuid default null, p_email text default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if private.reseller_role(p_reseller_id) is distinct from 'owner' then raise exception 'Só o responsável pela revenda remove pessoas.' using errcode = '42501'; end if;
  if p_user_id = auth.uid() then raise exception 'Você não pode remover a si mesmo.'; end if;
  if p_user_id is not null then delete from public.reseller_members where reseller_id = p_reseller_id and user_id = p_user_id; end if;
  if p_email is not null then delete from public.reseller_invites where reseller_id = p_reseller_id and email = lower(trim(p_email)); end if;
end $$;

-- ---------- Admin da plataforma ----------
create or replace function public.admin_resellers()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_platform_admin() then raise exception 'Sem permissão.' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(private.reseller_report(r.id, true) order by r.created_at desc) from public.resellers r), '[]'::jsonb);
end $$;

create or replace function public.admin_reseller_save(p jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid := nullif(p->>'id', '')::uuid; v_code text := private.norm_code(p->>'code'); v_owner text := lower(trim(coalesce(p->>'owner_email', ''))); v_uid uuid;
begin
  if not private.is_platform_admin() then raise exception 'Sem permissão.' using errcode = '42501'; end if;
  if v_code in ('admin','painel','revenda','login','api','www','app','loja','r') then raise exception 'Código reservado. Escolha outro.'; end if;
  begin
    if v_id is null then
      insert into public.resellers (name, code, document, contact_email, phone, commission_pct, active)
      values (trim(p->>'name'), v_code, nullif(trim(p->>'document'), ''), nullif(lower(trim(p->>'contact_email')), ''), nullif(trim(p->>'phone'), ''),
              coalesce((p->>'commission_pct')::numeric, 20), coalesce((p->>'active')::boolean, true))
      returning id into v_id;
    else
      update public.resellers set name = coalesce(trim(p->>'name'), name), code = case when p ? 'code' then v_code else code end,
        document = case when p ? 'document' then nullif(trim(p->>'document'), '') else document end,
        contact_email = case when p ? 'contact_email' then nullif(lower(trim(p->>'contact_email')), '') else contact_email end,
        phone = case when p ? 'phone' then nullif(trim(p->>'phone'), '') else phone end,
        commission_pct = coalesce((p->>'commission_pct')::numeric, commission_pct),
        active = coalesce((p->>'active')::boolean, active)
      where id = v_id;
      if not found then raise exception 'Revenda não encontrada.'; end if;
    end if;
  exception
    when unique_violation then raise exception 'Já existe uma revenda com este código.';
    when check_violation then raise exception 'Confira os dados: nome (2 a 120 letras), código (3 a 30 letras minúsculas, números ou hífen), e-mail e comissão (0 a 80%%).';
  end;
  if v_owner <> '' then
    if v_owner !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'E-mail do responsável inválido.'; end if;
    select id into v_uid from auth.users where lower(email) = v_owner and email_confirmed_at is not null;
    if v_uid is not null then
      insert into public.reseller_members (reseller_id, user_id, role) values (v_id, v_uid, 'owner')
      on conflict (reseller_id, user_id) do update set role = 'owner';
    else
      insert into public.reseller_invites (reseller_id, email, role, invited_by) values (v_id, v_owner, 'owner', auth.uid())
      on conflict (reseller_id, email) do update set role = 'owner';
    end if;
  end if;
  insert into public.audit_logs (tenant_id, actor_id, action, entity, entity_id, after, ip)
  values (null, auth.uid(), 'reseller_save', 'resellers', v_id::text, p - 'owner_email', private.request_ip());
  return v_id;
end $$;

create or replace function public.admin_reseller_link(p_tenant_id uuid, p_reseller_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_old uuid;
begin
  if not private.is_platform_admin() then raise exception 'Sem permissão.' using errcode = '42501'; end if;
  select reseller_id into v_old from public.tenants where id = p_tenant_id for update;
  if not found then raise exception 'Loja não encontrada.'; end if;
  if p_reseller_id is not null and not exists (select 1 from public.resellers where id = p_reseller_id) then raise exception 'Revenda não encontrada.'; end if;
  if v_old is not distinct from p_reseller_id then return; end if;
  update public.tenants set reseller_id = p_reseller_id, reseller_since = case when p_reseller_id is null then null else now() end where id = p_tenant_id;
  insert into public.audit_logs (tenant_id, actor_id, action, entity, entity_id, before, after, ip)
  values (p_tenant_id, auth.uid(), 'reseller_link', 'tenants', p_tenant_id::text, jsonb_build_object('reseller_id', v_old),
          jsonb_build_object('reseller_id', p_reseller_id), private.request_ip());
end $$;

create or replace function public.admin_reseller_payout(p_reseller_id uuid, p_month date, p_amount_cents integer, p_note text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if not private.is_platform_admin() then raise exception 'Sem permissão.' using errcode = '42501'; end if;
  if p_amount_cents is null or p_amount_cents <= 0 then raise exception 'Informe o valor do repasse.'; end if;
  insert into public.reseller_payouts (reseller_id, month, amount_cents, note, created_by)
  values (p_reseller_id, date_trunc('month', coalesce(p_month, now()::date))::date, p_amount_cents, nullif(trim(p_note), ''), auth.uid())
  returning id into v_id;
  insert into public.audit_logs (tenant_id, actor_id, action, entity, entity_id, after, ip)
  values (null, auth.uid(), 'reseller_payout', 'reseller_payouts', v_id::text,
          jsonb_build_object('reseller_id', p_reseller_id, 'month', p_month, 'amount_cents', p_amount_cents), private.request_ip());
  return v_id;
exception when foreign_key_violation then raise exception 'Revenda não encontrada.';
end $$;

create or replace function public.admin_reseller_payout_delete(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v public.reseller_payouts;
begin
  if not private.is_platform_admin() then raise exception 'Sem permissão.' using errcode = '42501'; end if;
  delete from public.reseller_payouts where id = p_id returning * into v;
  if not found then raise exception 'Repasse não encontrado.'; end if;
  insert into public.audit_logs (tenant_id, actor_id, action, entity, entity_id, before, ip)
  values (null, auth.uid(), 'reseller_payout_delete', 'reseller_payouts', p_id::text, to_jsonb(v), private.request_ip());
end $$;

-- ---------- Permissões ----------
revoke execute on function private.reseller_role(uuid), private.norm_code(text), private.reseller_report(uuid, boolean) from public, anon, authenticated;
revoke execute on function public.reseller_public(text), public.reseller_claim(uuid, text), public.reseller_accept_invites(), public.reseller_my(),
  public.reseller_overview(uuid), public.reseller_invite(uuid, text, text), public.reseller_remove(uuid, uuid, text),
  public.admin_resellers(), public.admin_reseller_save(jsonb), public.admin_reseller_link(uuid, uuid),
  public.admin_reseller_payout(uuid, date, integer, text), public.admin_reseller_payout_delete(uuid) from public, anon;
grant execute on function public.reseller_public(text) to anon, authenticated;
grant execute on function public.reseller_claim(uuid, text), public.reseller_accept_invites(), public.reseller_my(),
  public.reseller_overview(uuid), public.reseller_invite(uuid, text, text), public.reseller_remove(uuid, uuid, text),
  public.admin_resellers(), public.admin_reseller_save(jsonb), public.admin_reseller_link(uuid, uuid),
  public.admin_reseller_payout(uuid, date, integer, text), public.admin_reseller_payout_delete(uuid) to authenticated;
