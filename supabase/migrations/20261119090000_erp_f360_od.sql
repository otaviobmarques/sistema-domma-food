-- =====================================================================
-- Domma Food · 046 · Integrações de gestão: F360 Finanças e PDVs Open Delivery (Eclética)
--   F360: cada venda concluída (e cada cancelamento) vira um cupom no
--         "Webhook F360 - PDV" da loja, para conciliação e fluxo de caixa.
--   Open Delivery (Pedidos): o Domma atua como Ordering Application. O PDV
--         (Eclética ou outro aderente) pega o token, faz polling dos eventos,
--         busca o pedido no formato Open Delivery e devolve confirmação,
--         preparo, pronto, despacho, entrega e cancelamento.
-- =====================================================================
alter table public.products add column if not exists pdv_code text check (char_length(pdv_code) <= 60);
alter table public.options add column if not exists pdv_code text check (char_length(pdv_code) <= 60);

create table public.erp_settings (
  unit_id uuid primary key references public.units(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  -- F360
  f360_enabled boolean not null default false,
  f360_url_secret_id uuid,              -- URL do webhook (identificador do serviço) no Vault
  f360_url_hint text,
  f360_cnpj text check (f360_cnpj ~ '^[0-9]{14}$'),
  f360_since timestamptz,
  f360_last_ok_at timestamptz, f360_last_error text,
  -- Open Delivery (PDV)
  od_enabled boolean not null default false,
  od_app_name text not null default 'Eclética' check (char_length(od_app_name) between 1 and 40),
  od_client_id text unique check (od_client_id ~ '^dmo_[0-9a-f]{24}$'),
  od_secret_hash text,
  od_channels text[] not null default array['web','whatsapp','totem','table','phone','counter'],
  od_since timestamptz,
  od_last_poll_at timestamptz,
  updated_at timestamptz not null default now()
);
alter table public.erp_settings enable row level security;
alter table public.erp_settings force row level security;
revoke all on public.erp_settings from anon, authenticated;

create table public.f360_queue (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  unit_id uuid not null references public.units(id) on delete cascade,
  order_id uuid not null references public.orders(id) on delete cascade,
  kind text not null check (kind in ('sale','cancel')),
  status text not null default 'queued' check (status in ('queued','sending','sent','failed')),
  attempts int not null default 0,
  last_error text,
  next_attempt_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  unique (order_id, kind)
);
create index f360_queue_pending on public.f360_queue (next_attempt_at) where status in ('queued','sending');
alter table public.f360_queue enable row level security;
alter table public.f360_queue force row level security;
revoke all on public.f360_queue from anon, authenticated;

create table public.od_tokens (
  token_hash text primary key,
  unit_id uuid not null references public.units(id) on delete cascade,
  expires_at timestamptz not null
);
create index od_tokens_unit on public.od_tokens (unit_id);
create table public.od_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  unit_id uuid not null references public.units(id) on delete cascade,
  order_id uuid not null references public.orders(id) on delete cascade,
  event_type text not null,
  created_at timestamptz not null default now(),
  acked_at timestamptz
);
create index od_events_pending on public.od_events (unit_id, created_at) where acked_at is null;
alter table public.od_tokens enable row level security;
alter table public.od_tokens force row level security;
alter table public.od_events enable row level security;
alter table public.od_events force row level security;
revoke all on public.od_tokens, public.od_events from anon, authenticated;

create or replace function private.valid_cnpj(p text)
returns boolean language plpgsql immutable set search_path = '' as $$
declare s int; r int; i int; w1 int[] := array[5,4,3,2,9,8,7,6,5,4,3,2]; w2 int[] := array[6,5,4,3,2,9,8,7,6,5,4,3,2];
begin
  if p is null or p !~ '^[0-9]{14}$' or p ~ '^(.)\1{13}$' then return false; end if;
  s := 0; for i in 1..12 loop s := s + substr(p, i, 1)::int * w1[i]; end loop; r := s % 11;
  if (case when r < 2 then 0 else 11 - r end) <> substr(p, 13, 1)::int then return false; end if;
  s := 0; for i in 1..13 loop s := s + substr(p, i, 1)::int * w2[i]; end loop; r := s % 11;
  return (case when r < 2 then 0 else 11 - r end) = substr(p, 14, 1)::int;
end $$;

-- ---------- Painel (dono/gerência) ----------
create or replace function public.erp_overview(p_unit_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare u public.units; s public.erp_settings;
begin
  select * into u from public.units where id = p_unit_id;
  if not found or not private.can_manage(u.tenant_id) or not private.can_access_unit(u.id) then raise exception 'Sem permissão.' using errcode = '42501'; end if;
  select * into s from public.erp_settings where unit_id = u.id;
  return jsonb_build_object(
    'fiscal_cnpj', (select cnpj from public.fiscal_settings where unit_id = u.id),
    'f360', jsonb_build_object('enabled', coalesce(s.f360_enabled, false), 'url_hint', s.f360_url_hint, 'cnpj', s.f360_cnpj,
      'since', s.f360_since, 'last_ok_at', s.f360_last_ok_at, 'last_error', s.f360_last_error,
      'queued', (select count(*) from public.f360_queue where unit_id = u.id and status in ('queued','sending')),
      'failed', (select count(*) from public.f360_queue where unit_id = u.id and status = 'failed'),
      'sent_today', (select count(*) from public.f360_queue where unit_id = u.id and status = 'sent' and sent_at > now() - interval '24 hours'),
      'recent', coalesce((select jsonb_agg(jsonb_build_object('number', o.number, 'kind', q.kind, 'status', q.status, 'error', q.last_error,
          'at', coalesce(q.sent_at, q.created_at)) order by q.id desc)
        from (select * from public.f360_queue where unit_id = u.id order by id desc limit 10) q join public.orders o on o.id = q.order_id), '[]'::jsonb)),
    'od', jsonb_build_object('enabled', coalesce(s.od_enabled, false), 'app_name', coalesce(s.od_app_name, 'Eclética'), 'client_id', s.od_client_id,
      'has_secret', s.od_secret_hash is not null, 'channels', coalesce(to_jsonb(s.od_channels), '["web","whatsapp","totem","table","phone","counter"]'::jsonb),
      'since', s.od_since, 'last_poll_at', s.od_last_poll_at,
      'pending_events', (select count(*) from public.od_events where unit_id = u.id and acked_at is null)));
end $$;

create or replace function public.erp_save(p_unit_id uuid, p jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare u public.units; s public.erp_settings;
  v_url text := nullif(trim(p->>'f360_url'), ''); v_cnpj text := nullif(regexp_replace(coalesce(p->>'f360_cnpj', ''), '\D', '', 'g'), '');
  v_ch text[];
begin
  select * into u from public.units where id = p_unit_id;
  if not found or not private.can_manage(u.tenant_id) or not private.can_access_unit(u.id) then raise exception 'Sem permissão.' using errcode = '42501'; end if;
  insert into public.erp_settings (unit_id, tenant_id) values (u.id, u.tenant_id) on conflict (unit_id) do nothing;
  select * into s from public.erp_settings where unit_id = u.id for update;
  if v_url is not null then
    v_url := rtrim(v_url, '/');
    if v_url ~ '^https://webhook\.f360\.com\.br/[A-Za-z0-9_-]{6,120}$' then v_url := v_url || '/f360-cupom-fiscal'; end if;
    if v_url !~ '^https://webhook\.f360\.com\.br/[A-Za-z0-9_-]{6,120}/f360-cupom-fiscal$' then
      raise exception 'URL inválida. Use a URL do "Webhook F360 - PDV" (https://webhook.f360.com.br/.../f360-cupom-fiscal).'; end if;
  end if;
  if v_cnpj is not null and not private.valid_cnpj(v_cnpj) then raise exception 'CNPJ inválido.'; end if;
  if p ? 'od_channels' then
    select coalesce(array_agg(distinct x), '{}') into v_ch from jsonb_array_elements_text(p->'od_channels') x
     where x in ('web','whatsapp','totem','table','phone','counter','ifood','99food','keeta','aiqfome','marketplace');
  end if;
  update public.erp_settings set
    f360_url_secret_id = case when v_url is not null then private.vault_put(f360_url_secret_id, v_url, 'f360_webhook') else f360_url_secret_id end,
    f360_url_hint = case when v_url is not null then 'webhook.f360.com.br/…' || right(split_part(v_url, '/', 4), 4) else f360_url_hint end,
    f360_cnpj = case when p ? 'f360_cnpj' then v_cnpj else f360_cnpj end,
    f360_enabled = coalesce((p->>'f360_enabled')::boolean, f360_enabled),
    od_enabled = coalesce((p->>'od_enabled')::boolean, od_enabled),
    od_app_name = coalesce(left(nullif(trim(p->>'od_app_name'), ''), 40), od_app_name),
    od_channels = coalesce(v_ch, od_channels),
    updated_at = now()
  where unit_id = u.id returning * into s;
  if s.f360_enabled and (s.f360_url_secret_id is null or s.f360_cnpj is null) then
    raise exception 'Para ligar o F360, informe a URL do webhook e o CNPJ da loja cadastrado no F360.'; end if;
  if s.od_enabled and s.od_secret_hash is null then raise exception 'Gere as credenciais do Open Delivery antes de ligar.'; end if;
  -- só vão para o F360 / PDV os pedidos a partir de quando a integração foi ligada
  update public.erp_settings set
    f360_since = case when s.f360_enabled and f360_since is null then now() when not s.f360_enabled then null else f360_since end,
    od_since = case when s.od_enabled and od_since is null then now() when not s.od_enabled then null else od_since end
  where unit_id = u.id;
end $$;

-- gera (ou troca) as credenciais do Open Delivery; o segredo aparece uma vez
create or replace function public.erp_od_credentials(p_unit_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare u public.units; v_id text; v_secret text := 'dms_' || encode(extensions.gen_random_bytes(24), 'hex');
begin
  select * into u from public.units where id = p_unit_id;
  if not found or not private.can_manage(u.tenant_id) or not private.can_access_unit(u.id) then raise exception 'Sem permissão.' using errcode = '42501'; end if;
  insert into public.erp_settings (unit_id, tenant_id) values (u.id, u.tenant_id) on conflict (unit_id) do nothing;
  update public.erp_settings set od_client_id = coalesce(od_client_id, 'dmo_' || encode(extensions.gen_random_bytes(12), 'hex')),
    od_secret_hash = encode(extensions.digest(v_secret, 'sha256'), 'hex'), updated_at = now()
  where unit_id = u.id returning od_client_id into v_id;
  delete from public.od_tokens where unit_id = u.id;     -- tokens antigos param de valer
  return jsonb_build_object('client_id', v_id, 'client_secret', v_secret, 'merchant_id', u.id);
end $$;

create or replace function public.erp_f360_retry(p_unit_id uuid)
returns int language plpgsql security definer set search_path = '' as $$
declare u public.units; n int;
begin
  select * into u from public.units where id = p_unit_id;
  if not found or not private.can_manage(u.tenant_id) or not private.can_access_unit(u.id) then raise exception 'Sem permissão.' using errcode = '42501'; end if;
  update public.f360_queue set status = 'queued', attempts = 0, next_attempt_at = now(), last_error = null where unit_id = u.id and status = 'failed';
  get diagnostics n = row_count;
  return n;
end $$;

-- ---------- Gatilhos nos pedidos ----------
create or replace function private.erp_on_order()
returns trigger language plpgsql security definer set search_path = '' as $$
declare s public.erp_settings; v_types text[] := '{}'; v_old public.order_status := case when tg_op = 'UPDATE' then old.status end;
begin
  select * into s from public.erp_settings where unit_id = new.unit_id and (f360_enabled or od_enabled);
  if not found then return null; end if;
  -- F360: venda concluída e cancelamento de venda já enviada
  if s.f360_enabled and new.created_at >= s.f360_since then
    if new.status = 'completed' and v_old is distinct from 'completed' then
      insert into public.f360_queue (tenant_id, unit_id, order_id, kind) values (new.tenant_id, new.unit_id, new.id, 'sale') on conflict do nothing;
    elsif new.status = 'cancelled' and v_old = 'completed' then
      insert into public.f360_queue (tenant_id, unit_id, order_id, kind) values (new.tenant_id, new.unit_id, new.id, 'cancel') on conflict do nothing;
    end if;
  end if;
  -- Open Delivery: eventos para o PDV (sem eco do que o próprio PDV mandou)
  if s.od_enabled and new.created_at >= s.od_since and new.channel::text = any (s.od_channels)
     and coalesce(current_setting('domma.od_echo', true), '') <> new.id::text then
    if new.status not in ('awaiting_payment','cancelled') and (v_old is null or v_old = 'awaiting_payment') then
      v_types := v_types || 'CREATED'::text;
      if new.status <> 'pending' then v_types := v_types || 'CONFIRMED'::text; end if;
    elsif v_old is not null and v_old <> new.status and v_old <> 'awaiting_payment' then
      v_types := v_types || case new.status
        when 'preparing' then case when v_old = 'pending' then 'CONFIRMED' else 'PREPARING' end
        when 'ready' then 'READY_FOR_PICKUP' when 'dispatched' then 'DISPATCHED' when 'awaiting_pickup' then 'READY_FOR_PICKUP'
        when 'completed' then 'CONCLUDED' when 'cancelled' then 'CANCELLED' else null end;
    end if;
    insert into public.od_events (tenant_id, unit_id, order_id, event_type)
    select new.tenant_id, new.unit_id, new.id, t from unnest(v_types) t where t is not null;
  end if;
  return null;
end $$;
create trigger orders_erp after insert or update of status on public.orders
  for each row execute function private.erp_on_order();

-- ---------- F360: fila (servidor) ----------
create or replace function private.f360_payload(q public.f360_queue)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare o public.orders; u public.units; s public.erp_settings; v_pay jsonb; v_date text;
begin
  select * into o from public.orders where id = q.order_id;
  select * into u from public.units where id = o.unit_id;
  select * into s from public.erp_settings where unit_id = o.unit_id;
  v_date := to_char(o.created_at at time zone coalesce(u.timezone, 'America/Sao_Paulo'), 'YYYY-MM-DD"T"HH24:MI:SS');
  select jsonb_agg(jsonb_build_object(
      'FormaPagamento', case p.method::text when 'cash' then 'Dinheiro' when 'pix' then 'PIX' when 'debit_card' then 'Cartao Debito'
        when 'voucher' then 'Voucher' when 'credit_account' then 'Crediario' else 'Cartao Credito' end,
      'Valor', round(p.amount_cents / 100.0, 2), 'Bandeira', case when p.method::text = 'pix' then 'PIX' else '' end,
      'Autorizacao', '', 'NSU', coalesce(p.txid, ''), 'QtdParcelas', '1', 'Vencimento', v_date))
    into v_pay
  from public.payments p where p.order_id = o.id and p.status::text in ('confirmed','paid','approved','captured') and p.amount_cents > 0;
  if v_pay is null then
    v_pay := jsonb_build_array(jsonb_build_object(
      'FormaPagamento', case o.payment_method::text when 'cash' then 'Dinheiro' when 'pix' then 'PIX' when 'debit_card' then 'Cartao Debito'
        when 'voucher' then 'Voucher' when 'credit_account' then 'Crediario' else 'Cartao Credito' end,
      'Valor', round(o.total_cents / 100.0, 2), 'Bandeira', case when o.payment_method::text = 'pix' then 'PIX' else '' end,
      'Autorizacao', '', 'NSU', '', 'QtdParcelas', '1', 'Vencimento', v_date));
  end if;
  return jsonb_build_object('NomeSistema', 'Domma Food', 'Values', jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
    'NumeroCupom', o.number::text, 'CodigoExternoCupom', o.id::text, 'CNPJEmitente', s.f360_cnpj, 'Data', v_date,
    'MeioPagamento', v_pay,
    'ValorFrete', case when o.delivery_fee_cents > 0 then round(o.delivery_fee_cents / 100.0, 2) end,
    'VendaCancelada', case when q.kind = 'cancel' then true end))));
end $$;

create or replace function public.f360_jobs(p_limit int default 30)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v jsonb; v_ids bigint[];
begin
  perform private.assert_service_role();
  update public.f360_queue set status = 'queued' where status = 'sending' and next_attempt_at < now() - interval '5 minutes';
  with picked as (
    select q.id from public.f360_queue q join public.erp_settings s on s.unit_id = q.unit_id
    where q.status = 'queued' and q.next_attempt_at <= now() and s.f360_enabled and s.f360_url_secret_id is not null
    order by q.id limit least(greatest(p_limit, 1), 100) for update of q skip locked)
  , upd as (update public.f360_queue q set status = 'sending', attempts = attempts + 1, next_attempt_at = now() from picked where q.id = picked.id returning q.*)
  select coalesce(jsonb_agg(jsonb_build_object('id', u.id, 'unit_id', u.unit_id, 'payload', private.f360_payload(u),
      'url', (select decrypted_secret from vault.decrypted_secrets where id = s.f360_url_secret_id))), '[]'::jsonb) into v
  from upd u join public.erp_settings s on s.unit_id = u.unit_id;
  return v;
end $$;

create or replace function public.f360_job_result(p_id bigint, p_ok boolean, p_error text)
returns void language plpgsql security definer set search_path = '' as $$
declare q public.f360_queue;
begin
  perform private.assert_service_role();
  update public.f360_queue set status = case when p_ok then 'sent' when attempts >= 6 then 'failed' else 'queued' end,
    sent_at = case when p_ok then now() end, last_error = case when p_ok then null else left(p_error, 300) end,
    next_attempt_at = now() + make_interval(mins => least(5 * attempts * attempts, 360))
  where id = p_id returning * into q;
  update public.erp_settings set f360_last_ok_at = case when p_ok then now() else f360_last_ok_at end,
    f360_last_error = case when p_ok then null else left(p_error, 300) end where unit_id = q.unit_id;
end $$;

-- ---------- Open Delivery (servidor) ----------
create or replace function public.od_issue_token(p_client_id text, p_client_secret text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.erp_settings; v_tok text := 'dmt_' || encode(extensions.gen_random_bytes(24), 'hex');
begin
  perform private.assert_service_role();
  select * into s from public.erp_settings where od_client_id = p_client_id;
  if s.unit_id is null or s.od_secret_hash is null or not s.od_enabled
     or s.od_secret_hash <> encode(extensions.digest(coalesce(p_client_secret, ''), 'sha256'), 'hex') then return null; end if;
  delete from public.od_tokens where unit_id = s.unit_id and expires_at < now();
  insert into public.od_tokens (token_hash, unit_id, expires_at) values (encode(extensions.digest(v_tok, 'sha256'), 'hex'), s.unit_id, now() + interval '1 hour');
  return jsonb_build_object('access_token', v_tok, 'token_type', 'bearer', 'expires_in', 3600);
end $$;

create or replace function public.od_unit(p_token text)
returns uuid language sql stable security definer set search_path = '' as $$
  select t.unit_id from public.od_tokens t join public.erp_settings s on s.unit_id = t.unit_id
  where t.token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex') and t.expires_at > now() and s.od_enabled
    and coalesce(auth.role(), '') = 'service_role';
$$;

create or replace function public.od_poll(p_unit_id uuid, p_types text[] default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform private.assert_service_role();
  update public.erp_settings set od_last_poll_at = now() where unit_id = p_unit_id;
  return coalesce((select jsonb_agg(jsonb_build_object('eventId', e.id, 'eventType', e.event_type, 'orderId', e.order_id,
      'createdAt', to_char(e.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) order by e.created_at, e.id)
    from (select * from public.od_events where unit_id = p_unit_id and acked_at is null
          and (p_types is null or cardinality(p_types) = 0 or event_type = any (p_types)) order by created_at, id limit 100) e), '[]'::jsonb);
end $$;

create or replace function public.od_ack(p_unit_id uuid, p_ids uuid[])
returns int language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  perform private.assert_service_role();
  update public.od_events set acked_at = now() where unit_id = p_unit_id and id = any (p_ids) and acked_at is null;
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function private.od_money(c bigint)
returns jsonb language sql immutable set search_path = '' as $$ select jsonb_build_object('value', round(coalesce(c, 0) / 100.0, 2), 'currency', 'BRL') $$;
create or replace function private.od_ts(t timestamptz)
returns text language sql immutable set search_path = '' as $$ select to_char(t at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') $$;

create or replace function public.od_order(p_unit_id uuid, p_order_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare o public.orders; u public.units; cu public.customers; v_items jsonb; v_pay jsonb; v_prepaid bigint; v_last text; v_type text; a jsonb;
begin
  perform private.assert_service_role();
  select * into o from public.orders where id = p_order_id and unit_id = p_unit_id;
  if not found then return null; end if;
  if not exists (select 1 from public.od_events where order_id = o.id) then return null; end if;   -- só pedidos enviados ao PDV
  select * into u from public.units where id = o.unit_id;
  select * into cu from public.customers where id = o.customer_id;
  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
      'id', i.id, 'index', i.rn, 'name', i.name, 'externalCode', coalesce(p.pdv_code, i.product_id::text, i.id::text), 'unit', 'UN',
      'quantity', i.quantity, 'specialInstructions', nullif(i.notes, ''),
      'unitPrice', private.od_money(i.unit_price_cents), 'totalPrice', private.od_money(i.total_cents),
      'optionsPrice', private.od_money(0),
      'options', (select jsonb_agg(jsonb_build_object('index', x.n, 'id', coalesce(x.opt->>'option_id', md5(i.id::text || x.n)),
            'name', x.opt->>'name', 'externalCode', coalesce(op.pdv_code, x.opt->>'option_id', x.opt->>'name'), 'unit', 'UN',
            'quantity', coalesce((x.opt->>'quantity')::numeric, 1),
            'unitPrice', private.od_money(coalesce((x.opt->>'price_cents')::bigint, 0)),
            'totalPrice', private.od_money(coalesce((x.opt->>'price_cents')::bigint, 0) * coalesce((x.opt->>'quantity')::int, 1))) order by x.n)
          from jsonb_array_elements(coalesce(i.options, '[]'::jsonb)) with ordinality x(opt, n)
          left join public.options op on op.id::text = x.opt->>'option_id')
    )) order by i.rn), '[]'::jsonb) into v_items
  from (select oi.*, row_number() over (order by oi.id) as rn from public.order_items oi where oi.order_id = o.id) i
  left join public.products p on p.id = i.product_id;
  v_prepaid := case when o.payment_status = 'paid' then o.total_cents else 0 end;
  v_pay := jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('value', round(o.total_cents / 100.0, 2), 'currency', 'BRL',
    'type', case when o.payment_status = 'paid' then 'PREPAID' else 'PENDING' end,
    'method', case o.payment_method::text when 'cash' then 'CASH' when 'pix' then 'PIX' when 'debit_card' then 'DEBIT' when 'credit_card' then 'CREDIT'
      when 'online_card' then 'CREDIT' when 'card_on_delivery' then 'CREDIT_DEBIT' when 'voucher' then 'MEAL_VOUCHER' else 'OTHER' end,
    'changeFor', case when o.payment_method = 'cash' and o.change_for_cents > 0 then round(o.change_for_cents / 100.0, 2) end)));
  v_last := (select event_type from public.od_events where order_id = o.id order by created_at desc, id desc limit 1);
  v_type := case o.type::text when 'delivery' then 'DELIVERY' when 'dine_in' then 'INDOOR' else 'TAKEOUT' end;
  a := coalesce(o.address, '{}'::jsonb);
  return jsonb_strip_nulls(jsonb_build_object(
    'id', o.id, 'type', v_type, 'displayId', o.number::text, 'sourceAppId', 'domma-food', 'salesChannel', o.channel::text, 'category', 'FOOD',
    'createdAt', private.od_ts(o.created_at), 'lastEvent', v_last,
    'orderTiming', case when o.scheduled_for is not null then 'SCHEDULED' else 'INSTANT' end,
    'preparationStartDateTime', private.od_ts(coalesce(o.accepted_at, o.created_at)),
    'merchant', jsonb_build_object('id', u.id, 'name', u.name),
    'items', v_items,
    'otherFees', case when o.delivery_fee_cents > 0 then jsonb_build_array(jsonb_build_object('name', 'Taxa de entrega', 'type', 'DELIVERY_FEE',
      'receivedBy', 'MERCHANT', 'price', private.od_money(o.delivery_fee_cents))) end,
    'discounts', case when o.discount_cents > 0 then jsonb_build_array(jsonb_build_object('amount', private.od_money(o.discount_cents), 'target', 'CART',
      'sponsorshipValues', jsonb_build_array(jsonb_build_object('name', 'MERCHANT', 'amount', private.od_money(o.discount_cents),
        'discountCode', o.coupon_code)))) end,
    'total', jsonb_build_object('itemsPrice', private.od_money(o.subtotal_cents), 'otherFees', private.od_money(o.delivery_fee_cents),
      'discount', private.od_money(o.discount_cents), 'orderAmount', private.od_money(o.total_cents)),
    'payments', jsonb_build_object('prepaid', round(v_prepaid / 100.0, 2), 'pending', round((o.total_cents - v_prepaid) / 100.0, 2), 'methods', v_pay),
    'customer', jsonb_build_object('id', coalesce(o.customer_id::text, md5(o.customer_phone)), 'name', o.customer_name,
      'phone', jsonb_build_object('number', case when o.customer_phone ~ '^0+$' then '' else o.customer_phone end),
      'ordersCountOnMerchant', coalesce(cu.orders_count, 0)),
    'schedule', case when o.scheduled_for is not null then jsonb_build_object('scheduledDateTimeStart', private.od_ts(o.scheduled_for),
      'scheduledDateTimeEnd', private.od_ts(o.scheduled_for + interval '30 minutes')) end,
    'delivery', case when v_type = 'DELIVERY' then jsonb_build_object('deliveredBy', 'MERCHANT',
      'deliveryAddress', jsonb_strip_nulls(jsonb_build_object('country', 'BR', 'state', coalesce(a->>'state', u.state, ''), 'city', coalesce(a->>'city', ''),
        'district', coalesce(a->>'neighborhood', ''), 'street', coalesce(a->>'street', ''), 'number', coalesce(nullif(a->>'number', ''), 'S/N'),
        'complement', nullif(a->>'complement', ''), 'reference', nullif(a->>'reference', ''),
        'formattedAddress', concat_ws(', ', nullif(a->>'street', ''), nullif(a->>'number', ''), nullif(a->>'neighborhood', ''), nullif(a->>'city', '')),
        'postalCode', coalesce(regexp_replace(coalesce(a->>'postal_code', ''), '\D', '', 'g'), ''),
        'coordinates', case when a->>'lat' is not null and a->>'lng' is not null then jsonb_build_object('latitude', (a->>'lat')::numeric, 'longitude', (a->>'lng')::numeric) end)),
      'estimatedDeliveryDateTime', private.od_ts(coalesce(o.estimated_ready_at, o.created_at + interval '45 minutes'))) end,
    'takeout', case when v_type = 'TAKEOUT' then jsonb_build_object('mode', 'DEFAULT', 'takeoutDateTime', private.od_ts(coalesce(o.estimated_ready_at, o.created_at + interval '20 minutes'))) end,
    'indoor', case when v_type = 'INDOOR' then jsonb_build_object('mode', case when o.tab_id is not null then 'TAB' else 'DEFAULT' end,
      'indoorDateTime', private.od_ts(o.created_at)) end,
    'sendPreparing', true, 'sendDelivered', true, 'sendPickedUp', true, 'sendTracking', false,
    'extraInfo', nullif(o.notes, '')));
end $$;

-- ação do PDV sobre o pedido (confirmar, preparar, pronto, despachar, entregue, cancelar)
create or replace function public.od_action(p_unit_id uuid, p_order_id uuid, p_action text, p_body jsonb default '{}')
returns text language plpgsql security definer set search_path = '' as $$
declare o public.orders; v_new public.order_status; s public.erp_settings;
begin
  perform private.assert_service_role();
  select * into s from public.erp_settings where unit_id = p_unit_id;
  select * into o from public.orders where id = p_order_id and unit_id = p_unit_id for update;
  if not found or not exists (select 1 from public.od_events where order_id = o.id) then return 'not_found'; end if;
  if p_action in ('acceptCancellation','denyCancellation') then return 'ok'; end if;   -- o Domma não pede cancelamento ao PDV
  if o.status in ('cancelled','completed') then return case when p_action = 'requestCancellation' and o.status = 'cancelled' then 'ok' else 'invalid' end; end if;
  if o.status = 'awaiting_payment' and p_action <> 'requestCancellation' then return 'invalid'; end if;
  v_new := case p_action
    when 'confirm' then case when o.status = 'pending' then 'preparing' end
    when 'preparing' then case when o.status in ('pending') then 'preparing' end
    when 'readyForPickup' then case when o.status in ('pending','preparing') then 'ready' end
    when 'dispatch' then case when o.status in ('pending','preparing','ready') then 'dispatched' end
    when 'delivered' then 'completed' when 'pickedUp' then 'completed'
    when 'requestCancellation' then 'cancelled'
    else null end;
  if v_new is null then return 'ok'; end if;                 -- já está nesse ponto (ou ação sem efeito)
  if v_new <> 'cancelled' then perform set_config('domma.od_echo', o.id::text, true); end if;   -- o PDV já sabe; não devolve o evento
  update public.orders set status = v_new,
    accepted_at = case when v_new = 'preparing' then coalesce(accepted_at, now()) else accepted_at end,
    ready_at = case when v_new = 'ready' then coalesce(ready_at, now()) else ready_at end,
    dispatched_at = case when v_new = 'dispatched' then coalesce(dispatched_at, now()) else dispatched_at end,
    completed_at = case when v_new = 'completed' then coalesce(completed_at, now()) else completed_at end,
    cancelled_at = case when v_new = 'cancelled' then now() else cancelled_at end,
    cancel_reason = case when v_new = 'cancelled' then left(coalesce(nullif(p_body->>'reason', ''), 'Cancelado pelo PDV'), 300) else cancel_reason end,
    estimated_ready_at = case when p_action = 'confirm' and (p_body->>'preparationTime') ~ '^[0-9]{1,3}$'
      then now() + make_interval(mins => (p_body->>'preparationTime')::int) else estimated_ready_at end
  where id = o.id;
  perform set_config('domma.od_echo', '', true);
  insert into public.order_events (tenant_id, order_id, from_status, to_status, note)
  values (o.tenant_id, o.id, o.status, v_new, coalesce(s.od_app_name, 'PDV') || ' (Open Delivery): ' || p_action);
  return 'ok';
end $$;

-- ---------- Cron: envia a fila do F360 ----------
do $$ begin
  if not exists (select 1 from vault.secrets where name = 'erp_worker_secret') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'erp_worker_secret', 'Domma Food: worker de integrações de gestão');
  end if;
end $$;
create or replace function public.erp_worker_secret()
returns text language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.assert_service_role();
  return (select decrypted_secret from vault.decrypted_secrets where name = 'erp_worker_secret');
end $$;
create or replace function private.erp_cron_tick()
returns void language plpgsql security definer set search_path = '' as $$
declare v_secret text;
begin
  delete from public.od_tokens where expires_at < now() - interval '1 day';
  delete from public.od_events where acked_at < now() - interval '30 days';
  if not exists (select 1 from public.f360_queue where status = 'queued' and next_attempt_at <= now()) then return; end if;
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'erp_worker_secret';
  perform net.http_post(url := 'https://kcwidutqdqbyphrjnlef.supabase.co/functions/v1/erp/f360/worker', body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type','application/json','x-worker-secret', v_secret), timeout_milliseconds := 25000);
exception when others then null;
end $$;
select cron.schedule('domma-erp', '*/5 * * * *', $$select private.erp_cron_tick()$$);

grant execute on function public.erp_overview(uuid), public.erp_save(uuid, jsonb), public.erp_od_credentials(uuid), public.erp_f360_retry(uuid) to authenticated;
revoke execute on function public.erp_overview(uuid), public.erp_save(uuid, jsonb), public.erp_od_credentials(uuid), public.erp_f360_retry(uuid) from public, anon;
revoke execute on function public.f360_jobs(int), public.f360_job_result(bigint, boolean, text), public.od_issue_token(text, text), public.od_unit(text),
  public.od_poll(uuid, text[]), public.od_ack(uuid, uuid[]), public.od_order(uuid, uuid), public.od_action(uuid, uuid, text, jsonb), public.erp_worker_secret()
  from public, anon, authenticated;
grant execute on function public.f360_jobs(int), public.f360_job_result(bigint, boolean, text), public.od_issue_token(text, text), public.od_unit(text),
  public.od_poll(uuid, text[]), public.od_ack(uuid, uuid[]), public.od_order(uuid, uuid), public.od_action(uuid, uuid, text, jsonb), public.erp_worker_secret()
  to service_role;
revoke execute on function private.erp_on_order(), private.f360_payload(public.f360_queue), private.erp_cron_tick(), private.valid_cnpj(text)
  from public, anon, authenticated;
