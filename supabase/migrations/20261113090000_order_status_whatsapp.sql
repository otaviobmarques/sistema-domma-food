-- =====================================================================
-- Domma Food · 035 · Avisos de status do pedido pelo WhatsApp
-- Usa a mesma conta da API oficial do Marketing (marketing_settings).
-- Mensagens de utilidade, com modelo aprovado por evento; só para quem
-- marcou "receber avisos deste pedido" no checkout. Fila só de service_role.
-- =====================================================================
-- correção: o Postgres limita repetições de regex a 255; {1,512} quebrava campanhas com modelo
alter table public.campaigns drop constraint campaigns_template_name_check;
alter table public.campaigns add constraint campaigns_template_name_check
  check (template_name is null or template_name ~ '^[a-z0-9_]{1,255}$');

alter table public.marketing_settings add column status_enabled boolean not null default false;
alter table public.orders add column notify_whatsapp boolean not null default false;

create table public.status_templates (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  event text not null check (event in ('received','accepted','ready','dispatched','completed','cancelled')),
  enabled boolean not null default false,
  template_name text check (template_name is null or template_name ~ '^[a-z0-9_]{1,255}$'),
  template_lang text not null default 'pt_BR' check (template_lang ~ '^[a-z]{2,3}(_[A-Z]{2})?$'),
  template_params text[] not null default array['nome','numero'],
  updated_at timestamptz not null default now(),
  primary key (tenant_id, event),
  check (not enabled or template_name is not null),
  check (template_params <@ array['nome','numero','loja','link','previsao','entregador','total','motivo']::text[] and cardinality(template_params) <= 8)
);
create table public.order_notifications (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  order_id uuid references public.orders(id) on delete cascade,   -- nulo = envio de teste
  event text not null,
  phone text not null,
  template_name text not null,
  template_lang text not null,
  params jsonb not null default '[]',
  status text not null default 'queued' check (status in ('queued','sending','sent','delivered','read','failed','skipped')),
  wa_message_id text, error text, attempts integer not null default 0,
  created_at timestamptz not null default now(),
  sent_at timestamptz, delivered_at timestamptz, read_at timestamptz,
  unique (order_id, event)
);
create index order_notifications_queue_idx on public.order_notifications(id) where status = 'queued';
create index order_notifications_wa_idx on public.order_notifications(wa_message_id) where wa_message_id is not null;
create index order_notifications_tenant_idx on public.order_notifications(tenant_id, created_at desc);

alter table public.status_templates enable row level security;
alter table public.status_templates force row level security;
alter table public.order_notifications enable row level security;
alter table public.order_notifications force row level security;
create policy st_select on public.status_templates for select to authenticated using (private.can_manage(tenant_id));
create policy on_select on public.order_notifications for select to authenticated using (private.can_manage(tenant_id));

-- ---------- Montagem e enfileiramento ----------
create or replace function private.status_enqueue(p_order uuid, p_event text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare o public.orders; s public.marketing_settings; t public.status_templates; u public.units;
  v_params jsonb := '[]'::jsonb; k text; v_val text; v_phone text; v_tz text; v_courier text;
begin
  select * into o from public.orders where id = p_order;
  if not found or not o.notify_whatsapp or o.type = 'dine_in'
     or o.channel::text in ('ifood','keeta','99food','aiqfome','marketplace','table') then return false; end if;
  select * into s from public.marketing_settings where tenant_id = o.tenant_id;
  if not found or not s.wa_enabled or not s.status_enabled then return false; end if;
  select * into t from public.status_templates where tenant_id = o.tenant_id and event = p_event and enabled;
  if not found then return false; end if;
  v_phone := private.only_digits(o.customer_phone);
  if v_phone !~ '^[0-9]{10,13}$' then return false; end if;
  if length(v_phone) <= 11 then v_phone := '55' || v_phone; end if;
  select * into u from public.units where id = o.unit_id;
  v_tz := coalesce(u.timezone, 'America/Sao_Paulo');
  if 'entregador' = any (t.template_params) then
    select c.name into v_courier from public.deliveries d join public.couriers c on c.id = d.courier_id
     where d.order_id = o.id and d.status <> 'cancelled' order by d.created_at desc limit 1;
  end if;
  foreach k in array t.template_params loop
    v_val := case k
      when 'nome' then coalesce(nullif(split_part(trim(o.customer_name), ' ', 1), ''), 'cliente')
      when 'numero' then o.number::text
      when 'loja' then u.name
      when 'link' then 'https://domma-food.vercel.app/pedido/' || o.public_token
      when 'previsao' then coalesce(to_char(o.estimated_ready_at at time zone v_tz, 'HH24:MI'), 'em breve')
      when 'entregador' then coalesce(split_part(v_courier, ' ', 1), 'nosso entregador')
      when 'total' then 'R$ ' || to_char(o.total_cents / 100.0, 'FM999G990D00')
      when 'motivo' then coalesce(nullif(left(o.cancel_reason, 200), ''), 'não informado')
      else '' end;
    v_params := v_params || to_jsonb(v_val);
  end loop;
  insert into public.order_notifications (tenant_id, order_id, event, phone, template_name, template_lang, params)
  values (o.tenant_id, o.id, p_event, v_phone, t.template_name, t.template_lang, v_params)
  on conflict (order_id, event) do nothing;
  if found then perform private.kick_marketing_worker(); end if;
  return found;
end $$;

create or replace function private.status_on_order()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_event text;
begin
  if not new.notify_whatsapp then return null; end if;
  v_event := case
    when old.status = 'awaiting_payment' and new.status = 'pending' then 'received'
    when new.status = 'preparing' and old.status in ('pending','awaiting_payment') then 'accepted'
    when new.status in ('ready','awaiting_pickup') and new.type = 'pickup' then 'ready'
    when new.status = 'dispatched' then 'dispatched'
    when new.status = 'completed' then 'completed'
    when new.status = 'cancelled' then 'cancelled' end;
  -- Pix/cartão confirmado e já aceito automaticamente: o cliente fica sabendo das duas coisas
  if old.status = 'awaiting_payment' and new.status = 'preparing' then perform private.status_enqueue(new.id, 'received'); end if;
  if v_event is not null then perform private.status_enqueue(new.id, v_event); end if;
  return null;
exception when others then return null;   -- aviso nunca bloqueia o pedido
end $$;
create trigger orders_status_whatsapp after update of status on public.orders for each row
  when (old.status is distinct from new.status) execute function private.status_on_order();

create or replace function private.status_on_order_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
declare o public.orders;
begin
  select * into o from public.orders where id = new.id;   -- valor final (o checkout marca o aviso depois do insert)
  if o.notify_whatsapp and o.status in ('pending','preparing') then
    perform private.status_enqueue(o.id, 'received');
    if o.status = 'preparing' then perform private.status_enqueue(o.id, 'accepted'); end if;
  end if;
  return null;
exception when others then return null;
end $$;
create constraint trigger orders_status_whatsapp_insert after insert on public.orders deferrable initially deferred
  for each row execute function private.status_on_order_insert();

create or replace function private.status_store_flag(p_tenant uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select s.wa_enabled and s.status_enabled from public.marketing_settings s where s.tenant_id = p_tenant), false)
     and exists (select 1 from public.status_templates t where t.tenant_id = p_tenant and t.enabled);
$$;

-- checkout: o cliente escolhe receber os avisos deste pedido
do $$ declare d text; begin
  d := pg_get_functiondef('public.place_order(jsonb)'::regprocedure);
  if position($x$select customer_id, tenant_id into v_cust, v_tenant from public.orders where id = v_order;$x$ in d) = 0 then raise exception 'place_order mudou'; end if;
  execute replace(d, $x$select customer_id, tenant_id into v_cust, v_tenant from public.orders where id = v_order;$x$,
    $x$select customer_id, tenant_id into v_cust, v_tenant from public.orders where id = v_order;
  if coalesce((p->>'notify_whatsapp')::boolean, false) then
    update public.orders set notify_whatsapp = true where id = v_order;
  end if;$x$);
  -- cardápio: mostra a opção só quando a loja envia avisos
  d := pg_get_functiondef('public.get_store(text)'::regprocedure);
  if position($x$'is_open', v_open,$x$ in d) = 0 then raise exception 'get_store mudou'; end if;
  execute replace(d, $x$'is_open', v_open,$x$, $x$'is_open', v_open, 'wa_status', private.status_store_flag(u.tenant_id),$x$);
end $$;
