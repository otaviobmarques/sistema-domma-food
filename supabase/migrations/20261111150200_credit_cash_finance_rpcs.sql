-- =====================================================================
-- Domma Food · 019 · Fiado no caixa/PDV/mesas e resumo financeiro
-- =====================================================================

-- lança no extrato do fiado e atualiza o saldo devedor
create or replace function private.credit_post(p_tenant uuid, p_customer uuid, p_kind text, p_amount integer,
                                               p_order uuid, p_tab uuid, p_method text, p_note text)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_bal integer;
begin
  update public.customers set credit_balance_cents = credit_balance_cents + p_amount
   where id = p_customer and tenant_id = p_tenant returning credit_balance_cents into v_bal;
  if not found then raise exception 'Cliente não encontrado.'; end if;
  insert into public.credit_ledger (tenant_id, customer_id, kind, amount_cents, balance_after, order_id, tab_id, method, note, created_by)
  values (p_tenant, p_customer, p_kind, p_amount, v_bal, p_order, p_tab, p_method, left(nullif(trim(p_note), ''), 200), auth.uid());
  return v_bal;
end $$;

alter table public.cash_moves drop constraint cash_moves_kind_check;
alter table public.cash_moves add constraint cash_moves_kind_check check (kind in ('sale','supply','withdrawal','credit_payment'));

-- pagamentos (vários por venda), agora com fiado; devolve o troco
drop function private.register_payments(uuid, uuid, int, jsonb, uuid, uuid);
create function private.register_payments(p_tenant uuid, p_session uuid, p_total int, p_payments jsonb, p_order uuid, p_tab uuid, p_customer uuid)
returns int language plpgsql security definer set search_path = '' as $$
declare pm jsonb; v_sum int := 0; v_cash int := 0; v_credit int := 0; v_amt int; v_change int; v_m text; v_lim int; v_bal int;
begin
  if jsonb_typeof(p_payments) <> 'array' or jsonb_array_length(p_payments) = 0 then raise exception 'Informe a forma de pagamento.'; end if;
  for pm in select * from jsonb_array_elements(p_payments) loop
    v_amt := (pm->>'amount_cents')::int; v_m := pm->>'method';
    if v_amt is null or v_amt <= 0 then raise exception 'Valor de pagamento inválido.'; end if;
    if v_m not in ('cash','pix','credit_card','debit_card','voucher','credit_account') then raise exception 'Forma de pagamento inválida.'; end if;
    v_sum := v_sum + v_amt;
    if v_m = 'cash' then v_cash := v_cash + v_amt; elsif v_m = 'credit_account' then v_credit := v_credit + v_amt; end if;
  end loop;
  if v_sum < p_total then raise exception 'Faltam R$ % para fechar a conta.', to_char((p_total - v_sum) / 100.0, 'FM999990D00'); end if;
  v_change := v_sum - p_total;
  if v_change > v_cash then raise exception 'Só é possível dar troco sobre o valor em dinheiro.'; end if;
  if v_credit > 0 then
    if p_customer is null then raise exception 'Para vender fiado, identifique o cliente pelo telefone.'; end if;
    select credit_limit_cents, credit_balance_cents into v_lim, v_bal from public.customers
     where id = p_customer and tenant_id = p_tenant for update;
    if not found then raise exception 'Cliente não encontrado.'; end if;
    if v_lim = 0 then raise exception 'Este cliente não tem fiado liberado. Um gerente define o limite na tela Fiado.'; end if;
    if v_bal + v_credit > v_lim then
      raise exception 'Limite de fiado insuficiente. Disponível: R$ %.', to_char(greatest(v_lim - v_bal, 0) / 100.0, 'FM999990D00'); end if;
  end if;
  for pm in select * from jsonb_array_elements(p_payments) loop
    v_m := pm->>'method'; v_amt := (pm->>'amount_cents')::int;
    if v_m = 'cash' then v_amt := v_amt - least(v_change, v_amt); v_change := v_change - least(v_change, (pm->>'amount_cents')::int); end if;
    if v_amt > 0 then
      insert into public.payments (tenant_id, order_id, tab_id, method, gateway, amount_cents, status, confirmed_by)
      values (p_tenant, p_order, p_tab, v_m::public.payment_method, 'pdv', v_amt, 'paid', auth.uid());
      insert into public.cash_moves (tenant_id, session_id, kind, method, amount_cents, order_id, tab_id, created_by)
      values (p_tenant, p_session, 'sale', v_m::public.payment_method, v_amt, p_order, p_tab, auth.uid());
      if v_m = 'credit_account' then
        perform private.credit_post(p_tenant, p_customer, 'charge', v_amt, p_order, p_tab, null,
          case when p_tab is not null then 'Conta de mesa' else 'Venda no balcão' end);
      end if;
    end if;
  end loop;
  return v_sum - p_total;
end $$;

-- fiado entra nas vendas, mas não no dinheiro contado; recebimentos de fiado entram na forma em que foram pagos
create or replace function private.cash_expected(p_session uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'cash', s.opening_float_cents + coalesce(sum(case when m.method = 'cash' and m.kind in ('sale','supply','credit_payment') then m.amount_cents
                                                      when m.kind = 'withdrawal' then -m.amount_cents else 0 end), 0),
    'pix', coalesce(sum(m.amount_cents) filter (where m.kind in ('sale','credit_payment') and m.method = 'pix'), 0),
    'credit_card', coalesce(sum(m.amount_cents) filter (where m.kind in ('sale','credit_payment') and m.method = 'credit_card'), 0),
    'debit_card', coalesce(sum(m.amount_cents) filter (where m.kind in ('sale','credit_payment') and m.method = 'debit_card'), 0),
    'voucher', coalesce(sum(m.amount_cents) filter (where m.kind = 'sale' and m.method = 'voucher'), 0),
    'credit_account', coalesce(sum(m.amount_cents) filter (where m.kind = 'sale' and m.method = 'credit_account'), 0),
    'credit_received', coalesce(sum(m.amount_cents) filter (where m.kind = 'credit_payment'), 0),
    'sales_total', coalesce(sum(m.amount_cents) filter (where m.kind = 'sale'), 0),
    'supply', coalesce(sum(m.amount_cents) filter (where m.kind = 'supply'), 0),
    'withdrawal', coalesce(sum(m.amount_cents) filter (where m.kind = 'withdrawal'), 0),
    'sales_count', count(*) filter (where m.kind = 'sale'))
  from public.cash_sessions s left join public.cash_moves m on m.session_id = s.id
  where s.id = p_session group by s.id;
$$;

-- ---------- PDV: venda de balcão (com fiado) ----------
create or replace function public.pos_sale(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  u public.units; s uuid; q jsonb; v_sub int; v_disc int := coalesce((p->>'discount_cents')::int, 0); v_total int;
  v_order uuid; v_n int; v_change int; v_phone text := private.only_digits(p->'customer'->>'phone'); v_cust uuid;
  v_name text := left(coalesce(nullif(trim(p->'customer'->>'name'), ''), 'Balcão'), 120);
begin
  select * into u from public.units where id = (p->>'unit_id')::uuid;
  if not found or not private.can_access_unit(u.id) or not private.has_role(u.tenant_id, array['owner','manager','cashier']::public.member_role[]) then
    raise exception 'Sem permissão.' using errcode = '42501'; end if;
  s := private.open_session(u.id);
  if s is null then raise exception 'Abra o caixa antes de vender.'; end if;
  if coalesce(p->'payments'->0->>'method', '') not in ('cash','pix','credit_card','debit_card','voucher','credit_account') then
    raise exception 'Informe a forma de pagamento.'; end if;
  q := private.price_items(u.id, p->'items', 'counter'); v_sub := (q->>'subtotal_cents')::int;
  if v_disc < 0 or v_disc > v_sub then raise exception 'Desconto inválido.'; end if;
  if v_disc > 0 and v_disc * 100.0 / v_sub > private.max_discount(u.tenant_id) then
    raise exception 'Desconto acima do seu limite (% %%). Peça a um gerente.', private.max_discount(u.tenant_id);
  end if;
  v_total := v_sub - v_disc;
  if length(v_phone) between 10 and 13 then
    insert into public.customers (tenant_id, name, phone) values (u.tenant_id, v_name, v_phone)
    on conflict (tenant_id, phone) do update set name = case when excluded.name = 'Balcão' then public.customers.name else excluded.name end
    returning id into v_cust;
  end if;
  update public.units set order_counter = order_counter + 1 where id = u.id returning order_counter into v_n;
  insert into public.orders (tenant_id, unit_id, number, channel, type, status, customer_id, customer_name, customer_phone,
    subtotal_cents, discount_cents, total_cents, payment_method, payment_status, notes, accepted_at, paid_at, cash_session_id)
  values (u.tenant_id, u.id, v_n, 'counter', case when p->>'type' = 'dine_in' then 'dine_in'::public.order_type else 'pickup'::public.order_type end,
    'preparing', v_cust, v_name, coalesce(nullif(v_phone, ''), '00000000000'), v_sub, v_disc, v_total,
    (p->'payments'->0->>'method')::public.payment_method, 'paid', left(nullif(trim(p->>'notes'), ''), 500), now(), now(), s)
  returning id into v_order;
  perform private.insert_items(u.tenant_id, v_order, q->'items');
  v_change := private.register_payments(u.tenant_id, s, v_total, p->'payments', v_order, null, v_cust);
  insert into public.order_events (tenant_id, order_id, to_status, note, actor_id) values (u.tenant_id, v_order, 'preparing', 'Venda no balcão (PDV)', auth.uid());
  if v_disc > 0 then
    insert into public.audit_logs (tenant_id, actor_id, action, entity, entity_id, after, ip)
    values (u.tenant_id, auth.uid(), 'discount', 'orders', v_order::text, jsonb_build_object('discount_cents', v_disc, 'subtotal_cents', v_sub), private.request_ip());
  end if;
  return jsonb_build_object('order_id', v_order, 'number', v_n, 'total_cents', v_total, 'change_cents', v_change);
end $$;

-- ---------- Mesas: fechamento da conta (com fiado) ----------
drop function public.tab_close(uuid, jsonb, boolean, integer);
create function public.tab_close(p_tab_id uuid, p_payments jsonb, p_service_fee boolean default true, p_discount_cents integer default 0,
                                 p_customer_id uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare t public.tabs; s uuid; v_sub int; v_fee int; v_disc int := coalesce(p_discount_cents, 0); v_total int; v_change int; r record; v_m public.payment_method;
begin
  select * into t from public.tabs where id = p_tab_id for update;
  if not found or not private.can_access_unit(t.unit_id) or not private.has_role(t.tenant_id, array['owner','manager','cashier']::public.member_role[]) then
    raise exception 'Só o caixa ou o gerente fecham a conta.' using errcode = '42501'; end if;
  if t.status <> 'open' then raise exception 'Esta comanda já foi fechada.'; end if;
  s := private.open_session(t.unit_id);
  if s is null then raise exception 'Abra o caixa antes de fechar a conta.'; end if;
  select coalesce(sum(subtotal_cents), 0) into v_sub from public.orders where tab_id = t.id and status <> 'cancelled';
  if v_sub = 0 then raise exception 'A comanda está vazia.'; end if;
  if v_disc < 0 or v_disc > v_sub then raise exception 'Desconto inválido.'; end if;
  if v_disc > 0 and v_disc * 100.0 / v_sub > private.max_discount(t.tenant_id) then
    raise exception 'Desconto acima do seu limite (% %%). Peça a um gerente.', private.max_discount(t.tenant_id); end if;
  v_fee := case when p_service_fee then round(v_sub * t.service_fee_pct / 100.0)::int else 0 end;
  v_total := v_sub + v_fee - v_disc;
  v_change := private.register_payments(t.tenant_id, s, v_total, p_payments, null, t.id, p_customer_id);
  v_m := (p_payments->0->>'method')::public.payment_method;
  for r in select id, status from public.orders where tab_id = t.id and status <> 'cancelled' loop
    update public.orders set status = 'completed', completed_at = now(), payment_status = 'paid', paid_at = now(),
           payment_method = v_m, cash_session_id = s, customer_id = coalesce(customer_id, p_customer_id) where id = r.id;
    if r.status <> 'completed' then
      insert into public.order_events (tenant_id, order_id, from_status, to_status, note, actor_id)
      values (t.tenant_id, r.id, r.status, 'completed', 'Conta da mesa fechada', auth.uid());
    end if;
  end loop;
  update public.tabs set status = 'closed', closed_at = now(), closed_by = auth.uid(), subtotal_cents = v_sub,
         service_fee_cents = v_fee, discount_cents = v_disc, total_cents = v_total where id = t.id;
  return jsonb_build_object('total_cents', v_total, 'service_fee_cents', v_fee, 'change_cents', v_change);
end $$;
grant execute on function public.tab_close(uuid, jsonb, boolean, integer, uuid) to authenticated;

-- venda fiada cancelada sai da conta do cliente
create or replace function private.order_credit_reversal()
returns trigger language plpgsql security definer set search_path = '' as $$
declare l record;
begin
  for l in select customer_id, sum(amount_cents)::int as amt from public.credit_ledger
           where order_id = new.id and kind in ('charge','reversal') group by customer_id having sum(amount_cents) > 0 loop
    perform private.credit_post(new.tenant_id, l.customer_id, 'reversal', -l.amt, new.id, null, null, 'Pedido cancelado');
  end loop;
  return null;
end $$;
create trigger orders_credit_reversal after update of status on public.orders
  for each row when (new.status = 'cancelled' and old.status <> 'cancelled')
  execute function private.order_credit_reversal();
