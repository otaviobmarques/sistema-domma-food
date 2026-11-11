-- =====================================================================
-- Domma Food · 030 · Impressão automática: impressoras por setor, fila de
-- impressão e agentes (programa no computador da loja ou aba do navegador)
-- =====================================================================
create table public.printers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  unit_id uuid not null references public.units(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  connection text not null default 'network' check (connection in ('network','system','browser')),
  address text check (address is null or char_length(address) <= 120),       -- IP:porta (rede) ou nome da impressora no sistema
  paper_width integer not null default 80 check (paper_width in (58, 80)),
  stations text[] not null default '{}',     -- setores do KDS que imprimem aqui (comanda de produção)
  print_receipt boolean not null default false,  -- via do pedido completa (balcão/entrega)
  copies integer not null default 1 check (copies between 1 and 3),
  on_event text not null default 'accepted' check (on_event in ('accepted','created')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create table public.print_agents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  unit_id uuid not null references public.units(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  token_hash text not null unique,
  last_seen_at timestamptz, last_seen_info text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create table public.print_jobs (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  unit_id uuid not null references public.units(id) on delete cascade,
  printer_id uuid not null references public.printers(id) on delete cascade,
  order_id uuid references public.orders(id) on delete set null,
  kind text not null check (kind in ('kitchen','receipt','test')),
  station text,
  content text not null,
  status text not null default 'queued' check (status in ('queued','printing','done','failed')),
  attempts integer not null default 0,
  error text,
  claimed_by uuid references public.print_agents(id) on delete set null,
  claimed_at timestamptz,
  created_at timestamptz not null default now(),
  printed_at timestamptz
);
create index print_jobs_queue_idx on public.print_jobs(unit_id, id) where status in ('queued','printing');
create index print_jobs_order_idx on public.print_jobs(order_id);

do $$ declare t text; begin
  foreach t in array array['printers','print_agents','print_jobs'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
  end loop;
end $$;
create policy pr_select on public.printers for select to authenticated
  using (private.can_access_unit(unit_id) and private.has_role(tenant_id, array['owner','manager','cashier','attendant','kitchen']::public.member_role[]));
create policy pr_write on public.printers for all to authenticated
  using (private.can_manage(tenant_id) and private.can_access_unit(unit_id))
  with check (private.can_manage(tenant_id) and private.can_access_unit(unit_id)
    and exists (select 1 from public.units u where u.id = unit_id and u.tenant_id = printers.tenant_id));
create policy pa_select on public.print_agents for select to authenticated
  using (private.can_manage(tenant_id) and private.can_access_unit(unit_id));
create policy pj_select on public.print_jobs for select to authenticated
  using (private.can_access_unit(unit_id) and private.has_role(tenant_id, array['owner','manager','cashier','attendant','kitchen']::public.member_role[]));
alter publication supabase_realtime add table public.print_jobs;

-- ---------- Texto do cupom (o agente converte para ESC/POS) ----------
-- Marcadores no início da linha: "##" título grande, "**" negrito, "--" linha divisória, "==" corte.
create or replace function private.print_ticket(p_order uuid, p_kind text, p_station text, p_width integer)
returns text language plpgsql stable security definer set search_path = '' as $$
declare o public.orders; u public.units; w int := case when p_width = 58 then 32 else 42 end; t text := ''; i record; op jsonb;
  v_tz text; v_type text; v_tab text;
  pad text;
begin
  select * into o from public.orders where id = p_order;
  select * into u from public.units where id = o.unit_id;
  v_tz := coalesce(u.timezone, 'America/Sao_Paulo');
  v_type := case o.type when 'delivery' then 'ENTREGA' when 'pickup' then 'RETIRADA' else 'SALÃO' end;
  select coalesce('MESA ' || dt.name, 'COMANDA ' || nullif(tb.label, '')) into v_tab
    from public.tabs tb left join public.dining_tables dt on dt.id = tb.table_id where tb.id = o.tab_id;
  t := t || '##' || case when p_kind = 'kitchen' then upper(coalesce(p_station, 'cozinha')) || ' #' || o.number else u.name end || e'\n';
  if p_kind = 'receipt' then t := t || '**Pedido #' || o.number || e'\n'; end if;
  t := t || '**' || coalesce(v_tab, v_type) || ' · ' || to_char(o.created_at at time zone v_tz, 'DD/MM HH24:MI') || e'\n';
  if o.scheduled_for is not null then t := t || '**AGENDADO: ' || to_char(o.scheduled_for at time zone v_tz, 'DD/MM HH24:MI') || e'\n'; end if;
  t := t || left(o.customer_name, w) || e'\n' || e'--\n';
  for i in select * from public.order_items where order_id = o.id
            and (p_kind <> 'kitchen' or coalesce(station, 'cozinha') = coalesce(p_station, 'cozinha')) order by id loop
    pad := case when p_kind = 'receipt' then to_char(i.total_cents / 100.0, 'FM999G990D00') else '' end;
    t := t || '**' || left(i.quantity || 'x ' || i.name, w - length(pad) - 1) || repeat(' ', greatest(w - length(left(i.quantity || 'x ' || i.name, w - length(pad) - 1)) - length(pad), 1)) || pad || e'\n';
    for op in select * from jsonb_array_elements(coalesce(i.options, '[]'::jsonb)) loop
      t := t || '  + ' || left(case when coalesce((op->>'quantity')::int, 1) > 1 then (op->>'quantity') || 'x ' else '' end || (op->>'name'), w - 4) || e'\n';
    end loop;
    if i.notes is not null then t := t || '  OBS: ' || left(i.notes, w * 2) || e'\n'; end if;
  end loop;
  if o.notes is not null then t := t || e'--\n' || '**OBS DO PEDIDO: ' || left(o.notes, w * 3) || e'\n'; end if;
  if p_kind = 'receipt' then
    t := t || e'--\n' || 'Subtotal' || lpad(to_char(o.subtotal_cents / 100.0, 'FM999G990D00'), w - 8) || e'\n';
    if o.discount_cents > 0 then t := t || 'Desconto' || lpad('-' || to_char(o.discount_cents / 100.0, 'FM999G990D00'), w - 8) || e'\n'; end if;
    if o.delivery_fee_cents > 0 then t := t || 'Entrega' || lpad(to_char(o.delivery_fee_cents / 100.0, 'FM999G990D00'), w - 7) || e'\n'; end if;
    t := t || '**TOTAL' || lpad('R$ ' || to_char(o.total_cents / 100.0, 'FM999G990D00'), w - 5) || e'\n';
    t := t || 'Pagamento: ' || case o.payment_method::text when 'pix' then 'Pix' when 'cash' then 'Dinheiro' when 'card_on_delivery' then 'Cartão na entrega'
      when 'credit_card' then 'Crédito' when 'debit_card' then 'Débito' when 'online_card' then 'Cartão online' when 'voucher' then 'Vale' when 'credit_account' then 'Fiado' else o.payment_method::text end
      || case when o.payment_status = 'paid' then ' (PAGO)' else ' (A RECEBER)' end || e'\n';
    if o.change_for_cents is not null then t := t || '**Troco para R$ ' || to_char(o.change_for_cents / 100.0, 'FM999G990D00') || e'\n'; end if;
    if o.type = 'delivery' and o.address is not null then
      t := t || e'--\n' || '**' || left(concat_ws(', ', o.address->>'street', o.address->>'number'), w * 2) || e'\n'
        || left(concat_ws(' · ', o.address->>'complement', o.address->>'neighborhood'), w * 2) || e'\n';
      if o.address->>'reference' is not null then t := t || 'Ref: ' || left(o.address->>'reference', w * 2) || e'\n'; end if;
      t := t || 'Tel: ' || o.customer_phone || e'\n';
    end if;
    t := t || e'--\n' || 'Documento sem valor fiscal' || e'\n';
  end if;
  return t || e'==\n';
end $$;

-- enfileira as impressões de um pedido conforme as impressoras da loja
create or replace function private.print_enqueue_order(p_order uuid, p_event text)
returns integer language plpgsql security definer set search_path = '' as $$
declare o public.orders; p public.printers; st text; n int := 0; c int;
begin
  select * into o from public.orders where id = p_order;
  for p in select * from public.printers where unit_id = o.unit_id and active and on_event = p_event loop
    for c in 1..p.copies loop
      foreach st in array p.stations loop
        if exists (select 1 from public.order_items where order_id = o.id and coalesce(station, 'cozinha') = st) then
          insert into public.print_jobs (tenant_id, unit_id, printer_id, order_id, kind, station, content)
          values (o.tenant_id, o.unit_id, p.id, o.id, 'kitchen', st, private.print_ticket(o.id, 'kitchen', st, p.paper_width));
          n := n + 1;
        end if;
      end loop;
      if p.print_receipt then
        insert into public.print_jobs (tenant_id, unit_id, printer_id, order_id, kind, content)
        values (o.tenant_id, o.unit_id, p.id, o.id, 'receipt', private.print_ticket(o.id, 'receipt', null, p.paper_width));
        n := n + 1;
      end if;
    end loop;
  end loop;
  return n;
end $$;

-- gatilho: pedido aceito (ou criado, conforme a impressora). Itens de mesa entram como pedidos novos da comanda.
create or replace function private.print_on_order()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and new.status = 'preparing' and old.status in ('pending','awaiting_payment') then
    perform private.print_enqueue_order(new.id, 'accepted');
  end if;
  -- Pix/cartão confirmado depois: para a loja, o pedido "chegou" agora
  if tg_op = 'UPDATE' and old.status = 'awaiting_payment' and new.status in ('pending','preparing') then
    perform private.print_enqueue_order(new.id, 'created');
  end if;
  return null;
exception when others then return null;  -- impressão nunca bloqueia o pedido
end $$;
create trigger orders_print after update of status on public.orders for each row execute function private.print_on_order();

-- pedidos que já nascem aceitos (PDV, mesa, aceite automático) ou recém-criados: os itens entram depois do pedido,
-- então a impressão é disparada no fim da transação
create or replace function private.print_on_order_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'preparing' then perform private.print_enqueue_order(new.id, 'accepted'); end if;
  if new.status in ('pending','preparing') then perform private.print_enqueue_order(new.id, 'created'); end if;
  return null;
exception when others then return null;
end $$;
create constraint trigger orders_print_insert after insert on public.orders deferrable initially deferred
  for each row execute function private.print_on_order_insert();

-- ---------- Painel ----------
create or replace function public.print_test(p_printer_id uuid)
returns bigint language plpgsql security definer set search_path = '' as $$
declare p public.printers; v bigint; u public.units;
begin
  select * into p from public.printers where id = p_printer_id;
  if not found or not private.can_access_unit(p.unit_id) or not private.can_manage(p.tenant_id) then raise exception 'Sem permissão.' using errcode = '42501'; end if;
  select * into u from public.units where id = p.unit_id;
  insert into public.print_jobs (tenant_id, unit_id, printer_id, kind, content)
  values (p.tenant_id, p.unit_id, p.id, 'test', '##TESTE DE IMPRESSÃO' || e'\n' || '**' || u.name || e'\n' || 'Impressora: ' || p.name || e'\n'
    || 'Papel: ' || p.paper_width || ' mm' || e'\n--\n' || 'Se você está lendo isto, a impressão' || e'\n' || 'automática está funcionando.' || e'\n==\n')
  returning id into v;
  return v;
end $$;

create or replace function public.print_reprint(p_order_id uuid)
returns integer language plpgsql security definer set search_path = '' as $$
declare o public.orders;
begin
  select * into o from public.orders where id = p_order_id;
  if not found or not private.can_access_unit(o.unit_id) or not private.has_role(o.tenant_id, array['owner','manager','cashier','attendant','kitchen']::public.member_role[]) then
    raise exception 'Sem permissão.' using errcode = '42501'; end if;
  return private.print_enqueue_order(o.id, 'accepted') + private.print_enqueue_order(o.id, 'created');
end $$;

-- agente: cria e devolve o token uma única vez (guardamos só o hash)
create or replace function public.print_agent_create(p_unit_id uuid, p_name text)
returns text language plpgsql security definer set search_path = '' as $$
declare u public.units; v_tok text := 'dfp_' || encode(extensions.gen_random_bytes(24), 'hex');
begin
  select * into u from public.units where id = p_unit_id;
  if not found or not private.can_access_unit(u.id) or not private.can_manage(u.tenant_id) then raise exception 'Sem permissão.' using errcode = '42501'; end if;
  insert into public.print_agents (tenant_id, unit_id, name, token_hash)
  values (u.tenant_id, u.id, left(coalesce(nullif(trim(p_name), ''), 'Computador da loja'), 60), encode(extensions.digest(v_tok, 'sha256'), 'hex'));
  return v_tok;
end $$;
create or replace function public.print_agent_revoke(p_agent_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare a public.print_agents;
begin
  select * into a from public.print_agents where id = p_agent_id;
  if not found or not private.can_manage(a.tenant_id) then raise exception 'Sem permissão.' using errcode = '42501'; end if;
  update public.print_agents set active = false where id = a.id;
end $$;

-- ---------- Agente (programa da loja): pega e confirma trabalhos ----------
create or replace function private.print_agent_by_token(p_token text)
returns public.print_agents language sql stable security definer set search_path = '' as $$
  select * from public.print_agents where active and p_token ~ '^dfp_[0-9a-f]{48}$'
    and token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex');
$$;
create or replace function public.print_agent_poll(p_token text, p_info text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare a public.print_agents; v jsonb;
begin
  a := private.print_agent_by_token(p_token);
  if a.id is null then raise exception 'Chave do agente inválida.' using errcode = '42501'; end if;
  update public.print_agents set last_seen_at = now(), last_seen_info = left(p_info, 120) where id = a.id;
  -- trabalhos presos (agente caiu no meio) voltam para a fila
  update public.print_jobs set status = 'queued' where unit_id = a.unit_id and status = 'printing' and claimed_at < now() - interval '2 minutes';
  with picked as (
    select j.id from public.print_jobs j join public.printers p on p.id = j.printer_id
    where j.unit_id = a.unit_id and j.status = 'queued' and p.connection in ('network','system') and p.active
    order by j.id limit 10 for update of j skip locked)
  update public.print_jobs j set status = 'printing', claimed_by = a.id, claimed_at = now(), attempts = attempts + 1
  from picked where j.id = picked.id;
  select coalesce(jsonb_agg(jsonb_build_object('id', j.id, 'content', j.content, 'printer', jsonb_build_object(
      'connection', p.connection, 'address', p.address, 'paper_width', p.paper_width, 'name', p.name)) order by j.id), '[]'::jsonb) into v
  from public.print_jobs j join public.printers p on p.id = j.printer_id
  where j.claimed_by = a.id and j.status = 'printing' and j.claimed_at > now() - interval '10 seconds';
  return jsonb_build_object('agent', a.name, 'jobs', v);
end $$;
create or replace function public.print_agent_done(p_token text, p_job_id bigint, p_ok boolean, p_error text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare a public.print_agents;
begin
  a := private.print_agent_by_token(p_token);
  if a.id is null then raise exception 'Chave do agente inválida.' using errcode = '42501'; end if;
  update public.print_jobs set status = case when p_ok then 'done' when attempts >= 3 then 'failed' else 'queued' end,
    printed_at = case when p_ok then now() end, error = case when p_ok then null else left(p_error, 300) end
  where id = p_job_id and claimed_by = a.id and status = 'printing';
end $$;

-- ---------- Estação no navegador (painel aberto em um computador) ----------
create or replace function public.print_browser_claim(p_unit_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare u public.units; v jsonb;
begin
  select * into u from public.units where id = p_unit_id;
  if not found or not private.can_access_unit(u.id) or not private.has_role(u.tenant_id, array['owner','manager','cashier','attendant','kitchen']::public.member_role[]) then
    raise exception 'Sem permissão.' using errcode = '42501'; end if;
  update public.print_jobs set status = 'queued' where unit_id = u.id and status = 'printing' and claimed_by is null and claimed_at < now() - interval '2 minutes';
  with picked as (
    select j.id from public.print_jobs j join public.printers p on p.id = j.printer_id
    where j.unit_id = u.id and j.status = 'queued' and p.connection = 'browser' and p.active order by j.id limit 10 for update of j skip locked)
  update public.print_jobs j set status = 'printing', claimed_at = now(), attempts = attempts + 1 from picked where j.id = picked.id;
  select coalesce(jsonb_agg(jsonb_build_object('id', j.id, 'content', j.content, 'paper_width', p.paper_width, 'printer', p.name) order by j.id), '[]'::jsonb) into v
  from public.print_jobs j join public.printers p on p.id = j.printer_id
  where j.unit_id = u.id and j.status = 'printing' and j.claimed_by is null and p.connection = 'browser' and j.claimed_at > now() - interval '10 seconds';
  return v;
end $$;
create or replace function public.print_browser_done(p_job_id bigint, p_ok boolean, p_error text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare j public.print_jobs;
begin
  select * into j from public.print_jobs where id = p_job_id;
  if not found or not private.can_access_unit(j.unit_id) then raise exception 'Sem permissão.' using errcode = '42501'; end if;
  update public.print_jobs set status = case when p_ok then 'done' when attempts >= 3 then 'failed' else 'queued' end,
    printed_at = case when p_ok then now() end, error = case when p_ok then null else left(p_error, 300) end
  where id = j.id and status = 'printing';
end $$;

grant execute on function public.print_agent_poll(text, text), public.print_agent_done(text, bigint, boolean, text) to anon, authenticated;
grant execute on function public.print_test(uuid), public.print_reprint(uuid), public.print_agent_create(uuid, text), public.print_agent_revoke(uuid),
  public.print_browser_claim(uuid), public.print_browser_done(bigint, boolean, text) to authenticated;
