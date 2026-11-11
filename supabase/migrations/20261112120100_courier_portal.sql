-- =====================================================================
-- Domma Food · 029 · App do entregador (link), acerto e acompanhamento
-- =====================================================================
create or replace function public.courier_link(p_id uuid)
returns text language plpgsql stable security definer set search_path = '' as $$
declare c public.couriers;
begin
  select * into c from public.couriers where id = p_id;
  if not found or not private.can_access_unit(c.unit_id) or not private.can_manage(c.tenant_id) then raise exception 'Sem permissão.' using errcode = '42501'; end if;
  return c.access_token;
end $$;

create or replace function private.courier_by_token(p_token text)
returns public.couriers language sql stable security definer set search_path = '' as $$
  select * from public.couriers where access_token = p_token and active and p_token ~ '^[0-9a-f]{32}$';
$$;

-- tela do entregador: entregas em andamento (endereço e contato só enquanto a entrega estiver com ele)
create or replace function public.courier_portal(p_token text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare c public.couriers; u public.units; v_tz text; v_day timestamptz;
begin
  c := private.courier_by_token(p_token);
  if c.id is null then return null; end if;
  select * into u from public.units where id = c.unit_id;
  v_tz := coalesce(u.timezone, 'America/Sao_Paulo');
  v_day := date_trunc('day', now() at time zone v_tz) at time zone v_tz;
  return jsonb_build_object(
    'courier', jsonb_build_object('name', c.name, 'vehicle', c.vehicle),
    'store', jsonb_build_object('name', u.name, 'phone', coalesce(u.whatsapp, u.phone), 'lat', u.lat, 'lng', u.lng,
      'address', concat_ws(', ', nullif(concat_ws(' ', u.street, u.number), ''), u.neighborhood, u.city)),
    'deliveries', coalesce((select jsonb_agg(jsonb_build_object(
        'id', d.id, 'batch_id', d.batch_id, 'seq', d.seq, 'status', d.status, 'fee_cents', d.fee_cents,
        'collect_cents', d.collect_cents, 'collect_method', d.collect_method, 'change_for_cents', d.change_for_cents,
        'order_number', o.number, 'order_status', o.status, 'customer_name', o.customer_name, 'customer_phone', o.customer_phone,
        'address', o.address, 'notes', o.notes, 'items', (select sum(quantity) from public.order_items where order_id = o.id))
        order by d.assigned_at, d.seq)
      from public.deliveries d join public.orders o on o.id = d.order_id
      where d.courier_id = c.id and d.status in ('assigned','picked_up')), '[]'::jsonb),
    'today', (select jsonb_build_object('delivered', count(*) filter (where d.status = 'delivered'),
        'fees_cents', coalesce(sum(d.fee_cents) filter (where d.status = 'delivered'), 0),
        'cash_cents', coalesce(sum(d.collect_cents) filter (where d.status = 'delivered' and coalesce(d.collected_method, d.collect_method) = 'cash'), 0))
      from public.deliveries d where d.courier_id = c.id and d.assigned_at >= v_day));
end $$;

create or replace function public.courier_action(p_token text, p_delivery_id uuid, p_action text, p_method text default null, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c public.couriers; d public.deliveries; o public.orders;
begin
  c := private.courier_by_token(p_token);
  if c.id is null then raise exception 'Link inválido. Peça um novo link à loja.' using errcode = '42501'; end if;
  select * into d from public.deliveries where id = p_delivery_id and courier_id = c.id for update;
  if not found then raise exception 'Entrega não encontrada.'; end if;
  select * into o from public.orders where id = d.order_id for update;
  if p_action = 'pickup' then
    if d.status <> 'assigned' then raise exception 'Esta entrega já saiu.'; end if;
    if o.status = 'preparing' then raise exception 'O pedido #% ainda está em preparo.', o.number; end if;
    if o.status <> 'ready' then raise exception 'O pedido #% não está pronto para sair.', o.number; end if;
    update public.deliveries set status = 'picked_up', picked_up_at = now() where id = d.id;
    perform private.order_status_system(o.id, 'dispatched', 'Saiu para entrega com ' || c.name);
  elsif p_action = 'deliver' then
    if d.status <> 'picked_up' then raise exception 'Marque a saída antes de concluir.'; end if;
    if d.collect_cents > 0 and coalesce(p_method, '') not in ('cash','card_on_delivery','pix','voucher') then
      raise exception 'Informe como o cliente pagou.'; end if;
    update public.deliveries set status = 'delivered', delivered_at = now(),
      collected_method = case when d.collect_cents > 0 then p_method end where id = d.id;
    if d.collect_cents > 0 and p_method is distinct from d.collect_method then
      update public.orders set payment_method = p_method::public.payment_method where id = o.id;
      update public.payments set method = p_method::public.payment_method where order_id = o.id and status = 'pending';
    end if;
    perform private.order_status_system(o.id, 'completed', 'Entregue por ' || c.name);
    if d.collect_cents > 0 and p_method = 'pix' then   -- Pix direto na conta da loja: confere depois no extrato
      update public.orders set payment_status = 'paid', paid_at = now() where id = o.id;
      update public.payments set status = 'paid' where order_id = o.id and status = 'pending';
    end if;
  elsif p_action = 'fail' then
    if d.status not in ('assigned','picked_up') then raise exception 'Entrega já finalizada.'; end if;
    if coalesce(trim(p_reason), '') = '' then raise exception 'Informe o motivo.'; end if;
    update public.deliveries set status = 'returned', fail_reason = left(trim(p_reason), 200) where id = d.id;
    if o.status = 'dispatched' then perform private.order_status_system(o.id, 'ready', 'Entrega não realizada: ' || left(trim(p_reason), 200)); end if;
  else raise exception 'Ação inválida.'; end if;
  return jsonb_build_object('ok', true);
end $$;

-- ---------- Acerto ----------
create or replace function public.courier_open_balance(p_courier_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare c public.couriers;
begin
  select * into c from public.couriers where id = p_courier_id;
  if not found or not private.can_access_unit(c.unit_id) or not private.has_role(c.tenant_id, array['owner','manager','cashier']::public.member_role[]) then
    raise exception 'Sem permissão.' using errcode = '42501'; end if;
  return (select jsonb_build_object('deliveries', count(*), 'fees_cents', coalesce(sum(fee_cents), 0),
      'cash_cents', coalesce(sum(collect_cents) filter (where coalesce(collected_method, collect_method) = 'cash'), 0),
      'card_cents', coalesce(sum(collect_cents) filter (where coalesce(collected_method, collect_method) in ('card_on_delivery','voucher')), 0),
      'pix_cents', coalesce(sum(collect_cents) filter (where collected_method = 'pix'), 0),
      'returned', (select count(*) from public.deliveries r where r.courier_id = c.id and r.status = 'returned' and r.settlement_id is null),
      'since', min(delivered_at), 'items', coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'number', o.number, 'delivered_at', d.delivered_at,
         'fee_cents', d.fee_cents, 'collect_cents', d.collect_cents, 'method', coalesce(d.collected_method, d.collect_method)) order by d.delivered_at), '[]'::jsonb))
    from public.deliveries d join public.orders o on o.id = d.order_id
    where d.courier_id = c.id and d.status = 'delivered' and d.settlement_id is null);
end $$;

create or replace function public.courier_settle(p_courier_id uuid, p_cash_received_cents integer, p_pay_from_cash boolean, p_note text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c public.couriers; b jsonb; v_id uuid; s uuid; v_fees int; v_cash int; v_tz text;
begin
  select * into c from public.couriers where id = p_courier_id for update;
  if not found or not private.can_access_unit(c.unit_id) or not private.has_role(c.tenant_id, array['owner','manager','cashier']::public.member_role[]) then
    raise exception 'Sem permissão.' using errcode = '42501'; end if;
  b := public.courier_open_balance(c.id);
  if (b->>'deliveries')::int = 0 and (b->>'returned')::int = 0 then raise exception 'Não há entregas para acertar.'; end if;
  if p_cash_received_cents is null or p_cash_received_cents < 0 then raise exception 'Informe o dinheiro recebido do entregador.'; end if;
  v_fees := (b->>'fees_cents')::int; v_cash := (b->>'cash_cents')::int;
  s := private.open_session(c.unit_id);
  if p_pay_from_cash and s is null then raise exception 'Abra o caixa para pagar o entregador com o dinheiro da gaveta.'; end if;
  insert into public.courier_settlements (tenant_id, unit_id, courier_id, deliveries, fees_cents, cash_expected_cents, cash_received_cents,
    difference_cents, paid_from_cash, note)
  values (c.tenant_id, c.unit_id, c.id, (b->>'deliveries')::int, v_fees, v_cash, p_cash_received_cents,
    p_cash_received_cents - v_cash, p_pay_from_cash, left(nullif(trim(p_note), ''), 300)) returning id into v_id;
  update public.deliveries set settlement_id = v_id where courier_id = c.id and status in ('delivered','returned') and settlement_id is null;
  if s is not null and p_cash_received_cents > 0 then
    insert into public.cash_moves (tenant_id, session_id, kind, method, amount_cents, note, created_by)
    values (c.tenant_id, s, 'courier_cash', 'cash', p_cash_received_cents, left('Entregas: ' || c.name, 200), auth.uid());
  end if;
  if p_pay_from_cash and v_fees > 0 then
    insert into public.cash_moves (tenant_id, session_id, kind, method, amount_cents, note, created_by)
    values (c.tenant_id, s, 'withdrawal', 'cash', v_fees, left('Taxas do entregador ' || c.name, 200), auth.uid());
  end if;
  if v_fees > 0 then
    select timezone into v_tz from public.units where id = c.unit_id;
    insert into public.fin_entries (tenant_id, unit_id, kind, description, category, party, amount_cents, due_date, paid_at, paid_method, created_by)
    values (c.tenant_id, c.unit_id, 'payable', left('Entregas de ' || c.name || ' (' || (b->>'deliveries') || ')', 160), 'Entregadores', c.name, v_fees,
      (now() at time zone coalesce(v_tz, 'America/Sao_Paulo'))::date,
      case when p_pay_from_cash then now() end, case when p_pay_from_cash then 'cash' end, auth.uid());
  end if;
  return jsonb_build_object('id', v_id, 'fees_cents', v_fees, 'cash_expected_cents', v_cash, 'difference_cents', p_cash_received_cents - v_cash);
end $$;

-- ---------- Acompanhamento do cliente: nome do entregador quando sai ----------
create or replace function private.order_courier(p_order uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('name', split_part(c.name, ' ', 1), 'vehicle', c.vehicle, 'picked_up_at', d.picked_up_at)
  from public.deliveries d join public.couriers c on c.id = d.courier_id
  where d.order_id = p_order and d.status in ('picked_up','delivered') order by d.assigned_at desc limit 1;
$$;
do $$ declare d text; begin
  d := pg_get_functiondef('public.get_order_by_token(text)'::regprocedure);
  if position($x$'unit', jsonb_build_object('name', u.name$x$ in d) = 0 then raise exception 'get_order_by_token mudou'; end if;
  execute replace(d, $x$'unit', jsonb_build_object('name', u.name$x$, $x$'courier', private.order_courier(o.id),
    'unit', jsonb_build_object('name', u.name$x$);
end $$;

grant execute on function public.courier_portal(text), public.courier_action(text, uuid, text, text, text) to anon, authenticated;
grant execute on function public.courier_assign(uuid[], uuid), public.courier_unassign(uuid), public.courier_save(uuid, uuid, jsonb),
  public.courier_rotate_link(uuid), public.courier_link(uuid), public.courier_open_balance(uuid),
  public.courier_settle(uuid, integer, boolean, text) to authenticated;
