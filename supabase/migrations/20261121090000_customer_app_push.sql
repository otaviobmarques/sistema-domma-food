-- =====================================================================
-- Domma Food · 048 · App do cliente instalável (PWA)
--   - Notificações no aparelho (Web Push) com o andamento do pedido
--   - "Pedir de novo": pedidos guardados no aparelho (por token) viram sacola
--   - Números do app no painel
-- O cliente não precisa de login: quem tem o link do pedido (token) pode
-- pedir avisos dele. Nenhum dado pessoal vai na assinatura.
-- =====================================================================

-- ---------- Assinaturas (uma por navegador/aparelho) ----------
create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  endpoint text not null unique check (char_length(endpoint) <= 1000 and endpoint ~ ('^https://(' ||
    'fcm\.googleapis\.com|android\.googleapis\.com|updates\.push\.services\.mozilla\.com|push\.services\.mozilla\.com|' ||
    '[a-z0-9-]+(\.[a-z0-9-]+)*\.push\.apple\.com|[a-z0-9-]+(\.[a-z0-9-]+)*\.notify\.windows\.com)/')),
  p256dh text not null check (p256dh ~ '^[A-Za-z0-9_-]{86,88}={0,2}$'),
  auth text not null check (auth ~ '^[A-Za-z0-9_-]{16,24}={0,2}$'),
  created_at timestamptz not null default now(),
  last_ok_at timestamptz,
  failures integer not null default 0
);
create table public.push_order_links (
  order_id uuid not null references public.orders(id) on delete cascade,
  subscription_id uuid not null references public.push_subscriptions(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  unit_id uuid not null references public.units(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (order_id, subscription_id)
);
create index push_order_links_sub_idx on public.push_order_links(subscription_id);
create index push_order_links_unit_idx on public.push_order_links(unit_id, created_at desc);

create table public.push_queue (
  id bigint generated always as identity primary key,
  subscription_id uuid references public.push_subscriptions(id) on delete set null,   -- histórico fica
  order_id uuid references public.orders(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  unit_id uuid not null references public.units(id) on delete cascade,
  event text not null,
  payload jsonb not null,
  status text not null default 'queued' check (status in ('queued','sending','sent','failed','gone')),
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  unique (order_id, subscription_id, event)
);
create index push_queue_ready_idx on public.push_queue(next_attempt_at) where status = 'queued';
create index push_queue_unit_idx on public.push_queue(unit_id, created_at desc);

alter table public.push_subscriptions enable row level security;
alter table public.push_subscriptions force row level security;
alter table public.push_order_links enable row level security;
alter table public.push_order_links force row level security;
alter table public.push_queue enable row level security;
alter table public.push_queue force row level security;
-- sem políticas nem permissões: só funções do servidor leem e escrevem
revoke all on public.push_subscriptions, public.push_order_links, public.push_queue from anon, authenticated;

-- ---------- Chaves VAPID (geradas pela função "push" na primeira vez) ----------
create or replace function public.push_public_key()
returns text language sql stable security definer set search_path = '' as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'push_vapid_public';
$$;
create or replace function public.push_vapid_get()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.assert_service_role();
  return jsonb_build_object(
    'public', (select decrypted_secret from vault.decrypted_secrets where name = 'push_vapid_public'),
    'private', (select decrypted_secret from vault.decrypted_secrets where name = 'push_vapid_private'));
end $$;
-- grava o par só se ainda não existir (chamadas concorrentes ficam com o primeiro)
create or replace function public.push_vapid_init(p_public text, p_private text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform private.assert_service_role();
  if p_public !~ '^[A-Za-z0-9_-]{86,88}$' or char_length(p_private) > 400 then raise exception 'Chave inválida.'; end if;
  perform pg_advisory_xact_lock(hashtext('domma_push_vapid'));
  if not exists (select 1 from vault.secrets where name = 'push_vapid_public') then
    perform vault.create_secret(p_private, 'push_vapid_private', 'Domma Food: chave privada VAPID (Web Push)');
    perform vault.create_secret(p_public, 'push_vapid_public', 'Domma Food: chave pública VAPID (Web Push)');
  end if;
  return public.push_vapid_get();
end $$;

-- ---------- Cliente: ligar / desligar avisos de um pedido ----------
create or replace function public.push_subscribe(p_token text, p_endpoint text, p_p256dh text, p_auth text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare o public.orders; v_sub uuid;
begin
  select * into o from public.orders where public_token = p_token;
  if not found then raise exception 'Pedido não encontrado.'; end if;
  if o.status in ('completed','cancelled') or o.created_at < now() - interval '2 days' then
    raise exception 'Este pedido já foi encerrado.'; end if;
  if (select count(*) from public.push_order_links where order_id = o.id) >= 5 then
    raise exception 'Limite de aparelhos para este pedido atingido.'; end if;
  insert into public.push_subscriptions (endpoint, p256dh, auth) values (p_endpoint, p_p256dh, p_auth)
  on conflict (endpoint) do update set p256dh = excluded.p256dh, auth = excluded.auth, failures = 0
  returning id into v_sub;
  insert into public.push_order_links (order_id, subscription_id, tenant_id, unit_id)
  values (o.id, v_sub, o.tenant_id, o.unit_id) on conflict do nothing;
  return true;
end $$;

create or replace function public.push_unsubscribe(p_token text, p_endpoint text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  delete from public.push_order_links l using public.orders o, public.push_subscriptions s
   where l.order_id = o.id and o.public_token = p_token and l.subscription_id = s.id and s.endpoint = p_endpoint;
end $$;

create or replace function public.push_is_on(p_token text, p_endpoint text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.push_order_links l join public.orders o on o.id = l.order_id
    join public.push_subscriptions s on s.id = l.subscription_id where o.public_token = p_token and s.endpoint = p_endpoint);
$$;

-- ---------- Avisos a cada etapa ----------
create or replace function private.push_message(o public.orders, p_old text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare u public.units; v_event text; v_title text; v_body text;
begin
  select * into u from public.units where id = o.unit_id;
  if p_old = 'awaiting_payment' and o.status in ('pending','preparing') then
    v_event := 'paid'; v_title := 'Pagamento confirmado';
    v_body := case when o.status = 'preparing' then 'Seu pedido #' || o.number || ' já está sendo preparado.'
      else 'Seu pedido #' || o.number || ' chegou na loja e logo será aceito.' end;
  elsif o.status = 'preparing' and p_old = 'pending' then
    v_event := 'accepted'; v_title := 'Pedido #' || o.number || ' aceito';
    v_body := 'A loja já está preparando seu pedido' ||
      coalesce(' (previsão ' || to_char(o.estimated_ready_at at time zone coalesce(u.timezone, 'America/Sao_Paulo'), 'HH24:MI') || ').', '.');
  elsif o.status in ('ready','awaiting_pickup') and o.type = 'pickup' then
    v_event := 'ready'; v_title := 'Pronto para retirar'; v_body := 'Seu pedido #' || o.number || ' está esperando por você no balcão.';
  elsif o.status = 'dispatched' then
    v_event := 'dispatched'; v_title := 'Saiu para entrega'; v_body := 'Seu pedido #' || o.number || ' está a caminho.';
  elsif o.status = 'completed' then
    v_event := 'completed'; v_title := 'Pedido concluído'; v_body := 'Bom apetite! Toque para avaliar o pedido #' || o.number || '.';
  elsif o.status = 'cancelled' then
    v_event := 'cancelled'; v_title := 'Pedido #' || o.number || ' cancelado';
    v_body := coalesce('Motivo: ' || nullif(left(o.cancel_reason, 140), ''), 'Fale com a loja se tiver dúvidas.');
  else return null; end if;
  return jsonb_build_object('event', v_event, 'title', left(u.name || ': ' || v_title, 120), 'body', v_body,
    'url', '/pedido/' || o.public_token, 'tag', 'pedido-' || o.number, 'icon', '/loja/' || u.slug || '/app-icon/192');
end $$;

create or replace function private.push_kick()
returns void language plpgsql security definer set search_path = '' as $$
declare v_secret text;
begin
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'push_worker_secret';
  if v_secret is null then return; end if;
  perform net.http_post(url := 'https://kcwidutqdqbyphrjnlef.supabase.co/functions/v1/push/worker', body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type','application/json','x-worker-secret', v_secret), timeout_milliseconds := 25000);
exception when others then null;
end $$;

create or replace function private.push_on_order()
returns trigger language plpgsql security definer set search_path = '' as $$
declare m jsonb; n int;
begin
  if not exists (select 1 from public.push_order_links where order_id = new.id) then return null; end if;
  m := private.push_message(new, old.status::text);
  if m is null then return null; end if;
  insert into public.push_queue (subscription_id, order_id, tenant_id, unit_id, event, payload)
  select l.subscription_id, new.id, new.tenant_id, new.unit_id, m->>'event', m - 'event'
  from public.push_order_links l where l.order_id = new.id
  on conflict (order_id, subscription_id, event) do nothing;
  get diagnostics n = row_count;
  if n > 0 then perform private.push_kick(); end if;
  return null;
exception when others then return null;   -- aviso nunca bloqueia o pedido
end $$;
create trigger orders_push after update of status on public.orders for each row
  when (old.status is distinct from new.status) execute function private.push_on_order();

-- ---------- Worker (função "push") ----------
create or replace function public.push_jobs(p_limit int default 50)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v jsonb;
begin
  perform private.assert_service_role();
  -- envios presos (worker caiu no meio) voltam para a fila
  update public.push_queue set status = 'queued' where status = 'sending' and next_attempt_at < now() - interval '5 minutes';
  with c as (
    select q.id from public.push_queue q where q.status = 'queued' and q.next_attempt_at <= now()
    order by q.id limit least(greatest(p_limit, 1), 200) for update skip locked),
  upd as (
    update public.push_queue q set status = 'sending', attempts = q.attempts + 1, next_attempt_at = now()
    from c where q.id = c.id returning q.id, q.subscription_id, q.payload, q.event)
  select coalesce(jsonb_agg(jsonb_build_object('id', upd.id, 'endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth,
      'payload', upd.payload, 'urgent', upd.event in ('ready','dispatched','cancelled')) order by upd.id), '[]'::jsonb) into v
  from upd join public.push_subscriptions s on s.id = upd.subscription_id;
  return v;
end $$;

create or replace function public.push_job_result(p_id bigint, p_ok boolean, p_gone boolean default false, p_error text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare q public.push_queue;
begin
  perform private.assert_service_role();
  select * into q from public.push_queue where id = p_id;
  if not found then return; end if;
  if p_ok then
    update public.push_queue set status = 'sent', sent_at = now(), error = null where id = p_id;
    update public.push_subscriptions set last_ok_at = now(), failures = 0 where id = q.subscription_id;
  elsif p_gone then
    -- o navegador cancelou a assinatura: apaga (os vínculos vão junto; a fila fica como histórico)
    update public.push_queue set status = 'gone', error = left(p_error, 300) where id = p_id;
    delete from public.push_subscriptions where id = q.subscription_id;
    update public.push_queue set status = 'gone' where subscription_id is null and status = 'queued';
  else
    update public.push_queue set status = case when q.attempts >= 4 then 'failed' else 'queued' end,
      next_attempt_at = now() + make_interval(mins => q.attempts * 2), error = left(p_error, 300) where id = p_id;
    update public.push_subscriptions set failures = failures + 1 where id = q.subscription_id;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from vault.secrets where name = 'push_worker_secret') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'push_worker_secret', 'Domma Food: worker de notificações (Web Push)');
  end if;
end $$;
create or replace function public.push_worker_secret()
returns text language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.assert_service_role();
  return (select decrypted_secret from vault.decrypted_secrets where name = 'push_worker_secret');
end $$;

create or replace function private.push_cron_tick()
returns void language plpgsql security definer set search_path = '' as $$
begin
  -- avisos velhos não servem mais; assinaturas sem uso há 60 dias saem
  delete from public.push_queue where created_at < now() - interval '30 days';
  delete from public.push_order_links where created_at < now() - interval '30 days';
  delete from public.push_subscriptions s where s.created_at < now() - interval '60 days'
    and not exists (select 1 from public.push_order_links l where l.subscription_id = s.id);
  update public.push_queue set status = 'failed', error = coalesce(error, 'Expirou na fila')
   where status = 'queued' and created_at < now() - interval '1 hour';
  if exists (select 1 from public.push_queue where status = 'queued' and next_attempt_at <= now()) then perform private.push_kick(); end if;
exception when others then null;
end $$;
select cron.schedule('domma-push', '*/2 * * * *', $$select private.push_cron_tick()$$);

-- ---------- Pedir de novo: pedidos guardados no aparelho ----------
create or replace function public.my_orders(p_slug text, p_tokens text[])
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_unit uuid;
begin
  select id into v_unit from public.units where slug = lower(p_slug) and active;
  if v_unit is null or p_tokens is null then return '[]'::jsonb; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('token', o.public_token, 'number', o.number, 'status', o.status, 'type', o.type,
        'created_at', o.created_at, 'total_cents', o.total_cents,
        'items', (select coalesce(jsonb_agg(jsonb_build_object('product_id', i.product_id, 'name', i.name, 'quantity', i.quantity,
            'notes', i.notes, 'options', (select coalesce(jsonb_agg(jsonb_build_object('option_id', x->>'option_id',
              'name', x->>'name', 'quantity', coalesce((x->>'quantity')::int, 1))), '[]'::jsonb)
              from jsonb_array_elements(case when jsonb_typeof(i.options) = 'array' then i.options else '[]'::jsonb end) x))), '[]'::jsonb)
          from public.order_items i where i.order_id = o.id))
      order by o.created_at desc)
    from (select * from public.orders where unit_id = v_unit
            and public_token = any (p_tokens[1:20]) and created_at > now() - interval '365 days'
          order by created_at desc limit 10) o), '[]'::jsonb);
end $$;

-- ---------- Painel: números do app ----------
create or replace function public.push_stats(p_unit_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare u public.units;
begin
  select * into u from public.units where id = p_unit_id;
  if not found or not private.can_manage(u.tenant_id) or not private.can_access_unit(u.id) then
    raise exception 'Sem permissão.' using errcode = '42501'; end if;
  return jsonb_build_object(
    'slug', u.slug,
    'ready', public.push_public_key() is not null,
    'orders_30d', (select count(*) from public.orders where unit_id = u.id and created_at > now() - interval '30 days' and channel = 'web'),
    'orders_with_push_30d', (select count(distinct order_id) from public.push_order_links where unit_id = u.id and created_at > now() - interval '30 days'),
    'devices_30d', (select count(distinct subscription_id) from public.push_order_links where unit_id = u.id and created_at > now() - interval '30 days'),
    'sent_30d', (select count(*) from public.push_queue where unit_id = u.id and status = 'sent' and created_at > now() - interval '30 days'),
    'failed_30d', (select count(*) from public.push_queue where unit_id = u.id and status = 'failed' and created_at > now() - interval '30 days'));
end $$;

grant execute on function public.push_public_key(), public.push_subscribe(text, text, text, text), public.push_unsubscribe(text, text),
  public.push_is_on(text, text), public.my_orders(text, text[]) to anon, authenticated;
grant execute on function public.push_stats(uuid) to authenticated;
revoke execute on function public.push_stats(uuid) from public, anon;
revoke execute on function public.push_vapid_get(), public.push_vapid_init(text, text), public.push_jobs(int),
  public.push_job_result(bigint, boolean, boolean, text), public.push_worker_secret() from public, anon, authenticated;
grant execute on function public.push_vapid_get(), public.push_vapid_init(text, text), public.push_jobs(int),
  public.push_job_result(bigint, boolean, boolean, text), public.push_worker_secret() to service_role;
revoke execute on function private.push_message(public.orders, text), private.push_kick(), private.push_on_order(), private.push_cron_tick()
  from public, anon, authenticated;
