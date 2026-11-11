-- =====================================================================
-- Domma Food · 041 · Totem de autoatendimento
-- Cada totem é um aparelho da loja (tablet ou tela touch) com um link
-- próprio (/totem/<chave>). O cliente monta o pedido, escolhe comer aqui
-- ou levar e paga no caixa ou por Pix na tela (Mercado Pago).
-- A chave do totem é guardada só como hash; pode ser trocada ou revogada.
-- =====================================================================
create table public.totems (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  unit_id uuid not null references public.units(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  token_hash text not null unique,
  active boolean not null default true,
  allow_dine_in boolean not null default true,
  allow_takeout boolean not null default true,
  allow_pix boolean not null default true,
  allow_counter boolean not null default true,
  auto_accept boolean not null default false,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  check (allow_dine_in or allow_takeout),
  check (allow_pix or allow_counter)
);
alter table public.totems enable row level security;
alter table public.totems force row level security;
create policy totems_select on public.totems for select to authenticated
  using (private.can_manage(tenant_id) and private.can_access_unit(unit_id));
revoke all on public.totems from anon;
revoke insert, update, delete on public.totems from authenticated;
alter table public.orders add column totem_id uuid references public.totems(id) on delete set null;

create or replace function private.totem_by_token(p_token text)
returns public.totems language sql stable security definer set search_path = '' as $$
  select * from public.totems where active and p_token ~ '^dft_[0-9a-f]{40}$'
    and token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex');
$$;

-- ---------- Painel (dono/gerente) ----------
create or replace function public.totem_create(p_unit_id uuid, p_name text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare u public.units; v_tok text := 'dft_' || encode(extensions.gen_random_bytes(20), 'hex'); v uuid;
begin
  select * into u from public.units where id = p_unit_id;
  if not found or not private.can_manage(u.tenant_id) or not private.can_access_unit(u.id) then raise exception 'Sem permissão.' using errcode = '42501'; end if;
  if (select count(*) from public.totems where unit_id = u.id and active) >= 20 then raise exception 'Limite de 20 totens por loja.'; end if;
  insert into public.totems (tenant_id, unit_id, name, token_hash)
  values (u.tenant_id, u.id, left(coalesce(nullif(trim(p_name), ''), 'Totem'), 60), encode(extensions.digest(v_tok, 'sha256'), 'hex'))
  returning id into v;
  return jsonb_build_object('id', v, 'token', v_tok);
end $$;
create or replace function public.totem_update(p_totem_id uuid, p jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare t public.totems;
begin
  select * into t from public.totems where id = p_totem_id;
  if not found or not private.can_manage(t.tenant_id) or not private.can_access_unit(t.unit_id) then raise exception 'Sem permissão.' using errcode = '42501'; end if;
  update public.totems set
    name = coalesce(left(nullif(trim(p->>'name'), ''), 60), name),
    allow_dine_in = coalesce((p->>'allow_dine_in')::boolean, allow_dine_in),
    allow_takeout = coalesce((p->>'allow_takeout')::boolean, allow_takeout),
    allow_pix = coalesce((p->>'allow_pix')::boolean, allow_pix),
    allow_counter = coalesce((p->>'allow_counter')::boolean, allow_counter),
    auto_accept = coalesce((p->>'auto_accept')::boolean, auto_accept),
    active = coalesce((p->>'active')::boolean, active)
  where id = t.id;
exception when check_violation then
  raise exception 'Deixe pelo menos uma opção de consumo (aqui ou levar) e uma de pagamento (caixa ou Pix).';
end $$;
create or replace function public.totem_rotate(p_totem_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare t public.totems; v_tok text := 'dft_' || encode(extensions.gen_random_bytes(20), 'hex');
begin
  select * into t from public.totems where id = p_totem_id;
  if not found or not private.can_manage(t.tenant_id) or not private.can_access_unit(t.unit_id) then raise exception 'Sem permissão.' using errcode = '42501'; end if;
  update public.totems set token_hash = encode(extensions.digest(v_tok, 'sha256'), 'hex'), active = true, last_seen_at = null where id = t.id;
  return v_tok;
end $$;

-- ---------- Aparelho do totem (chave pública do link) ----------
create or replace function public.totem_info(p_token text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare t public.totems; u public.units; tn public.tenants;
begin
  t := private.totem_by_token(p_token);
  if t.id is null then return null; end if;
  select * into u from public.units where id = t.unit_id;
  select * into tn from public.tenants where id = t.tenant_id;
  if tn.status = 'suspended' or not u.active then return null; end if;
  return jsonb_build_object('slug', u.slug, 'unit_name', u.name, 'totem', t.name, 'is_open', private.unit_is_open_at(u, now()),
    'allow_dine_in', t.allow_dine_in, 'allow_takeout', t.allow_takeout, 'allow_counter', t.allow_counter,
    'allow_pix', t.allow_pix and coalesce((private.gateway_store_info(u.id)->>'pix')::boolean, false));
end $$;
create or replace function public.totem_ping(p_token text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare t public.totems;
begin
  t := private.totem_by_token(p_token);
  if t.id is null then return false; end if;
  update public.totems set last_seen_at = now() where id = t.id and (last_seen_at is null or last_seen_at < now() - interval '30 seconds');
  return true;
end $$;
create or replace function public.totem_order(p_token text, p_items jsonb, p_mode text, p_name text, p_pay text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare t public.totems; u public.units; q jsonb; v_order uuid; v_n int; v_status public.order_status; v_tok text;
  v_name text := left(nullif(regexp_replace(trim(coalesce(p_name, '')), '\s+', ' ', 'g'), ''), 40);
  v_pix boolean := p_pay = 'pix'; v_total int;
begin
  t := private.totem_by_token(p_token);
  if t.id is null then raise exception 'Este totem foi desativado. Chame um atendente.'; end if;
  select * into u from public.units where id = t.unit_id;
  if (select status from public.tenants where id = t.tenant_id) = 'suspended' then raise exception 'Loja indisponível no momento.'; end if;
  if not private.unit_is_open_at(u, now()) then raise exception 'A loja não está recebendo pedidos agora.'; end if;
  if p_mode not in ('dine_in','pickup') or (p_mode = 'dine_in' and not t.allow_dine_in) or (p_mode = 'pickup' and not t.allow_takeout) then
    raise exception 'Escolha se vai comer aqui ou levar.'; end if;
  if p_pay not in ('pix','counter') or (p_pay = 'counter' and not t.allow_counter) then raise exception 'Escolha a forma de pagamento.'; end if;
  if v_pix and not (t.allow_pix and coalesce((private.gateway_store_info(u.id)->>'pix')::boolean, false)) then
    raise exception 'Pix indisponível neste totem. Pague no caixa.'; end if;
  if v_name is null then raise exception 'Informe seu nome para chamarmos quando o pedido estiver pronto.'; end if;
  -- antiabuso: limite por totem
  perform 1 from public.totems where id = t.id for update;
  if (select count(*) from public.orders where totem_id = t.id and created_at > now() - interval '10 minutes') >= 15 then
    raise exception 'Muitos pedidos neste totem em pouco tempo. Chame um atendente.'; end if;
  q := private.price_items(u.id, p_items, 'totem');
  v_total := (q->>'subtotal_cents')::int;
  if v_total > 300000 then raise exception 'Pedido acima do limite do totem. Faça pelo caixa.'; end if;
  v_status := case when v_pix then 'awaiting_payment' when t.auto_accept then 'preparing' else 'pending' end;
  update public.units set order_counter = order_counter + 1 where id = u.id returning order_counter into v_n;
  insert into public.orders (tenant_id, unit_id, number, channel, type, status, customer_name, customer_phone,
    subtotal_cents, total_cents, payment_method, payment_status, notes, accepted_at, totem_id)
  values (u.tenant_id, u.id, v_n, 'totem', p_mode::public.order_type, v_status, v_name, '00000000000',
    v_total, v_total, case when v_pix then 'pix' else 'cash' end::public.payment_method, 'pending',
    case when v_pix then 'Totem ' || t.name || ' · Pix' else 'Totem ' || t.name || ' · PAGAR NO CAIXA' end
      || case when p_mode = 'dine_in' then ' · comer aqui' else ' · para levar' end,
    case when v_status = 'preparing' then now() end, t.id)
  returning id, public_token into v_order, v_tok;
  perform private.insert_items(u.tenant_id, v_order, q->'items');
  if v_pix then
    insert into public.payments (tenant_id, order_id, method, amount_cents) values (u.tenant_id, v_order, 'pix', v_total);
  end if;
  insert into public.order_events (tenant_id, order_id, to_status, note) values (u.tenant_id, v_order, v_status, 'Pedido no totem ' || t.name);
  update public.totems set last_seen_at = now() where id = t.id;
  return jsonb_build_object('number', v_n, 'token', v_tok, 'status', v_status, 'total_cents', v_total, 'pay', p_pay);
end $$;

-- ---------- Caixa: receber pedido pago na loja (totem, retirada) ----------
create or replace function public.order_receive(p_order_id uuid, p_payments jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare o public.orders; s uuid; v_change int;
begin
  select * into o from public.orders where id = p_order_id for update;
  if not found or not private.can_access_unit(o.unit_id)
     or not private.has_role(o.tenant_id, array['owner','manager','cashier','attendant']::public.member_role[]) then
    raise exception 'Sem permissão.' using errcode = '42501'; end if;
  if o.payment_status = 'paid' then raise exception 'Este pedido já está pago.'; end if;
  if o.status in ('cancelled','awaiting_payment') then raise exception 'Este pedido não pode ser recebido no caixa.'; end if;
  if o.connection_id is not null or o.tab_id is not null then raise exception 'Este pedido é recebido pelo marketplace ou pela conta da mesa.'; end if;
  s := private.open_session(o.unit_id);
  if s is null then raise exception 'Abra o caixa antes de receber.'; end if;
  delete from public.payments where order_id = o.id and status = 'pending';
  v_change := private.register_payments(o.tenant_id, s, o.total_cents, p_payments, o.id, null, o.customer_id);
  update public.orders set payment_status = 'paid', paid_at = now(), cash_session_id = s,
    payment_method = (p_payments->0->>'method')::public.payment_method where id = o.id;
  insert into public.order_events (tenant_id, order_id, from_status, to_status, note, actor_id)
  values (o.tenant_id, o.id, o.status, o.status, 'Pagamento recebido no caixa', auth.uid());
  return jsonb_build_object('change_cents', v_change);
end $$;

grant execute on function public.totem_info(text), public.totem_ping(text), public.totem_order(text, jsonb, text, text, text) to anon, authenticated;
grant execute on function public.totem_create(uuid, text), public.totem_update(uuid, jsonb), public.totem_rotate(uuid),
  public.order_receive(uuid, jsonb) to authenticated;
revoke execute on function public.totem_create(uuid, text), public.totem_update(uuid, jsonb), public.totem_rotate(uuid),
  public.order_receive(uuid, jsonb) from public, anon;
revoke execute on function private.totem_by_token(text) from public, anon, authenticated;
