-- Teste funcional ponta a ponta (rodar após run_local.sh). Falha com exceção se algo quebrar.
\set ON_ERROR_STOP 1
insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111','dono@a.com'),
  ('22222222-2222-2222-2222-222222222222','dono@b.com');

set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select public.create_tenant('Bella Massa Ltda','Bella Massa Pizzaria','bella-massa') as t \gset
-- configura loja: sempre aberta, localização, pix
update public.units set is_open_override = true, lat = -19.93, lng = -43.94, pix_key = 'pix@bella.com',
  pix_merchant_name = 'BELLA MASSA', pix_merchant_city = 'BELO HORIZONTE',
  accepted_payments = array['pix','cash','card_on_delivery']::payment_method[] where slug = 'bella-massa';
insert into public.delivery_zones (tenant_id, unit_id, name, kind, neighborhoods, fee_cents, free_above_cents)
  select tenant_id, id, 'Savassi', 'neighborhood', array['Savassi','Funcionários'], 700, 10000 from public.units where slug='bella-massa';
insert into public.coupons (tenant_id, code, kind, value, min_order_cents)
  select tenant_id, 'BEMVINDO10', 'percent', 10, 0 from public.units where slug='bella-massa';

select set_config('test.a_tenant', tenant_id::text, false), set_config('test.a_cat', (select id::text from public.categories limit 1), false)
  from public.units where slug='bella-massa';
-- loja B (outro tenant)
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select public.create_tenant('Outra','Outra Loja','outra-loja');
do $$ begin
  if (select count(*) from public.products) <> 1 then raise exception 'VAZAMENTO: tenant B vê produtos de A'; end if;
  if exists (select 1 from public.units where slug='bella-massa') then raise exception 'VAZAMENTO units'; end if;
end $$;
-- tenant B tenta inserir produto no tenant A
do $$ begin
  begin
    insert into public.products (tenant_id, category_id, name, price_cents)
    values (current_setting('test.a_tenant')::uuid, current_setting('test.a_cat')::uuid, 'hack', 1);
    raise exception 'FALHA: insert cruzado permitido';
  exception when others then
    if sqlerrm like 'FALHA%' then raise; end if;
  end;
end $$;

-- cliente anônimo
reset request.jwt.claim.sub;
set role anon;
do $$ declare s jsonb; pid uuid; oid uuid; q jsonb; r jsonb; tok text;
begin
  s := public.get_store('bella-massa');
  if s is null then raise exception 'get_store nulo'; end if;
  pid := (s->'menu'->0->'products'->0->>'id')::uuid;
  oid := (s->'menu'->0->'products'->0->'option_groups'->0->'options'->0->>'id')::uuid;
  -- cotação: 2x produto (29,90) + queijo (4,00) = 67,80; bairro Funcionários taxa 7,00; cupom 10% = 6,78
  q := public.quote_order(jsonb_build_object('slug','bella-massa','type','delivery','payment_method','cash',
        'customer', jsonb_build_object('name','Ana','phone','(31) 98877-1122'),
        'address', jsonb_build_object('street','Rua X','number','10','neighborhood','funcionarios'),
        'coupon_code','bemvindo10',
        'items', jsonb_build_array(jsonb_build_object('product_id',pid,'quantity',2,
                 'options', jsonb_build_array(jsonb_build_object('option_id',oid))))));
  raise notice 'quote %', q;
  if (q->>'subtotal_cents')::int <> 6780 or (q->>'delivery_fee_cents')::int <> 700
     or (q->>'discount_cents')::int <> 678 or (q->>'total_cents')::int <> 6802 then
    raise exception 'cálculo errado: %', q; end if;
  -- tentativa de manipular preço é ignorada (servidor recalcula)
  r := public.place_order(jsonb_build_object('slug','bella-massa','type','pickup','payment_method','pix',
        'customer', jsonb_build_object('name','Ana Paula','phone','31988771122'),
        'items', jsonb_build_array(jsonb_build_object('product_id',pid,'quantity',1,'unit_price_cents',1))));
  if (r->>'total_cents')::int <> 2990 or r->>'status' <> 'awaiting_payment' then raise exception 'place errado %', r; end if;
  tok := r->>'token';
  if public.get_order_by_token(tok)->'pix'->>'key' <> 'pix@bella.com' then raise exception 'pix ausente'; end if;
  if public.get_order_by_token('x') is not null then raise exception 'token inválido retornou'; end if;
  -- opção de outro produto/grupo é rejeitada
  begin
    perform public.place_order(jsonb_build_object('slug','bella-massa','type','pickup','payment_method','cash',
        'customer', jsonb_build_object('name','Z','phone','31999999999'),
        'items', jsonb_build_array(jsonb_build_object('product_id',pid,'quantity',1,
           'options', jsonb_build_array(jsonb_build_object('option_id', gen_random_uuid()))))));
    raise exception 'FALHA opção inválida aceita';
  exception when others then if sqlerrm like 'FALHA%' then raise; end if; end;
  -- bairro fora da área
  begin
    perform public.quote_order(jsonb_build_object('slug','bella-massa','type','delivery','payment_method','cash',
        'customer', jsonb_build_object('name','Z','phone','31999999999'),
        'address', jsonb_build_object('street','R','neighborhood','Lugar Nenhum'),
        'items', jsonb_build_array(jsonb_build_object('product_id',pid,'quantity',1))));
    raise exception 'FALHA área';
  exception when others then if sqlerrm like 'FALHA%' then raise; end if; end;
  -- raio: ponto a ~1 km cai na zona de 3 km
  q := public.quote_order(jsonb_build_object('slug','bella-massa','type','delivery','payment_method','cash',
        'customer', jsonb_build_object('name','Z','phone','31999999999'),
        'address', jsonb_build_object('street','R','neighborhood','?','lat',-19.935,'lng',-43.945),
        'items', jsonb_build_array(jsonb_build_object('product_id',pid,'quantity',1))));
  if (q->>'delivery_fee_cents')::int <> 500 then raise exception 'raio errado %', q; end if;
end $$;
do $$ begin
  begin perform count(*) from public.orders; raise exception 'FALHA anon leu orders';
  exception when insufficient_privilege then null; end;
end $$;

-- dono A confirma Pix e avança status
reset role; set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
do $$ declare oid uuid; begin
  select id into oid from public.orders limit 1;
  perform public.confirm_payment(oid);
  perform public.set_order_status(oid, 'preparing');
  begin perform public.set_order_status(oid, 'dispatched'); raise exception 'FALHA transição';
  exception when others then if sqlerrm like 'FALHA%' then raise; end if; end;
  perform public.set_order_status(oid, 'ready');
  perform public.set_order_status(oid, 'awaiting_pickup');
  perform public.set_order_status(oid, 'completed');
  if (select orders_count from public.customers where phone='31988771122') <> 1 then raise exception 'crm'; end if;
  raise notice 'dashboard %', public.dashboard_stats((select unit_id from public.orders where id=oid), now()-interval '1 day', now()+interval '1 hour');
end $$;
-- B não consegue mexer no pedido de A
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
do $$ begin
  begin perform public.set_order_status((select id from public.orders limit 1), 'cancelled', 'x');
  exception when others then return; end;
  -- B não enxerga, então o select retorna null -> deve dar erro "não encontrado"
  raise exception 'FALHA B alterou pedido de A';
end $$;
reset role;
select count(*) as audit_rows from public.audit_logs;
select 'TODOS OS TESTES PASSARAM' as resultado;
-- 2FA: dono A ativa TOTP; sessão aal1 perde acesso, aal2 recupera
insert into auth.mfa_factors (user_id, status) values ('11111111-1111-1111-1111-111111111111','verified');
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
set request.jwt.claims = '{"aal":"aal1"}';
do $$ begin if (select count(*) from public.products) <> 0 then raise exception 'FALHA: aal1 acessou com 2FA ativo'; end if; end $$;
set request.jwt.claims = '{"aal":"aal2"}';
do $$ begin if (select count(*) from public.products) = 0 then raise exception 'FALHA: aal2 bloqueado'; end if; end $$;
reset role;
select '2FA OK' as resultado;
-- ===== Marketplaces (Open Delivery) =====
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
set request.jwt.claims = '{"aal":"aal2"}';
do $$ declare r jsonb; u uuid; begin
  select id into u from public.units where slug = 'bella-massa';
  r := public.save_marketplace_connection(u, '99food', '99Food Savassi', 'app-99', 'cli-1', 'segredo-super', 'https://api.99food.test', 'https://api.99food.test', true, false, true);
  if r->>'api_key' is null or length(r->>'api_key') <> 48 then raise exception 'FALHA api_key %', r; end if;
  if exists (select 1 from public.marketplace_connections where client_secret_id is null) then raise exception 'FALHA vault'; end if;
  perform set_config('test.conn', r->>'id', false);
end $$;
-- B não vê a conexão de A
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
do $$ begin if exists (select 1 from public.marketplace_connections) then raise exception 'FALHA vazamento conexões'; end if; end $$;
reset role;
-- Edge Function (service_role) ingere um pedido no formato Open Delivery
set role service_role;
do $$ declare oid uuid; o public.orders; c uuid := current_setting('test.conn')::uuid; begin
  if public.od_connection_secret(c) <> 'segredo-super' then raise exception 'FALHA segredo'; end if;
  oid := public.od_ingest_order(c, '{
    "id":"ext-123","displayId":"4821","type":"DELIVERY","createdAt":"2026-11-10T20:00:00Z","sendPreparing":true,"sendDelivered":true,
    "customer":{"id":"c1","name":"João Marketplace","phone":{"number":"+55 31 99999-0000"},"ordersCountOnMerchant":1},
    "items":[{"id":"i1","name":"Pizza G","externalCode":"x","unit":"UN","quantity":2,"unitPrice":{"value":50,"currency":"BRL"},"totalPrice":{"value":100,"currency":"BRL"},
              "options":[{"id":"o1","name":"Borda","externalCode":"b","unit":"UN","quantity":1,"unitPrice":{"value":5,"currency":"BRL"},"totalPrice":{"value":5,"currency":"BRL"}}]}],
    "otherFees":[{"name":"Entrega","type":"DELIVERY_FEE","receivedBy":"MERCHANT","price":{"value":7,"currency":"BRL"}}],
    "total":{"itemsPrice":{"value":100,"currency":"BRL"},"otherFees":{"value":7,"currency":"BRL"},"discount":{"value":0,"currency":"BRL"},"orderAmount":{"value":107,"currency":"BRL"}},
    "payments":{"prepaid":0,"pending":107,"methods":[{"value":107,"currency":"BRL","type":"PENDING","method":"CASH","changeFor":150}]},
    "delivery":{"deliveredBy":"MERCHANT","deliveryAddress":{"country":"BR","state":"MG","city":"BH","district":"Savassi","street":"Rua X","number":"1","formattedAddress":"Rua X, 1","postalCode":"30000000","coordinates":{"latitude":-19.9,"longitude":-43.9}},"estimatedDeliveryDateTime":"2026-11-10T20:45:00Z"}
  }'::jsonb);
  if public.od_ingest_order(c, '{"id":"ext-123"}'::jsonb) <> oid then raise exception 'FALHA idempotência'; end if;
  select * into o from public.orders where id = oid;
  if o.channel <> '99food' or o.total_cents <> 10700 or o.delivery_fee_cents <> 700 or o.payment_method <> 'cash'
     or o.change_for_cents <> 15000 or o.status <> 'pending' or o.customer_phone <> '5531999990000' then raise exception 'FALHA mapeamento %', row_to_json(o); end if;
  perform set_config('test.mkt_order', oid::text, false);
end $$;
reset role;
-- loja aceita no painel -> fila "confirm" + "preparing"; pronto -> readyForPickup
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
do $$ declare oid uuid := current_setting('test.mkt_order')::uuid; begin
  perform public.set_order_status(oid, 'preparing');
  perform public.set_order_status(oid, 'ready');
end $$;
reset role;
do $$ begin
  if (select string_agg(action, ',' order by id) from public.integration_outbox) <> 'confirm,preparing,readyForPickup' then
    raise exception 'FALHA outbox: %', (select string_agg(action, ',' order by id) from public.integration_outbox); end if;
end $$;
-- marketplace pede cancelamento -> loja nega
set role service_role;
select public.od_apply_event(current_setting('test.conn')::uuid, 'ext-123', 'ORDER_CANCELLATION_REQUEST');
reset role; set role authenticated;
select public.respond_marketplace_cancellation(current_setting('test.mkt_order')::uuid, false);
reset role;
do $$ begin
  if (select action from public.integration_outbox order by id desc limit 1) <> 'denyCancellation' then raise exception 'FALHA deny'; end if;
end $$;
-- marketplace conclui
set role service_role;
select public.od_apply_event(current_setting('test.conn')::uuid, 'ext-123', 'CONCLUDED');
reset role;
do $$ begin if (select status from public.orders where id = current_setting('test.mkt_order')::uuid) <> 'completed' then raise exception 'FALHA concluir'; end if; end $$;
-- anon/authenticated não chamam funções internas
set role authenticated;
do $$ begin
  begin perform public.od_connection_secret(current_setting('test.conn')::uuid); raise exception 'FALHA segredo exposto';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
select 'MARKETPLACES OK' as resultado;
-- Exclusão completa de um tenant (encerramento de conta) funciona
delete from public.tenants where id = (select tenant_id from public.units where slug = 'outra-loja');
do $$ begin if exists (select 1 from public.units where slug = 'outra-loja') then raise exception 'FALHA exclusão tenant'; end if; end $$;
select 'EXCLUSAO OK' as resultado;
-- Super admin
insert into auth.users (id, email) values ('33333333-3333-3333-3333-333333333333','admin@x.com');
insert into public.platform_admins values ('33333333-3333-3333-3333-333333333333');
set role authenticated;
set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
set request.jwt.claims = '{"aal":"aal1"}';
do $$ declare r jsonb; t uuid; begin
  r := public.admin_overview();
  if (r->'totals'->>'tenants')::int < 1 then raise exception 'FALHA overview'; end if;
  t := (r->'tenants'->0->>'id')::uuid;
  perform public.admin_set_tenant(t, 'completo', 'active');
end $$;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
do $$ begin
  begin perform public.admin_overview(); raise exception 'FALHA: lojista acessou admin';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
select 'ADMIN OK' as resultado;
-- Equipe: convite para quem já tem conta e para quem ainda não tem
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
set request.jwt.claims = '{"aal":"aal2"}';
do $$ declare t uuid := current_setting('test.a_tenant')::uuid; begin
  if public.invite_member(t, 'dono@b.com', 'cashier') <> 'added' then raise exception 'FALHA add'; end if;
  if public.invite_member(t, 'Novo@Equipe.com', 'kitchen') <> 'invited' then raise exception 'FALHA invite'; end if;
  if jsonb_array_length(public.list_members(t)) <> 2 then raise exception 'FALHA list'; end if;
  begin perform public.invite_member(t, 'x@y.com', 'owner'); raise exception 'FALHA owner';
  exception when others then if sqlerrm like 'FALHA%' then raise; end if; end;
end $$;
reset role;
insert into auth.users (id, email) values ('44444444-4444-4444-4444-444444444444','novo@equipe.com');
set role authenticated;
set request.jwt.claim.sub = '44444444-4444-4444-4444-444444444444';
set request.jwt.claims = '{"aal":"aal1"}';
do $$ begin
  if public.accept_invitations() <> 1 then raise exception 'FALHA accept'; end if;
  if (select role from public.memberships where user_id = auth.uid()) <> 'kitchen' then raise exception 'FALHA role'; end if;
  begin perform public.invite_member(current_setting('test.a_tenant')::uuid, 'z@z.com', 'waiter'); raise exception 'FALHA cozinha convidou';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
select 'EQUIPE OK' as resultado;
-- ===== Fase 2: caixa, PDV, mesas, KDS =====
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
set request.jwt.claims = '{"aal":"aal2"}';
do $$ declare u uuid; pid uuid; r jsonb; tb uuid; tab uuid; it record; st jsonb;
begin
  select id into u from public.units where slug = 'bella-massa';
  select id into pid from public.products where tenant_id = current_setting('test.a_tenant')::uuid limit 1;  -- 29,90
  begin perform public.pos_sale(jsonb_build_object('unit_id', u, 'items', jsonb_build_array(jsonb_build_object('product_id', pid)),
      'payments', jsonb_build_array(jsonb_build_object('method','cash','amount_cents',5000)))); raise exception 'FALHA vendeu sem caixa';
  exception when others then if sqlerrm like 'FALHA%' then raise; end if; end;
  perform public.cash_open(u, 10000);
  -- venda: 2x 29,90 = 59,80; desconto 4,80 => 55,00; paga 20 pix + 50 dinheiro => troco 15
  r := public.pos_sale(jsonb_build_object('unit_id', u, 'discount_cents', 480,
      'items', jsonb_build_array(jsonb_build_object('product_id', pid, 'quantity', 2)),
      'payments', jsonb_build_array(jsonb_build_object('method','pix','amount_cents',2000), jsonb_build_object('method','cash','amount_cents',5000))));
  if (r->>'total_cents')::int <> 5500 or (r->>'change_cents')::int <> 1500 then raise exception 'FALHA pdv %', r; end if;
  begin perform public.pos_sale(jsonb_build_object('unit_id', u, 'items', jsonb_build_array(jsonb_build_object('product_id', pid)),
      'payments', jsonb_build_array(jsonb_build_object('method','pix','amount_cents',1000)))); raise exception 'FALHA pagou a menos';
  exception when others then if sqlerrm like 'FALHA%' then raise; end if; end;
  perform public.cash_move(u, 'withdrawal', 3000, 'Sangria teste');
  -- mesa
  insert into public.dining_tables (tenant_id, unit_id, name) values (current_setting('test.a_tenant')::uuid, u, '07') returning id into tb;
  tab := public.tab_open(u, tb, '', 2, 'João');
  perform public.tab_add_items(tab, jsonb_build_array(jsonb_build_object('product_id', pid, 'quantity', 1)));
  perform public.tab_add_items(tab, jsonb_build_array(jsonb_build_object('product_id', pid, 'quantity', 1)));
  -- KDS: conclui os itens do primeiro pedido da mesa => pedido fica pronto
  for it in select i.id from public.order_items i join public.orders o on o.id = i.order_id where o.tab_id = tab order by o.number limit 1 loop
    perform public.kds_set_item(it.id, 'preparing'); perform public.kds_set_item(it.id, 'done');
  end loop;
  if (select count(*) from public.orders where tab_id = tab and status = 'ready') <> 1 then raise exception 'FALHA kds'; end if;
  begin perform public.cash_close(u, '{"cash":0}'::jsonb, ''); raise exception 'FALHA fechou com mesa aberta';
  exception when others then if sqlerrm like 'FALHA%' then raise; end if; end;
  -- fecha a conta: 59,80 + 10% (5,98) = 65,78 no crédito
  r := public.tab_close(tab, jsonb_build_array(jsonb_build_object('method','credit_card','amount_cents',6578)), true, 0);
  if (r->>'total_cents')::int <> 6578 then raise exception 'FALHA tab %', r; end if;
  if exists (select 1 from public.orders where tab_id = tab and (status <> 'completed' or payment_status <> 'paid')) then raise exception 'FALHA pedidos da mesa'; end if;
  st := public.cash_status(u)->'expected';
  -- dinheiro: 100 fundo + 35 (50 - 15 troco) - 30 sangria = 105; pix 20; crédito 65,78
  if (st->>'cash')::int <> 10500 or (st->>'pix')::int <> 2000 or (st->>'credit_card')::int <> 6578 then raise exception 'FALHA caixa %', st; end if;
  r := public.cash_close(u, '{"cash":10000,"pix":2000,"credit_card":6578}'::jsonb, 'faltou 5');
  if (r->>'difference_cents')::int <> -500 then raise exception 'FALHA diferença %', r; end if;
end $$;
-- cozinha não abre caixa nem vende; garçom (não há) — cozinha pode marcar item
set request.jwt.claim.sub = '44444444-4444-4444-4444-444444444444';
set request.jwt.claims = '{"aal":"aal1"}';
do $$ begin
  begin perform public.cash_open((select id from public.units where slug='bella-massa'), 0); raise exception 'FALHA cozinha abriu caixa';
  exception when insufficient_privilege then null; end;
  perform public.kds_set_item((select id from public.order_items limit 1), 'done');
end $$;
reset role;
select 'FASE2 OK' as resultado;
-- ===== Fidelidade e avaliações =====
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
set request.jwt.claims = '{"aal":"aal2"}';
insert into public.loyalty_settings (tenant_id, cashback_enabled, cashback_pct, cashback_max_use_pct, points_enabled, points_per_real)
  values (current_setting('test.a_tenant')::uuid, true, 10, 50, true, 1);
insert into public.rewards (tenant_id, name, points_cost) values (current_setting('test.a_tenant')::uuid, 'Refri grátis', 20);
reset role;
do $$ declare pid uuid; r jsonb; q jsonb; tok text; dev text; oid uuid; base jsonb; cust uuid;
begin
  select id into pid from public.products where tenant_id = current_setting('test.a_tenant')::uuid limit 1; -- 29,90
  base := jsonb_build_object('slug','bella-massa','type','pickup','payment_method','cash',
          'customer', jsonb_build_object('name','Fiel Cliente','phone','31977770001'),
          'items', jsonb_build_array(jsonb_build_object('product_id', pid, 'quantity', 1)));
  set local role anon;
  r := public.place_order(base); dev := r->>'device_token'; oid := (r->>'order_id')::uuid; tok := r->>'token';
  if dev is null or (r->>'cashback_used_cents')::int <> 0 then raise exception 'FALHA 1º pedido %', r; end if;
  reset role;
  -- loja conclui => +10% cashback (2,99) e 29 pontos
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
  perform public.set_order_status(oid, 'preparing'); perform public.set_order_status(oid, 'ready'); perform public.set_order_status(oid, 'completed');
  reset role;
  select id into cust from public.customers where phone = '31977770001';
  if (select cashback_cents from public.customers where id = cust) <> 299 or (select points_balance from public.customers where id = cust) <> 29 then
    raise exception 'FALHA crédito: % / %', (select cashback_cents from public.customers where id = cust), (select points_balance from public.customers where id = cust); end if;
  set local role anon;
  -- sem token do aparelho: não usa cashback (outra pessoa digitando o telefone)
  q := public.quote_order(base || jsonb_build_object('use_cashback', true));
  if (q->>'cashback_applied')::int <> 0 or (q->>'cashback_available')::int <> 0 then raise exception 'FALHA: usou cashback sem aparelho conhecido %', q; end if;
  if (public.loyalty_info('bella-massa', '31977770001', 'token-falso')->>'cashback_cents') is not null then raise exception 'FALHA: saldo vazou'; end if;
  -- com token: usa 2,99 (limite 50% de 29,90 = 14,95) => total 26,91
  q := public.quote_order(base || jsonb_build_object('use_cashback', true, 'device_token', dev));
  if (q->>'cashback_applied')::int <> 299 or (q->>'total_cents')::int <> 2691 then raise exception 'FALHA cotação %', q; end if;
  r := public.place_order(base || jsonb_build_object('use_cashback', true, 'device_token', dev, 'change_for_cents', 3000));
  if (r->>'total_cents')::int <> 2691 then raise exception 'FALHA pedido cashback %', r; end if;
  reset role;
  if (select cashback_cents from public.customers where id = cust) <> 0 then raise exception 'FALHA débito'; end if;
  -- cancelamento devolve o cashback usado
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
  perform public.set_order_status((r->>'order_id')::uuid, 'cancelled', 'teste');
  perform public.redeem_reward(cust, (select id from public.rewards limit 1));
  perform public.loyalty_adjust(cust, 'cashback', 500, 'cortesia');
  reset role;
  if (select cashback_cents from public.customers where id = cust) <> 799 or (select points_balance from public.customers where id = cust) <> 9 then
    raise exception 'FALHA final: % / %', (select cashback_cents from public.customers where id = cust), (select points_balance from public.customers where id = cust); end if;
  -- expiração
  update public.loyalty_ledger set expires_at = now() - interval '1 day' where customer_id = cust and amount > 0 and kind = 'cashback';
  perform private.loyalty_expire();
  if (select cashback_cents from public.customers where id = cust) <> 0 then raise exception 'FALHA expiração: %', (select cashback_cents from public.customers where id = cust); end if;
  -- avaliação pelo token do pedido concluído
  set local role anon;
  if not (public.order_extras(tok)->>'can_review')::boolean then raise exception 'FALHA can_review'; end if;
  perform public.submit_review(tok, 5, 'Ótimo!');
  begin perform public.submit_review(tok, 1, 'de novo'); raise exception 'FALHA avaliou 2x';
  exception when others then if sqlerrm like 'FALHA%' then raise; end if; end;
  if (public.store_reviews('bella-massa')->>'count')::int <> 1 then raise exception 'FALHA store_reviews'; end if;
  reset role;
end $$;
select 'FIDELIDADE OK' as resultado;
-- ===== Estoque, Financeiro e Fiado =====
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
set request.jwt.claims = '{"aal":"aal2"}';
do $$ declare t uuid := current_setting('test.a_tenant')::uuid; u uuid; pid uuid; si uuid; r jsonb; cust uuid; f jsonb; oid uuid; tb uuid; tab uuid;
begin
  select id into u from public.units where slug = 'bella-massa';
  select id into pid from public.products where tenant_id = t limit 1;  -- 29,90
  -- insumo + compra: 10 kg por R$ 200 => custo médio 2000/kg; depois 10 kg por R$ 300 => 2500/kg
  insert into public.stock_items (tenant_id, unit_id, name, unit, min_qty) values (t, u, 'Mussarela', 'kg', 5) returning id into si;
  begin update public.stock_items set qty = 999 where id = si; raise exception 'FALHA editou saldo direto';
  exception when insufficient_privilege then null; end;
  perform public.stock_move(si, 'purchase', 10, 20000, null, true);
  r := public.stock_move(si, 'purchase', 10, 30000, 'NF 12', false);
  if (r->>'qty')::numeric <> 20 or (r->>'cost_cents')::numeric <> 2500 then raise exception 'FALHA custo médio %', r; end if;
  if (select count(*) from public.fin_entries where category = 'Compras de insumos' and amount_cents = 20000 and paid_at is not null) <> 1 then
    raise exception 'FALHA despesa da compra'; end if;
  begin perform public.stock_move(si, 'loss', 1, null, '', false); raise exception 'FALHA perda sem motivo';
  exception when others then if sqlerrm like 'FALHA%' then raise; end if; end;
  -- ficha técnica: 0,2 kg por pizza; venda de 3 no PDV baixa 0,6
  insert into public.product_recipes (product_id, stock_item_id, tenant_id, qty) values (pid, si, t, 0.2);
  if not (public.cash_status(u)->>'open')::boolean then perform public.cash_open(u, 0); end if;
  r := public.pos_sale(jsonb_build_object('unit_id', u, 'items', jsonb_build_array(jsonb_build_object('product_id', pid, 'quantity', 3)),
       'payments', jsonb_build_array(jsonb_build_object('method','pix','amount_cents',8970))));
  if (select qty from public.stock_items where id = si) <> 19.4 then raise exception 'FALHA baixa: %', (select qty from public.stock_items where id = si); end if;
  -- cancelar devolve
  oid := (r->>'order_id')::uuid;
  perform public.set_order_status(oid, 'cancelled', 'teste estoque');
  if (select qty from public.stock_items where id = si) <> 20 then raise exception 'FALHA devolução: %', (select qty from public.stock_items where id = si); end if;
  -- contagem
  perform public.stock_move(si, 'adjust', 18.5, null, 'inventário', false);
  if (select qty from public.stock_items where id = si) <> 18.5 then raise exception 'FALHA contagem'; end if;

  -- fiado: sem cliente / sem limite / acima do limite falham
  begin perform public.pos_sale(jsonb_build_object('unit_id', u, 'items', jsonb_build_array(jsonb_build_object('product_id', pid)),
       'payments', jsonb_build_array(jsonb_build_object('method','credit_account','amount_cents',2990)))); raise exception 'FALHA fiado sem cliente';
  exception when others then if sqlerrm like 'FALHA%' then raise; end if; end;
  begin perform public.pos_sale(jsonb_build_object('unit_id', u, 'customer', jsonb_build_object('name','Zé Fiado','phone','31966660001'),
       'items', jsonb_build_array(jsonb_build_object('product_id', pid)),
       'payments', jsonb_build_array(jsonb_build_object('method','credit_account','amount_cents',2990)))); raise exception 'FALHA fiado sem limite';
  exception when others then if sqlerrm like 'FALHA%' then raise; end if; end;
  insert into public.customers (tenant_id, name, phone) values (t, 'Zé Fiado', '31966660001') on conflict (tenant_id, phone) do nothing;
  select id into cust from public.customers where tenant_id = t and phone = '31966660001';
  begin update public.customers set credit_limit_cents = 999999, cashback_cents = 999999 where id = cust; raise exception 'FALHA editou saldos direto';
  exception when insufficient_privilege then null; end;
  perform public.credit_set_limit(cust, 5000);
  r := public.pos_sale(jsonb_build_object('unit_id', u, 'customer', jsonb_build_object('name','Zé Fiado','phone','31966660001'),
       'items', jsonb_build_array(jsonb_build_object('product_id', pid)),
       'payments', jsonb_build_array(jsonb_build_object('method','credit_account','amount_cents',2990))));
  if (select credit_balance_cents from public.customers where id = cust) <> 2990 then raise exception 'FALHA saldo fiado'; end if;
  begin perform public.pos_sale(jsonb_build_object('unit_id', u, 'customer', jsonb_build_object('name','Zé Fiado','phone','31966660001'),
       'items', jsonb_build_array(jsonb_build_object('product_id', pid)),
       'payments', jsonb_build_array(jsonb_build_object('method','credit_account','amount_cents',2990)))); raise exception 'FALHA estourou limite';
  exception when others then if sqlerrm like 'FALHA%' then raise; end if; end;
  -- fiado não entra no dinheiro esperado; recebimento em dinheiro entra
  f := public.cash_status(u)->'expected';
  if (f->>'credit_account')::int <> 2990 then raise exception 'FALHA caixa fiado %', f; end if;
  begin perform public.credit_pay(cust, 5000, 'cash', u, null); raise exception 'FALHA recebeu a mais';
  exception when others then if sqlerrm like 'FALHA%' then raise; end if; end;
  perform public.credit_pay(cust, 1000, 'cash', u, null);
  if ((public.cash_status(u)->'expected'->>'cash')::int - (f->>'cash')::int) <> 1000 then raise exception 'FALHA recebimento no caixa'; end if;
  if (select credit_balance_cents from public.customers where id = cust) <> 1990 then raise exception 'FALHA saldo após receber'; end if;
  -- cancelar a venda fiada estorna o que ainda é devido por ela (2990), sem deixar saldo negativo por conta do recebimento
  perform public.credit_adjust(cust, 1000, 'reabre para teste');
  perform public.set_order_status((r->>'order_id')::uuid, 'cancelled', 'teste fiado');
  if (select credit_balance_cents from public.customers where id = cust) <> 0 then
    raise exception 'FALHA estorno fiado: %', (select credit_balance_cents from public.customers where id = cust); end if;
  -- mesa fechada no fiado
  select id into tb from public.dining_tables where unit_id = u limit 1;
  tab := public.tab_open(u, tb, 'fiado', 1, null);
  perform public.tab_add_items(tab, jsonb_build_array(jsonb_build_object('product_id', pid)));
  perform public.tab_close(tab, jsonb_build_array(jsonb_build_object('method','credit_account','amount_cents',2990)), false, 0, cust);
  if (select credit_balance_cents from public.customers where id = cust) <> 2990 then raise exception 'FALHA mesa fiado'; end if;

  -- financeiro
  insert into public.fin_entries (tenant_id, unit_id, kind, description, category, amount_cents, due_date)
  values (t, u, 'payable', 'Aluguel', 'Aluguel', 150000, current_date - 2), (t, null, 'receivable', 'Evento', 'Eventos', 40000, current_date + 5);
  update public.fin_entries set paid_at = now(), paid_method = 'pix' where description = 'Evento';
  f := public.fin_summary(t, u, current_date - 1, current_date + 1);
  if (f->>'payable_overdue_cents')::int <> 150000 or (f->>'other_income_cents')::int <> 40000 or (f->>'expenses_cents')::int <> 20000
     or (f->>'credit_open_cents')::int <> 2990 then raise exception 'FALHA resumo %', f; end if;
  if (f->>'result_cents')::bigint <> (f->>'sales_cents')::bigint + (f->>'service_fee_cents')::bigint - (f->>'tab_discount_cents')::bigint + 40000 - 20000 then
    raise exception 'FALHA resultado %', f; end if;
  if (f->>'cmv_cents')::int <> 500 then raise exception 'FALHA cmv % (só a pizza da mesa: 0,2 kg x 25,00)', f->>'cmv_cents'; end if;
end $$;
-- cozinha não vê financeiro nem fiado, nem mexe em estoque
set request.jwt.claim.sub = '44444444-4444-4444-4444-444444444444';
set request.jwt.claims = '{"aal":"aal1"}';
do $$ begin
  if (select count(*) from public.fin_entries) <> 0 or (select count(*) from public.credit_ledger) <> 0 then raise exception 'FALHA cozinha viu financeiro'; end if;
  begin perform public.fin_summary(current_setting('test.a_tenant')::uuid, null, current_date, current_date); raise exception 'FALHA cozinha resumo';
  exception when insufficient_privilege then null; end;
  begin perform public.stock_move((select id from public.stock_items limit 1), 'adjust', 0, null, 'x', false); raise exception 'FALHA cozinha ajustou';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
select 'GESTAO OK' as resultado;
-- ===== QR Code na mesa =====
do $$ declare u uuid; tk text; pid uuid; r jsonb; info jsonb; tab uuid; o uuid;
begin
  select id into u from public.units where slug = 'bella-massa';
  select qr_token into tk from public.dining_tables where unit_id = u and name = '07';
  select id into pid from public.products where tenant_id = current_setting('test.a_tenant')::uuid limit 1;
  perform set_config('test.qr_token', tk, false);
  perform set_config('test.pid', pid::text, false);
end $$;
set role anon;
do $$ declare tk text := current_setting('test.qr_token'); pid uuid := current_setting('test.pid')::uuid; r jsonb; info jsonb;
begin
  if public.table_info('0123456789abcdef01234567') is not null then raise exception 'FALHA token falso'; end if;
  info := public.table_info(tk);
  if info->>'table' <> '07' or info->>'slug' <> 'bella-massa' then raise exception 'FALHA info %', info; end if;
  r := public.table_order(tk, jsonb_build_array(jsonb_build_object('product_id', pid, 'quantity', 2)), 'Ana', 'sem cebola');
  if r->>'status' <> 'pending' then raise exception 'FALHA status %', r; end if;
  perform public.table_call(tk, 'waiter');
  info := public.table_info(tk);
  if jsonb_array_length(info->'tab'->'orders') < 1 or info->'tab'->>'waiter_called_at' is null then raise exception 'FALHA tab %', info; end if;
  -- antiabuso: no máximo 3 pendentes
  perform public.table_order(tk, jsonb_build_array(jsonb_build_object('product_id', pid)), null, null);
  perform public.table_order(tk, jsonb_build_array(jsonb_build_object('product_id', pid)), null, null);
  begin perform public.table_order(tk, jsonb_build_array(jsonb_build_object('product_id', pid)), null, null); raise exception 'FALHA limite pendentes';
  exception when others then if sqlerrm like 'FALHA%' then raise; end if; end;
  -- preço vem do servidor: complemento inventado é recusado
  begin perform public.table_order(tk, jsonb_build_array(jsonb_build_object('product_id', pid, 'options', jsonb_build_array(jsonb_build_object('option_id', gen_random_uuid())))), null, null);
    raise exception 'FALHA opção falsa';
  exception when others then if sqlerrm like 'FALHA%' then raise; end if; end;
  -- anon não lê tabelas internas
  begin perform 1 from public.tabs; raise exception 'FALHA anon leu tabs'; exception when insufficient_privilege then null; end;
end $$;
reset role;
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
set request.jwt.claims = '{"aal":"aal2"}';
do $$ declare tb uuid; tab uuid; o record; tk2 text;
begin
  select d.id into tb from public.dining_tables d where d.qr_token = current_setting('test.qr_token');
  select id into tab from public.tabs where table_id = tb and status = 'open';
  -- não fecha com pendente
  begin perform public.tab_close(tab, jsonb_build_array(jsonb_build_object('method','pix','amount_cents',999999)), false, 0, null); raise exception 'FALHA fechou com pendente';
  exception when others then if sqlerrm like 'FALHA%' then raise; end if; end;
  for o in select id from public.orders where tab_id = tab and status = 'pending' loop
    perform public.set_order_status(o.id, 'preparing', null);
  end loop;
  perform public.tab_ack_call(tab);
  if (select waiter_called_at from public.tabs where id = tab) is not null then raise exception 'FALHA ack'; end if;
  perform public.tab_close(tab, jsonb_build_array(jsonb_build_object('method','pix','amount_cents',
    (select sum(subtotal_cents) from public.orders where tab_id = tab and status <> 'cancelled')::int)), false, 0, null);
  tk2 := public.table_qr_rotate(tb);
  if tk2 = current_setting('test.qr_token') then raise exception 'FALHA rotate'; end if;
end $$;
reset role;
set role anon;
do $$ begin
  if public.table_info(current_setting('test.qr_token')) is not null then raise exception 'FALHA token antigo ainda vale'; end if;
end $$;
reset role;
select 'QR MESA OK' as resultado;

-- ===== NFC-e =====
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
set request.jwt.claims = '{"aal":"aal2"}';
do $$ declare u uuid; pid uuid; r jsonb;
begin
  select id into u from public.units where slug = 'bella-massa';
  select id into pid from public.products where tenant_id = current_setting('test.a_tenant')::uuid limit 1;
  begin perform public.fiscal_save_settings(u, '{"enabled": true}'::jsonb, null); raise exception 'FALHA ativou sem token';
  exception when others then if sqlerrm like 'FALHA%' then raise; end if; end;
  perform public.fiscal_save_settings(u, '{"cnpj":"12.345.678/0001-95","legal_name":"Bella Massa LTDA","enabled":true,"auto_emit":true}'::jsonb, 'tok_homologacao_1234567890');
  begin perform public.fiscal_save_settings(u, '{"environment":"producao"}'::jsonb, null); raise exception 'FALHA produção sem teste';
  exception when others then if sqlerrm like 'FALHA%' then raise; end if; end;
  -- venda no PDV com desconto: 2x 29,90 = 59,80 − 9,80 = 50,00; pago 30 pix + 20 dinheiro (troco 0)
  r := public.pos_sale(jsonb_build_object('unit_id', u, 'discount_cents', 980, 'items', jsonb_build_array(jsonb_build_object('product_id', pid, 'quantity', 2)),
       'payments', jsonb_build_array(jsonb_build_object('method','pix','amount_cents',3000), jsonb_build_object('method','cash','amount_cents',2000))));
  perform set_config('test.fiscal_order', r->>'order_id', false);
  if (select count(*) from public.fiscal_documents where order_id = (r->>'order_id')::uuid and status = 'pending') <> 1 then raise exception 'FALHA emissão automática'; end if;
  begin perform public.fiscal_request((r->>'order_id')::uuid, null, null); raise exception 'FALHA duplicou nota';
  exception when others then if sqlerrm like 'FALHA%' then raise; end if; end;
  -- token não aparece para o lojista
  if has_function_privilege('public.fiscal_test_token(uuid)', 'execute') or has_function_privilege('public.fiscal_jobs(integer)', 'execute') then raise exception 'FALHA token exposto'; end if;
  begin perform 1 from public.fiscal_settings where token_secret_id is not null; exception when others then null; end;
end $$;
reset role;
-- worker (service_role)
set request.jwt.claims = '{"role":"service_role"}';
do $$ declare jobs jsonb; j jsonb; p jsonb; st text; d uuid;
begin
  jobs := public.fiscal_jobs(10);
  select x into j from jsonb_array_elements(jobs) x where (x->>'id')::uuid = (select id from public.fiscal_documents where order_id = current_setting('test.fiscal_order')::uuid);
  if j is null or j->>'token' <> 'tok_homologacao_1234567890' then raise exception 'FALHA job %', jobs; end if;
  p := j->'payload';
  if p->>'cnpj_emitente' <> '12345678000195' or jsonb_array_length(p->'items') <> 1 then raise exception 'FALHA payload %', p; end if;
  if (p->'items'->0->>'valor_bruto')::numeric <> 59.80 or (p->'items'->0->>'valor_desconto')::numeric <> 9.80 then raise exception 'FALHA valores %', p->'items'->0; end if;
  if p->'items'->0->>'descricao' not like 'NOTA FISCAL EMITIDA EM AMBIENTE DE HOMOLOGACAO%' then raise exception 'FALHA homologação'; end if;
  if (select sum((x->>'valor_pagamento')::numeric) from jsonb_array_elements(p->'formas_pagamento') x) <> 50.00 then raise exception 'FALHA pagamentos %', p->'formas_pagamento'; end if;
  if not exists (select 1 from jsonb_array_elements(p->'formas_pagamento') x where x->>'forma_pagamento' = '17') then raise exception 'FALHA código pix'; end if;
  if p->>'data_emissao' !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$' then raise exception 'FALHA data %', p->>'data_emissao'; end if;
  d := (j->>'id')::uuid;
  -- provedor fora do ar: volta para a fila
  st := public.fiscal_job_result(d, 503, '{"mensagem":"indisponível"}'::jsonb);
  if st <> 'pending' then raise exception 'FALHA retry %', st; end if;
  update public.fiscal_documents set next_attempt_at = now() where id = d;
  jobs := public.fiscal_jobs(10);
  st := public.fiscal_job_result(d, 201, '{"status":"autorizado","numero":"12","serie":"1","chave_nfe":"NFe3126","caminho_danfe":"/arquivos/danfe.html","mensagem_sefaz":"Autorizado o uso da NF-e"}'::jsonb);
  if st <> 'authorized' or (select number from public.fiscal_documents where id = d) <> '12' then raise exception 'FALHA autorizado %', st; end if;
  perform set_config('test.fiscal_doc', d::text, false);
end $$;
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
set request.jwt.claims = '{"aal":"aal2"}';
do $$ begin
  begin perform public.fiscal_cancel(current_setting('test.fiscal_doc')::uuid, 'curto'); raise exception 'FALHA justificativa curta';
  exception when others then if sqlerrm like 'FALHA%' then raise; end if; end;
  perform public.fiscal_cancel(current_setting('test.fiscal_doc')::uuid, 'Cliente desistiu da compra no balcão');
end $$;
reset role;
set request.jwt.claims = '{"role":"service_role"}';
do $$ declare jobs jsonb; st text; d uuid := current_setting('test.fiscal_doc')::uuid;
begin
  jobs := public.fiscal_jobs(10);
  if not exists (select 1 from jsonb_array_elements(jobs) x where x->>'action' = 'cancel' and (x->>'id')::uuid = d) then raise exception 'FALHA job cancel %', jobs; end if;
  st := public.fiscal_job_result(d, 200, '{"status":"cancelado","mensagem_sefaz":"Evento registrado"}'::jsonb);
  if st <> 'cancelled' then raise exception 'FALHA cancelado %', st; end if;
  -- rejeição da SEFAZ
  insert into public.fiscal_documents (tenant_id, unit_id, order_id, environment)
  select tenant_id, unit_id, id, 'homologacao' from public.orders where id = current_setting('test.fiscal_order')::uuid returning id into d;
  jobs := public.fiscal_jobs(10);
  st := public.fiscal_job_result(d, 201, '{"status":"erro_autorizacao","mensagem_sefaz":"Rejeição: NCM inexistente"}'::jsonb);
  if st <> 'rejected' then raise exception 'FALHA rejeição %', st; end if;
end $$;
set request.jwt.claims = '{"role":"anon"}';
do $$ begin
  begin perform public.fiscal_test_token(gen_random_uuid()); raise exception 'FALHA anon leu token'; exception when insufficient_privilege then null; end;
  begin perform public.fiscal_jobs(1); raise exception 'FALHA anon leu fila'; exception when insufficient_privilege then null; end;
end $$;
select 'NFCE OK' as resultado;
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
set request.jwt.claims = '{"aal":"aal2"}';
do $$ begin
  begin update public.dining_tables set qr_token = 'aaaaaaaaaaaaaaaaaaaaaaaa'; raise exception 'FALHA editou token';
  exception when insufficient_privilege then null; end;
  update public.dining_tables set area = 'Salão' where name = '07';
end $$;
reset role;
select 'TOKEN OK' as resultado;
-- ===== Pagamento online (Mercado Pago) =====
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
set request.jwt.claims = '{"aal":"aal2"}';
do $$ declare u uuid;
begin
  select id into u from public.units where slug = 'bella-massa';
  perform set_config('test.unit', u::text, false);
  begin perform public.gateway_save_settings(u, '{"enabled":true}'::jsonb, null, null); raise exception 'FALHA ativou sem credencial';
  exception when others then if sqlerrm like 'FALHA%' then raise; end if; end;
  begin perform public.gateway_save_settings(u, '{}'::jsonb, 'token-qualquer', null); raise exception 'FALHA token inválido aceito';
  exception when others then if sqlerrm like 'FALHA%' then raise; end if; end;
  perform public.gateway_save_settings(u, '{"public_key":"TEST-1234abcd-5678-efgh-9012-ijklmnopqrst","card_enabled":true,"max_installments":3}'::jsonb,
    'TEST-1234567890123456-111111-abcdefabcdefabcdefabcdefabcdef12-123456789', 'segredo-do-webhook-123456');
  begin perform public.gateway_save_settings(u, '{"enabled":true}'::jsonb, null, null); raise exception 'FALHA ativou sem teste';
  exception when others then if sqlerrm like 'FALHA%' then raise; end if; end;
end $$;
reset role;
set request.jwt.claims = '{"role":"service_role"}';
do $$ begin perform public.gateway_test_result(current_setting('test.unit')::uuid, true, 'ok'); end $$;
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
set request.jwt.claims = '{"aal":"aal2"}';
do $$ begin
  perform public.gateway_save_settings(current_setting('test.unit')::uuid, '{"enabled":true}'::jsonb, null, null);
  if not ('online_card' = any ((select accepted_payments from public.units where id = current_setting('test.unit')::uuid)::text[])) then raise exception 'FALHA online_card'; end if;
end $$;
reset role;
set role anon;
do $$ declare pid uuid := current_setting('test.pid')::uuid; r jsonb; g jsonb;
begin
  g := public.get_store('bella-massa')->'unit'->'gateway';
  if g->>'public_key' is null or (g->>'card')::boolean is not true or g ? 'token' then raise exception 'FALHA store gateway %', g; end if;
  r := public.place_order(jsonb_build_object('slug','bella-massa','type','pickup','payment_method','online_card',
        'customer', jsonb_build_object('name','Paula Cartão','phone','31944440001'),
        'items', jsonb_build_array(jsonb_build_object('product_id',pid,'quantity',1))));
  if r->>'status' <> 'awaiting_payment' then raise exception 'FALHA status cartão %', r; end if;
  perform set_config('test.gw_token', r->>'token', false);
  if public.get_order_by_token(r->>'token')->'gateway'->'config'->>'public_key' is null then raise exception 'FALHA order gateway'; end if;
  if public.get_order_by_token(r->>'token')->'pix' <> 'null'::jsonb and public.get_order_by_token(r->>'token')->>'pix' is not null then raise exception 'FALHA pix estático com gateway'; end if;
  begin perform public.gateway_context(r->>'token'); raise exception 'FALHA anon leu contexto';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
set request.jwt.claims = '{"role":"service_role"}';
do $$ declare c jsonb; gp uuid; gp2 uuid; st text; oid uuid;
begin
  c := public.gateway_context(current_setting('test.gw_token'));
  if c->>'token' not like 'TEST-%' or (c->>'total_cents')::int <> 2990 then raise exception 'FALHA contexto %', c; end if;
  oid := (c->>'order_id')::uuid;
  gp := public.gateway_begin(oid, 'card', 2990);
  -- valor diferente do pedido não confirma
  st := public.gateway_record(gp, '{"id":"9001","status":"approved","transaction_amount":1.00}'::jsonb);
  if st <> 'error' or (select payment_status from public.orders where id = oid) = 'paid' then raise exception 'FALHA valor adulterado %', st; end if;
  gp := public.gateway_begin(oid, 'card', 2990);
  st := public.gateway_record(gp, '{"id":"9002","status":"rejected","status_detail":"cc_rejected_insufficient_amount","transaction_amount":29.90}'::jsonb);
  if st <> 'rejected' then raise exception 'FALHA rejeitado %', st; end if;
  gp := public.gateway_begin(oid, 'card', 2990);
  st := public.gateway_record(gp, '{"id":"9003","status":"approved","transaction_amount":29.90,"installments":2,"card":{"last_four_digits":"4242"},"payment_method_id":"visa"}'::jsonb);
  if st <> 'paid' or (select payment_status from public.orders where id = oid) <> 'paid'
     or (select status from public.orders where id = oid) not in ('pending','preparing') then raise exception 'FALHA aprovado %', st; end if;
  if public.gateway_find(current_setting('test.unit')::uuid, '9003') <> gp then raise exception 'FALHA find'; end if;
  -- segundo pagamento aprovado para o mesmo pedido: estorno automático
  gp2 := public.gateway_begin(oid, 'card', 2990);
  st := public.gateway_record(gp2, '{"id":"9004","status":"approved","transaction_amount":29.90}'::jsonb);
  if st <> 'refund_needed' or (select refund_status from public.gateway_payments where id = gp2) <> 'requested' then raise exception 'FALHA duplicado %', st; end if;
  perform set_config('test.gw_order', oid::text, false);
  perform set_config('test.gw_gp', gp::text, false);
end $$;
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
set request.jwt.claims = '{"aal":"aal2"}';
do $$ begin
  perform public.set_order_status(current_setting('test.gw_order')::uuid, 'cancelled', 'teste estorno');
  if (select refund_status from public.gateway_payments where id = current_setting('test.gw_gp')::uuid) <> 'requested' then raise exception 'FALHA estorno no cancelamento'; end if;
end $$;
reset role;
set request.jwt.claims = '{"role":"service_role"}';
do $$ declare j jsonb; x jsonb;
begin
  j := public.gateway_refund_jobs();
  if jsonb_array_length(j) <> 2 then raise exception 'FALHA jobs %', j; end if;
  for x in select * from jsonb_array_elements(j) loop perform public.gateway_refund_result((x->>'id')::uuid, true, 'ok'); end loop;
  if exists (select 1 from public.gateway_payments where order_id = current_setting('test.gw_order')::uuid and status = 'approved') then raise exception 'FALHA refund'; end if;
end $$;
set request.jwt.claims = '{"role":"anon"}';
reset role;
select 'PAGAMENTO ONLINE OK' as resultado;
-- ===== Entregadores e rotas =====
do $$ declare u public.units; n int; i int; oid uuid;
begin
  select * into u from public.units where slug = 'bella-massa';
  for i in 1..3 loop
    update public.units set order_counter = order_counter + 1 where id = u.id returning order_counter into n;
    insert into public.orders (tenant_id, unit_id, number, channel, type, status, customer_name, customer_phone, address,
      subtotal_cents, delivery_fee_cents, total_cents, payment_method, payment_status, change_for_cents, accepted_at)
    values (u.tenant_id, u.id, n, 'web', 'delivery', (case when i = 3 then 'preparing' else 'ready' end)::public.order_status, 'Cliente ' || i, '3190000000' || i,
      jsonb_build_object('street','Rua ' || i, 'number', '10', 'neighborhood','Centro', 'lat', -19.93 + i * 0.01 * (4 - i), 'lng', -43.94),
      3000, 800, 3800, case when i = 1 then 'pix'::public.payment_method else 'cash'::public.payment_method end,
      case when i = 1 then 'paid'::public.payment_status else 'pending'::public.payment_status end, case when i = 2 then 5000 end, now())
    returning id into oid;
    insert into public.payments (tenant_id, order_id, method, amount_cents, status)
    values (u.tenant_id, oid, case when i = 1 then 'pix'::public.payment_method else 'cash'::public.payment_method end, 3800,
            case when i = 1 then 'paid'::public.payment_status else 'pending'::public.payment_status end);
    perform set_config('test.dl_o' || i, oid::text, false);
  end loop;
end $$;
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
set request.jwt.claims = '{"aal":"aal2"}';
do $$ declare u uuid; c uuid; c2 uuid; b uuid; tk text; r jsonb;
begin
  select id into u from public.units where slug = 'bella-massa';
  c := public.courier_save(null, u, '{"name":"João Motoboy","phone":"(31) 98888-7777","fee_mode":"fixed","fee_value":600}'::jsonb);
  c2 := public.courier_save(null, u, '{"name":"Rita Bike","fee_mode":"delivery_fee","vehicle":"bike"}'::jsonb);
  perform set_config('test.courier', c::text, false);
  begin perform access_token from public.couriers limit 1; raise exception 'FALHA leu token do entregador';
  exception when insufficient_privilege then null; end;
  tk := public.courier_link(c); perform set_config('test.ctoken', tk, false);
  -- primeiro atribui a Rita e troca para o João (troca permitida antes da saída)
  perform public.courier_assign(array[current_setting('test.dl_o1')::uuid], c2);
  b := public.courier_assign(array[current_setting('test.dl_o1')::uuid, current_setting('test.dl_o2')::uuid, current_setting('test.dl_o3')::uuid], c);
  if (select count(*) from public.deliveries where batch_id = b) <> 3 then raise exception 'FALHA rota'; end if;
  if (select count(*) from public.deliveries where order_id = current_setting('test.dl_o1')::uuid and status = 'assigned') <> 1 then raise exception 'FALHA troca'; end if;
  if (select fee_cents from public.deliveries where batch_id = b limit 1) <> 600 then raise exception 'FALHA taxa'; end if;
  if (select collect_cents from public.deliveries where order_id = current_setting('test.dl_o1')::uuid and status = 'assigned') <> 0 then raise exception 'FALHA pago online não cobra'; end if;
  begin perform public.courier_assign(array[gen_random_uuid()], c); raise exception 'FALHA pedido inexistente';
  exception when others then if sqlerrm like 'FALHA%' then raise; end if; end;
end $$;
reset role;
do $$ begin
  perform set_config('test.d1', (select id::text from public.deliveries where order_id = current_setting('test.dl_o1')::uuid and status = 'assigned'), false);
  perform set_config('test.d2', (select id::text from public.deliveries where order_id = current_setting('test.dl_o2')::uuid and status = 'assigned'), false);
  perform set_config('test.d3', (select id::text from public.deliveries where order_id = current_setting('test.dl_o3')::uuid and status = 'assigned'), false);
  perform set_config('test.o2tok', (select public_token from public.orders where id = current_setting('test.dl_o2')::uuid), false);
end $$;
set role anon;
do $$ declare tk text := current_setting('test.ctoken'); p jsonb;
  d1 uuid := current_setting('test.d1')::uuid; d2 uuid := current_setting('test.d2')::uuid; d3 uuid := current_setting('test.d3')::uuid;
begin
  if public.courier_portal('00000000000000000000000000000000') is not null then raise exception 'FALHA token falso'; end if;
  p := public.courier_portal(tk);
  if jsonb_array_length(p->'deliveries') <> 3 then raise exception 'FALHA portal %', p; end if;
  begin perform public.courier_action(tk, d3, 'pickup'); raise exception 'FALHA saiu em preparo';
  exception when others then if sqlerrm like 'FALHA%' then raise; end if; end;
  begin perform public.courier_action(tk, d1, 'deliver', 'cash'); raise exception 'FALHA entregou sem sair';
  exception when others then if sqlerrm like 'FALHA%' then raise; end if; end;
  perform public.courier_action(tk, d1, 'pickup'); perform public.courier_action(tk, d2, 'pickup');
  if public.get_order_by_token(current_setting('test.o2tok'))->>'status' <> 'dispatched' then raise exception 'FALHA dispatched'; end if;
  if public.get_order_by_token(current_setting('test.o2tok'))->'courier'->>'name' <> 'João' then raise exception 'FALHA nome no acompanhamento'; end if;
  perform public.courier_action(tk, d1, 'deliver', null);
  begin perform public.courier_action(tk, d2, 'deliver', null); raise exception 'FALHA sem forma de pagamento';
  exception when others then if sqlerrm like 'FALHA%' then raise; end if; end;
  perform public.courier_action(tk, d2, 'deliver', 'cash');
  if (public.get_order_by_token(current_setting('test.o2tok'))->>'status') || (public.get_order_by_token(current_setting('test.o2tok'))->>'payment_status') <> 'completedpaid' then raise exception 'FALHA concluído'; end if;
  -- outro entregador não mexe na entrega
  begin perform public.courier_action(md5('x'), d3, 'fail', null, 'teste'); raise exception 'FALHA token alheio';
  exception when others then if sqlerrm like 'FALHA%' then raise; end if; end;
  perform public.courier_action(tk, d3, 'fail', null, 'Cliente ausente');
  if (public.courier_portal(tk)->'today'->>'delivered')::int <> 2 then raise exception 'FALHA resumo'; end if;
end $$;
reset role;
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
set request.jwt.claims = '{"aal":"aal2"}';
do $$ declare c uuid := current_setting('test.courier')::uuid; b jsonb; r jsonb; u uuid; e0 int;
begin
  select id into u from public.units where slug = 'bella-massa';
  b := public.courier_open_balance(c);
  if (b->>'deliveries')::int <> 2 or (b->>'fees_cents')::int <> 1200 or (b->>'cash_cents')::int <> 3800 then raise exception 'FALHA saldo %', b; end if;
  if not (public.cash_status(u)->>'open')::boolean then perform public.cash_open(u, 0); end if;
  e0 := (public.cash_status(u)->'expected'->>'cash')::int;
  r := public.courier_settle(c, 3800, true, 'acerto do dia');
  if (r->>'difference_cents')::int <> 0 then raise exception 'FALHA diferença %', r; end if;
  -- caixa: +38,00 do entregador −12,00 de taxas
  if (public.cash_status(u)->'expected'->>'cash')::int - e0 <> 2600 then raise exception 'FALHA caixa %', (public.cash_status(u)->'expected'->>'cash')::int - e0; end if;
  if not exists (select 1 from public.fin_entries where category = 'Entregadores' and amount_cents = 1200 and paid_at is not null) then raise exception 'FALHA financeiro'; end if;
  if (public.courier_open_balance(c)->>'deliveries')::int <> 0 then raise exception 'FALHA saldo zerado'; end if;
  begin perform public.courier_settle(c, 0, false, null); raise exception 'FALHA acerto vazio';
  exception when others then if sqlerrm like 'FALHA%' then raise; end if; end;
end $$;
reset role;
select 'ENTREGADORES OK' as resultado;
-- ===== Impressão automática =====
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
set request.jwt.claims = '{"aal":"aal2"}';
do $$ declare u uuid; t uuid; p uuid; pb uuid; tk text; pid uuid; r jsonb;
begin
  select id, tenant_id into u, t from public.units where slug = 'bella-massa';
  insert into public.printers (tenant_id, unit_id, name, connection, address, stations, print_receipt) values (t, u, 'Cozinha', 'network', '192.168.0.50:9100', array['cozinha'], false) returning id into p;
  insert into public.printers (tenant_id, unit_id, name, connection, stations, print_receipt, paper_width) values (t, u, 'Balcão', 'browser', '{}', true, 58) returning id into pb;
  tk := public.print_agent_create(u, 'PC da cozinha');
  perform set_config('test.ptoken', tk, false);
  select id into pid from public.products where tenant_id = t limit 1;
  if not (public.cash_status(u)->>'open')::boolean then perform public.cash_open(u, 0); end if;
  r := public.pos_sale(jsonb_build_object('unit_id', u, 'items', jsonb_build_array(jsonb_build_object('product_id', pid, 'quantity', 2, 'notes', 'sem cebola')),
       'payments', jsonb_build_array(jsonb_build_object('method','pix','amount_cents',5980))));
  perform set_config('test.porder', r->>'order_id', false);
  perform public.print_test(p);
end $$;
reset role;
do $$ begin
  -- gatilho adiado: os trabalhos aparecem depois do fim da transação do pedido
  if (select count(*) from public.print_jobs where order_id = current_setting('test.porder')::uuid) <> 2 then
    raise exception 'FALHA fila %', (select count(*) from public.print_jobs where order_id = current_setting('test.porder')::uuid); end if;
  if (select content from public.print_jobs where order_id = current_setting('test.porder')::uuid and kind = 'kitchen') not like '%2x%OBS: sem cebola%' then
    raise exception 'FALHA comanda %', (select content from public.print_jobs where order_id = current_setting('test.porder')::uuid and kind = 'kitchen'); end if;
  if (select content from public.print_jobs where order_id = current_setting('test.porder')::uuid and kind = 'receipt') not like '%TOTAL%(PAGO)%' then raise exception 'FALHA via'; end if;
end $$;
set role anon;
do $$ declare r jsonb; j jsonb;
begin
  begin perform public.print_agent_poll('dfp_' || repeat('0', 48)); raise exception 'FALHA token falso';
  exception when insufficient_privilege then null; end;
  r := public.print_agent_poll(current_setting('test.ptoken'), 'teste');
  if jsonb_array_length(r->'jobs') <> 2 then raise exception 'FALHA poll %', r; end if;   -- comanda + teste (a via é do navegador)
  for j in select * from jsonb_array_elements(r->'jobs') loop perform public.print_agent_done(current_setting('test.ptoken'), (j->>'id')::bigint, true); end loop;
  if jsonb_array_length(public.print_agent_poll(current_setting('test.ptoken'))->'jobs') <> 0 then raise exception 'FALHA repetiu'; end if;
end $$;
reset role;
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
set request.jwt.claims = '{"aal":"aal2"}';
do $$ declare u uuid; b jsonb;
begin
  select id into u from public.units where slug = 'bella-massa';
  b := public.print_browser_claim(u);
  if jsonb_array_length(b) <> 1 then raise exception 'FALHA navegador %', b; end if;
  perform public.print_browser_done((b->0->>'id')::bigint, true);
  if public.print_reprint(current_setting('test.porder')::uuid) <> 2 then raise exception 'FALHA reimpressão'; end if;
end $$;
reset role;
select 'IMPRESSAO OK' as resultado;

-- ===== Marketing =====
do $$ declare t uuid;
begin
  select tenant_id into t from public.units where slug = 'bella-massa';
  update public.customers set opt_in_marketing = true, last_order_at = now() - interval '45 days', birthday = (now() at time zone 'America/Sao_Paulo')::date - interval '30 years'
   where tenant_id = t and phone in ('31988771122', '31944440001');
  update public.customers set opt_in_marketing = false where tenant_id = t and phone not in ('31988771122', '31944440001');
end $$;
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
set request.jwt.claims = '{"aal":"aal2"}';
do $$ declare t uuid; c uuid; r jsonb; a uuid;
begin
  select tenant_id into t from public.units where slug = 'bella-massa';
  if (public.campaign_audience_count(t, '{"type":"inactive","days":30}')->>'eligible')::int <> 2 then raise exception 'FALHA público %', public.campaign_audience_count(t, '{"type":"inactive","days":30}'); end if;
  begin perform public.campaign_save(null, t, '{"name":"API sem modelo","channel":"whatsapp_api","message":"Oi {nome}"}'::jsonb); raise exception 'FALHA sem modelo';
  exception when others then if sqlerrm like 'FALHA%' then raise; end if; end;
  c := public.campaign_save(null, t, jsonb_build_object('name','Volta logo','segment', '{"type":"inactive","days":30}'::jsonb,
        'message','Oi {nome}! Sentimos sua falta na {loja}. Use o cupom {cupom}: {link}', 'coupon_mode','unique','coupon_value',15));
  r := public.campaign_launch(c);
  if (r->>'messages')::int <> 2 then raise exception 'FALHA disparo %', r; end if;
  if (select count(*) from public.coupons where tenant_id = t and code like 'DOMMA%' and max_uses = 1) <> 2 then raise exception 'FALHA cupons únicos'; end if;
  if (select body from public.campaign_messages where campaign_id = c limit 1) not like 'Oi %! Sentimos sua falta na Bella Massa%DOMMA%/loja/bella-massa' then
    raise exception 'FALHA texto %', (select body from public.campaign_messages where campaign_id = c limit 1); end if;
  perform public.campaign_message_mark((select id from public.campaign_messages where campaign_id = c order by id limit 1), true);
  -- limite de frequência: nova campanha não pega quem acabou de receber
  if (public.campaign_audience_count(t, '{"type":"inactive","days":30}')->>'eligible')::int <> 0 then raise exception 'FALHA frequência'; end if;
  -- automação de aniversário (canal manual)
  a := public.campaign_save(null, t, jsonb_build_object('name','Aniversário','kind','birthday','segment','{"type":"birthday_today"}'::jsonb,
        'message','Feliz aniversário, {nome}! Presente: {cupom}','coupon_mode','shared','coupon_kind','free_delivery','active',true));
  perform set_config('test.camp', c::text, false);
  perform set_config('test.auto', a::text, false);
end $$;
reset role;
do $$ declare n int; t uuid;
begin
  select tenant_id into t from public.units where slug = 'bella-massa';
  update public.campaigns set status = 'active' where id = current_setting('test.auto')::uuid;
  update public.marketing_settings set frequency_days = 1 where tenant_id = t;
  insert into public.marketing_settings (tenant_id, frequency_days) values (t, 1) on conflict (tenant_id) do update set frequency_days = 1;
  delete from public.campaign_messages where campaign_id = current_setting('test.camp')::uuid and status = 'manual_pending';
  update public.campaign_messages set created_at = now() - interval '2 days' where campaign_id = current_setting('test.camp')::uuid;
  n := private.marketing_daily();
  if n <> 2 then raise exception 'FALHA aniversário %', n; end if;
  if private.marketing_daily() <> 0 then raise exception 'FALHA aniversário repetido'; end if;
  -- conversão: cliente que recebeu e pediu
  update public.campaign_messages set status = 'manual_done', sent_at = now() where campaign_id = current_setting('test.auto')::uuid;
end $$;
set role anon;
do $$ declare r jsonb;
begin
  r := public.place_order(jsonb_build_object('slug','bella-massa','type','pickup','payment_method','cash',
        'customer', jsonb_build_object('name','Ana Paula','phone','31988771122','birthday','1990-05-17'),
        'items', jsonb_build_array(jsonb_build_object('product_id', current_setting('test.pid')::uuid, 'quantity', 1))));
end $$;
reset role;
set request.jwt.claims = '{"role":"service_role"}';
do $$ declare t uuid;
begin
  select tenant_id into t from public.units where slug = 'bella-massa';
  if (select count(*) from public.campaign_messages where campaign_id = current_setting('test.auto')::uuid and converted_order_id is not null) <> 1 then raise exception 'FALHA conversão'; end if;
  if public.marketing_inbound(t, '5531944440001', 'sair') is not true then raise exception 'FALHA SAIR'; end if;
  if (select opt_in_marketing from public.customers where tenant_id = t and phone = '31944440001') then raise exception 'FALHA opt-out'; end if;
  if public.marketing_inbound(t, '5531988771122', 'Quero uma pizza') then raise exception 'FALHA mensagem comum virou opt-out'; end if;
  if (select birthday from public.customers where tenant_id = t and phone = '31988771122') is null then raise exception 'FALHA aniversário salvo'; end if;
end $$;
set request.jwt.claims = '{"role":"anon"}';
do $$ begin
  begin perform public.marketing_jobs(1); raise exception 'FALHA anon fila'; exception when insufficient_privilege then null; end;
end $$;
reset role;
select 'MARKETING OK' as resultado;

-- ===== Avisos de status pelo WhatsApp =====
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
set request.jwt.claims = '{"aal":"aal2"}';
do $$ declare t uuid;
begin
  select tenant_id into t from public.units where slug = 'bella-massa';
  begin perform public.status_save_settings(t, true, '[]'::jsonb); raise exception 'FALHA ativou sem API';
  exception when others then if sqlerrm like 'FALHA%' then raise; end if; end;
  begin perform public.status_save_settings(t, false, '[{"event":"accepted","enabled":true}]'::jsonb); raise exception 'FALHA sem modelo';
  exception when others then if sqlerrm like 'FALHA%' then raise; end if; end;
end $$;
reset role;
do $$ declare t uuid; begin
  select tenant_id into t from public.units where slug = 'bella-massa';
  update public.marketing_settings set wa_enabled = true, wa_phone_number_id = '1234567890' where tenant_id = t;   -- simula API conectada
end $$;
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
set request.jwt.claims = '{"aal":"aal2"}';
do $$ declare t uuid;
begin
  select tenant_id into t from public.units where slug = 'bella-massa';
  perform public.status_save_settings(t, true, jsonb_build_array(
    jsonb_build_object('event','received','enabled',true,'template_name','pedido_recebido','params', jsonb_build_array('nome','numero','link')),
    jsonb_build_object('event','accepted','enabled',true,'template_name','pedido_em_preparo','params', jsonb_build_array('nome','numero','previsao')),
    jsonb_build_object('event','ready','enabled',true,'template_name','pedido_pronto','params', jsonb_build_array('nome','numero','loja')),
    jsonb_build_object('event','cancelled','enabled',true,'template_name','pedido_cancelado','params', jsonb_build_array('nome','numero','motivo')),
    jsonb_build_object('event','completed','enabled',false,'template_name','pedido_entregue')));
  if (public.status_overview(t)->>'status_enabled')::boolean is not true then raise exception 'FALHA ativar'; end if;
  if public.status_test(t, 'accepted', '31911112222') is null then raise exception 'FALHA teste'; end if;
end $$;
reset role;
set role anon;
do $$ declare r jsonb; r2 jsonb;
begin
  if (public.get_store('bella-massa')->'unit'->>'wa_status')::boolean is not true then raise exception 'FALHA flag na loja %', public.get_store('bella-massa')->'unit'->>'wa_status'; end if;
  r := public.place_order(jsonb_build_object('slug','bella-massa','type','pickup','payment_method','cash','notify_whatsapp',true,
        'customer', jsonb_build_object('name','Joana Teste','phone','31977776666'),
        'items', jsonb_build_array(jsonb_build_object('product_id', current_setting('test.pid')::uuid, 'quantity', 1))));
  r2 := public.place_order(jsonb_build_object('slug','bella-massa','type','pickup','payment_method','cash',
        'customer', jsonb_build_object('name','Sem Aviso','phone','31977775555'),
        'items', jsonb_build_array(jsonb_build_object('product_id', current_setting('test.pid')::uuid, 'quantity', 1))));
  perform set_config('test.norder', r->>'order_id', false);
  perform set_config('test.norder2', r2->>'order_id', false);
end $$;
reset role;
do $$ declare o uuid := current_setting('test.norder')::uuid; n public.order_notifications;
begin
  if not (select notify_whatsapp from public.orders where id = o) then raise exception 'FALHA opção no pedido'; end if;
  select * into n from public.order_notifications where order_id = o and event = 'received';
  if not found then raise exception 'FALHA aviso de recebido'; end if;
  if n.phone <> '5531977776666' or n.params->>0 <> 'Joana' or n.params->>2 not like 'https://domma-food.vercel.app/pedido/%' then raise exception 'FALHA parâmetros %', n; end if;
  if exists (select 1 from public.order_notifications where order_id = current_setting('test.norder2')::uuid) then raise exception 'FALHA avisou sem opção'; end if;
end $$;
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
set request.jwt.claims = '{"aal":"aal2"}';
do $$ declare o uuid := current_setting('test.norder')::uuid;
begin
  perform public.set_order_status(o, 'preparing');
  perform public.set_order_status(o, 'ready');
  perform public.set_order_status(o, 'awaiting_pickup');   -- não repete o "pronto"
  perform public.set_order_status(o, 'completed');          -- desligado
  perform public.set_order_status(current_setting('test.norder2')::uuid, 'cancelled', 'Sem estoque');
end $$;
reset role;
set request.jwt.claims = '{"role":"service_role"}';
do $$ declare o uuid := current_setting('test.norder')::uuid; j jsonb; r jsonb;
begin
  if (select string_agg(event, ',' order by id) from public.order_notifications where order_id = o) <> 'received,accepted,ready' then
    raise exception 'FALHA eventos %', (select string_agg(event, ',' order by id) from public.order_notifications where order_id = o); end if;
  r := public.status_jobs(50);
  if jsonb_array_length(r) <> 4 then raise exception 'FALHA fila % ', jsonb_array_length(r); end if;   -- 3 do pedido + teste
  if (r->0->>'template') is null or (r->0->>'phone_number_id') <> '1234567890' then raise exception 'FALHA job %', r->0; end if;
  for j in select * from jsonb_array_elements(r) loop
    perform public.status_job_result((j->>'id')::bigint, true, 'wamid.T' || (j->>'id'), null);
  end loop;
  perform public.marketing_status_update((select tenant_id from public.orders where id = o), 'wamid.T' || (select id from public.order_notifications where order_id = o and event = 'ready'), 'read', null);
  if (select status from public.order_notifications where order_id = o and event = 'ready') <> 'read' then raise exception 'FALHA leitura'; end if;
  if jsonb_array_length(public.status_jobs(50)) <> 0 then raise exception 'FALHA repetiu'; end if;
  -- atrasado é descartado
  update public.order_notifications set status = 'queued', created_at = now() - interval '1 hour' where order_id = o and event = 'accepted';
  if jsonb_array_length(public.status_jobs(50)) <> 0 then raise exception 'FALHA atrasado enviado'; end if;
  if (select status from public.order_notifications where order_id = o and event = 'accepted') <> 'skipped' then raise exception 'FALHA atrasado'; end if;
end $$;
set request.jwt.claims = '{"role":"anon"}';
do $$ begin
  begin perform public.status_jobs(1); raise exception 'FALHA anon fila'; exception when insufficient_privilege then null; end;
end $$;
reset role;
select 'AVISOS WHATSAPP OK' as resultado;

-- ===== Cobrança da assinatura (SaaS) =====
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
set request.jwt.claims = '{"aal":"aal2"}';
do $$ declare t uuid; r jsonb;
begin
  select tenant_id into t from public.units where slug = 'bella-massa';
  r := public.billing_overview(t);
  if (r->>'enabled')::boolean then raise exception 'FALHA cobrança ligada por padrão'; end if;
  if jsonb_array_length(r->'plans') < 4 then raise exception 'FALHA planos'; end if;
  if public.billing_can_manage(t) is not true then raise exception 'FALHA dono'; end if;
  -- dono não muda o próprio status, isenção ou validade
  begin update public.tenants set billing_exempt = true where id = t; raise exception 'FALHA isenção pelo dono';
  exception when insufficient_privilege then null; end;
  begin update public.tenants set paid_until = '2099-01-01' where id = t; raise exception 'FALHA validade pelo dono';
  exception when insufficient_privilege then null; end;
  perform set_config('test.bt', t::text, false);
end $$;
-- funcionário não vê a assinatura
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
do $$ begin
  begin perform public.billing_overview(current_setting('test.bt')::uuid); raise exception 'FALHA estranho viu assinatura';
  exception when insufficient_privilege then null; end;
end $$;
-- super admin configura (sem teste não ativa)
set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
do $$ begin
  begin perform public.admin_billing_save('{}'::jsonb, 'chave-errada'); raise exception 'FALHA chave aceita';
  exception when others then if sqlerrm like 'FALHA%' then raise; end if; end;
  perform public.admin_billing_save('{"env":"sandbox","grace_days":5}'::jsonb, '$aact_hmlg_000000000000000000000000000000');
  begin perform public.admin_billing_save('{"enabled":true}'::jsonb); raise exception 'FALHA ativou sem teste';
  exception when others then if sqlerrm like 'FALHA%' then raise; end if; end;
  if (public.admin_billing_settings()->>'api_key_hint') <> '0000' then raise exception 'FALHA dica da chave'; end if;
end $$;
reset role;
set request.jwt.claims = '{"role":"service_role"}';
do $$ declare t uuid := current_setting('test.bt')::uuid; c jsonb; x public.tenants;
begin
  perform public.billing_test_result(true, 'ok');
  c := public.billing_context(t);
  if c->>'api_key' <> '$aact_hmlg_000000000000000000000000000000' or (c->'plans'->'completo'->>'price_cents')::int <> 38900 then raise exception 'FALHA contexto %', c; end if;
  -- assinatura criada durante o teste
  update public.tenants set status = 'trial', trial_ends_at = now() + interval '3 days', plan_id = 'essencial' where id = t;
  perform public.billing_save_account(t, jsonb_build_object('customer_id','cus_1','subscription_id','sub_1','plan_id','delivery',
    'name','Bella Massa Ltda','cpf_cnpj','12345678000199','email','fin@bella.com','status','active','next_due_date', (current_date + 3)::text));
  if (select plan_id from public.tenants where id = t) <> 'delivery' then raise exception 'FALHA plano'; end if;
  -- fatura criada (pendente) e paga
  if public.billing_apply_payment(jsonb_build_object('id','pay_1','subscription','sub_1','customer','cus_1','value',229.0,'netValue',225.5,
       'status','PENDING','billingType','UNDEFINED','dueDate',(current_date + 3)::text,'invoiceUrl','https://sandbox.asaas.com/i/1')) <> t then raise exception 'FALHA fatura'; end if;
  if (select status from public.tenants where id = t) <> 'trial' then raise exception 'FALHA pendente mudou status'; end if;
  perform public.billing_apply_payment(jsonb_build_object('id','pay_1','subscription','sub_1','value',229.0,'status','RECEIVED',
       'dueDate',(current_date + 3)::text,'paymentDate',current_date::text,'billingType','PIX'));
  select * into x from public.tenants where id = t;
  if x.status <> 'active' or x.paid_until <> (current_date + 3 + interval '1 month')::date then raise exception 'FALHA pago % %', x.status, x.paid_until; end if;
  if (select value_cents from public.billing_invoices where provider_id = 'pay_1') <> 22900 then raise exception 'FALHA valor'; end if;
  -- próxima fatura vence e atrasa
  perform public.billing_apply_payment(jsonb_build_object('id','pay_2','subscription','sub_1','value',229.0,'status','OVERDUE','dueDate',(current_date - 6)::text));
  select * into x from public.tenants where id = t;
  if x.status <> 'past_due' or x.past_due_since::date <> current_date - 6 then raise exception 'FALHA atraso % %', x.status, x.past_due_since; end if;
  -- evento repetido é ignorado
  if public.billing_event_seen('evt_1', 'PAYMENT_OVERDUE', 'pay_2') then raise exception 'FALHA evento novo'; end if;
  if not public.billing_event_seen('evt_1', 'PAYMENT_OVERDUE', 'pay_2') then raise exception 'FALHA idempotência'; end if;
  -- cobrança de outra empresa / de fora do Domma não afeta ninguém
  if public.billing_apply_payment(jsonb_build_object('id','pay_x','subscription','sub_desconhecida','value',10,'status','OVERDUE','dueDate',current_date::text)) is not null then
    raise exception 'FALHA fatura estranha'; end if;
end $$;
-- rotina diária: carência (5 dias) vencida → suspende; pagar reativa
set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
set role authenticated;
do $$ begin perform public.admin_billing_save('{"enabled":true}'::jsonb); end $$;
reset role;
do $$ declare t uuid := current_setting('test.bt')::uuid; x public.tenants;
begin
  perform private.billing_daily();
  select * into x from public.tenants where id = t;
  if x.status <> 'suspended' or x.suspended_reason <> 'billing' then raise exception 'FALHA suspensão %', x.status; end if;
  if public.get_store('bella-massa') is not null then raise exception 'FALHA loja suspensa no ar'; end if;
end $$;
set request.jwt.claims = '{"role":"service_role"}';
do $$ declare t uuid := current_setting('test.bt')::uuid; x public.tenants;
begin
  perform public.billing_apply_payment(jsonb_build_object('id','pay_2','subscription','sub_1','value',229.0,'status','CONFIRMED',
       'dueDate',(current_date - 6)::text,'paymentDate',current_date::text));
  select * into x from public.tenants where id = t;
  if x.status <> 'active' or x.suspended_reason is not null or x.past_due_since is not null then raise exception 'FALHA reativar % %', x.status, x.suspended_reason; end if;
end $$;
reset role;
-- suspensão manual do admin não é desfeita por pagamento; isenção protege da rotina
set role authenticated;
set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
do $$ declare t uuid := current_setting('test.bt')::uuid;
begin
  perform public.admin_set_tenant(t, 'delivery', 'suspended');
end $$;
reset role;
set request.jwt.claims = '{"role":"service_role"}';
do $$ declare t uuid := current_setting('test.bt')::uuid;
begin
  perform public.billing_apply_payment(jsonb_build_object('id','pay_3','subscription','sub_1','value',229.0,'status','RECEIVED','dueDate',(current_date + 20)::text));
  if (select status from public.tenants where id = t) <> 'suspended' then raise exception 'FALHA pagamento derrubou suspensão manual'; end if;
end $$;
reset role;
set role authenticated;
set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
do $$ declare t uuid := current_setting('test.bt')::uuid;
begin
  perform public.admin_set_tenant(t, 'delivery', 'trial', 14);
  perform public.admin_set_exempt(t, true);
end $$;
reset role;
do $$ declare t uuid := current_setting('test.bt')::uuid;
begin
  update public.tenants set trial_ends_at = now() - interval '30 days' where id = t;
  perform private.billing_daily();
  if (select status from public.tenants where id = t) <> 'trial' then raise exception 'FALHA isento suspenso'; end if;
  update public.tenants set billing_exempt = false, status = 'active', trial_ends_at = now() + interval '14 days', past_due_since = null where id = t;
end $$;
-- cancelamento: usa até o fim do período pago
set request.jwt.claims = '{"role":"service_role"}';
do $$ declare t uuid := current_setting('test.bt')::uuid; x public.tenants;
begin
  perform public.billing_save_account(t, '{"status":"canceled","subscription_id":null}'::jsonb);
  select * into x from public.tenants where id = t;
  if x.cancel_at is null or x.cancel_at < current_date then raise exception 'FALHA cancelamento %', x.cancel_at; end if;
end $$;
set request.jwt.claims = '{"role":"anon"}';
do $$ begin
  begin perform public.billing_context(current_setting('test.bt')::uuid); raise exception 'FALHA anon contexto'; exception when insufficient_privilege then null; end;
end $$;
reset role;
set request.jwt.claims = '{}';
do $$ begin
  update public.billing_settings set enabled = false, api_key_secret_id = null where id;
  update public.tenants set status = 'active', cancel_at = null, suspended_reason = null where id = current_setting('test.bt')::uuid;
end $$;
select 'COBRANCA SAAS OK' as resultado;

-- ===== iFood =====
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
set request.jwt.claims = '{"aal":"aal2"}';
do $$ declare u uuid; r jsonb;
begin
  select id into u from public.units where slug = 'bella-massa';
  r := public.ifood_overview(u);
  if (r->>'app_ready')::boolean or r->'connection' <> 'null'::jsonb then raise exception 'FALHA estado inicial %', r; end if;
  begin perform public.ifood_set_options(u, false, true); raise exception 'FALHA ativou sem conectar';
  exception when others then if sqlerrm like 'FALHA%' then raise; end if; end;
  begin perform public.admin_ifood_save('abc12345-x', 'segredo-super-longo-123'); raise exception 'FALHA lojista salvou app';
  exception when insufficient_privilege then null; end;
  perform set_config('test.iu', u::text, false);
end $$;
set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
do $$ begin
  perform public.admin_ifood_save('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'segredo-do-app-ifood-123456');
  if (public.admin_ifood_settings()->>'has_secret')::boolean is not true then raise exception 'FALHA app'; end if;
end $$;
reset role;
set request.jwt.claims = '{"role":"service_role"}';
do $$ declare u uuid := current_setting('test.iu')::uuid; c uuid; ctx jsonb; oid uuid; r jsonb; o public.orders;
begin
  if public.ifood_app_secret()->>'client_secret' <> 'segredo-do-app-ifood-123456' then raise exception 'FALHA segredo do app'; end if;
  c := public.ifood_save_user_code(u, 'HJLX-LPSQ', 'https://portal.ifood.com.br/apps/code?c=HJLX-LPSQ', 'verificador-secreto', 600);
  ctx := public.ifood_auth_context(c);
  if ctx->>'verifier' <> 'verificador-secreto' then raise exception 'FALHA verificador'; end if;
  perform public.ifood_save_token(c, '{"access_token":"tok","refresh_token":"ref","expires_at":9999999999}'::jsonb);
  ctx := public.ifood_auth_context(c);
  if ctx->'token'->>'refresh_token' <> 'ref' or ctx->>'verifier' is not null then raise exception 'FALHA token %', ctx; end if;
  perform public.ifood_set_merchant(c, 'merchant-uuid-1', 'Bella Massa iFood', '[{"id":"merchant-uuid-1","name":"Bella Massa iFood"}]');
  if jsonb_array_length(public.ifood_connections()) <> 1 then raise exception 'FALHA conexões ativas'; end if;
  -- pedido de entrega pago online, entregue pelo iFood
  oid := public.ifood_ingest_order(c, '{
    "id":"ifood-order-1","displayId":"7A2B","orderType":"DELIVERY","orderTiming":"IMMEDIATE","isTest":true,"extraInfo":"Sem cebola",
    "customer":{"name":"João Cliente","phone":{"number":"0800 700 1234","localizer":"12345678"}},
    "items":[{"name":"Pizza Margherita","externalCode":"x","quantity":1,"unitPrice":50,"totalPrice":56,"observations":"bem assada",
              "options":[{"name":"Borda recheada","quantity":1,"unitPrice":6}]}],
    "total":{"subTotal":56,"deliveryFee":7,"benefits":5,"additionalFees":0.99,"orderAmount":58.99},
    "payments":{"prepaid":58.99,"pending":0,"methods":[{"value":58.99,"method":"CREDIT","type":"ONLINE"}]},
    "delivery":{"mode":"DEFAULT","deliveredBy":"IFOOD","deliveryDateTime":"2026-11-13T20:00:00Z","pickupCode":"4321",
      "deliveryAddress":{"streetName":"Rua A","streetNumber":"10","neighborhood":"Centro","city":"BH","coordinates":{"latitude":-19.9,"longitude":-43.9}}}
  }'::jsonb);
  select * into o from public.orders where id = oid;
  if o.channel <> 'ifood' or o.status <> 'pending' or o.total_cents <> 5899 or o.delivery_fee_cents <> 799 or o.discount_cents <> 500
     or o.payment_status <> 'paid' or o.external_display_id <> '7A2B' or o.customer_id is not null then raise exception 'FALHA pedido %', to_jsonb(o); end if;
  if o.notes not like '%código 12345678%' or o.notes not like '%Código de coleta: 4321%' then raise exception 'FALHA observações %', o.notes; end if;
  if (select options->0->>'name' from public.order_items where order_id = oid) <> 'Borda recheada' then raise exception 'FALHA adicional'; end if;
  if public.ifood_ingest_order(c, '{"id":"ifood-order-1"}'::jsonb) <> oid then raise exception 'FALHA idempotência'; end if;
  perform set_config('test.ic', c::text, false);
  perform set_config('test.io', oid::text, false);
end $$;
reset role;
-- loja aceita no painel → confirmação vai para a fila do iFood
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
set request.jwt.claims = '{"aal":"aal2"}';
do $$ declare oid uuid := current_setting('test.io')::uuid;
begin
  perform public.set_order_status(oid, 'preparing');
  perform public.set_order_status(oid, 'ready');
end $$;
reset role;
do $$ declare oid uuid := current_setting('test.io')::uuid;
begin
  if (select string_agg(action, ',' order by id) from public.integration_outbox where order_id = oid) <> 'confirm,readyForPickup' then
    raise exception 'FALHA fila %', (select string_agg(action, ',' order by id) from public.integration_outbox where order_id = oid); end if;
end $$;
set request.jwt.claims = '{"role":"service_role"}';
do $$ declare c uuid := current_setting('test.ic')::uuid; oid uuid := current_setting('test.io')::uuid; o2 uuid;
begin
  -- iFood despacha (entrega pelo iFood) e conclui; nada volta para a fila
  perform public.ifood_apply_event(c, 'ifood-order-1', 'DSP');
  perform public.ifood_apply_event(c, 'ifood-order-1', 'CON');
  if (select status from public.orders where id = oid) <> 'completed' then raise exception 'FALHA concluído'; end if;
  if (select count(*) from public.integration_outbox where order_id = oid) <> 2 then raise exception 'FALHA eco para o iFood'; end if;
  -- confirmado no gestor do iFood não reenvia confirmação
  o2 := public.ifood_ingest_order(c, '{"id":"ifood-order-2","displayId":"9Z","orderType":"TAKEOUT","customer":{"name":"Ana"},
     "items":[],"total":{"subTotal":20,"orderAmount":20},"payments":{"pending":20,"methods":[{"method":"CASH","type":"OFFLINE","cash":{"changeFor":50}}]}}'::jsonb);
  if (select payment_method::text || '/' || change_for_cents from public.orders where id = o2) <> 'cash/5000' then raise exception 'FALHA dinheiro'; end if;
  perform public.ifood_apply_event(c, 'ifood-order-2', 'CFM');
  if (select status from public.orders where id = o2) <> 'preparing' or exists (select 1 from public.integration_outbox where order_id = o2) then raise exception 'FALHA CFM'; end if;
  -- cliente pede cancelamento (disputa)
  perform public.ifood_apply_event(c, 'ifood-order-2', 'HSD', '{"disputeId":"disp-1","action":"CANCELLATION","message":"Demorou"}');
  if not (select marketplace_cancel_requested from public.orders where id = o2) or (select external_flags->>'dispute_id' from public.orders where id = o2) <> 'disp-1' then raise exception 'FALHA disputa'; end if;
  perform set_config('test.io2', o2::text, false);
end $$;
reset role;
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
set request.jwt.claims = '{"aal":"aal2"}';
do $$ begin perform public.respond_marketplace_cancellation(current_setting('test.io2')::uuid, true); end $$;
reset role;
do $$ declare o2 uuid := current_setting('test.io2')::uuid;
begin
  if (select status from public.orders where id = o2) <> 'cancelled' then raise exception 'FALHA aceitar cancelamento'; end if;
  if (select string_agg(action, ',') from public.integration_outbox where order_id = o2) <> 'acceptCancellation' then raise exception 'FALHA fila disputa'; end if;
end $$;
-- funcionário/anon não acessam
set request.jwt.claims = '{"role":"anon"}';
do $$ begin
  begin perform public.ifood_connections(); raise exception 'FALHA anon conexões'; exception when insufficient_privilege then null; end;
  begin perform public.ifood_ingest_order(current_setting('test.ic')::uuid, '{}'); raise exception 'FALHA anon pedido'; exception when insufficient_privilege then null; end;
end $$;
reset role;
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
set request.jwt.claims = '{"aal":"aal2"}';
do $$ declare r jsonb;
begin
  r := public.ifood_overview(current_setting('test.iu')::uuid);
  if (r->'connection'->>'active')::boolean is not true or (r->'connection'->>'authorized')::boolean is not true then raise exception 'FALHA visão %', r; end if;
  if r::text like '%"ref"%' or r::text like '%tok%' then raise exception 'FALHA vazou token'; end if;
  perform public.ifood_disconnect(current_setting('test.iu')::uuid);
  if (public.ifood_overview(current_setting('test.iu')::uuid)->'connection'->>'active')::boolean then raise exception 'FALHA desconectar'; end if;
end $$;
reset role;
select 'IFOOD OK' as resultado;

-- ===== Domínio próprio =====
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
set request.jwt.claims = '{"aal":"aal2"}';
do $$ declare u uuid; r jsonb;
begin
  select id into u from public.units where slug = 'bella-massa';
  r := public.domain_overview(u);
  if (r->>'ready')::boolean or r->'domain' <> 'null'::jsonb then raise exception 'FALHA estado inicial %', r; end if;
  if public.domain_can_manage(u) is not true then raise exception 'FALHA gestor'; end if;
  begin perform public.admin_domains_save('prj_abcdefghij12', null, 'token-qualquer-123456789012'); raise exception 'FALHA lojista salvou token';
  exception when insufficient_privilege then null; end;
  perform set_config('test.du', u::text, false);
end $$;
reset role;
set request.jwt.claims = '{"role":"service_role"}';
do $$ declare u uuid := current_setting('test.du')::uuid;
begin
  -- domínios inválidos ou da plataforma são recusados
  begin perform public.domain_upsert(u, 'loja.vercel.app', 'pending', null, null); raise exception 'FALHA domínio vercel';
  exception when check_violation then null; end;
  begin perform public.domain_upsert(u, 'nao tem ponto', 'pending', null, null); raise exception 'FALHA domínio inválido';
  exception when check_violation then null; end;
  perform public.domain_upsert(u, 'Pedidos.BellaMassa.com.br', 'pending', '[{"type":"CNAME","name":"pedidos","value":"cname.vercel-dns.com"}]', null);
end $$;
reset role;
set role anon;
do $$ begin
  if public.get_unit_by_domain('pedidos.bellamassa.com.br') is not null then raise exception 'FALHA pendente resolveu'; end if;
end $$;
reset role;
set request.jwt.claims = '{"role":"service_role"}';
do $$ begin perform public.domain_upsert(current_setting('test.du')::uuid, 'pedidos.bellamassa.com.br', 'active', null, null); end $$;
reset role;
set role anon;
do $$ begin
  if public.get_unit_by_domain('PEDIDOS.bellamassa.com.br:443') is distinct from 'bella-massa' then raise exception 'FALHA resolver domínio'; end if;
  if public.get_unit_by_domain('outra.com.br') is not null then raise exception 'FALHA domínio desconhecido'; end if;
  begin perform public.domains_context(); raise exception 'FALHA anon token'; exception when insufficient_privilege then null; end;
end $$;
reset role;
do $$ declare u uuid := current_setting('test.du')::uuid;
begin
  if private.store_url_by_slug('bella-massa') <> 'https://pedidos.bellamassa.com.br' then raise exception 'FALHA url da loja'; end if;
  if private.store_base_url(u) <> 'https://pedidos.bellamassa.com.br' then raise exception 'FALHA url base'; end if;
  if (select dns->0->>'type' from public.unit_domains where unit_id = u) <> 'CNAME' then raise exception 'FALHA dns preservado'; end if;
  -- loja suspensa não resolve
  update public.tenants set status = 'suspended' where id = (select tenant_id from public.units where id = u);
  if public.get_unit_by_domain('pedidos.bellamassa.com.br') is not null then raise exception 'FALHA suspensa resolveu'; end if;
  update public.tenants set status = 'active' where id = (select tenant_id from public.units where id = u);
end $$;
set request.jwt.claims = '{"role":"service_role"}';
do $$ begin
  perform public.domain_delete(current_setting('test.du')::uuid);
  if private.store_url_by_slug('bella-massa') <> 'https://domma-food.vercel.app/loja/bella-massa' then raise exception 'FALHA url padrão'; end if;
end $$;
reset role;
select 'DOMINIO OK' as resultado;

-- ===== Totem de autoatendimento =====
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
set request.jwt.claims = '{"aal":"aal2"}';
do $$ declare u uuid; r jsonb;
begin
  select id into u from public.units where slug = 'bella-massa';
  r := public.totem_create(u, 'Totem da entrada');
  if r->>'token' !~ '^dft_[0-9a-f]{40}$' then raise exception 'FALHA chave do totem'; end if;
  begin perform public.totem_update((r->>'id')::uuid, '{"allow_dine_in":false,"allow_takeout":false}'); raise exception 'FALHA sem consumo';
  exception when others then if sqlerrm like 'FALHA%' then raise; end if; end;
  perform set_config('test.tt', r->>'token', false);
  perform set_config('test.tid', r->>'id', false);
end $$;
set request.jwt.claim.sub = '44444444-4444-4444-4444-444444444444';   -- cozinha não cria totem
do $$ begin
  begin perform public.totem_create((select id from public.units where slug = 'bella-massa'), 'x'); raise exception 'FALHA cozinha criou totem';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
do $$ begin update public.units set is_open_override = true where slug = 'bella-massa'; end $$;
set role anon;
do $$ declare r jsonb; i jsonb;
begin
  if public.totem_info('dft_' || repeat('0', 40)) is not null then raise exception 'FALHA chave falsa'; end if;
  i := public.totem_info(current_setting('test.tt'));
  if i->>'slug' <> 'bella-massa' or not (i->>'allow_pix')::boolean then raise exception 'FALHA info %', i; end if;   -- Mercado Pago do teste de pagamentos
  -- Pix na tela: aguarda pagamento, com o registro do pagamento pendente
  r := public.totem_order(current_setting('test.tt'), jsonb_build_array(jsonb_build_object('product_id', current_setting('test.pid')::uuid, 'quantity', 1)), 'pickup', 'Bruno', 'pix');
  if r->>'status' <> 'awaiting_payment' then raise exception 'FALHA pix %', r; end if;
  perform set_config('test.tpix', r->>'token', false);
  begin perform public.totem_order(current_setting('test.tt'), jsonb_build_array(jsonb_build_object('product_id', current_setting('test.pid')::uuid, 'quantity', 1)), 'dine_in', '  ', 'counter');
    raise exception 'FALHA sem nome'; exception when others then if sqlerrm like 'FALHA%' then raise; end if; end;
  r := public.totem_order(current_setting('test.tt'), jsonb_build_array(jsonb_build_object('product_id', current_setting('test.pid')::uuid, 'quantity', 2)), 'dine_in', ' Ana   Paula ', 'counter');
  if (r->>'number') is null or r->>'status' <> 'pending' or (r->>'total_cents')::int <= 0 then raise exception 'FALHA pedido %', r; end if;
  if public.totem_ping(current_setting('test.tt')) is not true then raise exception 'FALHA ping'; end if;
  perform set_config('test.torder', r->>'token', false);
end $$;
reset role;
do $$ declare o public.orders;
begin
  select * into o from public.orders where public_token = current_setting('test.torder');
  if o.channel <> 'totem' or o.type <> 'dine_in' or o.customer_name <> 'Ana Paula' or o.notes not like '%PAGAR NO CAIXA%' or o.totem_id is null then
    raise exception 'FALHA gravação %', to_jsonb(o); end if;
  if (select count(*) from public.order_items where order_id = o.id) <> 1 then raise exception 'FALHA itens'; end if;
  perform set_config('test.toid', o.id::text, false);
  if (select count(*) from public.payments p join public.orders x on x.id = p.order_id where x.public_token = current_setting('test.tpix') and p.status = 'pending') <> 1 then
    raise exception 'FALHA pagamento pendente do Pix'; end if;
end $$;
-- caixa recebe o pedido do totem
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
set request.jwt.claims = '{"aal":"aal2"}';
do $$ declare oid uuid := current_setting('test.toid')::uuid; tot int; r jsonb; u uuid;
begin
  select total_cents, unit_id into tot, u from public.orders where id = oid;
  if private.open_session(u) is null then perform public.cash_open(u, 10000); end if;
  begin perform public.order_receive(oid, jsonb_build_array(jsonb_build_object('method','pix','amount_cents', tot - 1))); raise exception 'FALHA recebeu a menos';
  exception when others then if sqlerrm like 'FALHA%' then raise; end if; end;
  r := public.order_receive(oid, jsonb_build_array(jsonb_build_object('method','cash','amount_cents', tot + 1000)));
  if (r->>'change_cents')::int <> 1000 then raise exception 'FALHA troco %', r; end if;
  if (select payment_status from public.orders where id = oid) <> 'paid' then raise exception 'FALHA pago'; end if;
  if not exists (select 1 from public.cash_moves where order_id = oid and kind = 'sale') then raise exception 'FALHA caixa'; end if;
  begin perform public.order_receive(oid, jsonb_build_array(jsonb_build_object('method','cash','amount_cents', tot))); raise exception 'FALHA recebeu duas vezes';
  exception when others then if sqlerrm like 'FALHA%' then raise; end if; end;
  -- desativar o totem corta os pedidos
  perform public.totem_update(current_setting('test.tid')::uuid, '{"active":false}');
end $$;
reset role;
set role anon;
do $$ begin
  begin perform public.totem_order(current_setting('test.tt'), jsonb_build_array(jsonb_build_object('product_id', current_setting('test.pid')::uuid, 'quantity', 1)), 'pickup', 'Ana', 'counter');
    raise exception 'FALHA totem desativado'; exception when others then if sqlerrm like 'FALHA%' then raise; end if; end;
  begin perform public.order_receive(current_setting('test.toid')::uuid, '[]'); raise exception 'FALHA anon receber'; exception when insufficient_privilege then null; end;
end $$;
reset role;
select 'TOTEM OK' as resultado;
