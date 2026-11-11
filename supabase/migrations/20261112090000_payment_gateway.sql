-- =====================================================================
-- Domma Food · 026 · Pagamento online (Mercado Pago): Pix com confirmação
-- automática e cartão de crédito no cardápio, webhook e estorno automático.
-- O valor cobrado vem sempre do pedido no banco; credenciais ficam no Vault.
-- =====================================================================
create table public.payment_gateways (
  unit_id uuid primary key references public.units(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  provider text not null default 'mercadopago' check (provider in ('mercadopago')),
  enabled boolean not null default false,
  pix_enabled boolean not null default true,
  card_enabled boolean not null default false,
  max_installments integer not null default 1 check (max_installments between 1 and 12),
  statement_descriptor text check (statement_descriptor is null or statement_descriptor ~ '^[A-Za-z0-9 ]{1,13}$'),
  public_key text check (public_key is null or public_key ~ '^(APP_USR|TEST)-[A-Za-z0-9-]{10,80}$'),
  live boolean,                                  -- credencial de produção (APP_USR) ou teste (TEST)
  access_token_secret_id uuid, webhook_secret_id uuid,
  token_hint text,
  last_test_at timestamptz, last_test_ok boolean, last_test_message text,
  updated_at timestamptz not null default now()
);
create table public.gateway_payments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  unit_id uuid not null references public.units(id) on delete cascade,
  order_id uuid not null references public.orders(id) on delete cascade,
  kind text not null check (kind in ('pix','card')),
  external_id text,
  status text not null default 'creating',      -- creating, pending, in_process, approved, rejected, cancelled, refunded, charged_back, error
  status_detail text,
  amount_cents integer not null check (amount_cents > 0),
  installments integer,
  card_last4 text, card_brand text,
  qr_code text, qr_code_base64 text, ticket_url text, expires_at timestamptz,
  refund_status text not null default 'none' check (refund_status in ('none','requested','processing','refunded','failed')),
  refund_message text, refund_attempts integer not null default 0, refund_next_at timestamptz,
  raw jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index gateway_payments_external_key on public.gateway_payments(unit_id, external_id) where external_id is not null;
create index gateway_payments_order_idx on public.gateway_payments(order_id, created_at desc);
create index gateway_payments_refund_idx on public.gateway_payments(refund_next_at) where refund_status = 'requested';
create trigger gateway_payments_touch before update on public.gateway_payments for each row execute function private.touch_updated_at();

alter table public.payment_gateways enable row level security;
alter table public.payment_gateways force row level security;
alter table public.gateway_payments enable row level security;
alter table public.gateway_payments force row level security;
create policy pg_select on public.payment_gateways for select to authenticated
  using (private.can_manage(tenant_id) and private.can_access_unit(unit_id));
create policy gp_select on public.gateway_payments for select to authenticated
  using (private.can_access_unit(unit_id) and private.has_role(tenant_id, array['owner','manager','cashier','attendant']::public.member_role[]));
create trigger payment_gateways_audit after insert or update on public.payment_gateways for each row execute function private.audit_row();
alter publication supabase_realtime add table public.gateway_payments;

-- ---------- Pagamento online exige confirmação: cartão online também aguarda pagamento ----------
do $$ declare d text; begin
  d := pg_get_functiondef('private.place_order_core(jsonb)'::regprocedure);
  if position($x$when v_pm = 'pix' then 'awaiting_payment'$x$ in d) = 0 then raise exception 'place_order_core mudou'; end if;
  execute replace(d, $x$when v_pm = 'pix' then 'awaiting_payment'$x$, $x$when v_pm in ('pix','online_card') then 'awaiting_payment'$x$);
end $$;

-- ---------- Informações públicas (cardápio e acompanhamento) ----------
create or replace function private.gateway_store_info(p_unit uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select case when g.enabled and g.public_key is not null and g.access_token_secret_id is not null then
    jsonb_build_object('provider', g.provider, 'pix', g.pix_enabled, 'card', g.card_enabled,
                       'public_key', g.public_key, 'max_installments', g.max_installments) end
  from public.payment_gateways g where g.unit_id = p_unit;
$$;
create or replace function private.gateway_order_info(p_order uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'config', private.gateway_store_info(o.unit_id),
    'attempts', (select count(*) from public.gateway_payments where order_id = o.id and kind = 'card'),
    'payment', (select jsonb_build_object('kind', gp.kind, 'status', gp.status, 'status_detail', gp.status_detail,
                  'qr_code', gp.qr_code, 'qr_code_base64', gp.qr_code_base64, 'ticket_url', gp.ticket_url,
                  'expires_at', gp.expires_at, 'card_last4', gp.card_last4, 'card_brand', gp.card_brand,
                  'installments', gp.installments, 'refund_status', gp.refund_status)
                from public.gateway_payments gp where gp.order_id = o.id order by gp.created_at desc limit 1))
  from public.orders o where o.id = p_order;
$$;
do $$ declare d text; begin
  d := pg_get_functiondef('public.get_store(text)'::regprocedure);
  if position($x$'is_open', v_open,$x$ in d) = 0 then raise exception 'get_store mudou'; end if;
  execute replace(d, $x$'is_open', v_open,$x$, $x$'is_open', v_open, 'gateway', private.gateway_store_info(u.id),$x$);
  d := pg_get_functiondef('public.get_order_by_token(text)'::regprocedure);
  if position($x$'pix', case when o.payment_method = 'pix'$x$ in d) = 0 then raise exception 'get_order_by_token mudou'; end if;
  execute replace(d, $x$'pix', case when o.payment_method = 'pix'$x$,
    $x$'gateway', case when o.payment_method in ('pix','online_card') then private.gateway_order_info(o.id) end,
    'pix', case when o.payment_method = 'pix' and private.gateway_store_info(o.unit_id) is null$x$);
  d := pg_get_functiondef('private.expire_pix_orders()'::regprocedure);
  execute replace(replace(d, $x$'Pix não pago no prazo'$x$, $x$'Pagamento não concluído no prazo'$x$), $x$'Pix expirado'$x$, $x$'Pagamento expirado'$x$);
end $$;

-- ---------- Configuração (dono da conta) ----------
create or replace function public.gateway_save_settings(p_unit_id uuid, p jsonb, p_access_token text default null, p_webhook_secret text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare u public.units; g public.payment_gateways; v uuid; v_pk text := nullif(trim(p->>'public_key'), '');
begin
  select * into u from public.units where id = p_unit_id;
  if not found or not private.can_access_unit(u.id) or not private.has_role(u.tenant_id, array['owner']::public.member_role[]) then
    raise exception 'Só o dono da conta altera o pagamento online.' using errcode = '42501'; end if;
  insert into public.payment_gateways (unit_id, tenant_id) values (u.id, u.tenant_id) on conflict (unit_id) do nothing;
  select * into g from public.payment_gateways where unit_id = u.id for update;
  if nullif(trim(p_access_token), '') is not null then
    if trim(p_access_token) !~ '^(APP_USR|TEST)-[A-Za-z0-9-]{20,200}$' then raise exception 'Access Token inválido. Ele começa com APP_USR- ou TEST-.'; end if;
    if g.access_token_secret_id is not null then perform vault.update_secret(g.access_token_secret_id, trim(p_access_token));
    else v := vault.create_secret(trim(p_access_token), 'mp_token_' || u.id, 'Domma Food: Mercado Pago access token');
         update public.payment_gateways set access_token_secret_id = v where unit_id = u.id; end if;
    update public.payment_gateways set token_hint = right(trim(p_access_token), 4), live = trim(p_access_token) like 'APP_USR-%',
           last_test_ok = null, last_test_at = null where unit_id = u.id;
  end if;
  if nullif(trim(p_webhook_secret), '') is not null then
    if char_length(trim(p_webhook_secret)) not between 16 and 200 then raise exception 'Assinatura secreta do webhook inválida.'; end if;
    if g.webhook_secret_id is not null then perform vault.update_secret(g.webhook_secret_id, trim(p_webhook_secret));
    else v := vault.create_secret(trim(p_webhook_secret), 'mp_webhook_' || u.id, 'Domma Food: Mercado Pago webhook secret');
         update public.payment_gateways set webhook_secret_id = v where unit_id = u.id; end if;
  end if;
  update public.payment_gateways set
    public_key = case when p ? 'public_key' then v_pk else public_key end,
    pix_enabled = coalesce((p->>'pix_enabled')::boolean, pix_enabled),
    card_enabled = coalesce((p->>'card_enabled')::boolean, card_enabled),
    max_installments = coalesce((p->>'max_installments')::int, max_installments),
    statement_descriptor = case when p ? 'statement_descriptor' then nullif(trim(p->>'statement_descriptor'), '') else statement_descriptor end,
    enabled = coalesce((p->>'enabled')::boolean, enabled), updated_at = now()
  where unit_id = u.id returning * into g;
  if g.enabled and (g.public_key is null or g.access_token_secret_id is null) then
    raise exception 'Para ativar, informe a Public Key e o Access Token do Mercado Pago.'; end if;
  if g.enabled and coalesce(g.last_test_ok, false) = false then raise exception 'Teste a conexão antes de ativar.'; end if;
  if g.public_key is not null and g.live is not null and (g.public_key like 'APP_USR-%') <> g.live then
    raise exception 'A Public Key e o Access Token são de ambientes diferentes (teste e produção).'; end if;
  -- formas aceitas no cardápio acompanham a configuração
  update public.units set accepted_payments = (
    select array_agg(distinct m) from unnest(accepted_payments || case when g.enabled and g.card_enabled
      then array['online_card']::public.payment_method[] else '{}' end
      || case when g.enabled and g.pix_enabled then array['pix']::public.payment_method[] else '{}' end) m
    where m <> 'online_card' or (g.enabled and g.card_enabled))
  where id = u.id;
end $$;
create or replace function public.gateway_can_test(p_unit_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.can_access_unit(p_unit_id) and private.has_role((select tenant_id from public.units where id = p_unit_id), array['owner']::public.member_role[]);
$$;
