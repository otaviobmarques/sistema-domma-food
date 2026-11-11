-- =====================================================================
-- Domma Food · 031 · Marketing e WhatsApp: campanhas, automações
-- (aniversário, clientes inativos), cupom automático, envio pela API
-- oficial do WhatsApp (Cloud API) ou manual por link, e conversões
-- =====================================================================
create table public.marketing_settings (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  wa_enabled boolean not null default false,
  wa_phone_number_id text check (wa_phone_number_id is null or wa_phone_number_id ~ '^[0-9]{5,30}$'),
  wa_business_account_id text check (wa_business_account_id is null or wa_business_account_id ~ '^[0-9]{5,30}$'),
  wa_token_secret_id uuid, wa_app_secret_id uuid, wa_token_hint text,
  wa_verify_token text not null default encode(extensions.gen_random_bytes(16), 'hex'),
  graph_version text not null default 'v23.0' check (graph_version ~ '^v[0-9]{2}\.[0-9]$'),
  frequency_days integer not null default 7 check (frequency_days between 1 and 60),
  send_from_hour integer not null default 9 check (send_from_hour between 0 and 23),
  send_to_hour integer not null default 21 check (send_to_hour between 1 and 24),
  last_test_at timestamptz, last_test_ok boolean, last_test_message text,
  updated_at timestamptz not null default now()
);
create table public.campaigns (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  unit_id uuid references public.units(id) on delete set null,
  name text not null check (char_length(name) between 2 and 80),
  kind text not null default 'manual' check (kind in ('manual','birthday','winback')),
  segment jsonb not null default '{"type":"inactive","days":30}',
  channel text not null default 'manual_links' check (channel in ('manual_links','whatsapp_api')),
  message text not null check (char_length(message) between 5 and 1000),   -- {nome}, {cupom}, {loja}, {link}, {cashback}
  template_name text check (template_name is null or template_name ~ '^[a-z0-9_]{1,512}$'),
  template_lang text not null default 'pt_BR',
  template_params text[] not null default array['nome'],               -- variáveis do modelo aprovado, na ordem
  coupon_mode text not null default 'none' check (coupon_mode in ('none','unique','shared')),
  coupon_kind text not null default 'percent' check (coupon_kind in ('percent','fixed','free_delivery')),
  coupon_value integer not null default 10,
  coupon_min_order_cents integer not null default 0,
  coupon_valid_days integer not null default 7 check (coupon_valid_days between 1 and 90),
  shared_coupon_id uuid references public.coupons(id) on delete set null,
  status text not null default 'draft' check (status in ('draft','sending','done','active','paused')),
  launched_at timestamptz,
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index campaigns_one_automation on public.campaigns(tenant_id, kind) where kind <> 'manual';
create table public.campaign_messages (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  period text not null default '',              -- automações: um envio por cliente por período (ex.: ano do aniversário)
  phone text not null,
  body text not null,
  params jsonb not null default '[]',
  coupon_code text,
  status text not null default 'queued' check (status in ('queued','sending','sent','delivered','read','failed','manual_pending','manual_done','skipped')),
  wa_message_id text, error text, attempts integer not null default 0,
  created_at timestamptz not null default now(),
  sent_at timestamptz, delivered_at timestamptz, read_at timestamptz,
  converted_order_id uuid references public.orders(id) on delete set null, converted_at timestamptz,
  unique (campaign_id, customer_id, period)
);
create index campaign_messages_queue_idx on public.campaign_messages(id) where status = 'queued';
create index campaign_messages_wa_idx on public.campaign_messages(wa_message_id) where wa_message_id is not null;
create index campaign_messages_customer_idx on public.campaign_messages(customer_id, sent_at desc);
alter table public.customers add column marketing_opt_out_at timestamptz;

do $$ declare t text; begin
  foreach t in array array['marketing_settings','campaigns','campaign_messages'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
  end loop;
end $$;
create policy ms_select on public.marketing_settings for select to authenticated using (private.can_manage(tenant_id));
create policy cp_select on public.campaigns for select to authenticated using (private.can_manage(tenant_id));
create policy cm_select on public.campaign_messages for select to authenticated using (private.can_manage(tenant_id));
create trigger campaigns_touch before update on public.campaigns for each row execute function private.touch_updated_at();
create trigger campaigns_audit after insert or update or delete on public.campaigns for each row execute function private.audit_row();

-- aniversário informado no checkout (opcional)
do $$ declare d text; begin
  d := pg_get_functiondef('public.place_order(jsonb)'::regprocedure);
  if position($x$select customer_id, tenant_id into v_cust, v_tenant from public.orders where id = v_order;$x$ in d) = 0 then raise exception 'place_order mudou'; end if;
  execute replace(d, $x$select customer_id, tenant_id into v_cust, v_tenant from public.orders where id = v_order;$x$,
    $x$select customer_id, tenant_id into v_cust, v_tenant from public.orders where id = v_order;
  if (p->'customer'->>'birthday') ~ '^\d{4}-\d{2}-\d{2}$' then
    begin
      update public.customers set birthday = coalesce(birthday, (p->'customer'->>'birthday')::date)
       where id = v_cust and (p->'customer'->>'birthday')::date between date '1900-01-01' and current_date;
    exception when others then null;
    end;
  end if;$x$);
end $$;

-- ---------- Público ----------
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
      else false end;
$$;

create or replace function public.campaign_audience_count(p_tenant_id uuid, p_segment jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare s public.marketing_settings;
begin
  if not private.can_manage(p_tenant_id) then raise exception 'Sem permissão.' using errcode = '42501'; end if;
  select * into s from public.marketing_settings where tenant_id = p_tenant_id;
  return jsonb_build_object(
    'eligible', (select count(*) from private.campaign_audience(p_tenant_id, p_segment, coalesce(s.frequency_days, 7))),
    'opted_in', (select count(*) from public.customers where tenant_id = p_tenant_id and opt_in_marketing and marketing_opt_out_at is null),
    'total', (select count(*) from public.customers where tenant_id = p_tenant_id));
end $$;

create or replace function private.campaign_render(p_msg text, c public.customers, p_store text, p_coupon text, p_slug text)
returns text language sql stable as $$
  select replace(replace(replace(replace(replace(p_msg,
    '{nome}', coalesce(split_part(c.name, ' ', 1), 'cliente')),
    '{cupom}', coalesce(p_coupon, '')),
    '{loja}', coalesce(p_store, '')),
    '{link}', coalesce('https://domma-food.vercel.app/loja/' || p_slug, '')),
    '{cashback}', to_char(coalesce(c.cashback_cents, 0) / 100.0, 'FM999G990D00'));
$$;

-- gera as mensagens de uma campanha (e cupons, se houver) para o público atual
create or replace function private.campaign_generate(p_campaign uuid, p_period text)
returns integer language plpgsql security definer set search_path = '' as $$
declare cp public.campaigns; s public.marketing_settings; u public.units; c public.customers; v_code text; n int := 0; v_cid uuid; v_val text;
  v_params jsonb; k text;
begin
  select * into cp from public.campaigns where id = p_campaign for update;
  select * into s from public.marketing_settings where tenant_id = cp.tenant_id;
  select * into u from public.units where id = coalesce(cp.unit_id, (select id from public.units where tenant_id = cp.tenant_id order by id limit 1));
  if cp.channel = 'whatsapp_api' and (s.wa_enabled is not true or cp.template_name is null) then
    raise exception 'Envio pela API do WhatsApp não está configurado (ou falta o nome do modelo aprovado).'; end if;
  if cp.coupon_mode = 'shared' and cp.shared_coupon_id is null then
    v_code := upper(left(regexp_replace(cp.name, '[^A-Za-z0-9]', '', 'g'), 8)) || upper(substr(md5(random()::text), 1, 4));
    insert into public.coupons (tenant_id, code, description, kind, value, min_order_cents, max_uses_per_customer, ends_at)
    values (cp.tenant_id, left(v_code, 30), 'Campanha: ' || cp.name, cp.coupon_kind, case when cp.coupon_kind = 'free_delivery' then 0 else cp.coupon_value end,
            cp.coupon_min_order_cents, 1, now() + make_interval(days => cp.coupon_valid_days)) returning id into v_cid;
    update public.campaigns set shared_coupon_id = v_cid where id = cp.id;
    cp.shared_coupon_id := v_cid;
  end if;
  for c in select cu.* from private.campaign_audience(cp.tenant_id, cp.segment, coalesce(s.frequency_days, 7)) a
           join public.customers cu on cu.id = a.customer_id
           where not exists (select 1 from public.campaign_messages m where m.campaign_id = cp.id and m.customer_id = cu.id and m.period = p_period)
           limit 2000 loop
    v_code := null;
    if cp.coupon_mode = 'unique' then
      v_code := case cp.kind when 'birthday' then 'NIVER' when 'winback' then 'VOLTA' else 'DOMMA' end || upper(substr(md5(random()::text || c.id::text), 1, 6));
      insert into public.coupons (tenant_id, code, description, kind, value, min_order_cents, max_uses, max_uses_per_customer, ends_at)
      values (cp.tenant_id, v_code, 'Campanha: ' || cp.name || ' · ' || left(c.name, 40), cp.coupon_kind,
              case when cp.coupon_kind = 'free_delivery' then 0 else cp.coupon_value end, cp.coupon_min_order_cents, 1, 1,
              now() + make_interval(days => cp.coupon_valid_days));
    elsif cp.coupon_mode = 'shared' then
      select code into v_code from public.coupons where id = cp.shared_coupon_id;
    end if;
    v_params := '[]'::jsonb;
    foreach k in array cp.template_params loop
      v_val := case k when 'nome' then coalesce(split_part(c.name, ' ', 1), 'cliente') when 'cupom' then coalesce(v_code, '')
        when 'loja' then u.name when 'link' then 'https://domma-food.vercel.app/loja/' || u.slug
        when 'cashback' then to_char(coalesce(c.cashback_cents, 0) / 100.0, 'FM999G990D00') else '' end;
      v_params := v_params || to_jsonb(v_val);
    end loop;
    insert into public.campaign_messages (tenant_id, campaign_id, customer_id, period, phone, body, params, coupon_code, status)
    values (cp.tenant_id, cp.id, c.id, p_period, case when length(c.phone) <= 11 then '55' || c.phone else c.phone end,
            private.campaign_render(cp.message, c, u.name, v_code, u.slug), v_params, v_code,
            case when cp.channel = 'whatsapp_api' then 'queued' else 'manual_pending' end);
    n := n + 1;
  end loop;
  return n;
end $$;
