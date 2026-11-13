-- Modo offline do caixa (PDV)
-- O PDV guarda a venda no aparelho quando a internet cai e envia quando a conexão volta.
-- - client_ref: identificador gerado no aparelho. Torna o envio idempotente: reenviar não duplica a venda.
-- - offline_sold_at: hora real da venda. O pedido entra com essa data e já concluído,
--   porque a cozinha trabalhou pelo cupom impresso e não deve receber o pedido de novo no KDS.
-- - Se o preço mudou enquanto o aparelho estava sem internet, vale o que foi cobrado do cliente
--   (cópia dos itens enviada pelo aparelho). Isso fica registrado na auditoria.

alter table public.orders add column client_ref uuid;
alter table public.orders add column offline_sold_at timestamptz;
create unique index orders_client_ref_uq on public.orders(unit_id, client_ref) where client_ref is not null;

-- Itens como foram cobrados no aparelho. O produto precisa ser da loja; nome e setor vêm do cadastro.
create or replace function private.pos_snapshot_items(p_tenant uuid, p_items jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare it jsonb; o jsonb; pr public.products; v_qty int; v_unit int; v_opts jsonb; v_items jsonb := '[]'::jsonb; v_sub int := 0;
begin
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then raise exception 'Adicione pelo menos um item.'; end if;
  if jsonb_array_length(p_items) > 80 then raise exception 'Itens demais.'; end if;
  for it in select * from jsonb_array_elements(p_items) loop
    select * into pr from public.products where id = (it->>'product_id')::uuid and tenant_id = p_tenant;
    if not found then raise exception 'Produto da venda offline não existe mais no cardápio.'; end if;
    v_qty := coalesce((it->>'quantity')::int, 1);
    v_unit := (it->>'unit_price_cents')::int;
    if v_qty < 1 or v_qty > 99 then raise exception 'Quantidade inválida.'; end if;
    if v_unit is null or v_unit < 0 or v_unit > 10000000 then raise exception 'Preço inválido na venda offline.'; end if;
    v_opts := '[]'::jsonb;
    for o in select * from jsonb_array_elements(coalesce(it->'options', '[]'::jsonb)) loop
      v_opts := v_opts || jsonb_build_object('group', left(coalesce(o->>'group', ''), 120), 'option_id', o->>'option_id',
        'name', left(coalesce(o->>'name', ''), 120), 'price_cents', coalesce((o->>'price_cents')::int, 0),
        'quantity', greatest(1, least(20, coalesce((o->>'quantity')::int, 1))));
    end loop;
    v_items := v_items || jsonb_build_object('product_id', pr.id, 'name', pr.name, 'quantity', v_qty, 'station', pr.station,
      'unit_price_cents', v_unit, 'total_cents', v_unit * v_qty, 'options', v_opts, 'notes', left(nullif(trim(it->>'notes'), ''), 300));
    v_sub := v_sub + v_unit * v_qty;
  end loop;
  return jsonb_build_object('items', v_items, 'subtotal_cents', v_sub);
end $$;
revoke execute on function private.pos_snapshot_items(uuid, jsonb) from public, anon, authenticated;

create or replace function public.pos_sale(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  u public.units; s uuid; q jsonb; v_sub int; v_disc int := coalesce((p->>'discount_cents')::int, 0); v_total int;
  v_order uuid; v_n int; v_change int; v_phone text := private.only_digits(p->'customer'->>'phone'); v_cust uuid;
  v_name text := left(coalesce(nullif(trim(p->'customer'->>'name'), ''), 'Balcão'), 120);
  v_ref uuid; v_off boolean := p ? 'offline_sold_at'; v_sold timestamptz; v_adjusted boolean := false; v_old public.orders;
begin
  select * into u from public.units where id = (p->>'unit_id')::uuid;
  if not found or not private.can_access_unit(u.id) or not private.has_role(u.tenant_id, array['owner','manager','cashier']::public.member_role[]) then
    raise exception 'Sem permissão.' using errcode = '42501'; end if;

  -- reenvio da mesma venda (resposta perdida ou fila do aparelho): devolve a venda já registrada
  if nullif(p->>'client_ref', '') is not null then
    begin v_ref := (p->>'client_ref')::uuid;
    exception when others then raise exception 'Identificador da venda inválido.'; end;
    perform pg_advisory_xact_lock(hashtextextended(u.id::text || v_ref::text, 0));
    select * into v_old from public.orders where unit_id = u.id and client_ref = v_ref;
    if found then
      return jsonb_build_object('order_id', v_old.id, 'number', v_old.number, 'total_cents', v_old.total_cents,
        'change_cents', 0, 'duplicate', true);
    end if;
  end if;

  if v_off then
    if v_ref is null then raise exception 'Venda offline sem identificador.'; end if;
    begin v_sold := (p->>'offline_sold_at')::timestamptz;
    exception when others then raise exception 'Data da venda offline inválida.'; end;
    if v_sold is null or v_sold < now() - interval '7 days' or v_sold > now() + interval '10 minutes' then
      raise exception 'Data da venda offline inválida (mais de 7 dias ou no futuro).'; end if;
    v_sold := least(v_sold, now());
    if exists (select 1 from jsonb_array_elements(coalesce(p->'payments', '[]'::jsonb)) x where x->>'method' = 'credit_account') then
      raise exception 'Fiado não pode ser vendido sem internet.'; end if;
    -- vai para o caixa em que a venda foi feita, se ainda estiver aberto; senão, para o caixa aberto agora
    select id into s from public.cash_sessions where id = (nullif(p->>'cash_session_id', ''))::uuid and unit_id = u.id and status = 'open';
    s := coalesce(s, private.open_session(u.id));
    if s is null then raise exception 'Abra o caixa para enviar as vendas feitas sem internet.'; end if;
  else
    s := private.open_session(u.id);
    if s is null then raise exception 'Abra o caixa antes de vender.'; end if;
  end if;

  if coalesce(p->'payments'->0->>'method', '') not in ('cash','pix','credit_card','debit_card','voucher','credit_account') then
    raise exception 'Informe a forma de pagamento.'; end if;

  if v_off then
    -- preço atual; se não bate com o cobrado (ou o item saiu do cardápio), vale o que o cliente pagou
    begin q := private.price_items(u.id, p->'items', 'counter');
    exception when others then q := null; end;
    if q is null or (q->>'subtotal_cents')::int <> (p->>'subtotal_cents')::int then
      q := private.pos_snapshot_items(u.tenant_id, p->'snapshot');
      v_adjusted := true;
    end if;
  else
    q := private.price_items(u.id, p->'items', 'counter');
  end if;
  v_sub := (q->>'subtotal_cents')::int;

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

  -- venda offline nasce "pronta" (a cozinha já trabalhou pelo cupom): não imprime de novo nem aparece no KDS;
  -- o estoque baixa na entrada dos itens e a conclusão logo abaixo dispara fidelidade e demais rotinas
  insert into public.orders (tenant_id, unit_id, number, channel, type, status, customer_id, customer_name, customer_phone,
    subtotal_cents, discount_cents, total_cents, payment_method, payment_status, notes, accepted_at, paid_at, cash_session_id,
    client_ref, offline_sold_at, created_at, ready_at)
  values (u.tenant_id, u.id, v_n, 'counter', case when p->>'type' = 'dine_in' then 'dine_in'::public.order_type else 'pickup'::public.order_type end,
    case when v_off then 'ready'::public.order_status else 'preparing'::public.order_status end,
    v_cust, v_name, coalesce(nullif(v_phone, ''), '00000000000'), v_sub, v_disc, v_total,
    (p->'payments'->0->>'method')::public.payment_method, 'paid', left(nullif(trim(p->>'notes'), ''), 500),
    coalesce(v_sold, now()), coalesce(v_sold, now()), s, v_ref, v_sold, coalesce(v_sold, now()), v_sold)
  returning id into v_order;
  perform private.insert_items(u.tenant_id, v_order, q->'items');
  v_change := private.register_payments(u.tenant_id, s, v_total, p->'payments', v_order, null, v_cust);

  if v_off then
    insert into public.order_events (tenant_id, order_id, to_status, note, actor_id) values (u.tenant_id, v_order, 'ready',
      'Venda no balcão feita sem internet às ' || to_char(v_sold at time zone 'America/Sao_Paulo', 'DD/MM HH24:MI')
      || ' (' || upper(left(replace(v_ref::text, '-', ''), 6)) || '), enviada quando a conexão voltou', auth.uid());
    update public.orders set status = 'completed', completed_at = v_sold where id = v_order;
    insert into public.order_events (tenant_id, order_id, from_status, to_status, note, actor_id)
    values (u.tenant_id, v_order, 'ready', 'completed', 'Concluído (venda offline)', auth.uid());
    insert into public.audit_logs (tenant_id, actor_id, action, entity, entity_id, after, ip)
    values (u.tenant_id, auth.uid(), 'offline_sale', 'orders', v_order::text,
      jsonb_build_object('sold_at', v_sold, 'total_cents', v_total, 'price_adjusted', v_adjusted), private.request_ip());
  else
    insert into public.order_events (tenant_id, order_id, to_status, note, actor_id) values (u.tenant_id, v_order, 'preparing', 'Venda no balcão (PDV)', auth.uid());
  end if;
  if v_disc > 0 then
    insert into public.audit_logs (tenant_id, actor_id, action, entity, entity_id, after, ip)
    values (u.tenant_id, auth.uid(), 'discount', 'orders', v_order::text, jsonb_build_object('discount_cents', v_disc, 'subtotal_cents', v_sub), private.request_ip());
  end if;
  return jsonb_build_object('order_id', v_order, 'number', v_n, 'total_cents', v_total, 'change_cents', v_change,
    'offline', v_off, 'price_adjusted', v_adjusted);
end $$;
