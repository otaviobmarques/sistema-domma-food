-- =====================================================================
-- Domma Food · 049 · Recuperação de carrinho
--   - O checkout guarda a sacola de quem autorizou ofertas (com telefone)
--   - Se o pedido não sai em X minutos, um lembrete com link que refaz a sacola
--     (e cupom opcional) vai por: WhatsApp oficial (automático), notificação no
--     aparelho ou lista para a loja enviar pelo WhatsApp dela
--   - Pedido feito depois do lembrete conta como recuperado
-- Proteção contra uso indevido: o cardápio é público, então qualquer um poderia
-- digitar o telefone de outra pessoa. O WhatsApp automático só sai para cliente
-- que já comprou e está no mesmo aparelho reconhecido (token do aparelho); a
-- notificação só vai para o próprio aparelho que montou a sacola.
-- =====================================================================

create table public.cart_recovery_settings (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  enabled boolean not null default false,
  delay_min integer not null default 60 check (delay_min between 20 and 720),
  message text not null default 'Oi {nome}! Seu pedido na {loja} ficou esperando na sacola. Quer finalizar? {link}'
    check (char_length(message) between 10 and 600),
  coupon_id uuid references public.coupons(id) on delete set null,
  template_name text check (template_name is null or template_name ~ '^[a-z0-9_]{1,255}$'),
  template_lang text not null default 'pt_BR' check (template_lang ~ '^[a-z]{2,3}(_[A-Z]{2})?$'),
  template_params text[] not null default array['nome','link'],
  updated_at timestamptz not null default now(),
  check (template_params <@ array['nome','loja','link','cupom','total']::text[] and cardinality(template_params) <= 5)
);

create table public.abandoned_carts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  unit_id uuid not null references public.units(id) on delete cascade,
  token text not null unique check (token ~ '^[a-f0-9]{32}$'),
  name text check (name is null or char_length(name) <= 120),
  phone text not null check (phone ~ '^[0-9]{10,13}$'),
  customer_id uuid references public.customers(id) on delete set null,
  verified boolean not null default false,          -- cliente conhecido no mesmo aparelho
  items jsonb not null default '[]',
  item_count integer not null default 0,
  subtotal_cents integer not null default 0 check (subtotal_cents between 0 and 10000000),
  push_subscription_id uuid references public.push_subscriptions(id) on delete set null,
  status text not null default 'open' check (status in ('open','manual_pending','reminded','recovered','converted','expired','discarded')),
  channel text check (channel in ('whatsapp_api','push','manual')),
  coupon_code text,
  wa_status text check (wa_status in ('queued','sending','sent','failed')),
  wa_params jsonb, wa_template text, wa_lang text, wa_message_id text, wa_error text, wa_attempts integer not null default 0,
  reminded_at timestamptz, opened_at timestamptz,
  order_id uuid references public.orders(id) on delete set null, order_total_cents integer, closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index abandoned_carts_open_idx on public.abandoned_carts(updated_at) where status = 'open';
create index abandoned_carts_phone_idx on public.abandoned_carts(unit_id, phone, created_at desc);
create index abandoned_carts_tenant_idx on public.abandoned_carts(tenant_id, created_at desc);
create index abandoned_carts_wa_idx on public.abandoned_carts(updated_at) where wa_status = 'queued';

alter table public.cart_recovery_settings enable row level security;
alter table public.cart_recovery_settings force row level security;
alter table public.abandoned_carts enable row level security;
alter table public.abandoned_carts force row level security;
-- sem políticas: painel e cardápio usam só as funções abaixo
revoke all on public.cart_recovery_settings, public.abandoned_carts from anon, authenticated;

-- ---------- Cardápio ----------
create or replace function public.cart_recovery_on(p_slug text)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select s.enabled from public.units u join public.cart_recovery_settings s on s.tenant_id = u.tenant_id
                   where u.slug = lower(p_slug) and u.active), false);
$$;

-- guarda/atualiza a sacola do checkout (só com aceite de ofertas e telefone)
create or replace function public.cart_snapshot(p_slug text, p_token text, p jsonb)
returns boolean language plpgsql security definer set search_path = '' as $$
declare u public.units; c public.abandoned_carts; v_phone text := private.only_digits(p->>'phone');
  v_items jsonb := '[]'::jsonb; it jsonb; pr public.products; v_opts jsonb; o jsonb; v_cust uuid; v_ver boolean := false;
  v_sub uuid; v_count int := 0; v_q int;
begin
  select * into u from public.units where slug = lower(p_slug) and active;
  if not found or p_token !~ '^[a-f0-9]{32}$' then return false; end if;
  if not exists (select 1 from public.cart_recovery_settings where tenant_id = u.tenant_id and enabled) then return false; end if;
  select * into c from public.abandoned_carts where token = p_token;
  if found and (c.unit_id <> u.id or c.status <> 'open') then return false; end if;
  -- sem aceite (ou desmarcou): não guarda nada e apaga o que havia
  if not coalesce((p->>'opt_in')::boolean, false) or v_phone !~ '^[0-9]{10,13}$' then
    delete from public.abandoned_carts where token = p_token and status = 'open';
    return false;
  end if;
  -- limites contra abuso: poucas sacolas por telefone por dia e por loja por hora
  if c.id is null and ((select count(*) from public.abandoned_carts where unit_id = u.id and phone = v_phone and created_at > now() - interval '1 day') >= 5
     or (select count(*) from public.abandoned_carts where unit_id = u.id and created_at > now() - interval '1 hour') >= 300) then
    return false;
  end if;
  if jsonb_typeof(p->'items') <> 'array' or jsonb_array_length(p->'items') = 0 then
    delete from public.abandoned_carts where token = p_token and status = 'open';
    return false;
  end if;
  for it in select * from jsonb_array_elements(p->'items') limit 30 loop
    select * into pr from public.products where id = case when (it->>'product_id') ~ '^[0-9a-f-]{36}$' then (it->>'product_id')::uuid end
      and tenant_id = u.tenant_id;
    if not found then continue; end if;
    v_q := least(greatest(coalesce((it->>'quantity')::int, 1), 1), 99);
    v_opts := '[]'::jsonb;
    if jsonb_typeof(it->'options') = 'array' then
      for o in select * from jsonb_array_elements(it->'options') limit 20 loop
        if (o->>'option_id') ~ '^[0-9a-f-]{36}$' then
          v_opts := v_opts || jsonb_build_object('option_id', o->>'option_id', 'name', left(o->>'name', 80),
            'quantity', least(greatest(coalesce((o->>'quantity')::int, 1), 1), 10));
        end if;
      end loop;
    end if;
    v_items := v_items || jsonb_build_object('product_id', pr.id, 'name', pr.name, 'quantity', v_q,
      'notes', nullif(left(trim(it->>'notes'), 140), ''), 'options', v_opts);
    v_count := v_count + v_q;
  end loop;
  if jsonb_array_length(v_items) = 0 then return false; end if;
  -- cliente conhecido neste aparelho?
  select id into v_cust from public.customers where tenant_id = u.tenant_id and phone = v_phone;
  if v_cust is not null and coalesce(p->>'device_token', '') <> '' then
    v_ver := exists (select 1 from public.customer_devices d where d.customer_id = v_cust
      and d.token_hash = encode(extensions.digest(p->>'device_token', 'sha256'), 'hex'));
  end if;
  -- notificação: só a assinatura que este aparelho já tem (criada ao acompanhar um pedido)
  if coalesce(p->>'push_endpoint', '') <> '' then
    select id into v_sub from public.push_subscriptions where endpoint = p->>'push_endpoint';
  end if;
  insert into public.abandoned_carts (tenant_id, unit_id, token, name, phone, customer_id, verified, items, item_count, subtotal_cents, push_subscription_id)
  values (u.tenant_id, u.id, p_token, nullif(left(trim(p->>'name'), 120), ''), v_phone, v_cust, v_ver, v_items, v_count,
    least(greatest(coalesce((p->>'subtotal_cents')::int, 0), 0), 10000000), v_sub)
  on conflict (token) do update set name = excluded.name, phone = excluded.phone, customer_id = excluded.customer_id,
    verified = excluded.verified, items = excluded.items, item_count = excluded.item_count, subtotal_cents = excluded.subtotal_cents,
    push_subscription_id = coalesce(excluded.push_subscription_id, abandoned_carts.push_subscription_id), updated_at = now();
  return true;
end $$;

-- link do lembrete: devolve os itens para refazer a sacola (e o cupom)
create or replace function public.cart_restore(p_slug text, p_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c public.abandoned_carts;
begin
  select a.* into c from public.abandoned_carts a join public.units u on u.id = a.unit_id
   where a.token = p_token and u.slug = lower(p_slug) and a.created_at > now() - interval '7 days';
  if not found then return null; end if;
  update public.abandoned_carts set opened_at = coalesce(opened_at, now()) where id = c.id;
  return jsonb_build_object('items', c.items, 'coupon_code', c.coupon_code, 'name', split_part(coalesce(c.name, ''), ' ', 1),
    'status', c.status);
end $$;

-- ---------- Pedido feito: fecha a sacola (recuperada se houve lembrete) ----------
create or replace function private.cart_on_order()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.abandoned_carts set
    status = case when status = 'reminded' then 'recovered' else 'converted' end,
    order_id = new.id, order_total_cents = new.total_cents, closed_at = now(), updated_at = now()
  where unit_id = new.unit_id and phone = private.only_digits(new.customer_phone)
    and status in ('open','manual_pending','reminded') and created_at > now() - interval '3 days'
    and (status <> 'reminded' or reminded_at > now() - interval '72 hours');
  return null;
exception when others then return null;   -- nunca bloqueia o pedido
end $$;
create trigger orders_cart_recovery after insert on public.orders for each row execute function private.cart_on_order();

-- ---------- Lembretes ----------
create or replace function private.cart_render(p_text text, c public.abandoned_carts, u public.units)
returns text language sql stable security definer set search_path = '' as $$
  select replace(replace(replace(replace(replace(p_text,
    '{nome}', coalesce(nullif(split_part(trim(coalesce(c.name, '')), ' ', 1), ''), 'tudo bem')),
    '{loja}', u.name),
    '{link}', 'https://domma-food.vercel.app/loja/' || u.slug || '?carrinho=' || c.token),
    '{cupom}', coalesce(c.coupon_code, '')),
    '{total}', 'R$ ' || to_char(c.subtotal_cents / 100.0, 'FM999G990D00'));
$$;

create or replace function private.cart_tick()
returns void language plpgsql security definer set search_path = '' as $$
declare r record; u public.units; v_cp public.coupons; v_hour int; v_wa boolean := false; v_push boolean := false; v_params jsonb; k text;
begin
  -- sem resposta em 24 h: encerra
  update public.abandoned_carts set status = 'expired', closed_at = now()
   where status in ('open','manual_pending') and created_at < now() - interval '24 hours';
  for r in
    select a.id, s.delay_min, s.message, s.coupon_id, s.template_name, s.template_lang, s.template_params,
      coalesce(m.send_from_hour, 9) as h_from, coalesce(m.send_to_hour, 21) as h_to, coalesce(m.wa_enabled, false) as wa_on,
      coalesce(m.frequency_days, 7) as freq
    from public.abandoned_carts a
    join public.cart_recovery_settings s on s.tenant_id = a.tenant_id and s.enabled
    left join public.marketing_settings m on m.tenant_id = a.tenant_id
    where a.status = 'open' and a.updated_at < now() - make_interval(mins => s.delay_min)
    order by a.updated_at limit 200
  loop
    declare c public.abandoned_carts;
    begin
      select * into c from public.abandoned_carts where id = r.id and status = 'open' for update skip locked;
      if not found then continue; end if;
      select * into u from public.units where id = c.unit_id;
      -- já pediu (por outro caminho)?
      if exists (select 1 from public.orders where unit_id = c.unit_id and private.only_digits(customer_phone) = c.phone and created_at >= c.created_at) then
        update public.abandoned_carts set status = 'converted', closed_at = now() where id = c.id; continue;
      end if;
      -- cancelou as ofertas, ou já recebeu lembrete há pouco
      if exists (select 1 from public.customers where id = c.customer_id and marketing_opt_out_at is not null)
         or exists (select 1 from public.abandoned_carts x where x.unit_id = c.unit_id and x.phone = c.phone and x.id <> c.id
                    and x.reminded_at > now() - make_interval(days => r.freq)) then
        update public.abandoned_carts set status = 'expired', closed_at = now() where id = c.id; continue;
      end if;
      -- respeita o horário de envio da loja (fica para depois)
      v_hour := extract(hour from now() at time zone coalesce(u.timezone, 'America/Sao_Paulo'));
      if v_hour < r.h_from or v_hour >= r.h_to then continue; end if;
      -- cupom válido agora
      select * into v_cp from public.coupons where id = r.coupon_id and active and (ends_at is null or ends_at > now())
        and (max_uses is null or uses_count < max_uses);
      c.coupon_code := v_cp.code;
      if c.verified and r.wa_on and r.template_name is not null then
        v_params := '[]'::jsonb;
        foreach k in array r.template_params loop
          v_params := v_params || to_jsonb(private.cart_render('{' || k || '}', c, u));
        end loop;
        update public.abandoned_carts set status = 'reminded', channel = 'whatsapp_api', reminded_at = now(), coupon_code = v_cp.code,
          wa_status = 'queued', wa_params = v_params, wa_template = r.template_name, wa_lang = r.template_lang where id = c.id;
        v_wa := true;
      elsif c.push_subscription_id is not null then
        insert into public.push_queue (subscription_id, order_id, tenant_id, unit_id, event, payload)
        values (c.push_subscription_id, null, c.tenant_id, c.unit_id, 'cart', jsonb_build_object(
          'title', left(u.name || ': sua sacola está esperando', 120),
          'body', 'Seus ' || c.item_count || ' ' || case when c.item_count = 1 then 'item continua' else 'itens continuam' end
            || ' na sacola. Toque para finalizar' || coalesce(' e use o cupom ' || v_cp.code, '') || '.',
          'url', '/loja/' || u.slug || '?carrinho=' || c.token, 'tag', 'carrinho', 'icon', '/loja/' || u.slug || '/app-icon/192'));
        update public.abandoned_carts set status = 'reminded', channel = 'push', reminded_at = now(), coupon_code = v_cp.code where id = c.id;
        v_push := true;
      else
        update public.abandoned_carts set status = 'manual_pending', channel = 'manual', coupon_code = v_cp.code where id = c.id;
      end if;
    end;
  end loop;
  if v_wa then perform private.kick_marketing_worker(); end if;
  if v_push then perform private.push_kick(); end if;
exception when others then null;
end $$;
select cron.schedule('domma-carts', '*/5 * * * *', $$select private.cart_tick()$$);

-- ---------- Worker do WhatsApp (função marketing) ----------
create or replace function public.cart_wa_jobs(p_limit integer default 50)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v jsonb; v_ids uuid[];
begin
  perform private.assert_service_role();
  update public.abandoned_carts set wa_status = 'queued' where wa_status = 'sending' and wa_attempts < 3 and updated_at < now() - interval '5 minutes';
  update public.abandoned_carts set wa_status = 'failed', wa_error = coalesce(wa_error, 'Não enviado a tempo.')
   where wa_status in ('queued','sending') and reminded_at < now() - interval '3 hours';
  with picked as (
    select a.id from public.abandoned_carts a join public.marketing_settings s on s.tenant_id = a.tenant_id
    where a.wa_status = 'queued' and s.wa_enabled order by a.reminded_at limit least(greatest(p_limit, 1), 100) for update of a skip locked),
  upd as (update public.abandoned_carts a set wa_status = 'sending', wa_attempts = wa_attempts + 1, updated_at = now()
          from picked where a.id = picked.id returning a.id)
  select array_agg(id) into v_ids from upd;
  select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'to', case when length(a.phone) <= 11 then '55' || a.phone else a.phone end,
      'params', a.wa_params, 'template', a.wa_template, 'lang', a.wa_lang,
      'phone_number_id', s.wa_phone_number_id, 'version', s.graph_version,
      'token', (select decrypted_secret from vault.decrypted_secrets where id = s.wa_token_secret_id))), '[]'::jsonb) into v
  from public.abandoned_carts a join public.marketing_settings s on s.tenant_id = a.tenant_id
  where a.id = any (coalesce(v_ids, '{}'));
  return v;
end $$;
create or replace function public.cart_wa_result(p_id uuid, p_ok boolean, p_wa_id text, p_error text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.assert_service_role();
  update public.abandoned_carts set wa_status = case when p_ok then 'sent' else 'failed' end, wa_message_id = p_wa_id,
    wa_error = left(p_error, 300), updated_at = now() where id = p_id;
end $$;

-- ---------- Painel ----------
create or replace function public.cart_overview(p_tenant_id uuid, p_days integer default 30)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare s public.cart_recovery_settings; v_from timestamptz := now() - make_interval(days => least(greatest(p_days, 1), 365));
begin
  if not private.can_manage(p_tenant_id) then raise exception 'Sem permissão.' using errcode = '42501'; end if;
  select * into s from public.cart_recovery_settings where tenant_id = p_tenant_id;
  return (
    with a as (select * from public.abandoned_carts where tenant_id = p_tenant_id and created_at >= v_from and private.can_access_unit(unit_id))
    select jsonb_build_object(
      'settings', jsonb_build_object('enabled', coalesce(s.enabled, false), 'delay_min', coalesce(s.delay_min, 60),
        'message', coalesce(s.message, 'Oi {nome}! Seu pedido na {loja} ficou esperando na sacola. Quer finalizar? {link}'),
        'coupon_id', s.coupon_id, 'template_name', s.template_name, 'template_lang', coalesce(s.template_lang, 'pt_BR'),
        'template_params', coalesce(s.template_params, array['nome','link'])),
      'wa_ready', coalesce((select wa_enabled from public.marketing_settings where tenant_id = p_tenant_id), false),
      'coupons', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'code', code, 'kind', kind, 'value', value) order by code)
          from public.coupons where tenant_id = p_tenant_id and active and (ends_at is null or ends_at > now())), '[]'::jsonb),
      'stats', jsonb_build_object(
        'captured', (select count(*) from a),
        'converted', (select count(*) from a where status = 'converted'),
        'reminded', (select count(*) from a where reminded_at is not null),
        'recovered', (select count(*) from a where status = 'recovered'),
        'recovered_cents', coalesce((select sum(a.order_total_cents) from a join public.orders o on o.id = a.order_id
            where a.status = 'recovered' and o.status <> 'cancelled'), 0),
        'manual_pending', (select count(*) from a where status = 'manual_pending'),
        'opened', (select count(*) from a where opened_at is not null and reminded_at is not null)),
      'carts', coalesce((select jsonb_agg(x order by x.created_at desc) from (
          select a.id, a.created_at, a.reminded_at, a.status, a.channel, a.name, a.phone, a.verified, a.item_count, a.subtotal_cents,
            a.wa_status, a.wa_error, a.opened_at, un.name as unit_name,
            (select string_agg(i->>'quantity' || 'x ' || (i->>'name'), ', ') from jsonb_array_elements(a.items) i) as summary,
            (select o.number from public.orders o where o.id = a.order_id) as order_number,
            case when a.status = 'manual_pending' then private.cart_render(coalesce(s.message, ''), a, un) end as manual_text
          from a join public.units un on un.id = a.unit_id
          where a.status <> 'open' or a.created_at > now() - interval '1 day'
          order by a.created_at desc limit 60) x), '[]'::jsonb))
  );
end $$;

create or replace function public.cart_save_settings(p_tenant_id uuid, p jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare v_params text[];
begin
  if not private.can_manage(p_tenant_id) then raise exception 'Sem permissão.' using errcode = '42501'; end if;
  if p ? 'coupon_id' and p->>'coupon_id' is not null
     and not exists (select 1 from public.coupons where id = (p->>'coupon_id')::uuid and tenant_id = p_tenant_id) then
    raise exception 'Cupom inválido.'; end if;
  if p ? 'message' and position('{link}' in coalesce(p->>'message', '')) = 0 then
    raise exception 'A mensagem precisa ter {link}, que refaz a sacola do cliente.'; end if;
  if p ? 'template_params' then
    select array_agg(x) into v_params from jsonb_array_elements_text(p->'template_params') x;
  end if;
  insert into public.cart_recovery_settings (tenant_id) values (p_tenant_id) on conflict do nothing;
  update public.cart_recovery_settings set
    enabled = coalesce((p->>'enabled')::boolean, enabled),
    delay_min = coalesce((p->>'delay_min')::int, delay_min),
    message = coalesce(nullif(trim(p->>'message'), ''), message),
    coupon_id = case when p ? 'coupon_id' then (p->>'coupon_id')::uuid else coupon_id end,
    template_name = case when p ? 'template_name' then nullif(lower(trim(p->>'template_name')), '') else template_name end,
    template_lang = coalesce(nullif(trim(p->>'template_lang'), ''), template_lang),
    template_params = coalesce(v_params, template_params),
    updated_at = now()
  where tenant_id = p_tenant_id;
  insert into public.audit_logs (tenant_id, actor_id, action, entity, entity_id, after, ip)
  values (p_tenant_id, auth.uid(), 'cart_recovery_settings', 'cart_recovery_settings', p_tenant_id::text, p - 'message', private.request_ip());
end $$;

-- lista manual: a loja enviou pelo WhatsApp dela (ou descartou)
create or replace function public.cart_manual_mark(p_cart_id uuid, p_sent boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare c public.abandoned_carts;
begin
  select * into c from public.abandoned_carts where id = p_cart_id;
  if not found or not private.can_manage(c.tenant_id) or not private.can_access_unit(c.unit_id) then
    raise exception 'Sem permissão.' using errcode = '42501'; end if;
  if c.status <> 'manual_pending' then raise exception 'Este carrinho não está aguardando envio.'; end if;
  update public.abandoned_carts set status = case when p_sent then 'reminded' else 'discarded' end,
    reminded_at = case when p_sent then now() end, closed_at = case when p_sent then null else now() end, updated_at = now()
  where id = c.id;
end $$;

grant execute on function public.cart_recovery_on(text), public.cart_snapshot(text, text, jsonb), public.cart_restore(text, text) to anon, authenticated;
grant execute on function public.cart_overview(uuid, integer), public.cart_save_settings(uuid, jsonb), public.cart_manual_mark(uuid, boolean) to authenticated;
revoke execute on function public.cart_overview(uuid, integer), public.cart_save_settings(uuid, jsonb), public.cart_manual_mark(uuid, boolean) from public, anon;
revoke execute on function public.cart_wa_jobs(integer), public.cart_wa_result(uuid, boolean, text, text) from public, anon, authenticated;
grant execute on function public.cart_wa_jobs(integer), public.cart_wa_result(uuid, boolean, text, text) to service_role;
revoke execute on function private.cart_on_order(), private.cart_tick(), private.cart_render(text, public.abandoned_carts, public.units)
  from public, anon, authenticated;
