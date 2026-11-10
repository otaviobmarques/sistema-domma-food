-- =====================================================================
-- Domma Food · 003 · Regras de negócio (RPCs)
-- Todo cálculo de preço, cupom, taxa e horário acontece AQUI, no banco.
-- O navegador só envia IDs e quantidades; nunca valores.
-- =====================================================================

-- ---------- Loja aberta? ----------
create or replace function private.unit_is_open_at(u public.units, at_ts timestamptz, respect_override boolean default true)
returns boolean language plpgsql stable set search_path = '' as $$
declare
  keys text[] := array['sun','mon','tue','wed','thu','fri','sat'];
  local_ts timestamp := at_ts at time zone u.timezone;
  dow int := extract(dow from local_ts)::int;
  t time := local_ts::time;
  iv jsonb; s time; e time;
begin
  if respect_override and u.is_open_override is not null then
    return u.is_open_override;
  end if;
  for iv in select * from jsonb_array_elements(coalesce(u.opening_hours->keys[dow+1], '[]'::jsonb)) loop
    s := (iv->>0)::time; e := (iv->>1)::time;
    if (s <= e and t >= s and t < e) or (s > e and t >= s) then return true; end if;
  end loop;
  -- intervalos que passam da meia-noite no dia anterior
  for iv in select * from jsonb_array_elements(coalesce(u.opening_hours->keys[((dow+6)%7)+1], '[]'::jsonb)) loop
    s := (iv->>0)::time; e := (iv->>1)::time;
    if s > e and t < e then return true; end if;
  end loop;
  return false;
end $$;

create or replace function private.category_available_at(c public.categories, tz text, at_ts timestamptz)
returns boolean language plpgsql stable set search_path = '' as $$
declare local_ts timestamp := at_ts at time zone tz;
begin
  if not c.active then return false; end if;
  if c.available_days is not null and not (extract(dow from local_ts)::smallint = any (c.available_days)) then
    return false;
  end if;
  if c.available_from is not null and c.available_to is not null then
    if c.available_from <= c.available_to then
      return local_ts::time >= c.available_from and local_ts::time < c.available_to;
    else
      return local_ts::time >= c.available_from or local_ts::time < c.available_to;
    end if;
  end if;
  return true;
end $$;

create or replace function private.only_digits(t text)
returns text language sql immutable as $$ select regexp_replace(coalesce(t,''), '[^0-9]', '', 'g') $$;

create or replace function private.norm(t text)
returns text language sql immutable set search_path = '' as $$
  select lower(trim(extensions.unaccent(coalesce(t,''))))
$$;

create or replace function private.haversine_km(lat1 float8, lng1 float8, lat2 float8, lng2 float8)
returns float8 language sql immutable as $$
  select 6371 * 2 * asin(sqrt(
    power(sin(radians(lat2 - lat1) / 2), 2) +
    cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2)))
$$;

-- ---------- Onboarding: cria empresa + loja + vínculo de dono ----------
create or replace function public.create_tenant(p_company text, p_unit_name text, p_slug text, p_seed boolean default true)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_tenant uuid; v_unit uuid; v_cat uuid; v_grp uuid; v_prod uuid;
begin
  if v_uid is null then raise exception 'Faça login para continuar.' using errcode = '42501'; end if;
  if (select count(*) from public.tenants where created_by = v_uid) >= 5 then
    raise exception 'Limite de empresas por usuário atingido.';
  end if;
  p_slug := lower(trim(p_slug));
  if exists (select 1 from public.units where slug = p_slug) then
    raise exception 'Este endereço (%) já está em uso.', p_slug;
  end if;

  insert into public.tenants (name, created_by) values (trim(p_company), v_uid) returning id into v_tenant;
  insert into public.units (tenant_id, name, slug) values (v_tenant, trim(p_unit_name), p_slug) returning id into v_unit;
  insert into public.memberships (tenant_id, user_id, role) values (v_tenant, v_uid, 'owner');

  if p_seed then
    insert into public.categories (tenant_id, name, position) values (v_tenant, 'Destaques', 0) returning id into v_cat;
    insert into public.products (tenant_id, category_id, name, description, price_cents, featured, position)
      values (v_tenant, v_cat, 'Produto de exemplo', 'Edite ou apague este item no painel.', 2990, true, 0)
      returning id into v_prod;
    insert into public.option_groups (tenant_id, name, min_select, max_select, price_rule)
      values (v_tenant, 'Adicionais', 0, 3, 'sum') returning id into v_grp;
    insert into public.options (tenant_id, group_id, name, price_cents, position) values
      (v_tenant, v_grp, 'Queijo extra', 400, 0), (v_tenant, v_grp, 'Bacon', 600, 1);
    insert into public.product_option_groups (product_id, group_id, tenant_id) values (v_prod, v_grp, v_tenant);
    insert into public.delivery_zones (tenant_id, unit_id, name, kind, radius_km, fee_cents, eta_min)
      values (v_tenant, v_unit, 'Até 3 km', 'radius', 3, 500, 40);
  end if;

  return jsonb_build_object('tenant_id', v_tenant, 'unit_id', v_unit, 'slug', p_slug);
end $$;

-- ---------- Cardápio público ----------
create or replace function public.get_store(p_slug text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  u public.units; t public.tenants; v_now timestamptz := now();
  v_open boolean; v_menu jsonb; v_zones jsonb;
begin
  select * into u from public.units where slug = lower(p_slug) and active;
  if not found then return null; end if;
  select * into t from public.tenants where id = u.tenant_id;
  if t.status = 'suspended' then return null; end if;
  v_open := private.unit_is_open_at(u, v_now);

  select coalesce(jsonb_agg(cat order by (cat->>'position')::int), '[]'::jsonb) into v_menu from (
    select jsonb_build_object(
      'id', c.id, 'name', c.name, 'description', c.description, 'position', c.position,
      'available_now', private.category_available_at(c, u.timezone, v_now),
      'products', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', p.id, 'name', p.name, 'description', p.description, 'image_url', p.image_url,
          'price_cents', coalesce(o.price_cents, p.price_cents),
          'promo_price_cents', case when o.price_cents is null then p.promo_price_cents end,
          'featured', p.featured, 'tags', p.tags,
          'available', (p.paused_until is null or p.paused_until < v_now) and coalesce(o.available, true),
          'option_groups', coalesce((
            select jsonb_agg(jsonb_build_object(
              'id', g.id, 'name', g.name, 'min', g.min_select, 'max', g.max_select,
              'allow_repeat', g.allow_repeat, 'price_rule', g.price_rule,
              'options', coalesce((select jsonb_agg(jsonb_build_object(
                  'id', op.id, 'name', op.name, 'description', op.description, 'price_cents', op.price_cents)
                  order by op.position, op.name)
                from public.options op where op.group_id = g.id and op.active), '[]'::jsonb)
            ) order by pog.position)
            from public.product_option_groups pog join public.option_groups g on g.id = pog.group_id
            where pog.product_id = p.id), '[]'::jsonb)
        ) order by p.position, p.name)
        from public.products p
        left join public.product_unit_overrides o on o.product_id = p.id and o.unit_id = u.id
        where p.category_id = c.id and p.active and 'web' = any (p.channels)), '[]'::jsonb)
    ) as cat
    from public.categories c where c.tenant_id = u.tenant_id and c.active
  ) s where jsonb_array_length(cat->'products') > 0;

  select coalesce(jsonb_agg(jsonb_build_object(
      'id', z.id, 'name', z.name, 'kind', z.kind, 'radius_km', z.radius_km,
      'neighborhoods', z.neighborhoods, 'fee_cents', z.fee_cents,
      'min_order_cents', z.min_order_cents, 'free_above_cents', z.free_above_cents, 'eta_min', z.eta_min)
      order by z.fee_cents), '[]'::jsonb)
    into v_zones from public.delivery_zones z where z.unit_id = u.id and z.active;

  return jsonb_build_object(
    'unit', jsonb_build_object(
      'id', u.id, 'slug', u.slug, 'name', u.name, 'description', u.description,
      'logo_url', u.logo_url, 'cover_url', u.cover_url, 'primary_color', u.primary_color,
      'phone', u.phone, 'whatsapp', u.whatsapp,
      'neighborhood', u.neighborhood, 'city', u.city, 'state', u.state,
      'has_location', u.lat is not null,
      'is_open', v_open, 'opening_hours', u.opening_hours,
      'accepts_delivery', u.accepts_delivery, 'accepts_pickup', u.accepts_pickup,
      'accepts_scheduling', u.accepts_scheduling,
      'min_order_cents', u.min_order_cents, 'prep_time_min', u.prep_time_min,
      'pickup_time_min', u.pickup_time_min,
      'accepted_payments', to_jsonb(u.accepted_payments)),
    'zones', v_zones,
    'menu', v_menu);
end $$;

-- ---------- Cálculo do pedido (compartilhado por cotação e criação) ----------
create or replace function private.compute_order(p jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  u public.units; t public.tenants;
  v_at timestamptz := coalesce((p->>'scheduled_for')::timestamptz, now());
  v_type text := p->>'type';
  v_items jsonb := '[]'::jsonb; it jsonb; opt jsonb;
  pr record; g record; v_base int; v_unit_price int; v_qty int;
  v_opts jsonb; v_group_total int; v_count int; v_prices int[];
  v_subtotal int := 0; v_fee int := 0; v_discount int := 0;
  z public.delivery_zones; v_zone_id uuid;
  c public.coupons; v_phone text; v_customer uuid; v_used int;
  v_lat float8 := (p->'address'->>'lat')::float8; v_lng float8 := (p->'address'->>'lng')::float8;
  v_pm text := p->>'payment_method';
begin
  select * into u from public.units where slug = lower(p->>'slug') and active;
  if not found then raise exception 'Loja não encontrada.'; end if;
  select * into t from public.tenants where id = u.tenant_id;
  if t.status = 'suspended' then raise exception 'Loja indisponível no momento.'; end if;

  -- Horário / agendamento
  if p ? 'scheduled_for' and p->>'scheduled_for' is not null then
    if not u.accepts_scheduling then raise exception 'Esta loja não aceita agendamento.'; end if;
    if v_at < now() + interval '20 minutes' or v_at > now() + interval '7 days' then
      raise exception 'Escolha um horário entre 20 minutos e 7 dias a partir de agora.';
    end if;
    if not private.unit_is_open_at(u, v_at, false) then
      raise exception 'A loja estará fechada no horário escolhido.';
    end if;
  elsif not private.unit_is_open_at(u, now()) then
    raise exception 'A loja está fechada agora.%',
      case when u.accepts_scheduling then ' Você pode agendar seu pedido.' else '' end;
  end if;

  if v_type = 'delivery' and not u.accepts_delivery then raise exception 'Esta loja não faz entregas.'; end if;
  if v_type = 'pickup' and not u.accepts_pickup then raise exception 'Esta loja não aceita retirada.'; end if;
  if v_type not in ('delivery','pickup') then raise exception 'Tipo de pedido inválido.'; end if;
  if v_pm is null or not (v_pm::public.payment_method = any (u.accepted_payments)) then
    raise exception 'Forma de pagamento não aceita.';
  end if;

  if jsonb_typeof(p->'items') <> 'array' or jsonb_array_length(p->'items') = 0 then
    raise exception 'O carrinho está vazio.';
  end if;
  if jsonb_array_length(p->'items') > 60 then raise exception 'Itens demais no pedido.'; end if;

  -- Itens
  for it in select * from jsonb_array_elements(p->'items') loop
    v_qty := coalesce((it->>'quantity')::int, 1);
    if v_qty < 1 or v_qty > 99 then raise exception 'Quantidade inválida.'; end if;

    select pd.*, c2.name as cat_name, o.price_cents as ov_price, coalesce(o.available, true) as ov_available,
           private.category_available_at(c2, u.timezone, v_at) as cat_ok
      into pr
      from public.products pd
      join public.categories c2 on c2.id = pd.category_id
      left join public.product_unit_overrides o on o.product_id = pd.id and o.unit_id = u.id
     where pd.id = (it->>'product_id')::uuid and pd.tenant_id = u.tenant_id;
    if not found or not pr.active or not pr.ov_available or not ('web' = any (pr.channels)) then
      raise exception 'Um item do carrinho não está mais disponível.';
    end if;
    if pr.paused_until is not null and pr.paused_until > now() then
      raise exception '"%" esgotou. Remova do carrinho para continuar.', pr.name;
    end if;
    if not pr.cat_ok then raise exception '"%" não está disponível neste horário.', pr.name; end if;

    v_base := coalesce(pr.ov_price, pr.promo_price_cents, pr.price_cents);
    v_unit_price := v_base;
    v_opts := '[]'::jsonb;

    -- Complementos por grupo
    for g in select og.* from public.product_option_groups pog
             join public.option_groups og on og.id = pog.group_id
             where pog.product_id = pr.id order by pog.position loop
      v_count := 0; v_prices := '{}'; v_group_total := 0;
      for opt in select * from jsonb_array_elements(coalesce(it->'options','[]'::jsonb)) loop
        declare
          o2 public.options; oq int := coalesce((opt->>'quantity')::int, 1);
        begin
          select * into o2 from public.options where id = (opt->>'option_id')::uuid and group_id = g.id and active;
          if found then
            if oq < 1 or oq > 20 or (oq > 1 and not g.allow_repeat) then raise exception 'Quantidade de complemento inválida.'; end if;
            v_count := v_count + oq;
            for i in 1..oq loop v_prices := v_prices || o2.price_cents; end loop;
            v_opts := v_opts || jsonb_build_object('group', g.name, 'option_id', o2.id, 'name', o2.name,
                                                   'price_cents', o2.price_cents, 'quantity', oq);
          end if;
        end;
      end loop;
      if v_count < g.min_select then raise exception 'Escolha pelo menos % em "%" (%).', g.min_select, g.name, pr.name; end if;
      if v_count > g.max_select then raise exception 'Escolha no máximo % em "%" (%).', g.max_select, g.name, pr.name; end if;
      if v_count > 0 then
        v_group_total := case g.price_rule
          when 'sum' then (select sum(x) from unnest(v_prices) x)
          when 'max' then (select max(x) from unnest(v_prices) x)
          when 'avg' then (select ceil(avg(x)) from unnest(v_prices) x)::int
        end;
      end if;
      v_unit_price := v_unit_price + coalesce(v_group_total, 0);
    end loop;

    -- opções enviadas que não pertencem ao produto
    if (select count(*) from jsonb_array_elements(coalesce(it->'options','[]'::jsonb))) >
       jsonb_array_length(v_opts) then
      raise exception 'Complemento inválido para "%".', pr.name;
    end if;

    v_items := v_items || jsonb_build_object(
      'product_id', pr.id, 'name', pr.name, 'quantity', v_qty,
      'unit_price_cents', v_unit_price, 'total_cents', v_unit_price * v_qty,
      'options', v_opts, 'notes', left(nullif(trim(it->>'notes'), ''), 300));
    v_subtotal := v_subtotal + v_unit_price * v_qty;
  end loop;

  if v_subtotal < u.min_order_cents then
    raise exception 'Pedido mínimo da loja: R$ %.', to_char(u.min_order_cents / 100.0, 'FM999990D00');
  end if;

  -- Taxa de entrega
  if v_type = 'delivery' then
    if v_lat is not null and v_lng is not null and u.lat is not null then
      select * into z from public.delivery_zones dz
       where dz.unit_id = u.id and dz.active and dz.kind = 'radius'
         and private.haversine_km(u.lat, u.lng, v_lat, v_lng) <= dz.radius_km
       order by dz.radius_km limit 1;
    end if;
    if z.id is null then
      select * into z from public.delivery_zones dz
       where dz.unit_id = u.id and dz.active and dz.kind = 'neighborhood'
         and exists (select 1 from unnest(dz.neighborhoods) nb
                     where private.norm(nb) = private.norm(p->'address'->>'neighborhood'))
       order by dz.fee_cents limit 1;
    end if;
    if z.id is null then raise exception 'Infelizmente não entregamos neste endereço.'; end if;
    if v_subtotal < z.min_order_cents then
      raise exception 'Pedido mínimo para sua região: R$ %.', to_char(z.min_order_cents / 100.0, 'FM999990D00');
    end if;
    v_zone_id := z.id;
    v_fee := case when z.free_above_cents is not null and v_subtotal >= z.free_above_cents then 0 else z.fee_cents end;
    if coalesce(trim(p->'address'->>'street'), '') = '' then raise exception 'Informe o endereço de entrega.'; end if;
  end if;

  -- Cupom
  v_phone := private.only_digits(p->'customer'->>'phone');
  if coalesce(trim(p->>'coupon_code'), '') <> '' then
    select * into c from public.coupons
     where tenant_id = u.tenant_id and code = upper(trim(p->>'coupon_code')) and active;
    if not found then raise exception 'Cupom inválido.'; end if;
    if c.starts_at is not null and now() < c.starts_at then raise exception 'Este cupom ainda não está valendo.'; end if;
    if c.ends_at is not null and now() > c.ends_at then raise exception 'Este cupom expirou.'; end if;
    if c.max_uses is not null and c.uses_count >= c.max_uses then raise exception 'Este cupom esgotou.'; end if;
    if v_subtotal < c.min_order_cents then
      raise exception 'Cupom válido para pedidos acima de R$ %.', to_char(c.min_order_cents / 100.0, 'FM999990D00');
    end if;
    select id into v_customer from public.customers where tenant_id = u.tenant_id and phone = v_phone;
    if c.first_order_only and v_customer is not null and exists (
        select 1 from public.orders where customer_id = v_customer and status <> 'cancelled') then
      raise exception 'Cupom válido só para o primeiro pedido.';
    end if;
    if c.max_uses_per_customer is not null and v_customer is not null then
      select count(*) into v_used from public.coupon_redemptions where coupon_id = c.id and customer_id = v_customer;
      if v_used >= c.max_uses_per_customer then raise exception 'Você já usou este cupom.'; end if;
    end if;
    v_discount := case c.kind
      when 'percent' then least(floor(v_subtotal * c.value / 100.0)::int, coalesce(c.max_discount_cents, 2147483647))
      when 'fixed' then least(c.value, v_subtotal)
      when 'free_delivery' then v_fee
    end;
  end if;

  return jsonb_build_object(
    'tenant_id', u.tenant_id, 'unit_id', u.id, 'auto_accept', u.auto_accept,
    'prep_time_min', u.prep_time_min, 'pickup_time_min', u.pickup_time_min,
    'eta_min', case when v_type = 'delivery' then z.eta_min else u.pickup_time_min end,
    'items', v_items, 'subtotal_cents', v_subtotal, 'delivery_fee_cents', v_fee,
    'discount_cents', v_discount, 'total_cents', v_subtotal + v_fee - v_discount,
    'zone_id', v_zone_id, 'coupon_id', c.id, 'coupon_code', c.code);
end $$;

create or replace function public.quote_order(p jsonb)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare r jsonb;
begin
  r := private.compute_order(p);
  return r - 'tenant_id' - 'auto_accept';
end $$;

-- ---------- Criação do pedido ----------
create or replace function public.place_order(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  q jsonb; v_unit public.units; v_number int; v_order uuid; v_token text;
  v_phone text := private.only_digits(p->'customer'->>'phone');
  v_name text := left(trim(p->'customer'->>'name'), 120);
  v_customer uuid; v_status public.order_status; v_pm public.payment_method;
  v_change int := (p->>'change_for_cents')::int; it jsonb;
begin
  if coalesce(v_name, '') = '' then raise exception 'Informe seu nome.'; end if;
  if length(v_phone) < 10 or length(v_phone) > 13 then raise exception 'Informe um WhatsApp válido com DDD.'; end if;

  q := private.compute_order(p);
  v_pm := (p->>'payment_method')::public.payment_method;

  -- Proteção contra abuso: no máximo 5 pedidos por telefone a cada 10 minutos
  if (select count(*) from public.orders
       where tenant_id = (q->>'tenant_id')::uuid and customer_phone = v_phone
         and created_at > now() - interval '10 minutes') >= 5 then
    raise exception 'Muitos pedidos em pouco tempo. Aguarde alguns minutos.';
  end if;

  if v_pm = 'cash' and v_change is not null and v_change < (q->>'total_cents')::int then
    raise exception 'O troco deve ser para um valor maior que o total.';
  end if;

  -- Numeração sequencial por loja (trava a linha da unidade)
  update public.units set order_counter = order_counter + 1
   where id = (q->>'unit_id')::uuid returning * into v_unit;
  v_number := v_unit.order_counter;

  -- Cliente (CRM)
  insert into public.customers (tenant_id, name, phone, opt_in_marketing)
  values ((q->>'tenant_id')::uuid, v_name, v_phone, coalesce((p->'customer'->>'opt_in')::boolean, false))
  on conflict (tenant_id, phone) do update
    set name = excluded.name,
        opt_in_marketing = public.customers.opt_in_marketing or excluded.opt_in_marketing
  returning id into v_customer;

  v_status := case
    when v_pm = 'pix' then 'awaiting_payment'
    when (q->>'auto_accept')::boolean then 'preparing'
    else 'pending' end;

  insert into public.orders (
    tenant_id, unit_id, number, channel, type, status, customer_id, customer_name, customer_phone,
    address, zone_id, scheduled_for, subtotal_cents, discount_cents, delivery_fee_cents, total_cents,
    payment_method, change_for_cents, coupon_id, coupon_code, notes, accepted_at, estimated_ready_at)
  values (
    (q->>'tenant_id')::uuid, (q->>'unit_id')::uuid, v_number, 'web', (p->>'type')::public.order_type,
    v_status, v_customer, v_name, v_phone,
    case when p->>'type' = 'delivery' then jsonb_build_object(
      'street', left(p->'address'->>'street',150), 'number', left(p->'address'->>'number',20),
      'complement', left(p->'address'->>'complement',100), 'neighborhood', left(p->'address'->>'neighborhood',80),
      'city', left(p->'address'->>'city',80), 'reference', left(p->'address'->>'reference',150),
      'lat', (p->'address'->>'lat')::float8, 'lng', (p->'address'->>'lng')::float8) end,
    (q->>'zone_id')::uuid, (p->>'scheduled_for')::timestamptz,
    (q->>'subtotal_cents')::int, (q->>'discount_cents')::int, (q->>'delivery_fee_cents')::int,
    (q->>'total_cents')::int, v_pm, case when v_pm = 'cash' then v_change end,
    (q->>'coupon_id')::uuid, q->>'coupon_code', left(nullif(trim(p->>'notes'), ''), 500),
    case when v_status = 'preparing' then now() end,
    coalesce((p->>'scheduled_for')::timestamptz, now()) + make_interval(mins => (q->>'eta_min')::int))
  returning id, public_token into v_order, v_token;

  for it in select * from jsonb_array_elements(q->'items') loop
    insert into public.order_items (tenant_id, order_id, product_id, name, quantity, unit_price_cents, total_cents, options, notes)
    values ((q->>'tenant_id')::uuid, v_order, (it->>'product_id')::uuid, it->>'name', (it->>'quantity')::int,
            (it->>'unit_price_cents')::int, (it->>'total_cents')::int, it->'options', it->>'notes');
  end loop;

  insert into public.payments (tenant_id, order_id, method, amount_cents)
  values ((q->>'tenant_id')::uuid, v_order, v_pm, (q->>'total_cents')::int);

  insert into public.order_events (tenant_id, order_id, from_status, to_status, note)
  values ((q->>'tenant_id')::uuid, v_order, null, v_status, 'Pedido criado pelo cardápio digital');

  if q->>'coupon_id' is not null then
    update public.coupons set uses_count = uses_count + 1
     where id = (q->>'coupon_id')::uuid and (max_uses is null or uses_count < max_uses);
    if not found then raise exception 'Este cupom esgotou.'; end if;
    insert into public.coupon_redemptions (tenant_id, coupon_id, customer_id, order_id, discount_cents)
    values ((q->>'tenant_id')::uuid, (q->>'coupon_id')::uuid, v_customer, v_order, (q->>'discount_cents')::int);
  end if;

  return jsonb_build_object('order_id', v_order, 'token', v_token, 'number', v_number,
                            'status', v_status, 'total_cents', (q->>'total_cents')::int);
end $$;

-- ---------- Acompanhamento público (pelo token secreto) ----------
create or replace function public.get_order_by_token(p_token text)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'number', o.number, 'status', o.status, 'type', o.type,
    'customer_name', split_part(o.customer_name, ' ', 1),
    'created_at', o.created_at, 'scheduled_for', o.scheduled_for,
    'estimated_ready_at', o.estimated_ready_at,
    'subtotal_cents', o.subtotal_cents, 'discount_cents', o.discount_cents,
    'delivery_fee_cents', o.delivery_fee_cents, 'total_cents', o.total_cents,
    'payment_method', o.payment_method, 'payment_status', o.payment_status,
    'change_for_cents', o.change_for_cents, 'cancel_reason', o.cancel_reason,
    'address', case when o.address is not null then jsonb_build_object(
        'street', o.address->>'street', 'number', o.address->>'number',
        'neighborhood', o.address->>'neighborhood') end,
    'pix', case when o.payment_method = 'pix' and o.payment_status = 'pending' and o.status = 'awaiting_payment'
      then jsonb_build_object('key', u.pix_key, 'merchant_name', u.pix_merchant_name,
                              'merchant_city', u.pix_merchant_city,
                              'expires_at', o.created_at + make_interval(mins => u.pix_expires_min)) end,
    'unit', jsonb_build_object('name', u.name, 'slug', u.slug, 'whatsapp', u.whatsapp, 'phone', u.phone,
                               'logo_url', u.logo_url, 'primary_color', u.primary_color),
    'items', (select coalesce(jsonb_agg(jsonb_build_object('name', i.name, 'quantity', i.quantity,
                'total_cents', i.total_cents, 'options', i.options, 'notes', i.notes)), '[]'::jsonb)
              from public.order_items i where i.order_id = o.id),
    'events', (select coalesce(jsonb_agg(jsonb_build_object('status', e.to_status, 'at', e.created_at) order by e.created_at), '[]'::jsonb)
               from public.order_events e where e.order_id = o.id))
  from public.orders o join public.units u on u.id = o.unit_id
  where o.public_token = p_token and length(p_token) = 36;
$$;

-- ---------- Máquina de estados do pedido ----------
create or replace function private.allowed_transition(f public.order_status, t public.order_status, ty public.order_type)
returns boolean language sql immutable as $$
  select case f
    when 'awaiting_payment' then t in ('pending','preparing','cancelled')
    when 'pending' then t in ('preparing','cancelled')
    when 'preparing' then t in ('ready','cancelled')
    when 'ready' then (t = 'dispatched' and ty = 'delivery') or (t = 'awaiting_pickup' and ty <> 'delivery')
                      or t in ('completed','cancelled')
    when 'dispatched' then t in ('completed','cancelled')
    when 'awaiting_pickup' then t in ('completed','cancelled')
    else false end
$$;

create or replace function public.set_order_status(p_order_id uuid, p_status public.order_status, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare o public.orders; v_role public.member_role;
begin
  select * into o from public.orders where id = p_order_id for update;
  if not found or not private.can_access_unit(o.unit_id) then raise exception 'Pedido não encontrado.' using errcode = '42501'; end if;
  select role into v_role from public.memberships where tenant_id = o.tenant_id and user_id = auth.uid();
  if v_role = 'waiter' then raise exception 'Sem permissão.' using errcode = '42501'; end if;
  if v_role = 'kitchen' and not (o.status = 'preparing' and p_status = 'ready') then
    raise exception 'A cozinha só pode marcar pedidos como prontos.' using errcode = '42501';
  end if;
  if v_role = 'courier' and not (p_status in ('dispatched','completed') and o.type = 'delivery') then
    raise exception 'Sem permissão.' using errcode = '42501';
  end if;
  if not private.allowed_transition(o.status, p_status, o.type) then
    raise exception 'Mudança de status inválida.';
  end if;
  if p_status = 'cancelled' and coalesce(trim(p_reason), '') = '' then
    raise exception 'Informe o motivo do cancelamento.';
  end if;

  update public.orders set
    status = p_status,
    accepted_at = case when p_status = 'preparing' then now() else accepted_at end,
    ready_at = case when p_status = 'ready' then now() else ready_at end,
    dispatched_at = case when p_status = 'dispatched' then now() else dispatched_at end,
    completed_at = case when p_status = 'completed' then now() else completed_at end,
    cancelled_at = case when p_status = 'cancelled' then now() else cancelled_at end,
    cancel_reason = case when p_status = 'cancelled' then left(p_reason, 300) else cancel_reason end,
    payment_status = case when p_status = 'completed' and payment_method in ('cash','card_on_delivery','voucher')
                          then 'paid'::public.payment_status else payment_status end,
    paid_at = case when p_status = 'completed' and payment_status = 'pending' then now() else paid_at end
  where id = o.id;

  insert into public.order_events (tenant_id, order_id, from_status, to_status, note, actor_id)
  values (o.tenant_id, o.id, o.status, p_status, left(p_reason, 300), auth.uid());

  if p_status = 'completed' then
    update public.payments set status = 'paid' where order_id = o.id and status = 'pending';
    update public.customers set
      orders_count = orders_count + 1, total_spent_cents = total_spent_cents + o.total_cents,
      first_order_at = coalesce(first_order_at, o.created_at), last_order_at = o.created_at
    where id = o.customer_id;
  elsif p_status = 'cancelled' then
    if o.coupon_id is not null then
      update public.coupons set uses_count = greatest(uses_count - 1, 0) where id = o.coupon_id;
      delete from public.coupon_redemptions where order_id = o.id;
    end if;
    -- Pagamentos confirmados ficam marcados para estorno manual / via gateway
    update public.payments set status = case when status = 'paid' then 'refunded'::public.payment_status else 'failed'::public.payment_status end
     where order_id = o.id;
    insert into public.audit_logs (tenant_id, actor_id, action, entity, entity_id, before, after, ip)
    values (o.tenant_id, auth.uid(), 'cancel', 'orders', o.id::text,
            jsonb_build_object('status', o.status), jsonb_build_object('reason', p_reason), private.request_ip());
  end if;

  return jsonb_build_object('id', o.id, 'status', p_status);
end $$;

-- ---------- Confirmação manual do Pix ----------
create or replace function public.confirm_payment(p_order_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare o public.orders; u public.units; v_next public.order_status;
begin
  select * into o from public.orders where id = p_order_id for update;
  if not found or not private.can_access_unit(o.unit_id)
     or not private.has_role(o.tenant_id, array['owner','manager','cashier','attendant']::public.member_role[]) then
    raise exception 'Sem permissão.' using errcode = '42501';
  end if;
  if o.payment_status = 'paid' then return jsonb_build_object('id', o.id, 'status', o.status); end if;
  if o.status = 'cancelled' then raise exception 'Pedido cancelado.'; end if;
  select * into u from public.units where id = o.unit_id;
  v_next := case when o.status = 'awaiting_payment' then
              case when u.auto_accept then 'preparing'::public.order_status else 'pending'::public.order_status end
            else o.status end;
  update public.orders set payment_status = 'paid', paid_at = now(), status = v_next,
         accepted_at = case when v_next = 'preparing' then now() else accepted_at end
   where id = o.id;
  update public.payments set status = 'paid', confirmed_by = auth.uid() where order_id = o.id;
  if v_next <> o.status then
    insert into public.order_events (tenant_id, order_id, from_status, to_status, note, actor_id)
    values (o.tenant_id, o.id, o.status, v_next, 'Pagamento Pix confirmado', auth.uid());
  end if;
  return jsonb_build_object('id', o.id, 'status', v_next);
end $$;

-- ---------- Expira Pix não pago (roda a cada minuto via pg_cron) ----------
create or replace function private.expire_pix_orders()
returns integer language plpgsql security definer set search_path = '' as $$
declare r record; n int := 0;
begin
  for r in select o.id, o.tenant_id, o.coupon_id from public.orders o join public.units u on u.id = o.unit_id
            where o.status = 'awaiting_payment' and o.payment_status = 'pending'
              and o.created_at < now() - make_interval(mins => u.pix_expires_min)
            for update of o skip locked loop
    update public.orders set status = 'cancelled', cancelled_at = now(), cancel_reason = 'Pix não pago no prazo'
     where id = r.id;
    update public.payments set status = 'failed' where order_id = r.id;
    insert into public.order_events (tenant_id, order_id, from_status, to_status, note)
    values (r.tenant_id, r.id, 'awaiting_payment', 'cancelled', 'Pix expirado');
    if r.coupon_id is not null then
      update public.coupons set uses_count = greatest(uses_count - 1, 0) where id = r.coupon_id;
      delete from public.coupon_redemptions where order_id = r.id;
    end if;
    n := n + 1;
  end loop;
  return n;
end $$;

create extension if not exists pg_cron;
select cron.schedule('domma-expire-pix', '* * * * *', $$select private.expire_pix_orders()$$);

-- ---------- Dashboard ----------
create or replace function public.dashboard_stats(p_unit_id uuid, p_from timestamptz, p_to timestamptz)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_tenant uuid; v_tz text;
begin
  select tenant_id, timezone into v_tenant, v_tz from public.units where id = p_unit_id;
  if v_tenant is null or not private.can_access_unit(p_unit_id)
     or not private.has_role(v_tenant, array['owner','manager']::public.member_role[]) then
    raise exception 'Sem permissão.' using errcode = '42501';
  end if;
  if p_to - p_from > interval '400 days' then raise exception 'Período longo demais.'; end if;

  return (
    with o as (select * from public.orders where unit_id = p_unit_id and created_at >= p_from and created_at < p_to),
         ok as (select * from o where status <> 'cancelled')
    select jsonb_build_object(
      'revenue_cents', coalesce((select sum(total_cents) from ok), 0),
      'orders', (select count(*) from ok),
      'avg_ticket_cents', coalesce((select round(avg(total_cents)) from ok), 0),
      'cancelled', (select count(*) from o where status = 'cancelled'),
      'new_customers', (select count(*) from public.customers c where c.tenant_id = v_tenant
                          and c.created_at >= p_from and c.created_at < p_to),
      'avg_prep_min', (select round(avg(extract(epoch from ready_at - accepted_at) / 60)) from ok
                        where ready_at is not null and accepted_at is not null),
      'by_hour', (select coalesce(jsonb_agg(jsonb_build_object('hour', h, 'orders', n, 'revenue_cents', r) order by h), '[]'::jsonb)
                    from (select extract(hour from created_at at time zone v_tz)::int h, count(*) n, sum(total_cents) r
                          from ok group by 1) x),
      'by_day', (select coalesce(jsonb_agg(jsonb_build_object('day', d, 'orders', n, 'revenue_cents', r) order by d), '[]'::jsonb)
                   from (select (created_at at time zone v_tz)::date d, count(*) n, sum(total_cents) r
                         from ok group by 1) x),
      'by_payment', (select coalesce(jsonb_agg(jsonb_build_object('method', m, 'orders', n, 'revenue_cents', r)), '[]'::jsonb)
                       from (select payment_method m, count(*) n, sum(total_cents) r from ok group by 1) x),
      'by_type', (select coalesce(jsonb_agg(jsonb_build_object('type', ty, 'orders', n)), '[]'::jsonb)
                    from (select type ty, count(*) n from ok group by 1) x),
      'top_products', (select coalesce(jsonb_agg(jsonb_build_object('name', name, 'quantity', q, 'revenue_cents', r) order by q desc), '[]'::jsonb)
                         from (select i.name, sum(i.quantity) q, sum(i.total_cents) r
                               from public.order_items i join ok on ok.id = i.order_id
                               group by i.name order by 2 desc limit 10) x)
    ));
end $$;

-- ---------- Permissões de execução ----------
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function public.get_store(text) to anon, authenticated;
grant execute on function public.quote_order(jsonb) to anon, authenticated;
grant execute on function public.place_order(jsonb) to anon, authenticated;
grant execute on function public.get_order_by_token(text) to anon, authenticated;
grant execute on function public.create_tenant(text, text, text, boolean) to authenticated;
grant execute on function public.set_order_status(uuid, public.order_status, text) to authenticated;
grant execute on function public.confirm_payment(uuid) to authenticated;
grant execute on function public.dashboard_stats(uuid, timestamptz, timestamptz) to authenticated;

-- Funções criadas no futuro não ficam expostas por padrão
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;
