-- Loja de DEMONSTRAÇÃO (dados fictícios): "Bella Massa Pizzaria" — usada no site e nas capturas de tela.
-- Pré-requisito: um usuário auth com e-mail demo@dommafood.local (dono da loja demo).
do $$
declare
  v_owner uuid := (select id from auth.users where email = 'demo@dommafood.local');
  t uuid; u uuid; c_piz uuid; c_bur uuid; c_por uuid; c_aca uuid; c_beb uuid; c_sob uuid; c_com uuid;
  g_borda uuid; g_sab uuid; g_add uuid; g_aca uuid;
  p record; i int; d timestamptz; v_cust uuid; v_ord uuid; v_n int := 0; v_ch text; v_items int; v_sub int; v_fee int; v_st text; v_pm text;
  prods uuid[]; prices int[]; names text[]; k int; q int;
  first_names text[] := array['Ana','Bruno','Carla','Diego','Eduarda','Felipe','Gabriela','Henrique','Isabela','João','Karina','Lucas','Mariana','Natália','Otávio','Paula','Rafael','Sofia','Thiago','Vanessa','William','Yasmin','Larissa','Pedro','Camila'];
  last_names text[] := array['Souza','Oliveira','Santos','Lima','Costa','Pereira','Almeida','Ribeiro','Carvalho','Gomes'];
  hoods text[] := array['Savassi','Funcionários','Lourdes','Santo Agostinho','Centro','Serra','Sion','Anchieta'];
begin
  if v_owner is null then raise exception 'crie o usuário demo primeiro'; end if;
  delete from public.tenants where created_by = v_owner;

  insert into public.tenants (name, cnpj, plan_id, status, created_by) values ('Bella Massa Pizzaria Ltda (demonstração)', null, 'completo', 'active', v_owner) returning id into t;
  insert into public.units (tenant_id, name, slug, phone, whatsapp, street, number, neighborhood, city, state, zip, lat, lng,
    is_open_override, accepts_scheduling, min_order_cents, prep_time_min, pickup_time_min, pix_key, pix_merchant_name, pix_merchant_city,
    description, primary_color, opening_hours)
  values (t, 'Bella Massa Pizzaria', 'bella-massa', '3133334444', '31988887777', 'Rua Pernambuco', '1000', 'Savassi', 'Belo Horizonte', 'MG', '30130151',
    -19.9365, -43.9345, true, true, 2500, 25, 20, 'demo@bellamassa.com.br', 'BELLA MASSA PIZZARIA', 'BELO HORIZONTE',
    'Pizzas de longa fermentação, burgers artesanais e açaí. Loja de demonstração do Domma Food.', '#D9262B',
    '{"mon":[["11:00","23:30"]],"tue":[["11:00","23:30"]],"wed":[["11:00","23:30"]],"thu":[["11:00","23:30"]],"fri":[["11:00","23:59"],["00:00","01:00"]],"sat":[["11:00","23:59"]],"sun":[["11:00","23:00"]]}')
  returning id into u;
  insert into public.memberships (tenant_id, user_id, role) values (t, v_owner, 'owner');

  insert into public.categories (tenant_id, name, position) values (t,'Pizzas',0) returning id into c_piz;
  insert into public.categories (tenant_id, name, position) values (t,'Hambúrgueres',1) returning id into c_bur;
  insert into public.categories (tenant_id, name, position) values (t,'Combos',2) returning id into c_com;
  insert into public.categories (tenant_id, name, position) values (t,'Porções',3) returning id into c_por;
  insert into public.categories (tenant_id, name, position) values (t,'Açaí',4) returning id into c_aca;
  insert into public.categories (tenant_id, name, position) values (t,'Sobremesas',5) returning id into c_sob;
  insert into public.categories (tenant_id, name, position) values (t,'Bebidas',6) returning id into c_beb;

  insert into public.option_groups (tenant_id, name, min_select, max_select, price_rule) values (t,'Borda recheada',0,1,'sum') returning id into g_borda;
  insert into public.options (tenant_id, group_id, name, price_cents, position) values (t,g_borda,'Catupiry',900,0),(t,g_borda,'Cheddar',900,1),(t,g_borda,'Chocolate',1100,2);
  insert into public.option_groups (tenant_id, name, min_select, max_select, price_rule) values (t,'Meio a meio (cobra o maior)',0,1,'max') returning id into g_sab;
  insert into public.options (tenant_id, group_id, name, price_cents, position) values (t,g_sab,'½ Calabresa',0,0),(t,g_sab,'½ Margherita',0,1),(t,g_sab,'½ Quatro queijos',800,2),(t,g_sab,'½ Frango c/ Catupiry',500,3);
  insert into public.option_groups (tenant_id, name, min_select, max_select, price_rule, allow_repeat) values (t,'Turbine seu burger',0,4,'sum',true) returning id into g_add;
  insert into public.options (tenant_id, group_id, name, price_cents, position) values (t,g_add,'Bacon extra',600,0),(t,g_add,'Cheddar extra',400,1),(t,g_add,'Ovo',300,2),(t,g_add,'Cebola caramelizada',350,3);
  insert into public.option_groups (tenant_id, name, min_select, max_select, price_rule) values (t,'Complementos do açaí',0,5,'sum') returning id into g_aca;
  insert into public.options (tenant_id, group_id, name, price_cents, position) values (t,g_aca,'Granola',0,0),(t,g_aca,'Banana',0,1),(t,g_aca,'Leite em pó',200,2),(t,g_aca,'Morango',300,3),(t,g_aca,'Nutella',600,4);

  insert into public.products (tenant_id, category_id, name, description, price_cents, promo_price_cents, featured, tags, position, sku) values
    (t,c_piz,'Pizza Calabresa G','Calabresa artesanal, cebola roxa, azeitonas e mozzarella. 8 fatias.',5490,null,true,'{mais pedido}',0,'piz-calabresa'),
    (t,c_piz,'Pizza Margherita G','Molho de tomate italiano, mozzarella de búfala e manjericão fresco.',5290,null,true,'{vegetariano}',1,'piz-margherita'),
    (t,c_piz,'Pizza Quatro Queijos G','Mozzarella, provolone, parmesão e gorgonzola com borda dourada.',6290,5690,false,'{}',2,'piz-4queijos'),
    (t,c_bur,'Burger da Casa','Blend 180 g, cheddar inglês, bacon crocante e maionese da casa no brioche.',3690,null,true,'{mais pedido}',0,'bur-casa'),
    (t,c_bur,'Smash Duplo','Dois smash de 90 g, queijo prato e picles no pão de batata.',3290,null,false,'{novo}',1,'bur-smash'),
    (t,c_com,'Combo Família','Pizza G + Burger da Casa + batata média + 2 refrigerantes 350 ml.',10990,9990,true,'{}',0,'combo-familia'),
    (t,c_por,'Batata Frita Crocante','Porção de 400 g com sal de alecrim e maionese verde.',2490,null,false,'{vegano}',0,'por-batata'),
    (t,c_aca,'Açaí 500 ml','Açaí puro batido na hora. Escolha seus complementos.',2400,null,false,'{}',0,'aca-500'),
    (t,c_sob,'Brownie com Sorvete','Brownie de chocolate meio amargo com sorvete de creme.',1990,null,false,'{}',0,'sob-brownie'),
    (t,c_beb,'Refrigerante Lata 350 ml','Coca-Cola, Guaraná ou Laranja.',790,null,false,'{}',0,'beb-lata'),
    (t,c_beb,'Refrigerante 2 L','Coca-Cola ou Guaraná.',1490,null,false,'{}',1,'beb-2l');

  insert into public.product_option_groups (product_id, group_id, tenant_id, position)
    select id, g_sab, t, 0 from public.products where tenant_id = t and category_id = c_piz
    union all select id, g_borda, t, 1 from public.products where tenant_id = t and category_id = c_piz
    union all select id, g_add, t, 0 from public.products where tenant_id = t and category_id = c_bur
    union all select id, g_aca, t, 0 from public.products where tenant_id = t and category_id = c_aca;

  insert into public.delivery_zones (tenant_id, unit_id, name, kind, radius_km, fee_cents, eta_min, free_above_cents) values
    (t,u,'Até 3 km','radius',3,500,35,12000),(t,u,'3 a 6 km','radius',6,800,45,null);
  insert into public.delivery_zones (tenant_id, unit_id, name, kind, neighborhoods, fee_cents, eta_min) values
    (t,u,'Região Centro-Sul','neighborhood',array['Savassi','Funcionários','Lourdes','Santo Agostinho','Centro','Serra','Sion','Anchieta'],600,40);
  insert into public.coupons (tenant_id, code, description, kind, value, min_order_cents, first_order_only, max_uses_per_customer) values
    (t,'BEMVINDO10','10% no primeiro pedido','percent',10,3000,true,1),(t,'FRETEGRATIS','Frete grátis acima de R$ 60','free_delivery',0,6000,false,null),
    (t,'SEXTOU15','R$ 15 de desconto às sextas','fixed',1500,8000,false,2);

  -- clientes
  for i in 1..60 loop
    insert into public.customers (tenant_id, name, phone, opt_in_marketing, created_at)
    values (t, first_names[1 + (i % 25)] || ' ' || last_names[1 + ((i * 7) % 10)], '319' || lpad((80000000 + i * 1373)::text, 8, '0'),
            i % 3 <> 0, now() - make_interval(days => 40 - (i % 30)));
  end loop;

  select array_agg(id order by position, name), array_agg(coalesce(promo_price_cents, price_cents) order by position, name), array_agg(name order by position, name)
    into prods, prices, names from public.products where tenant_id = t;

  -- 14 dias de pedidos (mais à noite e no fim de semana)
  for i in 1..420 loop
    d := date_trunc('day', now() at time zone 'America/Sao_Paulo') at time zone 'America/Sao_Paulo'
         - make_interval(days => (i % 14)) + make_interval(hours => (array[11,12,12,13,18,19,19,20,20,20,21,21,22,23])[1 + (i * 5) % 14], mins => (i * 17) % 60);
    if d > now() then continue; end if;
    if extract(dow from d) in (0,5,6) is false and i % 3 = 0 then continue; end if;
    v_n := v_n + 1;
    v_ch := (array['web','web','web','web','web','99food','keeta','aiqfome','web','whatsapp'])[1 + (i * 3) % 10];
    select id into v_cust from public.customers where tenant_id = t order by md5(id::text || i) limit 1;
    v_items := 1 + (i % 3); v_sub := 0;
    v_fee := case when i % 4 = 0 then 0 else (array[500,600,800])[1 + i % 3] end;
    v_pm := (array['pix','pix','card_on_delivery','cash','online_card'])[1 + (i * 7) % 5];
    v_st := case when i % 37 = 0 then 'cancelled' else 'completed' end;
    insert into public.orders (tenant_id, unit_id, number, channel, type, status, customer_id, customer_name, customer_phone, address,
      subtotal_cents, delivery_fee_cents, total_cents, payment_method, payment_status, created_at, accepted_at, ready_at, completed_at, cancelled_at, cancel_reason,
      external_display_id)
    select t, u, v_n, v_ch::public.order_channel, case when v_fee = 0 then 'pickup'::public.order_type else 'delivery'::public.order_type end, v_st::public.order_status,
      c.id, c.name, c.phone, case when v_fee > 0 then jsonb_build_object('street','Rua Exemplo','number',(100 + i)::text,'neighborhood',hoods[1 + i % 8],'city','Belo Horizonte') end,
      0, v_fee, 0, v_pm::public.payment_method, case when v_st = 'completed' then 'paid'::public.payment_status else 'failed'::public.payment_status end,
      d, d + interval '2 minutes', d + make_interval(mins => 18 + i % 15), d + make_interval(mins => 40 + i % 20),
      case when v_st = 'cancelled' then d + interval '5 minutes' end, case when v_st = 'cancelled' then 'Cliente desistiu' end,
      case when v_ch in ('99food','keeta','aiqfome') then (5000 + i)::text end
    from public.customers c where c.id = v_cust returning id into v_ord;
    for k in 1..v_items loop
      q := 1 + ((i + k) % 2);
      insert into public.order_items (tenant_id, order_id, product_id, name, quantity, unit_price_cents, total_cents)
      values (t, v_ord, prods[1 + (i * k + k) % array_length(prods,1)], names[1 + (i * k + k) % array_length(prods,1)], q,
              prices[1 + (i * k + k) % array_length(prods,1)], q * prices[1 + (i * k + k) % array_length(prods,1)]);
      v_sub := v_sub + q * prices[1 + (i * k + k) % array_length(prods,1)];
    end loop;
    update public.orders set subtotal_cents = v_sub, total_cents = v_sub + v_fee where id = v_ord;
  end loop;

  -- pedidos "ao vivo" para o gestor de pedidos
  for i in 1..7 loop
    v_n := v_n + 1;
    v_st := (array['pending','pending','preparing','preparing','ready','dispatched','awaiting_payment'])[i];
    v_ch := (array['web','99food','keeta','web','aiqfome','web','web'])[i];
    select id into v_cust from public.customers where tenant_id = t order by md5(id::text || 'live' || i) limit 1;
    insert into public.orders (tenant_id, unit_id, number, channel, type, status, customer_id, customer_name, customer_phone, address,
      subtotal_cents, delivery_fee_cents, total_cents, payment_method, payment_status, created_at, accepted_at, external_display_id, notes)
    select t, u, v_n, v_ch::public.order_channel, case when i = 4 then 'pickup'::public.order_type else 'delivery'::public.order_type end, v_st::public.order_status, c.id, c.name, c.phone,
      jsonb_build_object('street','Rua da Bahia','number',(200 + i)::text,'neighborhood',hoods[1 + i % 8],'city','Belo Horizonte'),
      0, 600, 0, (case when i = 7 then 'pix' when v_ch <> 'web' then 'online_card' else 'card_on_delivery' end)::public.payment_method,
      (case when v_ch <> 'web' then 'paid' else 'pending' end)::public.payment_status,
      now() - make_interval(mins => (array[1,3,9,14,22,31,2])[i]), case when v_st not in ('pending','awaiting_payment') then now() - make_interval(mins => (array[1,3,8,13,20,28,2])[i]) end,
      case when v_ch <> 'web' then (7700 + i)::text end, case when i = 3 then 'Sem cebola, por favor' end
    from public.customers c where c.id = v_cust returning id into v_ord;
    v_sub := 0;
    for k in 1..(1 + i % 3) loop
      insert into public.order_items (tenant_id, order_id, product_id, name, quantity, unit_price_cents, total_cents)
      values (t, v_ord, prods[1 + (i + k * 3) % array_length(prods,1)], names[1 + (i + k * 3) % array_length(prods,1)], 1,
              prices[1 + (i + k * 3) % array_length(prods,1)], prices[1 + (i + k * 3) % array_length(prods,1)]);
      v_sub := v_sub + prices[1 + (i + k * 3) % array_length(prods,1)];
    end loop;
    update public.orders set subtotal_cents = v_sub, total_cents = v_sub + 600 where id = v_ord;
  end loop;

  update public.units set order_counter = v_n where id = u;
  -- estatísticas de CRM
  update public.customers c set orders_count = s.n, total_spent_cents = s.total, first_order_at = s.f, last_order_at = s.l
    from (select customer_id, count(*) n, sum(total_cents) total, min(created_at) f, max(created_at) l
          from public.orders where tenant_id = t and status = 'completed' group by customer_id) s
   where s.customer_id = c.id;
  delete from public.audit_logs where tenant_id = t;
end $$;
