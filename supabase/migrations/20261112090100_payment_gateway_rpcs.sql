-- =====================================================================
-- Domma Food · 027 · Pagamento online: funções do sistema (somente service_role)
-- =====================================================================
do $$ begin
  if not exists (select 1 from vault.secrets where name = 'gateway_worker_secret') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'gateway_worker_secret', 'Domma Food: worker de pagamentos');
  end if;
  if not exists (select 1 from vault.secrets where name = 'gateway_worker_url') then
    perform vault.create_secret('https://kcwidutqdqbyphrjnlef.supabase.co/functions/v1/payments/worker', 'gateway_worker_url', 'Domma Food: URL do worker de pagamentos');
  end if;
end $$;

create or replace function private.kick_gateway_worker()
returns void language plpgsql security definer set search_path = '' as $$
declare v_url text; v_secret text;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'gateway_worker_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'gateway_worker_secret';
  if v_url is null or v_secret is null then return; end if;
  perform net.http_post(url := v_url, body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type','application/json','x-worker-secret', v_secret), timeout_milliseconds := 25000);
exception when others then null;
end $$;

-- pagamento aprovado: confirma o pedido (ou pede estorno se ele já foi cancelado)
create or replace function private.gateway_mark_paid(p_gp uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare gp public.gateway_payments; o public.orders; u public.units; v_next public.order_status;
begin
  select * into gp from public.gateway_payments where id = p_gp for update;
  select * into o from public.orders where id = gp.order_id for update;
  if o.status = 'cancelled' or (o.payment_status = 'paid' and exists (
       select 1 from public.gateway_payments x where x.order_id = o.id and x.id <> gp.id and x.status = 'approved')) then
    update public.gateway_payments set refund_status = 'requested', refund_next_at = now() where id = gp.id and refund_status = 'none';
    insert into public.order_events (tenant_id, order_id, to_status, note)
    values (o.tenant_id, o.id, o.status, 'Pagamento online recebido com o pedido cancelado ou já pago: estorno automático solicitado');
    perform private.kick_gateway_worker();
    return 'refund_needed';
  end if;
  if o.payment_status = 'paid' then return 'paid'; end if;
  select * into u from public.units where id = o.unit_id;
  v_next := case when o.status = 'awaiting_payment' then
              case when u.auto_accept then 'preparing'::public.order_status else 'pending'::public.order_status end
            else o.status end;
  update public.orders set payment_status = 'paid', paid_at = now(), status = v_next,
         accepted_at = case when v_next = 'preparing' then now() else accepted_at end where id = o.id;
  update public.payments set status = 'paid', gateway = 'mercadopago', txid = gp.external_id where order_id = o.id;
  if v_next <> o.status then
    insert into public.order_events (tenant_id, order_id, from_status, to_status, note)
    values (o.tenant_id, o.id, o.status, v_next, case gp.kind when 'pix' then 'Pix confirmado pelo Mercado Pago' else 'Cartão aprovado pelo Mercado Pago' end);
  end if;
  return 'paid';
end $$;

-- contexto para criar a cobrança a partir do token público do pedido
create or replace function public.gateway_context(p_order_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare o public.orders; g public.payment_gateways; u public.units;
begin
  perform private.assert_service_role();
  select * into o from public.orders where public_token = p_order_token;
  if not found then return null; end if;
  select * into g from public.payment_gateways where unit_id = o.unit_id;
  select * into u from public.units where id = o.unit_id;
  return jsonb_build_object('order_id', o.id, 'unit_id', o.unit_id, 'number', o.number, 'status', o.status,
    'payment_status', o.payment_status, 'payment_method', o.payment_method, 'total_cents', o.total_cents,
    'customer_name', o.customer_name, 'store', u.name, 'pix_expires_at', o.created_at + make_interval(mins => u.pix_expires_min),
    'enabled', coalesce(g.enabled, false), 'pix_enabled', coalesce(g.pix_enabled, false), 'card_enabled', coalesce(g.card_enabled, false),
    'max_installments', coalesce(g.max_installments, 1), 'statement_descriptor', g.statement_descriptor,
    'token', (select decrypted_secret from vault.decrypted_secrets where id = g.access_token_secret_id),
    'card_attempts', (select count(*) from public.gateway_payments where order_id = o.id and kind = 'card'),
    'open_pix', (select to_jsonb(x) from (select id, external_id, status, expires_at from public.gateway_payments
                 where order_id = o.id and kind = 'pix' and status in ('creating','pending') order by created_at desc limit 1) x),
    'last_payment', (select to_jsonb(x) from (select id, external_id, kind, status, updated_at from public.gateway_payments
                 where order_id = o.id order by created_at desc limit 1) x));
end $$;

create or replace function public.gateway_begin(p_order_id uuid, p_kind text, p_amount_cents integer)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v uuid;
begin
  perform private.assert_service_role();
  insert into public.gateway_payments (tenant_id, unit_id, order_id, kind, amount_cents)
  select tenant_id, unit_id, id, p_kind, p_amount_cents from public.orders where id = p_order_id returning id into v;
  return v;
end $$;

-- grava o estado devolvido pelo Mercado Pago (criação, consulta ou webhook)
create or replace function public.gateway_record(p_id uuid, p_body jsonb)
returns text language plpgsql security definer set search_path = '' as $$
declare gp public.gateway_payments; st text := lower(coalesce(p_body->>'status', 'error')); td jsonb := p_body->'point_of_interaction'->'transaction_data';
begin
  perform private.assert_service_role();
  select * into gp from public.gateway_payments where id = p_id for update;
  if not found then return 'missing'; end if;
  -- o valor aprovado precisa bater com o pedido
  if st = 'approved' and round(coalesce((p_body->>'transaction_amount')::numeric, 0) * 100) <> gp.amount_cents then
    st := 'error';
  end if;
  update public.gateway_payments set
    external_id = coalesce(p_body->>'id', external_id), status = st, status_detail = left(p_body->>'status_detail', 80),
    qr_code = coalesce(td->>'qr_code', qr_code), qr_code_base64 = coalesce(td->>'qr_code_base64', qr_code_base64),
    ticket_url = coalesce(td->>'ticket_url', ticket_url),
    expires_at = coalesce((p_body->>'date_of_expiration')::timestamptz, expires_at),
    installments = coalesce((p_body->>'installments')::int, installments),
    card_last4 = coalesce(p_body->'card'->>'last_four_digits', card_last4), card_brand = coalesce(p_body->>'payment_method_id', card_brand),
    refund_status = case when st in ('refunded','charged_back') then 'refunded' else refund_status end,
    raw = p_body - 'point_of_interaction'
  where id = gp.id;
  if st = 'approved' and gp.status <> 'approved' then return private.gateway_mark_paid(gp.id); end if;
  if st in ('refunded','charged_back') then
    update public.payments set status = 'refunded' where order_id = gp.order_id and status = 'paid';
  end if;
  return st;
end $$;

create or replace function public.gateway_find(p_unit_id uuid, p_external_id text)
returns uuid language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.assert_service_role();
  return (select id from public.gateway_payments where unit_id = p_unit_id and external_id = p_external_id);
end $$;

create or replace function public.gateway_secrets(p_unit_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.assert_service_role();
  return (select jsonb_build_object('token', (select decrypted_secret from vault.decrypted_secrets where id = g.access_token_secret_id),
      'webhook_secret', (select decrypted_secret from vault.decrypted_secrets where id = g.webhook_secret_id), 'live', g.live)
    from public.payment_gateways g where g.unit_id = p_unit_id);
end $$;

create or replace function public.gateway_test_result(p_unit_id uuid, p_ok boolean, p_message text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.assert_service_role();
  update public.payment_gateways set last_test_at = now(), last_test_ok = p_ok, last_test_message = left(p_message, 300) where unit_id = p_unit_id;
end $$;

create or replace function public.gateway_worker_secret()
returns text language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.assert_service_role();
  return (select decrypted_secret from vault.decrypted_secrets where name = 'gateway_worker_secret');
end $$;

-- ---------- Estornos ----------
create or replace function public.gateway_refund_jobs()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r record; v jsonb := '[]'::jsonb;
begin
  perform private.assert_service_role();
  update public.gateway_payments set refund_status = 'requested' where refund_status = 'processing' and updated_at < now() - interval '5 minutes';
  for r in select gp.id, gp.external_id, gp.unit_id from public.gateway_payments gp
           where gp.refund_status = 'requested' and coalesce(gp.refund_next_at, now()) <= now() and gp.external_id is not null
           order by gp.refund_next_at nulls first limit 10 for update skip locked loop
    update public.gateway_payments set refund_status = 'processing', refund_attempts = refund_attempts + 1 where id = r.id;
    v := v || jsonb_build_object('id', r.id, 'external_id', r.external_id,
      'token', (select decrypted_secret from vault.decrypted_secrets ds join public.payment_gateways g on g.access_token_secret_id = ds.id where g.unit_id = r.unit_id));
  end loop;
  return v;
end $$;

create or replace function public.gateway_refund_result(p_id uuid, p_ok boolean, p_message text)
returns void language plpgsql security definer set search_path = '' as $$
declare gp public.gateway_payments;
begin
  perform private.assert_service_role();
  select * into gp from public.gateway_payments where id = p_id for update;
  if p_ok then
    update public.gateway_payments set refund_status = 'refunded', status = 'refunded', refund_message = left(p_message, 300) where id = gp.id;
    update public.payments set status = 'refunded' where order_id = gp.order_id;
    insert into public.order_events (tenant_id, order_id, to_status, note)
    select tenant_id, id, status, 'Estorno feito no Mercado Pago' from public.orders where id = gp.order_id;
  elsif gp.refund_attempts >= 5 then
    update public.gateway_payments set refund_status = 'failed', refund_message = left(p_message, 300) where id = gp.id;
  else
    update public.gateway_payments set refund_status = 'requested', refund_message = left(p_message, 300),
      refund_next_at = now() + make_interval(mins => 2 * gp.refund_attempts) where id = gp.id;
  end if;
end $$;

-- pedido pago online cancelado: estorno automático
create or replace function private.gateway_refund_on_cancel()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.gateway_payments set refund_status = 'requested', refund_next_at = now()
   where order_id = new.id and status = 'approved' and refund_status = 'none';
  if found then perform private.kick_gateway_worker(); end if;
  return null;
end $$;
create trigger orders_gateway_refund after update of status on public.orders
  for each row when (new.status = 'cancelled' and old.status <> 'cancelled') execute function private.gateway_refund_on_cancel();

-- refazer estorno que falhou (gerência)
create or replace function public.gateway_retry_refund(p_gp_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare gp public.gateway_payments;
begin
  select * into gp from public.gateway_payments where id = p_gp_id for update;
  if not found or not private.can_access_unit(gp.unit_id) or not private.can_manage(gp.tenant_id) then
    raise exception 'Sem permissão.' using errcode = '42501'; end if;
  if gp.refund_status <> 'failed' then raise exception 'Este estorno não falhou.'; end if;
  update public.gateway_payments set refund_status = 'requested', refund_attempts = 0, refund_next_at = now() where id = gp.id;
  perform private.kick_gateway_worker();
end $$;

create or replace function private.gateway_cron_tick()
returns void language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.gateway_payments where refund_status = 'requested' and coalesce(refund_next_at, now()) <= now())
     or exists (select 1 from public.gateway_payments where status in ('pending','in_process','creating')
                and updated_at < now() - interval '2 minutes' and created_at > now() - interval '1 day') then
    perform private.kick_gateway_worker();
  end if;
end $$;
select cron.schedule('domma-gateway', '* * * * *', $$select private.gateway_cron_tick()$$);

-- pendentes para conferir (rede de segurança do webhook)
create or replace function public.gateway_pending_checks()
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform private.assert_service_role();
  return coalesce((select jsonb_agg(jsonb_build_object('id', gp.id, 'external_id', gp.external_id,
      'token', (select decrypted_secret from vault.decrypted_secrets ds join public.payment_gateways g on g.access_token_secret_id = ds.id where g.unit_id = gp.unit_id)))
    from (select * from public.gateway_payments where status in ('pending','in_process') and external_id is not null
          and updated_at < now() - interval '2 minutes' and created_at > now() - interval '1 day' order by updated_at limit 20) gp), '[]'::jsonb);
end $$;

revoke execute on function public.gateway_context(text), public.gateway_begin(uuid, text, integer), public.gateway_record(uuid, jsonb),
  public.gateway_find(uuid, text), public.gateway_secrets(uuid), public.gateway_test_result(uuid, boolean, text),
  public.gateway_worker_secret(), public.gateway_refund_jobs(), public.gateway_refund_result(uuid, boolean, text),
  public.gateway_pending_checks() from public, anon, authenticated;
grant execute on function public.gateway_context(text), public.gateway_begin(uuid, text, integer), public.gateway_record(uuid, jsonb),
  public.gateway_find(uuid, text), public.gateway_secrets(uuid), public.gateway_test_result(uuid, boolean, text),
  public.gateway_worker_secret(), public.gateway_refund_jobs(), public.gateway_refund_result(uuid, boolean, text),
  public.gateway_pending_checks() to service_role;
revoke execute on function public.gateway_save_settings(uuid, jsonb, text, text), public.gateway_can_test(uuid), public.gateway_retry_refund(uuid) from public, anon;
grant execute on function public.gateway_save_settings(uuid, jsonb, text, text), public.gateway_can_test(uuid), public.gateway_retry_refund(uuid) to authenticated;
revoke all on public.payment_gateways, public.gateway_payments from anon;
revoke insert, update, delete on public.payment_gateways, public.gateway_payments from authenticated;
