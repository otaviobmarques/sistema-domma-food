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
