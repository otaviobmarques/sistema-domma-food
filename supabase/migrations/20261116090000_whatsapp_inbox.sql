-- =====================================================================
-- Domma Food · 043 · PDV pelo WhatsApp (caixa de entrada + lançar pedido)
-- Mensagens que chegam no número oficial (WhatsApp Cloud API) viram conversas
-- no painel. A equipe responde dentro da janela de 24 h da Meta e lança o
-- pedido do cliente ali mesmo, com as mesmas regras do cardápio online
-- (preço, área de entrega, cupom, horário). Sem a API, o lançamento funciona
-- do mesmo jeito e a confirmação vai pelo WhatsApp da loja (link wa.me).
-- =====================================================================
create table public.wa_conversations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  wa_id text not null check (wa_id ~ '^[0-9]{8,15}$'),
  name text check (char_length(name) <= 120),
  customer_id uuid references public.customers(id) on delete set null,
  status text not null default 'open' check (status in ('open','closed')),
  unread int not null default 0 check (unread >= 0),
  last_preview text,
  last_message_at timestamptz not null default now(),
  last_inbound_at timestamptz,
  created_at timestamptz not null default now(),
  unique (tenant_id, wa_id)
);
create index wa_conversations_list on public.wa_conversations (tenant_id, status, last_message_at desc);

create table public.wa_messages (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  conversation_id uuid not null references public.wa_conversations(id) on delete cascade,
  direction text not null check (direction in ('in','out')),
  kind text not null default 'text' check (kind in ('text','image','audio','video','document','location','sticker','contacts','interactive','button','reaction','other')),
  body text check (char_length(body) <= 4096),
  wa_message_id text,
  status text not null check (status in ('received','queued','sending','sent','delivered','read','failed')),
  error text,
  author_id uuid,
  order_id uuid references public.orders(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (tenant_id, wa_message_id)
);
create index wa_messages_conv on public.wa_messages (conversation_id, id desc);

alter table public.wa_conversations enable row level security;
alter table public.wa_conversations force row level security;
alter table public.wa_messages enable row level security;
alter table public.wa_messages force row level security;
create policy wa_conversations_select on public.wa_conversations for select to authenticated
  using (private.has_role(tenant_id, array['owner','manager','cashier','attendant']::public.member_role[]));
create policy wa_messages_select on public.wa_messages for select to authenticated
  using (private.has_role(tenant_id, array['owner','manager','cashier','attendant']::public.member_role[]));
revoke all on public.wa_conversations, public.wa_messages from anon;
revoke insert, update, delete on public.wa_conversations, public.wa_messages from authenticated;
alter publication supabase_realtime add table public.wa_conversations;
alter publication supabase_realtime add table public.wa_messages;

create or replace function private.inbox_staff(p_tenant uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.has_role(p_tenant, array['owner','manager','cashier','attendant']::public.member_role[]);
$$;

-- ---------- Webhook (só o servidor) ----------
create or replace function public.inbox_inbound(p_tenant_id uuid, p_from text, p_name text, p_wa_msg_id text,
  p_kind text, p_text text, p_ts timestamptz default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_wa text := private.only_digits(p_from); c uuid; v_cust uuid; v_at timestamptz := least(coalesce(p_ts, now()), now());
  v_kind text := case when p_kind in ('text','image','audio','video','document','location','sticker','contacts','interactive','button','reaction') then p_kind else 'other' end;
  v_body text := left(nullif(trim(coalesce(p_text, '')), ''), 4096);
  v_new bigint;
begin
  perform private.assert_service_role();
  if v_wa !~ '^[0-9]{8,15}$' then return null; end if;
  select id into v_cust from public.customers where tenant_id = p_tenant_id and (phone = v_wa or '55' || phone = v_wa)
    order by last_order_at desc nulls last limit 1;
  insert into public.wa_conversations (tenant_id, wa_id, name, customer_id)
  values (p_tenant_id, v_wa, left(nullif(trim(p_name), ''), 120), v_cust)
  on conflict (tenant_id, wa_id) do update set name = coalesce(excluded.name, public.wa_conversations.name),
    customer_id = coalesce(public.wa_conversations.customer_id, excluded.customer_id)
  returning id into c;
  insert into public.wa_messages (tenant_id, conversation_id, direction, kind, body, wa_message_id, status, created_at)
  values (p_tenant_id, c, 'in', v_kind, v_body, nullif(p_wa_msg_id, ''), 'received', v_at)
  on conflict (tenant_id, wa_message_id) do nothing
  returning id into v_new;
  if v_new is not null then
    update public.wa_conversations set status = 'open', unread = unread + 1, last_message_at = greatest(last_message_at, v_at),
      last_inbound_at = greatest(coalesce(last_inbound_at, v_at), v_at),
      last_preview = left(coalesce(v_body, case v_kind when 'image' then '📷 Imagem' when 'audio' then '🎤 Áudio' when 'video' then '🎬 Vídeo'
        when 'document' then '📄 Documento' when 'location' then '📍 Localização' when 'sticker' then 'Figurinha' else 'Mensagem' end), 140)
    where id = c;
  end if;
  return c;
end $$;

create or replace function public.inbox_status(p_tenant_id uuid, p_wa_msg_id text, p_status text, p_error text default null)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  perform private.assert_service_role();
  if p_status not in ('sent','delivered','read','failed') then return false; end if;
  update public.wa_messages set status = p_status, error = case when p_status = 'failed' then left(p_error, 300) else error end
   where tenant_id = p_tenant_id and wa_message_id = p_wa_msg_id and direction = 'out'
     and (p_status = 'failed' or array_position(array['sending','sent','delivered','read'], p_status) > coalesce(array_position(array['sending','sent','delivered','read'], status), 0));
  return found;
end $$;

-- Envio: pega a mensagem na fila (uma vez) com as credenciais do número
create or replace function public.inbox_send_job(p_message_id bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare m public.wa_messages; c public.wa_conversations; s public.marketing_settings;
begin
  perform private.assert_service_role();
  update public.wa_messages set status = 'sending' where id = p_message_id and status = 'queued' and direction = 'out' returning * into m;
  if not found then return null; end if;
  select * into c from public.wa_conversations where id = m.conversation_id;
  select * into s from public.marketing_settings where tenant_id = m.tenant_id;
  if not coalesce(s.wa_enabled, false) or s.wa_phone_number_id is null then
    update public.wa_messages set status = 'failed', error = 'WhatsApp oficial desligado.' where id = m.id;
    return null;
  end if;
  return jsonb_build_object('id', m.id, 'to', c.wa_id, 'text', m.body, 'phone_number_id', s.wa_phone_number_id, 'version', s.graph_version,
    'token', (select decrypted_secret from vault.decrypted_secrets where id = s.wa_token_secret_id));
end $$;
create or replace function public.inbox_send_result(p_message_id bigint, p_ok boolean, p_wa_id text, p_error text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.assert_service_role();
  update public.wa_messages set status = case when p_ok then 'sent' else 'failed' end, wa_message_id = coalesce(nullif(p_wa_id, ''), wa_message_id),
    error = case when p_ok then null else left(p_error, 300) end
  where id = p_message_id and status = 'sending';
end $$;

-- ---------- Painel ----------
create or replace function public.inbox_overview(p_tenant_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare s public.marketing_settings;
begin
  if not private.inbox_staff(p_tenant_id) then raise exception 'Sem permissão.' using errcode = '42501'; end if;
  select * into s from public.marketing_settings where tenant_id = p_tenant_id;
  return jsonb_build_object('wa_enabled', coalesce(s.wa_enabled, false) and s.wa_phone_number_id is not null,
    'unread', (select coalesce(sum(unread), 0) from public.wa_conversations where tenant_id = p_tenant_id and status = 'open'),
    'conversations', coalesce((select jsonb_agg(x order by x.last_message_at desc) from (
      select c.id, c.wa_id, coalesce(c.name, cu.name) as name, c.status, c.unread, c.last_preview, c.last_message_at,
        c.last_inbound_at > now() - interval '24 hours' as window_open, c.customer_id, cu.orders_count
      from public.wa_conversations c left join public.customers cu on cu.id = c.customer_id
      where c.tenant_id = p_tenant_id order by c.last_message_at desc limit 200) x), '[]'::jsonb));
end $$;

create or replace function public.inbox_open(p_conversation_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c public.wa_conversations; cu public.customers; v_last public.orders;
begin
  select * into c from public.wa_conversations where id = p_conversation_id;
  if not found or not private.inbox_staff(c.tenant_id) then raise exception 'Sem permissão.' using errcode = '42501'; end if;
  if c.unread > 0 then update public.wa_conversations set unread = 0 where id = c.id; end if;
  select * into cu from public.customers where id = c.customer_id;
  select * into v_last from public.orders where c.customer_id is not null and customer_id = c.customer_id order by created_at desc limit 1;
  return jsonb_build_object(
    'conversation', jsonb_build_object('id', c.id, 'wa_id', c.wa_id, 'name', coalesce(c.name, cu.name), 'status', c.status,
      'window_open', c.last_inbound_at > now() - interval '24 hours',
      'window_closes_at', c.last_inbound_at + interval '24 hours'),
    'customer', case when cu.id is null then null else jsonb_build_object('id', cu.id, 'name', cu.name, 'phone', cu.phone,
      'orders_count', cu.orders_count, 'total_spent_cents', cu.total_spent_cents, 'last_order_at', cu.last_order_at,
      'cashback_cents', cu.cashback_cents, 'last_address', v_last.address,
      'recent_orders', coalesce((select jsonb_agg(jsonb_build_object('id', o.id, 'number', o.number, 'status', o.status, 'total_cents', o.total_cents,
          'created_at', o.created_at, 'channel', o.channel) order by o.created_at desc)
        from (select * from public.orders where customer_id = cu.id order by created_at desc limit 5) o), '[]'::jsonb)) end,
    'messages', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'direction', m.direction, 'kind', m.kind, 'body', m.body,
        'status', m.status, 'error', m.error, 'created_at', m.created_at, 'order_id', m.order_id) order by m.id)
      from (select * from public.wa_messages where conversation_id = c.id order by id desc limit 150) m), '[]'::jsonb));
end $$;

create or replace function public.inbox_queue_reply(p_conversation_id uuid, p_text text, p_order_id uuid default null)
returns bigint language plpgsql security definer set search_path = '' as $$
declare c public.wa_conversations; v_body text := left(trim(coalesce(p_text, '')), 4096); v bigint;
begin
  select * into c from public.wa_conversations where id = p_conversation_id;
  if not found or not private.inbox_staff(c.tenant_id) then raise exception 'Sem permissão.' using errcode = '42501'; end if;
  if v_body = '' then raise exception 'Escreva a mensagem.'; end if;
  if not exists (select 1 from public.marketing_settings where tenant_id = c.tenant_id and wa_enabled and wa_phone_number_id is not null) then
    raise exception 'O WhatsApp oficial não está ligado. Configure em Marketing › WhatsApp.'; end if;
  if c.last_inbound_at is null or c.last_inbound_at < now() - interval '24 hours' then
    raise exception 'A janela de 24 horas fechou: o WhatsApp só deixa responder até 24 h depois da última mensagem do cliente. Use o WhatsApp da loja.'; end if;
  if (select count(*) from public.wa_messages where conversation_id = c.id and direction = 'out' and created_at > now() - interval '1 minute') >= 20 then
    raise exception 'Muitas mensagens seguidas. Aguarde um pouco.'; end if;
  if p_order_id is not null and not exists (select 1 from public.orders where id = p_order_id and tenant_id = c.tenant_id) then
    raise exception 'Pedido inválido.'; end if;
  insert into public.wa_messages (tenant_id, conversation_id, direction, kind, body, status, author_id, order_id)
  values (c.tenant_id, c.id, 'out', 'text', v_body, 'queued', auth.uid(), p_order_id) returning id into v;
  update public.wa_conversations set last_message_at = now(), last_preview = left('Você: ' || v_body, 140), unread = 0, status = 'open' where id = c.id;
  return v;
end $$;

create or replace function public.inbox_set_status(p_conversation_id uuid, p_status text)
returns void language plpgsql security definer set search_path = '' as $$
declare c public.wa_conversations;
begin
  select * into c from public.wa_conversations where id = p_conversation_id;
  if not found or not private.inbox_staff(c.tenant_id) then raise exception 'Sem permissão.' using errcode = '42501'; end if;
  if p_status not in ('open','closed') then raise exception 'Situação inválida.'; end if;
  update public.wa_conversations set status = p_status, unread = case when p_status = 'closed' then 0 else unread end where id = c.id;
end $$;

-- ---------- Lançar pedido pelo atendimento ----------
-- Usa as mesmas regras do cardápio (compute_order/place_order_core) e marca o canal WhatsApp.
create or replace function public.wa_order(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare u public.units; c public.wa_conversations; r jsonb; v_order uuid; v_status public.order_status; v_cust uuid;
begin
  select * into u from public.units where id = (p->>'unit_id')::uuid;
  if not found or not private.can_access_unit(u.id) or not private.inbox_staff(u.tenant_id) then
    raise exception 'Sem permissão.' using errcode = '42501'; end if;
  if nullif(p->>'conversation_id', '') is not null then
    select * into c from public.wa_conversations where id = (p->>'conversation_id')::uuid and tenant_id = u.tenant_id;
    if not found then raise exception 'Conversa inválida.'; end if;
  end if;
  if coalesce(p->>'payment_method', '') = 'online_card' then raise exception 'Cartão online é só pelo cardápio. Use Pix ou pagamento na entrega.'; end if;
  r := private.place_order_core(jsonb_build_object(
    'slug', u.slug, 'type', p->>'type', 'items', p->'items', 'address', p->'address', 'coupon_code', p->>'coupon_code',
    'payment_method', p->>'payment_method', 'scheduled_for', p->>'scheduled_for', 'notes', p->>'notes',
    'change_for_cents', p->'change_for_cents',
    'customer', jsonb_build_object('name', p->'customer'->>'name', 'phone', p->'customer'->>'phone', 'opt_in', false)));
  v_order := (r->>'order_id')::uuid;
  v_status := case when r->>'status' = 'awaiting_payment' then 'awaiting_payment'::public.order_status else 'preparing'::public.order_status end;
  update public.orders set channel = 'whatsapp', status = v_status,
    accepted_at = case when v_status = 'preparing' then coalesce(accepted_at, now()) end,
    notify_whatsapp = coalesce((p->>'notify_whatsapp')::boolean, false)
  where id = v_order returning customer_id into v_cust;
  update public.order_events set note = 'Pedido lançado pelo atendimento (WhatsApp)', actor_id = auth.uid(), to_status = v_status
   where order_id = v_order and from_status is null;
  if c.id is not null then
    update public.wa_conversations set customer_id = coalesce(customer_id, v_cust) where id = c.id;
  end if;
  return r || jsonb_build_object('status', v_status);
end $$;

grant execute on function public.inbox_overview(uuid), public.inbox_open(uuid), public.inbox_queue_reply(uuid, text, uuid),
  public.inbox_set_status(uuid, text), public.wa_order(jsonb) to authenticated;
revoke execute on function public.inbox_overview(uuid), public.inbox_open(uuid), public.inbox_queue_reply(uuid, text, uuid),
  public.inbox_set_status(uuid, text), public.wa_order(jsonb) from public, anon;
revoke execute on function public.inbox_inbound(uuid, text, text, text, text, text, timestamptz), public.inbox_status(uuid, text, text, text),
  public.inbox_send_job(bigint), public.inbox_send_result(bigint, boolean, text, text) from public, anon, authenticated;
grant execute on function public.inbox_inbound(uuid, text, text, text, text, text, timestamptz), public.inbox_status(uuid, text, text, text),
  public.inbox_send_job(bigint), public.inbox_send_result(bigint, boolean, text, text) to service_role;
revoke execute on function private.inbox_staff(uuid) from public, anon, authenticated;
