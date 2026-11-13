-- =====================================================================
-- Domma Food · 052 · Cartão no totem com Mercado Pago Point
--   - Totem vinculado a uma maquininha Point (modo integrado / PDV)
--   - Pedido do totem com "cartão": o totem manda o valor para a maquininha
--     (API Orders do Mercado Pago) e o pedido segue quando o pagamento aprova
--   - Desistiu ou recusou: tenta de novo ou paga no caixa
--   - Mesma conta Mercado Pago do pagamento online (token no Vault), mesmo
--     webhook, conferência de pendentes e estorno automático
-- =====================================================================

alter table public.totems add column allow_card boolean not null default false;
alter table public.totems add column point_terminal_id text
  check (point_terminal_id is null or point_terminal_id ~ '^[A-Z0-9_]{2,40}__[A-Z0-9]{4,40}$');
-- o totem precisa de pelo menos uma forma de pagamento
do $$ declare c text; begin
  select conname into c from pg_constraint where conrelid = 'public.totems'::regclass and contype = 'c'
    and pg_get_constraintdef(oid) like '%allow_pix%allow_counter%';
  execute format('alter table public.totems drop constraint %I', c);
end $$;
alter table public.totems add constraint totems_payment_check check (allow_pix or allow_counter or allow_card);
alter table public.totems add constraint totems_card_terminal_check check (not allow_card or point_terminal_id is not null);

do $$ declare c text; begin
  select conname into c from pg_constraint where conrelid = 'public.gateway_payments'::regclass and contype = 'c'
    and pg_get_constraintdef(oid) like '%kind%pix%card%';
  execute format('alter table public.gateway_payments drop constraint %I', c);
end $$;
alter table public.gateway_payments add constraint gateway_payments_kind_check check (kind in ('pix','card','point'));
alter table public.gateway_payments add column point_terminal_id text;
alter table public.gateway_payments add column card_type text;   -- credit_card / debit_card

-- ---------- Totem: informação pública e pedido ----------
do $$ declare d text; begin
  d := pg_get_functiondef('public.totem_info(text)'::regprocedure);
  if position($x$'allow_pix'$x$ in d) = 0 then raise exception 'totem_info mudou'; end if;
  execute replace(d, $x$'allow_pix'$x$, $x$'allow_card', t.allow_card and t.point_terminal_id is not null
      and exists (select 1 from public.payment_gateways g where g.unit_id = t.unit_id and g.enabled and g.access_token_secret_id is not null),
    'allow_pix'$x$);
end $$;

create or replace function public.totem_order(p_token text, p_items jsonb, p_mode text, p_name text, p_pay text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare t public.totems; u public.units; q jsonb; v_order uuid; v_n int; v_status public.order_status; v_tok text;
  v_name text := left(nullif(regexp_replace(trim(coalesce(p_name, '')), '\s+', ' ', 'g'), ''), 40);
  v_pix boolean := p_pay = 'pix'; v_card boolean := p_pay in ('credit_card','debit_card'); v_total int;
begin
  t := private.totem_by_token(p_token);
  if t.id is null then raise exception 'Este totem foi desativado. Chame um atendente.'; end if;
  select * into u from public.units where id = t.unit_id;
  if (select status from public.tenants where id = t.tenant_id) = 'suspended' then raise exception 'Loja indisponível no momento.'; end if;
  if not private.unit_is_open_at(u, now()) then raise exception 'A loja não está recebendo pedidos agora.'; end if;
  if p_mode not in ('dine_in','pickup') or (p_mode = 'dine_in' and not t.allow_dine_in) or (p_mode = 'pickup' and not t.allow_takeout) then
    raise exception 'Escolha se vai comer aqui ou levar.'; end if;
  if p_pay not in ('pix','counter','credit_card','debit_card') or (p_pay = 'counter' and not t.allow_counter) then raise exception 'Escolha a forma de pagamento.'; end if;
  if v_pix and not (t.allow_pix and coalesce((private.gateway_store_info(u.id)->>'pix')::boolean, false)) then
    raise exception 'Pix indisponível neste totem. Pague no caixa.'; end if;
  if v_card and not (t.allow_card and t.point_terminal_id is not null and exists (select 1 from public.payment_gateways g
       where g.unit_id = u.id and g.enabled and g.access_token_secret_id is not null)) then
    raise exception 'Cartão indisponível neste totem. Pague no caixa.'; end if;
  if v_name is null then raise exception 'Informe seu nome para chamarmos quando o pedido estiver pronto.'; end if;
  -- antiabuso: limite por totem
  perform 1 from public.totems where id = t.id for update;
  if (select count(*) from public.orders where totem_id = t.id and created_at > now() - interval '10 minutes') >= 15 then
    raise exception 'Muitos pedidos neste totem em pouco tempo. Chame um atendente.'; end if;
  q := private.price_items(u.id, p_items, 'totem');
  v_total := (q->>'subtotal_cents')::int;
  if v_total > 300000 then raise exception 'Pedido acima do limite do totem. Faça pelo caixa.'; end if;
  if v_card and v_total < 100 then raise exception 'Valor baixo demais para cartão. Pague no caixa.'; end if;
  v_status := case when v_pix or v_card then 'awaiting_payment' when t.auto_accept then 'preparing' else 'pending' end;
  update public.units set order_counter = order_counter + 1 where id = u.id returning order_counter into v_n;
  insert into public.orders (tenant_id, unit_id, number, channel, type, status, customer_name, customer_phone,
    subtotal_cents, total_cents, payment_method, payment_status, notes, accepted_at, totem_id)
  values (u.tenant_id, u.id, v_n, 'totem', p_mode::public.order_type, v_status, v_name, '00000000000',
    v_total, v_total, case when v_pix then 'pix' when v_card then p_pay else 'cash' end::public.payment_method, 'pending',
    'Totem ' || t.name || case when v_pix then ' · Pix' when p_pay = 'credit_card' then ' · crédito na maquininha'
      when p_pay = 'debit_card' then ' · débito na maquininha' else ' · PAGAR NO CAIXA' end
      || case when p_mode = 'dine_in' then ' · comer aqui' else ' · para levar' end,
    case when v_status = 'preparing' then now() end, t.id)
  returning id, public_token into v_order, v_tok;
  perform private.insert_items(u.tenant_id, v_order, q->'items');
  if v_pix or v_card then
    insert into public.payments (tenant_id, order_id, method, amount_cents)
    values (u.tenant_id, v_order, case when v_pix then 'pix' else p_pay end::public.payment_method, v_total);
  end if;
  insert into public.order_events (tenant_id, order_id, to_status, note) values (u.tenant_id, v_order, v_status, 'Pedido no totem ' || t.name);
  update public.totems set last_seen_at = now() where id = t.id;
  return jsonb_build_object('number', v_n, 'token', v_tok, 'status', v_status, 'total_cents', v_total, 'pay', p_pay);
end $$;

-- desistiu do cartão (ou foi recusado): o pedido passa a "pagar no caixa"
create or replace function public.totem_pay_at_counter(p_token text, p_order_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare t public.totems; o public.orders; v_status public.order_status;
begin
  t := private.totem_by_token(p_token);
  if t.id is null then raise exception 'Este totem foi desativado. Chame um atendente.'; end if;
  select * into o from public.orders where public_token = p_order_token and totem_id = t.id for update;
  if not found then raise exception 'Pedido não encontrado.'; end if;
  if o.payment_status = 'paid' then return jsonb_build_object('status', o.status, 'paid', true); end if;
  if o.status <> 'awaiting_payment' then raise exception 'Este pedido não está aguardando pagamento.'; end if;
  if not t.allow_counter then raise exception 'Este totem não aceita pagamento no caixa. Chame um atendente.'; end if;
  if exists (select 1 from public.gateway_payments where order_id = o.id and kind = 'point' and status = 'in_process') then
    raise exception 'A maquininha ainda está processando. Aguarde um instante.'; end if;
  v_status := case when t.auto_accept then 'preparing' else 'pending' end;
  delete from public.payments where order_id = o.id and status = 'pending';
  update public.orders set status = v_status, payment_method = 'cash',
    notes = regexp_replace(coalesce(notes, ''), ' · (crédito|débito) na maquininha| · Pix', ' · PAGAR NO CAIXA'),
    accepted_at = case when v_status = 'preparing' then now() else accepted_at end
  where id = o.id;
  insert into public.order_events (tenant_id, order_id, from_status, to_status, note)
  values (o.tenant_id, o.id, o.status, v_status, 'Cliente escolheu pagar no caixa');
  return jsonb_build_object('status', v_status, 'paid', false);
end $$;

-- ---------- Pagamento na maquininha (função payments, service_role) ----------
create or replace function public.gateway_point_context(p_order_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare o public.orders; t public.totems; g public.payment_gateways; u public.units;
begin
  perform private.assert_service_role();
  select * into o from public.orders where public_token = p_order_token;
  if not found or o.totem_id is null then return null; end if;
  select * into t from public.totems where id = o.totem_id;
  select * into g from public.payment_gateways where unit_id = o.unit_id;
  select * into u from public.units where id = o.unit_id;
  return jsonb_build_object('order_id', o.id, 'unit_id', o.unit_id, 'number', o.number, 'status', o.status,
    'payment_status', o.payment_status, 'payment_method', o.payment_method, 'total_cents', o.total_cents, 'store', u.name,
    'terminal_id', t.point_terminal_id, 'allow_card', t.allow_card and t.active,
    'token', case when g.enabled then (select decrypted_secret from vault.decrypted_secrets where id = g.access_token_secret_id) end,
    'attempts', (select count(*) from public.gateway_payments where order_id = o.id and kind = 'point'),
    'open', (select to_jsonb(x) from (select id, external_id, status, updated_at from public.gateway_payments
             where order_id = o.id and kind = 'point' and status in ('creating','pending','in_process') order by created_at desc limit 1) x));
end $$;

-- grava o estado de uma order do Mercado Pago (API Orders, type=point)
create or replace function public.gateway_record_point(p_id uuid, p_body jsonb)
returns text language plpgsql security definer set search_path = '' as $$
declare gp public.gateway_payments; ost text := lower(coalesce(p_body->>'status', 'error')); pay jsonb := p_body->'transactions'->'payments'->0;
  st text; v_amount numeric;
begin
  perform private.assert_service_role();
  select * into gp from public.gateway_payments where id = p_id for update;
  if not found then return 'missing'; end if;
  st := case ost when 'created' then 'pending' when 'at_terminal' then 'in_process' when 'action_required' then 'in_process'
    when 'processed' then 'approved' when 'failed' then 'rejected' when 'canceled' then 'cancelled' when 'expired' then 'cancelled'
    when 'refunded' then 'refunded' else 'error' end;
  -- o valor aprovado precisa bater com o pedido
  if st = 'approved' then
    v_amount := coalesce(nullif(pay->>'paid_amount', '')::numeric, nullif(pay->>'amount', '')::numeric, nullif(p_body->>'total_paid_amount', '')::numeric, 0);
    if round(v_amount * 100) <> gp.amount_cents then st := 'error'; end if;
  end if;
  -- não volta de um estado final (webhooks podem chegar fora de ordem)
  if gp.status in ('approved','refunded') and st not in ('refunded') then return gp.status; end if;
  update public.gateway_payments set
    external_id = coalesce(p_body->>'id', external_id), status = st,
    status_detail = left(coalesce(pay->>'status_detail', p_body->>'status_detail'), 80),
    installments = coalesce((pay->'payment_method'->>'installments')::int, installments),
    card_brand = coalesce(pay->'payment_method'->>'id', card_brand),
    card_type = coalesce(pay->'payment_method'->>'type', card_type),
    refund_status = case when st = 'refunded' then 'refunded' else refund_status end,
    raw = p_body
  where id = gp.id;
  if st = 'approved' and gp.status <> 'approved' then return private.gateway_mark_paid(gp.id); end if;
  if st = 'refunded' then update public.payments set status = 'refunded' where order_id = gp.order_id and status = 'paid'; end if;
  return st;
end $$;

-- mensagem do histórico ao aprovar na maquininha
do $$ declare d text; begin
  d := pg_get_functiondef('private.gateway_mark_paid(uuid)'::regprocedure);
  if position($x$case gp.kind when 'pix' then 'Pix confirmado pelo Mercado Pago' else 'Cartão aprovado pelo Mercado Pago' end$x$ in d) = 0 then
    raise exception 'gateway_mark_paid mudou'; end if;
  execute replace(d, $x$case gp.kind when 'pix' then 'Pix confirmado pelo Mercado Pago' else 'Cartão aprovado pelo Mercado Pago' end$x$,
    $x$case gp.kind when 'pix' then 'Pix confirmado pelo Mercado Pago' when 'point' then 'Cartão aprovado na maquininha (Mercado Pago Point)' else 'Cartão aprovado pelo Mercado Pago' end$x$);
end $$;

-- estorno e conferência de pendentes também para a maquininha (o worker usa o "kind" para escolher a API)
create or replace function public.gateway_refund_jobs()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r record; v jsonb := '[]'::jsonb;
begin
  perform private.assert_service_role();
  update public.gateway_payments set refund_status = 'requested' where refund_status = 'processing' and updated_at < now() - interval '5 minutes';
  for r in select gp.id, gp.external_id, gp.unit_id, gp.kind from public.gateway_payments gp
           where gp.refund_status = 'requested' and coalesce(gp.refund_next_at, now()) <= now() and gp.external_id is not null
           order by gp.refund_next_at nulls first limit 10 for update skip locked loop
    update public.gateway_payments set refund_status = 'processing', refund_attempts = refund_attempts + 1 where id = r.id;
    v := v || jsonb_build_object('id', r.id, 'external_id', r.external_id, 'kind', r.kind,
      'token', (select decrypted_secret from vault.decrypted_secrets ds join public.payment_gateways g on g.access_token_secret_id = ds.id where g.unit_id = r.unit_id));
  end loop;
  return v;
end $$;
create or replace function public.gateway_pending_checks()
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform private.assert_service_role();
  return coalesce((select jsonb_agg(jsonb_build_object('id', gp.id, 'external_id', gp.external_id, 'kind', gp.kind,
      'token', (select decrypted_secret from vault.decrypted_secrets ds join public.payment_gateways g on g.access_token_secret_id = ds.id where g.unit_id = gp.unit_id)))
    from (select * from public.gateway_payments where status in ('pending','in_process') and external_id is not null
          and updated_at < now() - interval '2 minutes' and created_at > now() - interval '1 day' order by updated_at limit 20) gp), '[]'::jsonb);
end $$;

-- ---------- Painel: vincular a maquininha ----------
do $$ declare d text; begin
  d := pg_get_functiondef('public.totem_update(uuid, jsonb)'::regprocedure);
  if position($x$allow_pix = coalesce((p->>'allow_pix')::boolean, allow_pix)$x$ in d) = 0 then raise exception 'totem_update mudou'; end if;
  execute replace(d, $x$allow_pix = coalesce((p->>'allow_pix')::boolean, allow_pix)$x$,
    $x$allow_pix = coalesce((p->>'allow_pix')::boolean, allow_pix),
    allow_card = coalesce((p->>'allow_card')::boolean, allow_card),
    point_terminal_id = case when p ? 'point_terminal_id' then nullif(upper(trim(p->>'point_terminal_id')), '') else point_terminal_id end$x$);
  if position($x$uma de pagamento (caixa ou Pix).$x$ in d) = 0 then raise exception 'totem_update mudou (mensagem)'; end if;
  d := pg_get_functiondef('public.totem_update(uuid, jsonb)'::regprocedure);
  execute replace(d, $x$uma de pagamento (caixa ou Pix).$x$,
    $x$uma de pagamento (caixa, Pix ou cartão). Para cartão, vincule a maquininha (ID no formato MODELO__NÚMERO DE SÉRIE).$x$);
end $$;

grant execute on function public.totem_pay_at_counter(text, text) to anon, authenticated;
revoke execute on function public.gateway_point_context(text), public.gateway_record_point(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.gateway_point_context(text), public.gateway_record_point(uuid, jsonb) to service_role;
