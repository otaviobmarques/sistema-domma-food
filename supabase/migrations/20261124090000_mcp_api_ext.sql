-- =====================================================================
-- Domma Food · 051 · Consultas extras da API (usadas pelo servidor MCP)
--   - reports.sales   resumo de vendas por período (orders:read)
--   - orders.find     pedido pelo número, como o lojista fala ("#379")
--   - products.search produto pelo nome ("pizza de calabresa")
-- Mesma regra de chave/escopo/loja da api_call.
-- =====================================================================

create or replace function private.fold(p text)
returns text language sql immutable set search_path = '' as $$
  select lower(translate(coalesce(p, ''), 'ÁÀÂÃÄáàâãäÉÈÊËéèêëÍÌÎÏíìîïÓÒÔÕÖóòôõöÚÙÛÜúùûüÇçÑñ',
                                          'AAAAAaaaaaEEEEeeeeIIIIiiiiOOOOOoooooUUUUuuuuCcNn'));
$$;

create or replace function public.api_call_ext(p_key_id uuid, p_op text, p jsonb default '{}')
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare k public.api_keys; v_scope text; v_units uuid[]; v_tz text; v_from timestamptz; v_to timestamptz; v jsonb; o public.orders; v_n int;
begin
  perform private.assert_service_role();
  select * into k from public.api_keys where id = p_key_id and revoked_at is null;
  if not found then return jsonb_build_object('error', 'invalid_key'); end if;
  v_scope := case p_op when 'reports.sales' then 'orders:read' when 'orders.find' then 'orders:read' when 'products.search' then 'menu:read' else 'unknown' end;
  if v_scope = 'unknown' then return jsonb_build_object('error', 'not_found'); end if;
  if not (v_scope = any (k.scopes) or (p_op = 'products.search' and 'menu:write' = any (k.scopes))) then
    return jsonb_build_object('error', 'forbidden', 'message', 'A chave não tem o escopo ' || v_scope || '.'); end if;
  select coalesce(array_agg(id), '{}') into v_units from public.units where tenant_id = k.tenant_id and (k.unit_id is null or id = k.unit_id)
    and (not p ? 'unit_id' or id = (p->>'unit_id')::uuid);
  if cardinality(v_units) = 0 then return jsonb_build_object('error', 'not_found'); end if;
  select coalesce((select timezone from public.units where id = v_units[1]), 'America/Sao_Paulo') into v_tz;

  if p_op = 'reports.sales' then
    -- padrão: hoje (no fuso da loja); "to" é exclusivo
    v_from := coalesce((p->>'from')::timestamptz, (date_trunc('day', now() at time zone v_tz)) at time zone v_tz);
    v_to := coalesce((p->>'to')::timestamptz, now());
    if v_to <= v_from or v_to - v_from > interval '400 days' then return jsonb_build_object('error', 'invalid', 'message', 'Período inválido (máximo 400 dias).'); end if;
    return (
      with o as (select * from public.orders where unit_id = any (v_units) and created_at >= v_from and created_at < v_to),
           ok as (select * from o where status <> 'cancelled')
      select jsonb_build_object('period', jsonb_build_object('from', v_from, 'to', v_to, 'timezone', v_tz),
        'totals', jsonb_build_object('orders', (select count(*) from ok), 'revenue_cents', coalesce((select sum(total_cents) from ok), 0),
          'avg_ticket_cents', coalesce((select round(avg(total_cents)) from ok), 0), 'discount_cents', coalesce((select sum(discount_cents) from ok), 0),
          'delivery_fee_cents', coalesce((select sum(delivery_fee_cents) from ok), 0),
          'cancelled_orders', (select count(*) from o where status = 'cancelled'),
          'open_orders', (select count(*) from o where status in ('awaiting_payment','pending','preparing','ready','dispatched','awaiting_pickup'))),
        'by_channel', coalesce((select jsonb_object_agg(c, jsonb_build_object('orders', n, 'revenue_cents', r)) from
            (select channel::text c, count(*) n, sum(total_cents) r from ok group by 1) x), '{}'::jsonb),
        'by_type', coalesce((select jsonb_object_agg(c, jsonb_build_object('orders', n, 'revenue_cents', r)) from
            (select type::text c, count(*) n, sum(total_cents) r from ok group by 1) x), '{}'::jsonb),
        'by_payment', coalesce((select jsonb_object_agg(c, jsonb_build_object('orders', n, 'revenue_cents', r)) from
            (select payment_method::text c, count(*) n, sum(total_cents) r from ok group by 1) x), '{}'::jsonb),
        'by_day', case when v_to - v_from > interval '1 day' then coalesce((select jsonb_agg(jsonb_build_object('day', d, 'orders', n, 'revenue_cents', r) order by d)
            from (select (created_at at time zone v_tz)::date d, count(*) n, sum(total_cents) r from ok group by 1) z), '[]'::jsonb) end,
        'by_hour', case when v_to - v_from <= interval '1 day' then coalesce((select jsonb_agg(jsonb_build_object('hour', h, 'orders', n, 'revenue_cents', r) order by h)
            from (select extract(hour from created_at at time zone v_tz)::int h, count(*) n, sum(total_cents) r from ok group by 1) z), '[]'::jsonb) end,
        'top_products', coalesce((select jsonb_agg(jsonb_build_object('name', name, 'quantity', q, 'revenue_cents', r) order by q desc, r desc)
            from (select i.name, sum(i.quantity) q, sum(i.total_cents) r from public.order_items i join ok on ok.id = i.order_id
                  group by i.name order by 2 desc, 3 desc limit 10) w), '[]'::jsonb)));

  elsif p_op = 'orders.find' then
    select count(*) into v_n from public.orders where unit_id = any (v_units) and number = (p->>'number')::int;
    if v_n = 0 then return jsonb_build_object('error', 'not_found'); end if;
    if v_n > 1 then
      return jsonb_build_object('error', 'invalid', 'message', 'Há um pedido com esse número em mais de uma loja; informe a loja.',
        'options', (select jsonb_agg(jsonb_build_object('order_id', x.id, 'unit_id', x.unit_id, 'unit_name', u.name))
                    from public.orders x join public.units u on u.id = x.unit_id where x.unit_id = any (v_units) and x.number = (p->>'number')::int));
    end if;
    select * into o from public.orders where unit_id = any (v_units) and number = (p->>'number')::int;
    return jsonb_build_object('data', private.api_order_json(o));

  elsif p_op = 'products.search' then
    select coalesce(jsonb_agg(x order by x.score, x.name), '[]'::jsonb) into v from (
      select pr.id, pr.name, c.name as category, coalesce(ov.price_cents, pr.price_cents) as price_cents, pr.promo_price_cents,
        pr.active and (pr.paused_until is null or pr.paused_until <= now()) and coalesce(ov.available, true) as available, pr.paused_until,
        case when private.fold(pr.name) = private.fold(p->>'q') then 0 when private.fold(pr.name) like private.fold(p->>'q') || '%' then 1 else 2 end as score
      from public.products pr join public.categories c on c.id = pr.category_id
      left join public.product_unit_overrides ov on ov.product_id = pr.id and ov.unit_id = v_units[1] and cardinality(v_units) = 1
      where pr.tenant_id = k.tenant_id and length(trim(coalesce(p->>'q', ''))) >= 2
        and private.fold(pr.name) like '%' || replace(private.fold(trim(p->>'q')), ' ', '%') || '%'
      order by 8, 2 limit 10) x;
    return jsonb_build_object('data', v);
  end if;
  return jsonb_build_object('error', 'not_found');
exception when invalid_text_representation or invalid_datetime_format or datetime_field_overflow or numeric_value_out_of_range then
  return jsonb_build_object('error', 'invalid', 'message', 'Parâmetro inválido.');
end $$;

revoke execute on function public.api_call_ext(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.api_call_ext(uuid, text, jsonb) to service_role;
revoke execute on function private.fold(text) from public, anon, authenticated;
