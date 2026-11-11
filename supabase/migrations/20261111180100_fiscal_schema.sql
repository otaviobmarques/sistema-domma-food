-- =====================================================================
-- Domma Food · 022 · NFC-e: configuração fiscal, dados fiscais do produto,
-- documentos fiscais e montagem da nota (provedor: Focus NFe, API v2)
-- =====================================================================
create table public.fiscal_settings (
  unit_id uuid primary key references public.units(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  enabled boolean not null default false,
  provider text not null default 'focusnfe' check (provider in ('focusnfe')),
  environment text not null default 'homologacao' check (environment in ('homologacao','producao')),
  cnpj text check (cnpj is null or cnpj ~ '^[0-9]{14}$'),
  legal_name text check (legal_name is null or char_length(legal_name) <= 120),
  state_registration text check (state_registration is null or char_length(state_registration) <= 20),
  tax_regime text not null default '1' check (tax_regime in ('1','2','3')), -- 1 Simples, 2 Simples excesso, 3 Normal
  default_ncm text not null default '21069090' check (default_ncm ~ '^[0-9]{8}$'),
  default_cfop text not null default '5102' check (default_cfop ~ '^[0-9]{4}$'),
  default_icms_cst text not null default '102' check (default_icms_cst ~ '^[0-9]{2,3}$'),
  default_origin text not null default '0' check (default_origin ~ '^[0-8]$'),
  auto_emit boolean not null default false,
  include_marketplace boolean not null default false,
  token_secret_id uuid,              -- vault.secrets (token da API do provedor)
  token_hint text,                   -- últimos 4 caracteres, para exibir
  last_test_at timestamptz, last_test_ok boolean, last_test_message text,
  updated_at timestamptz not null default now()
);
-- ncm, cfop, cest e csosn já existem no produto (core_schema); faltam origem e unidade
alter table public.products
  add column fiscal_origin text check (fiscal_origin is null or fiscal_origin ~ '^[0-8]$'),
  add column fiscal_unit text not null default 'UN' check (char_length(fiscal_unit) between 1 and 6);

create table public.fiscal_documents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  unit_id uuid not null references public.units(id) on delete cascade,
  order_id uuid references public.orders(id) on delete set null,
  tab_id uuid references public.tabs(id) on delete set null,
  ref text not null unique default ('df' || replace(gen_random_uuid()::text, '-', '')),
  environment text not null,
  status text not null default 'pending' check (status in ('pending','processing','authorized','rejected','error','cancel_requested','cancelling','cancelled')),
  consumer_doc text check (consumer_doc is null or consumer_doc ~ '^([0-9]{11}|[0-9]{14})$'),
  total_cents integer,
  number text, series text, access_key text, protocol text,
  xml_url text, danfe_url text, qrcode_url text, consult_url text, cancel_xml_url text,
  message text, cancel_reason text,
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  payload jsonb, response jsonb,
  requested_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  authorized_at timestamptz, cancelled_at timestamptz,
  constraint fiscal_target_chk check (order_id is not null or tab_id is not null)
);
create index fiscal_documents_unit_created_idx on public.fiscal_documents(unit_id, created_at desc);
create index fiscal_documents_queue_idx on public.fiscal_documents(next_attempt_at) where status in ('pending','cancel_requested');
create unique index fiscal_documents_one_active_order on public.fiscal_documents(order_id)
  where order_id is not null and status not in ('rejected','error','cancelled');
create unique index fiscal_documents_one_active_tab on public.fiscal_documents(tab_id)
  where tab_id is not null and status not in ('rejected','error','cancelled');

do $$ declare t text; begin
  foreach t in array array['fiscal_settings','fiscal_documents'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('revoke insert, update, delete on public.%I from authenticated', t);
  end loop;
end $$;
create policy fs_select on public.fiscal_settings for select to authenticated
  using (private.can_manage(tenant_id) and private.can_access_unit(unit_id));
create policy fd_select on public.fiscal_documents for select to authenticated
  using (private.can_access_unit(unit_id) and private.has_role(tenant_id, array['owner','manager','cashier']::public.member_role[]));
create trigger fiscal_settings_audit after insert or update on public.fiscal_settings for each row execute function private.audit_row();
alter publication supabase_realtime add table public.fiscal_documents;

-- ---------- Configuração ----------
create or replace function public.fiscal_save_settings(p_unit_id uuid, p jsonb, p_token text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare u public.units; s public.fiscal_settings; v_secret uuid; v_cnpj text := private.only_digits(p->>'cnpj');
begin
  select * into u from public.units where id = p_unit_id;
  if not found or not private.can_access_unit(u.id) or not private.has_role(u.tenant_id, array['owner']::public.member_role[]) then
    raise exception 'Só o dono da conta altera a configuração fiscal.' using errcode = '42501'; end if;
  insert into public.fiscal_settings (unit_id, tenant_id) values (u.id, u.tenant_id) on conflict (unit_id) do nothing;
  select * into s from public.fiscal_settings where unit_id = u.id for update;
  if p_token is not null and trim(p_token) <> '' then
    if char_length(trim(p_token)) not between 16 and 200 then raise exception 'Token do provedor inválido.'; end if;
    if s.token_secret_id is not null then
      perform vault.update_secret(s.token_secret_id, trim(p_token));
    else
      v_secret := vault.create_secret(trim(p_token), 'fiscal_' || u.id, 'Domma Food: token do provedor fiscal');
      update public.fiscal_settings set token_secret_id = v_secret where unit_id = u.id;
    end if;
    update public.fiscal_settings set token_hint = right(trim(p_token), 4), last_test_at = null, last_test_ok = null where unit_id = u.id;
  end if;
  update public.fiscal_settings set
    environment = coalesce(p->>'environment', environment),
    last_test_ok = case when coalesce(p->>'environment', environment) <> environment then null else last_test_ok end,
    cnpj = case when p ? 'cnpj' then nullif(v_cnpj, '') else cnpj end,
    legal_name = case when p ? 'legal_name' then left(nullif(trim(p->>'legal_name'), ''), 120) else legal_name end,
    state_registration = case when p ? 'state_registration' then left(nullif(trim(p->>'state_registration'), ''), 20) else state_registration end,
    tax_regime = coalesce(p->>'tax_regime', tax_regime),
    default_ncm = coalesce(nullif(private.only_digits(p->>'default_ncm'), ''), default_ncm),
    default_cfop = coalesce(nullif(private.only_digits(p->>'default_cfop'), ''), default_cfop),
    default_icms_cst = coalesce(nullif(private.only_digits(p->>'default_icms_cst'), ''), default_icms_cst),
    default_origin = coalesce(p->>'default_origin', default_origin),
    auto_emit = coalesce((p->>'auto_emit')::boolean, auto_emit),
    include_marketplace = coalesce((p->>'include_marketplace')::boolean, include_marketplace),
    enabled = coalesce((p->>'enabled')::boolean, enabled),
    updated_at = now()
  where unit_id = u.id returning * into s;
  if s.enabled and (s.cnpj is null or s.token_secret_id is null) then
    raise exception 'Para ativar a NFC-e, informe o CNPJ e o token do provedor.'; end if;
  if s.environment = 'producao' and s.enabled and coalesce(s.last_test_ok, false) = false then
    raise exception 'Teste a conexão com o provedor antes de emitir em produção.'; end if;
end $$;

-- ---------- Montagem da nota (valores em reais, como a API espera) ----------
create or replace function private.fiscal_code(m text)
returns text language sql immutable as $$
  select case m when 'cash' then '01' when 'credit_card' then '03' when 'online_card' then '03' when 'card_on_delivery' then '03'
    when 'debit_card' then '04' when 'credit_account' then '05' when 'voucher' then '11' when 'pix' then '17' else '99' end;
$$;

create or replace function private.fiscal_payload(p_doc uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare d public.fiscal_documents; s public.fiscal_settings; tz text; v_items jsonb := '[]'::jsonb; v_pays jsonb := '[]'::jsonb;
  r record; v_n int := 0; v_gross bigint := 0; v_disc bigint := 0; v_total bigint; v_left bigint; v_alloc bigint; v_cnt int; v_i int := 0;
  v_paysum bigint; v_pleft bigint; v_pi int := 0; v_pc int; v_amt bigint; v_now timestamp; v_off interval;
begin
  select * into d from public.fiscal_documents where id = p_doc;
  select * into s from public.fiscal_settings where unit_id = d.unit_id;
  select timezone into tz from public.units where id = d.unit_id;
  -- itens e descontos (taxa de serviço e de entrega ficam fora da nota)
  create temp table if not exists _fi (n int, name text, qty int, unit_cents int, gross int, product_id uuid, ncm text, cfop text, cst text, origin text, un text) on commit drop;
  truncate _fi;
  insert into _fi
  select row_number() over (order by o.created_at, i.id), i.name, i.quantity, i.unit_price_cents, i.total_cents, i.product_id,
         case when p.ncm ~ '^[0-9]{8}$' then p.ncm else s.default_ncm end,
         case when p.cfop ~ '^[0-9]{4}$' then p.cfop else s.default_cfop end,
         case when p.csosn ~ '^[0-9]{2,3}$' then p.csosn else s.default_icms_cst end,
         coalesce(p.fiscal_origin, s.default_origin), coalesce(p.fiscal_unit, 'UN')
  from public.orders o join public.order_items i on i.order_id = o.id left join public.products p on p.id = i.product_id
  where o.status <> 'cancelled' and ((d.order_id is not null and o.id = d.order_id) or (d.tab_id is not null and o.tab_id = d.tab_id))
    and i.total_cents > 0;
  select coalesce(sum(gross), 0), count(*) into v_gross, v_cnt from _fi;
  if v_cnt = 0 then raise exception 'Não há itens com valor para emitir a nota.'; end if;
  if d.order_id is not null then
    select discount_cents + cashback_used_cents into v_disc from public.orders where id = d.order_id;
  else
    select discount_cents into v_disc from public.tabs where id = d.tab_id;
  end if;
  v_disc := least(greatest(coalesce(v_disc, 0), 0), v_gross - 1);
  v_total := v_gross - v_disc; v_left := v_disc;
  for r in select * from _fi order by n loop
    v_i := v_i + 1;
    v_alloc := case when v_i = v_cnt then v_left else floor(v_disc::numeric * r.gross / v_gross) end;
    v_alloc := least(v_alloc, r.gross); v_left := v_left - v_alloc;
    v_items := v_items || jsonb_strip_nulls(jsonb_build_object(
      'numero_item', r.n::text, 'codigo_produto', coalesce(left(replace(r.product_id::text, '-', ''), 12), 'ITEM' || r.n),
      'descricao', case when s.environment = 'homologacao' and r.n = 1
                        then 'NOTA FISCAL EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL' else left(r.name, 120) end,
      'codigo_ncm', r.ncm, 'cfop', r.cfop, 'icms_situacao_tributaria', r.cst, 'icms_origem', r.origin,
      'unidade_comercial', r.un, 'unidade_tributavel', r.un,
      'quantidade_comercial', r.qty, 'quantidade_tributavel', r.qty,
      'valor_unitario_comercial', round(r.unit_cents / 100.0, 2), 'valor_unitario_tributavel', round(r.unit_cents / 100.0, 2),
      'valor_bruto', round(r.gross / 100.0, 2),
      'valor_desconto', case when v_alloc > 0 then round(v_alloc / 100.0, 2) end));
  end loop;
  -- pagamentos proporcionais ao total da nota (troco já descontado no PDV)
  create temp table if not exists _fp (m text, amt bigint) on commit drop;
  truncate _fp;
  insert into _fp select method::text, sum(amount_cents) from public.payments
   where status = 'paid' and ((d.order_id is not null and order_id = d.order_id) or (d.tab_id is not null and tab_id = d.tab_id)) group by 1;
  if not exists (select 1 from _fp) then
    insert into _fp select payment_method::text, v_total from public.orders where id = coalesce(d.order_id,
      (select id from public.orders where tab_id = d.tab_id and status <> 'cancelled' limit 1));
  end if;
  select sum(amt), count(*) into v_paysum, v_pc from _fp;
  v_pleft := v_total;
  for r in select * from _fp order by amt desc loop
    v_pi := v_pi + 1;
    v_amt := case when v_pi = v_pc then v_pleft else round(v_total::numeric * r.amt / greatest(v_paysum, 1)) end;
    v_pleft := v_pleft - v_amt;
    if v_amt > 0 then
      v_pays := v_pays || jsonb_build_object('forma_pagamento', private.fiscal_code(r.m), 'valor_pagamento', round(v_amt / 100.0, 2));
    end if;
  end loop;
  v_now := now() at time zone coalesce(tz, 'America/Sao_Paulo');
  v_off := v_now - (now() at time zone 'UTC');
  return jsonb_strip_nulls(jsonb_build_object(
    'cnpj_emitente', s.cnpj,
    'data_emissao', to_char(v_now, 'YYYY-MM-DD"T"HH24:MI:SS') || case when v_off < interval '0' then '-' else '+' end || to_char(abs(extract(epoch from v_off)) / 3600, 'FM00') || ':' || to_char(mod(abs(extract(epoch from v_off))::int, 3600) / 60, 'FM00'),
    'natureza_operacao', 'VENDA AO CONSUMIDOR', 'presenca_comprador', '1', 'modalidade_frete', '9', 'local_destino', '1',
    'cpf_destinatario', case when length(d.consumer_doc) = 11 then d.consumer_doc end,
    'cnpj_destinatario', case when length(d.consumer_doc) = 14 then d.consumer_doc end,
    'items', v_items, 'formas_pagamento', v_pays,
    '_total_cents', v_total));
end $$;
