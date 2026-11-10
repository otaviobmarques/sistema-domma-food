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
