-- =====================================================================
-- Domma Food · 037 · Cobrança da assinatura do SaaS (Asaas)
-- Assinatura mensal por empresa; o cliente paga pela fatura do Asaas
-- (Pix, boleto ou cartão: dados de cartão nunca passam pelo Domma).
-- Status da empresa: trial → active / past_due → suspended (após carência).
-- Só a Edge Function (service_role) fala com o Asaas.
-- =====================================================================
alter table public.tenants
  add column billing_exempt boolean not null default false,       -- demonstração, parceiros
  add column past_due_since timestamptz,
  add column paid_until date,
  add column cancel_at date,
  add column suspended_reason text check (suspended_reason is null or suspended_reason in ('billing','admin'));
update public.tenants set billing_exempt = true where name like '%(demonstração)%';

-- campos de cobrança só mudam pelo billing / super admin.
-- Correção de segurança: a versão anterior era SECURITY DEFINER, então current_user
-- era sempre o dono da função (postgres) e a checagem nunca bloqueava o lojista.
-- Agora roda como quem fez a alteração (authenticated é barrado; funções do sistema passam).
create or replace function private.protect_tenant_billing()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if (new.plan_id is distinct from old.plan_id or new.status is distinct from old.status
      or new.trial_ends_at is distinct from old.trial_ends_at or new.billing_exempt is distinct from old.billing_exempt
      or new.past_due_since is distinct from old.past_due_since or new.paid_until is distinct from old.paid_until
      or new.cancel_at is distinct from old.cancel_at or new.suspended_reason is distinct from old.suspended_reason)
     and not private.is_platform_admin()
     and current_user not in ('postgres','service_role','supabase_admin') then
    raise exception 'plano/status só podem ser alterados pelo billing' using errcode = '42501';
  end if;
  return new;
end $$;

create table public.billing_settings (
  id boolean primary key default true check (id),
  env text not null default 'sandbox' check (env in ('sandbox','production')),
  api_key_secret_id uuid, api_key_hint text,
  webhook_token text not null default encode(extensions.gen_random_bytes(24), 'hex'),
  enabled boolean not null default false,
  grace_days integer not null default 7 check (grace_days between 1 and 30),
  last_test_at timestamptz, last_test_ok boolean, last_test_message text,
  updated_at timestamptz not null default now()
);
insert into public.billing_settings (id) values (true);

create table public.billing_accounts (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  customer_id text, subscription_id text unique,
  plan_id text references public.plans(id),
  name text, cpf_cnpj text check (cpf_cnpj is null or cpf_cnpj ~ '^([0-9]{11}|[0-9]{14})$'),
  email text, phone text,
  status text not null default 'none' check (status in ('none','active','canceled')),
  next_due_date date,
  updated_at timestamptz not null default now()
);
create table public.billing_invoices (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  provider_id text not null unique,
  subscription_id text,
  value_cents integer not null,
  net_cents integer,
  status text not null,                 -- PENDING, RECEIVED, CONFIRMED, OVERDUE, REFUNDED, DELETED, ...
  billing_type text,
  due_date date not null,
  paid_at timestamptz,
  invoice_url text, bank_slip_url text, description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index billing_invoices_tenant_idx on public.billing_invoices(tenant_id, due_date desc);
create table public.billing_events (
  id text primary key, event text not null, payment_id text, received_at timestamptz not null default now()
);

do $$ declare t text; begin
  foreach t in array array['billing_settings','billing_accounts','billing_invoices','billing_events'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
  end loop;
end $$;
create policy ba_select on public.billing_accounts for select to authenticated
  using (private.has_role(tenant_id, array['owner']::public.member_role[]) or private.is_platform_admin());
create policy bi_select on public.billing_invoices for select to authenticated
  using (private.has_role(tenant_id, array['owner']::public.member_role[]) or private.is_platform_admin());

-- ---------- Leitura para o dono (painel) ----------
create or replace function public.billing_overview(p_tenant_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare t public.tenants; s public.billing_settings; a public.billing_accounts;
begin
  if not (private.has_role(p_tenant_id, array['owner']::public.member_role[]) or private.is_platform_admin()) then
    raise exception 'Só o dono da conta vê a assinatura.' using errcode = '42501'; end if;
  select * into t from public.tenants where id = p_tenant_id;
  select * into s from public.billing_settings where id;
  select * into a from public.billing_accounts where tenant_id = p_tenant_id;
  return jsonb_build_object(
    'enabled', coalesce(s.enabled, false), 'grace_days', coalesce(s.grace_days, 7),
    'tenant', jsonb_build_object('name', t.name, 'cnpj', t.cnpj, 'plan_id', t.plan_id, 'status', t.status, 'trial_ends_at', t.trial_ends_at,
      'past_due_since', t.past_due_since, 'paid_until', t.paid_until, 'cancel_at', t.cancel_at, 'exempt', t.billing_exempt,
      'suspend_at', case when t.status = 'past_due' and t.past_due_since is not null then t.past_due_since + make_interval(days => coalesce(s.grace_days, 7)) end),
    'account', case when a.tenant_id is null then null else jsonb_build_object('plan_id', a.plan_id, 'name', a.name, 'cpf_cnpj', a.cpf_cnpj,
      'email', a.email, 'phone', a.phone, 'status', a.status, 'next_due_date', a.next_due_date) end,
    'plans', (select jsonb_agg(jsonb_build_object('id', id, 'name', name, 'price_cents', price_cents, 'max_units', max_units, 'max_users', max_users) order by price_cents, id)
              from public.plans where active),
    'invoices', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'value_cents', i.value_cents, 'status', i.status, 'billing_type', i.billing_type,
        'due_date', i.due_date, 'paid_at', i.paid_at, 'invoice_url', i.invoice_url, 'description', i.description) order by i.due_date desc)
      from (select * from public.billing_invoices where tenant_id = p_tenant_id and status <> 'DELETED' order by due_date desc limit 24) i), '[]'::jsonb));
end $$;
create or replace function public.billing_can_manage(p_tenant_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.has_role(p_tenant_id, array['owner']::public.member_role[]);
$$;

-- ---------- Serviço (Edge Function) ----------
create or replace function public.billing_context(p_tenant_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare s public.billing_settings; t public.tenants; a public.billing_accounts;
begin
  perform private.assert_service_role();
  select * into s from public.billing_settings where id;
  select * into t from public.tenants where id = p_tenant_id;
  select * into a from public.billing_accounts where tenant_id = p_tenant_id;
  return jsonb_build_object('env', s.env, 'enabled', s.enabled,
    'api_key', (select decrypted_secret from vault.decrypted_secrets where id = s.api_key_secret_id),
    'tenant', case when t.id is null then null else jsonb_build_object('id', t.id, 'name', t.name, 'cnpj', t.cnpj, 'plan_id', t.plan_id,
      'status', t.status, 'trial_ends_at', t.trial_ends_at, 'paid_until', t.paid_until, 'exempt', t.billing_exempt) end,
    'account', to_jsonb(a),
    'plans', (select jsonb_object_agg(id, jsonb_build_object('name', name, 'price_cents', price_cents)) from public.plans where active));
end $$;

create or replace function public.billing_save_account(p_tenant_id uuid, p jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare a public.billing_accounts; t public.tenants;
begin
  perform private.assert_service_role();
  insert into public.billing_accounts (tenant_id) values (p_tenant_id) on conflict (tenant_id) do nothing;
  update public.billing_accounts set
    customer_id = coalesce(p->>'customer_id', customer_id),
    subscription_id = case when p ? 'subscription_id' then p->>'subscription_id' else subscription_id end,
    plan_id = coalesce(p->>'plan_id', plan_id),
    name = coalesce(p->>'name', name), cpf_cnpj = coalesce(p->>'cpf_cnpj', cpf_cnpj),
    email = coalesce(p->>'email', email), phone = coalesce(p->>'phone', phone),
    status = coalesce(p->>'status', status),
    next_due_date = case when p ? 'next_due_date' then (p->>'next_due_date')::date else next_due_date end,
    updated_at = now()
  where tenant_id = p_tenant_id returning * into a;
  select * into t from public.tenants where id = p_tenant_id for update;
  if p ? 'plan_id' then update public.tenants set plan_id = p->>'plan_id' where id = p_tenant_id; end if;
  if a.status = 'active' then
    update public.tenants set cancel_at = null where id = p_tenant_id;
  elsif a.status = 'canceled' and p->>'status' = 'canceled' then
    -- usa até o fim do período pago (ou do teste); faturas em aberto deixam de valer
    update public.tenants set cancel_at = coalesce(greatest(t.paid_until, t.trial_ends_at::date), current_date) where id = p_tenant_id;
    update public.billing_invoices set status = 'DELETED', updated_at = now()
     where tenant_id = p_tenant_id and status in ('PENDING','OVERDUE');
    perform private.billing_refresh_tenant(p_tenant_id);
  end if;
end $$;

-- recalcula atraso a partir das faturas (sem mexer em suspensão feita pelo admin)
create or replace function private.billing_refresh_tenant(p_tenant_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare t public.tenants; v_overdue date; v_paid date; v_until date;
  v_status public.tenant_status; v_reason text; v_since timestamptz;
begin
  select * into t from public.tenants where id = p_tenant_id for update;
  if not found then return; end if;
  select min(due_date) into v_overdue from public.billing_invoices where tenant_id = t.id and status = 'OVERDUE';
  select max(due_date) into v_paid from public.billing_invoices where tenant_id = t.id and status in ('RECEIVED','CONFIRMED','RECEIVED_IN_CASH');
  v_until := case when v_paid is not null then greatest(coalesce(t.paid_until, v_paid), (v_paid + interval '1 month')::date) else t.paid_until end;
  v_status := t.status; v_reason := t.suspended_reason; v_since := t.past_due_since;
  if t.status = 'suspended' and t.suspended_reason is distinct from 'billing' then
    null;                                                  -- suspensão manual do admin fica como está
  elsif v_overdue is not null then
    v_since := v_overdue::timestamptz;
    if t.status <> 'suspended' then v_status := 'past_due'; end if;
  elsif v_until is not null and v_until >= current_date and (t.cancel_at is null or t.cancel_at > current_date) then
    v_status := 'active'; v_reason := null; v_since := null;
  end if;
  update public.tenants set paid_until = v_until, status = v_status, suspended_reason = v_reason, past_due_since = v_since
   where id = t.id and (paid_until, status, suspended_reason, past_due_since) is distinct from (v_until, v_status, v_reason, v_since);
end $$;

create or replace function public.billing_apply_payment(p jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_tenant uuid; v_due date := (p->>'dueDate')::date;
begin
  perform private.assert_service_role();
  select tenant_id into v_tenant from public.billing_accounts where subscription_id = p->>'subscription' and p->>'subscription' is not null;
  if v_tenant is null and coalesce(p->>'externalReference', '') ~ '^[0-9a-f-]{36}$' then
    select id into v_tenant from public.tenants where id = (p->>'externalReference')::uuid;
  end if;
  if v_tenant is null then
    select tenant_id into v_tenant from public.billing_accounts where customer_id = p->>'customer' and p->>'customer' is not null;
  end if;
  if v_tenant is null then return null; end if;   -- cobrança que não é do Domma
  insert into public.billing_invoices (tenant_id, provider_id, subscription_id, value_cents, net_cents, status, billing_type, due_date,
                                       paid_at, invoice_url, bank_slip_url, description)
  values (v_tenant, p->>'id', p->>'subscription', round((p->>'value')::numeric * 100), round((p->>'netValue')::numeric * 100),
          upper(coalesce(p->>'status', 'PENDING')), p->>'billingType', v_due,
          coalesce((p->>'clientPaymentDate')::date, (p->>'paymentDate')::date)::timestamptz, p->>'invoiceUrl', p->>'bankSlipUrl', left(p->>'description', 200))
  on conflict (provider_id) do update set value_cents = excluded.value_cents, net_cents = excluded.net_cents, status = excluded.status,
    billing_type = excluded.billing_type, due_date = excluded.due_date, paid_at = coalesce(excluded.paid_at, public.billing_invoices.paid_at),
    invoice_url = coalesce(excluded.invoice_url, public.billing_invoices.invoice_url), bank_slip_url = excluded.bank_slip_url,
    description = excluded.description, updated_at = now();
  perform private.billing_refresh_tenant(v_tenant);
  return v_tenant;
end $$;

create or replace function public.billing_event_seen(p_id text, p_event text, p_payment text)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  perform private.assert_service_role();
  insert into public.billing_events (id, event, payment_id) values (p_id, p_event, p_payment) on conflict (id) do nothing;
  return not found;   -- true = já processado
end $$;
create or replace function public.billing_webhook_context()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.assert_service_role();
  return (select jsonb_build_object('token', webhook_token, 'env', env,
    'api_key', (select decrypted_secret from vault.decrypted_secrets where id = api_key_secret_id)) from public.billing_settings where id);
end $$;
create or replace function public.billing_test_result(p_ok boolean, p_message text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.assert_service_role();
  update public.billing_settings set last_test_at = now(), last_test_ok = p_ok, last_test_message = left(p_message, 300) where id;
end $$;

-- ---------- Super admin ----------
create or replace function public.admin_billing_settings()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_platform_admin() then raise exception 'Sem permissão.' using errcode = '42501'; end if;
  return (select jsonb_build_object('env', env, 'api_key_hint', api_key_hint, 'webhook_token', webhook_token, 'enabled', enabled,
      'grace_days', grace_days, 'last_test_at', last_test_at, 'last_test_ok', last_test_ok, 'last_test_message', last_test_message,
      'accounts', (select jsonb_object_agg(a.tenant_id, jsonb_build_object('status', a.status, 'plan_id', a.plan_id, 'next_due_date', a.next_due_date,
          'last_invoice', (select jsonb_build_object('status', i.status, 'due_date', i.due_date, 'value_cents', i.value_cents)
                           from public.billing_invoices i where i.tenant_id = a.tenant_id and i.status <> 'DELETED' order by i.due_date desc limit 1)))
        from public.billing_accounts a),
      'exempt', (select coalesce(jsonb_agg(id), '[]'::jsonb) from public.tenants where billing_exempt),
      'mrr_cents', (select coalesce(sum(p.price_cents), 0) from public.billing_accounts a join public.plans p on p.id = a.plan_id
                    join public.tenants t on t.id = a.tenant_id where a.status = 'active' and t.status in ('active','past_due')))
    from public.billing_settings where id);
end $$;
create or replace function public.admin_billing_save(p jsonb, p_api_key text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare s public.billing_settings; v uuid; k text := nullif(trim(p_api_key), '');
begin
  if not private.is_platform_admin() then raise exception 'Sem permissão.' using errcode = '42501'; end if;
  select * into s from public.billing_settings where id for update;
  if k is not null then
    if k !~ '^\$aact_[A-Za-z0-9_:+/=.-]+$' or char_length(k) not between 26 and 400 then raise exception 'Chave da API do Asaas inválida (começa com $aact_).'; end if;
    if s.api_key_secret_id is not null then perform vault.update_secret(s.api_key_secret_id, k);
    else v := vault.create_secret(k, 'asaas_api_key', 'Domma Food: chave da API do Asaas (cobrança do SaaS)');
         update public.billing_settings set api_key_secret_id = v where id; end if;
    update public.billing_settings set api_key_hint = right(k, 4), last_test_ok = null where id;
  end if;
  update public.billing_settings set
    env = coalesce(nullif(p->>'env', ''), env),
    grace_days = coalesce((p->>'grace_days')::int, grace_days),
    last_test_ok = case when p ? 'env' and p->>'env' is distinct from env then null else last_test_ok end,
    updated_at = now()
  where id returning * into s;
  if p ? 'enabled' then
    if (p->>'enabled')::boolean and coalesce(s.last_test_ok, false) = false then raise exception 'Teste a conexão com o Asaas antes de ativar.'; end if;
    update public.billing_settings set enabled = (p->>'enabled')::boolean where id;
  end if;
end $$;
create or replace function public.admin_billing_rotate_webhook()
returns text language plpgsql security definer set search_path = '' as $$
declare v text := encode(extensions.gen_random_bytes(24), 'hex');
begin
  if not private.is_platform_admin() then raise exception 'Sem permissão.' using errcode = '42501'; end if;
  update public.billing_settings set webhook_token = v where id;
  return v;
end $$;
create or replace function public.admin_set_exempt(p_tenant_id uuid, p_exempt boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_platform_admin() then raise exception 'Sem permissão.' using errcode = '42501'; end if;
  update public.tenants set billing_exempt = p_exempt,
    status = case when p_exempt and (status = 'past_due' or (status = 'suspended' and suspended_reason = 'billing')) then 'active' else status end,
    suspended_reason = case when p_exempt and suspended_reason = 'billing' then null else suspended_reason end,
    past_due_since = case when p_exempt then null else past_due_since end
  where id = p_tenant_id;
end $$;
create or replace function public.admin_can_billing_test()
returns boolean language sql stable security definer set search_path = '' as $$ select private.is_platform_admin(); $$;

-- suspensão manual pelo admin não é desfeita pela cobrança
create or replace function public.admin_set_tenant(p_tenant_id uuid, p_plan_id text, p_status public.tenant_status, p_trial_days integer default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_platform_admin() then raise exception 'Sem permissão.' using errcode = '42501'; end if;
  update public.tenants set plan_id = p_plan_id, status = p_status,
    trial_ends_at = case when p_trial_days is not null then now() + make_interval(days => p_trial_days) else trial_ends_at end,
    suspended_reason = case when p_status = 'suspended' then 'admin' else null end,
    past_due_since = case when p_status = 'past_due' then coalesce(past_due_since, now()) when p_status in ('active','trial') then null else past_due_since end
  where id = p_tenant_id;
  if not found then raise exception 'Empresa não encontrada.'; end if;
end $$;

-- ---------- Rotina diária: fim do teste, carência, cancelamento ----------
create or replace function private.billing_daily()
returns integer language plpgsql security definer set search_path = '' as $$
declare s public.billing_settings; n int := 0; c int;
begin
  select * into s from public.billing_settings where id;
  if not coalesce(s.enabled, false) then return 0; end if;
  -- teste acabou sem pagamento: entra em atraso (com carência)
  update public.tenants t set status = 'past_due', past_due_since = t.trial_ends_at
   where t.status = 'trial' and t.trial_ends_at < now() and not t.billing_exempt;
  get diagnostics c = row_count; n := n + c;
  -- carência vencida: suspende (o painel continua aberto para o dono pagar)
  update public.tenants t set status = 'suspended', suspended_reason = 'billing'
   where t.status = 'past_due' and not t.billing_exempt and t.past_due_since < now() - make_interval(days => s.grace_days);
  get diagnostics c = row_count; n := n + c;
  -- assinatura cancelada: encerra no fim do período pago
  update public.tenants t set status = 'suspended', suspended_reason = 'billing'
   where t.status in ('active','trial','past_due') and not t.billing_exempt and t.cancel_at is not null and t.cancel_at <= current_date;
  get diagnostics c = row_count; n := n + c;
  return n;
end $$;
select cron.schedule('domma-billing-daily', '23 9 * * *', $$select private.billing_daily()$$);   -- 6h23 em Brasília

grant execute on function public.billing_context(uuid), public.billing_save_account(uuid, jsonb), public.billing_apply_payment(jsonb),
  public.billing_event_seen(text, text, text), public.billing_webhook_context(), public.billing_test_result(boolean, text) to service_role;
grant execute on function public.billing_overview(uuid), public.billing_can_manage(uuid), public.admin_billing_settings(), public.admin_billing_save(jsonb, text),
  public.admin_billing_rotate_webhook(), public.admin_set_exempt(uuid, boolean), public.admin_can_billing_test() to authenticated;
revoke execute on function public.billing_context(uuid), public.billing_save_account(uuid, jsonb), public.billing_apply_payment(jsonb),
  public.billing_event_seen(text, text, text), public.billing_webhook_context(), public.billing_test_result(boolean, text) from public, anon, authenticated;
revoke execute on function public.billing_overview(uuid), public.billing_can_manage(uuid), public.admin_billing_settings(), public.admin_billing_save(jsonb, text),
  public.admin_billing_rotate_webhook(), public.admin_set_exempt(uuid, boolean), public.admin_can_billing_test() from public, anon;
revoke execute on function private.billing_refresh_tenant(uuid), private.billing_daily() from public, anon, authenticated;
revoke all on public.billing_settings, public.billing_accounts, public.billing_invoices, public.billing_events from anon;
revoke insert, update, delete on public.billing_settings, public.billing_accounts, public.billing_invoices, public.billing_events from authenticated;
revoke select on public.billing_settings, public.billing_events from authenticated;
