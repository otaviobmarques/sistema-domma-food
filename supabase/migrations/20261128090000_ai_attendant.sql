-- Atendente IA no WhatsApp
-- Responde os clientes no WhatsApp oficial da loja: cardápio, preços, horário, entrega, pagamento e situação
-- do pedido, e manda o link do cardápio para o cliente fechar o pedido. Passa para a equipe quando não sabe,
-- quando o cliente pede uma pessoa ou em reclamações.
-- - Chave da IA: a da plataforma (admin, com limite de respostas por mês por loja) ou a da própria loja (sem limite).
-- - Mensagem do cliente → fila (ai_jobs, espera alguns segundos para juntar mensagens seguidas) → função "atendente"
--   (Claude) → resposta entra na conversa como mensagem da loja, marcada como IA.
-- - A IA para sozinha na conversa quando alguém da equipe responde (12 h) ou quando passa para a equipe.
-- - Tudo pelas funções abaixo; as tabelas novas não têm acesso direto.

-- ---------- Configuração ----------
create table public.ai_platform_settings (
  id boolean primary key default true check (id),
  enabled boolean not null default false,
  api_key_secret_id uuid,
  api_key_hint text,
  monthly_limit integer not null default 300 check (monthly_limit between 0 and 100000),
  last_test_at timestamptz, last_test_ok boolean, last_test_error text,
  updated_at timestamptz not null default now()
);
insert into public.ai_platform_settings (id) values (true);

create table public.ai_attendants (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  enabled boolean not null default false,
  unit_id uuid references public.units(id) on delete set null,
  instructions text check (instructions is null or char_length(instructions) <= 2000),
  use_own_key boolean not null default false,
  own_key_secret_id uuid,
  own_key_hint text,
  monthly_limit integer check (monthly_limit is null or monthly_limit between 0 and 100000),   -- só o admin muda
  last_test_at timestamptz, last_test_ok boolean, last_test_error text,
  updated_at timestamptz not null default now()
);

alter table public.wa_conversations add column ai_paused_until timestamptz;
alter table public.wa_conversations add column needs_human boolean not null default false;
alter table public.wa_conversations add column ai_handoff_reason text check (ai_handoff_reason is null or char_length(ai_handoff_reason) <= 300);
alter table public.wa_messages add column by_ai boolean not null default false;

create table public.ai_jobs (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  conversation_id uuid not null references public.wa_conversations(id) on delete cascade,
  status text not null default 'queued' check (status in ('queued','running','done','skipped','failed')),
  run_after timestamptz not null default now(),
  attempts integer not null default 0,
  result text check (result is null or char_length(result) <= 500),
  reply_message_id bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index ai_jobs_one_queued on public.ai_jobs(conversation_id) where status = 'queued';
create index ai_jobs_due on public.ai_jobs(run_after) where status = 'queued';
create index ai_jobs_tenant on public.ai_jobs(tenant_id, created_at desc);

create table public.ai_usage (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  month date not null,
  source text not null check (source in ('platform','own')),
  replies integer not null default 0,
  input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  cache_read_tokens bigint not null default 0,
  primary key (tenant_id, month, source)
);

alter table public.ai_platform_settings enable row level security;
alter table public.ai_platform_settings force row level security;
alter table public.ai_attendants enable row level security;
alter table public.ai_attendants force row level security;
alter table public.ai_jobs enable row level security;
alter table public.ai_jobs force row level security;
alter table public.ai_usage enable row level security;
alter table public.ai_usage force row level security;
revoke all on public.ai_platform_settings, public.ai_attendants, public.ai_jobs, public.ai_usage from anon, authenticated;

-- ---------- Worker (mesmo padrão do marketing) ----------
do $$ begin
  if not exists (select 1 from vault.secrets where name = 'ai_worker_secret') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'ai_worker_secret', 'Domma Food: worker do atendente IA');
  end if;
  if not exists (select 1 from vault.secrets where name = 'ai_worker_url') then
    perform vault.create_secret('https://kcwidutqdqbyphrjnlef.supabase.co/functions/v1/atendente/worker', 'ai_worker_url', 'Domma Food: URL do worker do atendente IA');
  end if;
end $$;

create or replace function private.kick_ai_worker()
returns void language plpgsql security definer set search_path = '' as $$
declare v_url text; v_secret text;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'ai_worker_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'ai_worker_secret';
  if v_url is null or v_secret is null then return; end if;
  perform net.http_post(url := v_url, body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type','application/json','x-worker-secret', v_secret), timeout_milliseconds := 25000);
exception when others then null;
end $$;

create or replace function public.ai_worker_secret()
returns text language sql stable security definer set search_path = '' as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'ai_worker_secret';
$$;

-- limite do mês (null = sem limite: chave própria)
create or replace function private.ai_limit(p_tenant uuid)
returns integer language sql stable security definer set search_path = '' as $$
  select case when a.use_own_key then null else coalesce(a.monthly_limit, s.monthly_limit) end
  from public.ai_attendants a cross join public.ai_platform_settings s where a.tenant_id = p_tenant;
$$;
create or replace function private.ai_used(p_tenant uuid, p_source text)
returns integer language sql stable security definer set search_path = '' as $$
  select coalesce((select replies from public.ai_usage where tenant_id = p_tenant and source = p_source
                   and month = date_trunc('month', now())::date), 0);
$$;
-- chave disponível agora para a loja: 'own', 'platform' ou null
create or replace function private.ai_key_source(p_tenant uuid)
returns text language sql stable security definer set search_path = '' as $$
  select case
    when a.use_own_key and a.own_key_secret_id is not null then 'own'
    when not a.use_own_key and s.enabled and s.api_key_secret_id is not null then 'platform'
  end
  from public.ai_attendants a cross join public.ai_platform_settings s where a.tenant_id = p_tenant;
$$;

-- ---------- Gatilhos na conversa ----------
create or replace function private.ai_on_message()
returns trigger language plpgsql security definer set search_path = '' as $$
declare c public.wa_conversations;
begin
  if new.direction = 'in' then
    if not exists (select 1 from public.ai_attendants where tenant_id = new.tenant_id and enabled) then return null; end if;
    select * into c from public.wa_conversations where id = new.conversation_id;
    if c.needs_human or (c.ai_paused_until is not null and c.ai_paused_until > now()) then return null; end if;
    -- espera alguns segundos para juntar mensagens seguidas do cliente numa resposta só
    insert into public.ai_jobs (tenant_id, conversation_id, run_after) values (new.tenant_id, new.conversation_id, now() + interval '6 seconds')
    on conflict (conversation_id) where status = 'queued' do update set run_after = now() + interval '6 seconds', updated_at = now();
    perform private.kick_ai_worker();
  elsif new.direction = 'out' and not new.by_ai and new.author_id is not null then
    -- alguém da equipe respondeu: a IA sai da conversa por 12 h
    update public.wa_conversations set ai_paused_until = greatest(coalesce(ai_paused_until, now()), now() + interval '12 hours'),
      needs_human = false where id = new.conversation_id;
    update public.ai_jobs set status = 'skipped', result = 'A equipe respondeu.', updated_at = now()
     where conversation_id = new.conversation_id and status = 'queued';
  end if;
  return null;
exception when others then
  return null;   -- a IA nunca atrapalha a caixa de entrada
end $$;
create trigger wa_messages_ai after insert on public.wa_messages for each row execute function private.ai_on_message();

-- ---------- Caixa de entrada: mostra a IA ----------
do $$ declare d text; begin
  d := pg_get_functiondef('public.inbox_overview(uuid)'::regprocedure);
  if position($x$c.customer_id, cu.orders_count$x$ in d) = 0 or position($x$return jsonb_build_object('wa_enabled'$x$ in d) = 0 then
    raise exception 'inbox_overview mudou'; end if;
  d := replace(d, $x$c.customer_id, cu.orders_count$x$, $x$c.customer_id, cu.orders_count, c.needs_human, c.ai_handoff_reason,
        (c.ai_paused_until is not null and c.ai_paused_until > now()) as ai_paused$x$);
  d := replace(d, $x$return jsonb_build_object('wa_enabled'$x$,
        $x$return jsonb_build_object('ai_enabled', exists (select 1 from public.ai_attendants a where a.tenant_id = p_tenant_id and a.enabled),
        'needs_human', (select count(*) from public.wa_conversations where tenant_id = p_tenant_id and needs_human and status = 'open'),
        'wa_enabled'$x$);
  execute d;
  d := pg_get_functiondef('public.inbox_open(uuid)'::regprocedure);
  if position($x$'window_closes_at', c.last_inbound_at + interval '24 hours')$x$ in d) = 0 or position($x$'order_id', m.order_id)$x$ in d) = 0 then
    raise exception 'inbox_open mudou'; end if;
  d := replace(d, $x$'window_closes_at', c.last_inbound_at + interval '24 hours')$x$,
        $x$'window_closes_at', c.last_inbound_at + interval '24 hours', 'needs_human', c.needs_human, 'ai_handoff_reason', c.ai_handoff_reason,
        'ai_paused_until', case when c.ai_paused_until > now() then c.ai_paused_until end)$x$);
  d := replace(d, $x$'order_id', m.order_id)$x$, $x$'order_id', m.order_id, 'by_ai', m.by_ai)$x$);
  execute d;
end $$;

-- a equipe liga/pausa a IA numa conversa ou marca como resolvida
create or replace function public.ai_conversation_set(p_conversation_id uuid, p_mode text)
returns void language plpgsql security definer set search_path = '' as $$
declare c public.wa_conversations;
begin
  select * into c from public.wa_conversations where id = p_conversation_id;
  if not found or not private.inbox_staff(c.tenant_id) then raise exception 'Sem permissão.' using errcode = '42501'; end if;
  if p_mode = 'auto' then
    update public.wa_conversations set ai_paused_until = null, needs_human = false, ai_handoff_reason = null where id = c.id;
  elsif p_mode = 'pause' then
    update public.wa_conversations set ai_paused_until = 'infinity' where id = c.id;
    update public.ai_jobs set status = 'skipped', result = 'IA pausada na conversa.', updated_at = now() where conversation_id = c.id and status = 'queued';
  elsif p_mode = 'resolved' then
    update public.wa_conversations set needs_human = false, ai_handoff_reason = null where id = c.id;
  else
    raise exception 'Modo inválido.';
  end if;
end $$;

-- ---------- Painel da loja ----------
create or replace function public.ai_settings_get(p_tenant_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare a public.ai_attendants; s public.ai_platform_settings;
begin
  if not private.can_manage(p_tenant_id) then raise exception 'Sem permissão.' using errcode = '42501'; end if;
  select * into a from public.ai_attendants where tenant_id = p_tenant_id;
  select * into s from public.ai_platform_settings;
  return jsonb_build_object(
    'enabled', coalesce(a.enabled, false), 'unit_id', a.unit_id, 'instructions', a.instructions,
    'use_own_key', coalesce(a.use_own_key, false), 'own_key_hint', a.own_key_hint,
    'own_key_test', case when a.last_test_at is null then null else jsonb_build_object('at', a.last_test_at, 'ok', a.last_test_ok, 'error', a.last_test_error) end,
    'platform_available', s.enabled and s.api_key_secret_id is not null,
    'monthly_limit', coalesce(a.monthly_limit, s.monthly_limit),
    'used_platform', private.ai_used(p_tenant_id, 'platform'), 'used_own', private.ai_used(p_tenant_id, 'own'),
    'wa_enabled', exists (select 1 from public.marketing_settings m where m.tenant_id = p_tenant_id and m.wa_enabled and m.wa_phone_number_id is not null),
    'can_edit', private.has_role(p_tenant_id, array['owner']::public.member_role[]));
end $$;

create or replace function public.ai_settings_save(p_tenant_id uuid, p jsonb, p_own_key text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare a public.ai_attendants; s public.ai_platform_settings; v_key text := nullif(trim(coalesce(p_own_key, '')), ''); v_unit uuid;
  v_enabled boolean; v_own boolean;
begin
  if not private.has_role(p_tenant_id, array['owner']::public.member_role[]) then
    raise exception 'Só o dono da conta configura o atendente IA.' using errcode = '42501'; end if;
  insert into public.ai_attendants (tenant_id) values (p_tenant_id) on conflict (tenant_id) do nothing;
  select * into a from public.ai_attendants where tenant_id = p_tenant_id for update;
  select * into s from public.ai_platform_settings;
  if v_key is not null then
    if v_key !~ '^sk-ant-[A-Za-z0-9_-]{20,200}$' then raise exception 'Chave inválida: copie a chave da API do Claude (começa com sk-ant-).'; end if;
    if a.own_key_secret_id is null then
      a.own_key_secret_id := vault.create_secret(v_key, 'ai_key_' || p_tenant_id, 'Domma Food: chave do atendente IA da loja');
    else
      perform vault.update_secret(a.own_key_secret_id, v_key);
    end if;
    update public.ai_attendants set own_key_secret_id = a.own_key_secret_id, own_key_hint = '…' || right(v_key, 4),
      last_test_at = null, last_test_ok = null, last_test_error = null where tenant_id = p_tenant_id;
    a.last_test_ok := null;
  end if;
  if p ? 'unit_id' then
    v_unit := nullif(p->>'unit_id', '')::uuid;
    if v_unit is not null and not exists (select 1 from public.units where id = v_unit and tenant_id = p_tenant_id) then raise exception 'Loja inválida.'; end if;
  else v_unit := a.unit_id; end if;
  v_own := coalesce((p->>'use_own_key')::boolean, a.use_own_key);
  v_enabled := coalesce((p->>'enabled')::boolean, a.enabled);
  if v_enabled then
    if not exists (select 1 from public.marketing_settings m where m.tenant_id = p_tenant_id and m.wa_enabled and m.wa_phone_number_id is not null) then
      raise exception 'Ligue antes o WhatsApp oficial em Marketing › WhatsApp: o atendente responde por ele.'; end if;
    if v_own and (a.own_key_secret_id is null or a.last_test_ok is not true) then
      raise exception 'Teste a sua chave antes de ligar o atendente.'; end if;
    if not v_own and not (s.enabled and s.api_key_secret_id is not null) then
      raise exception 'A IA da plataforma ainda não está disponível. Use a sua própria chave.'; end if;
  end if;
  update public.ai_attendants set enabled = v_enabled, use_own_key = v_own,
    unit_id = coalesce(v_unit, (select id from public.units where tenant_id = p_tenant_id order by created_at limit 1)),
    instructions = case when p ? 'instructions' then left(nullif(trim(p->>'instructions'), ''), 2000) else instructions end,
    updated_at = now()
  where tenant_id = p_tenant_id;
  insert into public.audit_logs (tenant_id, actor_id, action, entity, entity_id, after, ip)
  values (p_tenant_id, auth.uid(), 'ai_settings', 'ai_attendants', p_tenant_id::text,
          (p - 'instructions') || jsonb_build_object('own_key_changed', v_key is not null), private.request_ip());
  return public.ai_settings_get(p_tenant_id);
exception when check_violation then raise exception 'As instruções passam de 2.000 caracteres.';
end $$;

-- ---------- Admin da plataforma ----------
create or replace function public.admin_ai_settings()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare s public.ai_platform_settings;
begin
  if not private.is_platform_admin() then raise exception 'Sem permissão.' using errcode = '42501'; end if;
  select * into s from public.ai_platform_settings;
  return jsonb_build_object('enabled', s.enabled, 'api_key_hint', s.api_key_hint, 'monthly_limit', s.monthly_limit,
    'last_test', case when s.last_test_at is null then null else jsonb_build_object('at', s.last_test_at, 'ok', s.last_test_ok, 'error', s.last_test_error) end,
    'tenants', coalesce((select jsonb_agg(jsonb_build_object('tenant_id', t.id, 'name', t.name, 'enabled', a.enabled, 'use_own_key', a.use_own_key,
        'monthly_limit', a.monthly_limit, 'effective_limit', coalesce(a.monthly_limit, s.monthly_limit),
        'used_platform', private.ai_used(t.id, 'platform'), 'used_own', private.ai_used(t.id, 'own'),
        'tokens_month', (select coalesce(sum(input_tokens + output_tokens), 0) from public.ai_usage u where u.tenant_id = t.id and u.month = date_trunc('month', now())::date))
        order by a.enabled desc, t.name)
      from public.ai_attendants a join public.tenants t on t.id = a.tenant_id), '[]'::jsonb));
end $$;

create or replace function public.admin_ai_save(p jsonb, p_api_key text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.ai_platform_settings; v_key text := nullif(trim(coalesce(p_api_key, '')), ''); v_enabled boolean;
begin
  if not private.is_platform_admin() then raise exception 'Sem permissão.' using errcode = '42501'; end if;
  select * into s from public.ai_platform_settings for update;
  if v_key is not null then
    if v_key !~ '^sk-ant-[A-Za-z0-9_-]{20,200}$' then raise exception 'Chave inválida: copie a chave da API do Claude (começa com sk-ant-).'; end if;
    if s.api_key_secret_id is null then
      s.api_key_secret_id := vault.create_secret(v_key, 'ai_platform_key', 'Domma Food: chave da plataforma para o atendente IA');
    else
      perform vault.update_secret(s.api_key_secret_id, v_key);
    end if;
    update public.ai_platform_settings set api_key_secret_id = s.api_key_secret_id, api_key_hint = '…' || right(v_key, 4),
      last_test_at = null, last_test_ok = null, last_test_error = null;
    s.last_test_ok := null;
  end if;
  v_enabled := coalesce((p->>'enabled')::boolean, s.enabled);
  if v_enabled and (s.api_key_secret_id is null or s.last_test_ok is not true) then
    raise exception 'Teste a chave antes de ligar a IA da plataforma.'; end if;
  update public.ai_platform_settings set enabled = v_enabled,
    monthly_limit = coalesce((p->>'monthly_limit')::int, monthly_limit), updated_at = now();
  insert into public.audit_logs (tenant_id, actor_id, action, entity, entity_id, after, ip)
  values (null, auth.uid(), 'ai_platform_settings', 'ai_platform_settings', 'platform', p || jsonb_build_object('key_changed', v_key is not null), private.request_ip());
  return public.admin_ai_settings();
exception when check_violation then raise exception 'Limite mensal inválido (0 a 100.000).';
end $$;

create or replace function public.admin_ai_tenant_limit(p_tenant_id uuid, p_limit integer)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_platform_admin() then raise exception 'Sem permissão.' using errcode = '42501'; end if;
  if p_limit is not null and (p_limit < 0 or p_limit > 100000) then raise exception 'Limite inválido (0 a 100.000).'; end if;
  insert into public.ai_attendants (tenant_id, monthly_limit) values (p_tenant_id, p_limit)
  on conflict (tenant_id) do update set monthly_limit = excluded.monthly_limit, updated_at = now();
  insert into public.audit_logs (tenant_id, actor_id, action, entity, entity_id, after, ip)
  values (p_tenant_id, auth.uid(), 'ai_tenant_limit', 'ai_attendants', p_tenant_id::text, jsonb_build_object('monthly_limit', p_limit), private.request_ip());
end $$;

-- ---------- Teste de chave (função "atendente") ----------
-- quem chama com o próprio login: o admin testa a da plataforma; o dono testa a da loja
create or replace function public.ai_can_test(p_scope text, p_tenant_id uuid default null)
returns boolean language sql stable security definer set search_path = '' as $$
  select case p_scope when 'platform' then private.is_platform_admin()
                      when 'tenant' then private.has_role(p_tenant_id, array['owner']::public.member_role[]) else false end;
$$;
create or replace function public.ai_key_for_test(p_scope text, p_tenant_id uuid default null)
returns text language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.assert_service_role();
  return (select decrypted_secret from vault.decrypted_secrets where id =
    case p_scope when 'platform' then (select api_key_secret_id from public.ai_platform_settings)
                 else (select own_key_secret_id from public.ai_attendants where tenant_id = p_tenant_id) end);
end $$;
create or replace function public.ai_key_test_result(p_scope text, p_tenant_id uuid, p_ok boolean, p_error text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.assert_service_role();
  if p_scope = 'platform' then
    update public.ai_platform_settings set last_test_at = now(), last_test_ok = p_ok, last_test_error = left(p_error, 300),
      enabled = enabled and p_ok;
  else
    update public.ai_attendants set last_test_at = now(), last_test_ok = p_ok, last_test_error = left(p_error, 300),
      enabled = case when use_own_key then enabled and p_ok else enabled end where tenant_id = p_tenant_id;
  end if;
end $$;

-- ---------- Contexto para a IA ----------
create or replace function private.ai_store_context(p_tenant uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare a public.ai_attendants; u public.units; v_store jsonb;
begin
  select * into a from public.ai_attendants where tenant_id = p_tenant;
  select * into u from public.units where id = a.unit_id and tenant_id = p_tenant and active;
  if not found then select * into u from public.units where tenant_id = p_tenant and active order by created_at limit 1; end if;
  if u.id is null then return null; end if;
  v_store := public.get_store(u.slug);
  return jsonb_build_object(
    'name', u.name, 'description', u.description, 'menu_url', private.store_url_by_slug(u.slug),
    'address', nullif(concat_ws(', ', nullif(concat_ws(' ', u.street, u.number), ''), u.complement, u.neighborhood,
                                nullif(concat_ws(' - ', u.city, u.state), '')), ''),
    'phone', u.phone, 'timezone', u.timezone, 'is_open', v_store->'unit'->'is_open', 'opening_hours', u.opening_hours,
    'accepts_delivery', u.accepts_delivery, 'accepts_pickup', u.accepts_pickup, 'accepts_scheduling', u.accepts_scheduling,
    'min_order_cents', u.min_order_cents, 'prep_time_min', u.prep_time_min, 'pickup_time_min', u.pickup_time_min,
    'accepted_payments', u.accepted_payments, 'zones', v_store->'zones', 'menu', v_store->'menu',
    'instructions', a.instructions);
end $$;

-- o worker pega as conversas na vez (no máximo uma por vez em cada conversa)
create or replace function public.ai_jobs_claim(p_limit integer default 5)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v jsonb;
begin
  perform private.assert_service_role();
  -- trabalho que travou há mais de 5 minutos volta para a fila (até 3 tentativas)
  update public.ai_jobs set status = case when attempts >= 3 then 'failed' else 'queued' end,
    result = 'Tempo esgotado.', updated_at = now()
   where status = 'running' and updated_at < now() - interval '5 minutes'
     and not exists (select 1 from public.ai_jobs q where q.conversation_id = ai_jobs.conversation_id and q.status = 'queued');
  with due as (
    select id from public.ai_jobs j where status = 'queued' and run_after <= now()
      and not exists (select 1 from public.ai_jobs r where r.conversation_id = j.conversation_id and r.status = 'running')
    order by run_after limit greatest(1, least(p_limit, 20)) for update skip locked
  ), upd as (
    update public.ai_jobs j set status = 'running', attempts = attempts + 1, updated_at = now() from due where j.id = due.id
    returning j.id, j.run_after
  )
  select coalesce(jsonb_agg(id order by run_after), '[]'::jsonb) into v from upd;
  return v;
end $$;

-- próxima mensagem na fila (para o worker esperar o tempo de juntar mensagens)
create or replace function public.ai_jobs_next_due()
returns timestamptz language sql stable security definer set search_path = '' as $$
  select min(run_after) from public.ai_jobs where status = 'queued' and run_after < now() + interval '30 seconds';
$$;

-- tudo que a IA precisa para responder; null quando não deve responder (e o motivo fica no job)
create or replace function public.ai_job_context(p_job_id bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare j public.ai_jobs; c public.wa_conversations; a public.ai_attendants; v_src text; v_key text; v_limit int; v_used int; v_reason text;
  v_last public.wa_messages; v_store jsonb;
begin
  perform private.assert_service_role();
  select * into j from public.ai_jobs where id = p_job_id and status = 'running';
  if not found then return null; end if;
  select * into c from public.wa_conversations where id = j.conversation_id;
  select * into a from public.ai_attendants where tenant_id = j.tenant_id;
  select * into v_last from public.wa_messages where conversation_id = c.id order by id desc limit 1;
  v_src := private.ai_key_source(j.tenant_id);
  v_limit := private.ai_limit(j.tenant_id);
  v_used := private.ai_used(j.tenant_id, coalesce(v_src, 'platform'));
  v_reason := case
    when not coalesce(a.enabled, false) then 'Atendente desligado.'
    when not exists (select 1 from public.marketing_settings m where m.tenant_id = j.tenant_id and m.wa_enabled and m.wa_phone_number_id is not null) then 'WhatsApp oficial desligado.'
    when c.needs_human then 'Conversa com a equipe.'
    when c.ai_paused_until is not null and c.ai_paused_until > now() then 'IA pausada na conversa.'
    when c.last_inbound_at is null or c.last_inbound_at < now() - interval '24 hours' then 'Janela de 24 h fechada.'
    when v_last.direction is distinct from 'in' then 'A última mensagem já foi respondida.'
    when v_src is null then 'Sem chave da IA disponível.'
    when v_limit is not null and v_used >= v_limit then 'Limite de respostas do mês atingido.'
  end;
  if v_reason is not null then
    update public.ai_jobs set status = 'skipped', result = v_reason, updated_at = now() where id = j.id;
    if v_reason = 'Limite de respostas do mês atingido.' then
      update public.wa_conversations set needs_human = true, ai_handoff_reason = 'Limite mensal do atendente IA atingido.' where id = c.id;
    end if;
    return null;
  end if;
  v_store := private.ai_store_context(j.tenant_id);
  if v_store is null then
    update public.ai_jobs set status = 'skipped', result = 'Nenhuma loja ativa.', updated_at = now() where id = j.id;
    return null;
  end if;
  v_key := (select decrypted_secret from vault.decrypted_secrets where id =
            case v_src when 'own' then a.own_key_secret_id else (select api_key_secret_id from public.ai_platform_settings) end);
  return jsonb_build_object('job_id', j.id, 'tenant_id', j.tenant_id, 'conversation_id', c.id, 'source', v_src, 'api_key', v_key,
    'now', now(), 'store', v_store,
    'customer', jsonb_build_object('name', coalesce(c.name, (select name from public.customers where id = c.customer_id)),
      'orders', coalesce((select jsonb_agg(jsonb_build_object('number', o.number, 'status', o.status, 'type', o.type, 'total_cents', o.total_cents,
          'created_at', o.created_at, 'scheduled_for', o.scheduled_for, 'tracking_url',
          regexp_replace(v_store->>'menu_url', '/loja/[^/]+$', '') || '/pedido/' || o.public_token) order by o.created_at desc)
        from (select * from public.orders where tenant_id = j.tenant_id and created_at > now() - interval '30 days'
                and (customer_id = c.customer_id or customer_phone = c.wa_id or '55' || customer_phone = c.wa_id)
              order by created_at desc limit 3) o), '[]'::jsonb)),
    'messages', coalesce((select jsonb_agg(jsonb_build_object('direction', m.direction, 'kind', m.kind, 'body', m.body, 'by_ai', m.by_ai,
        'created_at', m.created_at) order by m.id)
      from (select * from public.wa_messages where conversation_id = c.id order by id desc limit 24) m), '[]'::jsonb));
end $$;

-- grava a resposta (ou a falha) e devolve a mensagem para enviar
create or replace function public.ai_job_finish(p_job_id bigint, p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare j public.ai_jobs; c public.wa_conversations; v_reply text := left(nullif(trim(coalesce(p->>'reply', '')), ''), 4096);
  v_handoff boolean := coalesce((p->>'handoff')::boolean, false); v_msg bigint; v_src text := coalesce(p->>'source', 'platform');
begin
  perform private.assert_service_role();
  select * into j from public.ai_jobs where id = p_job_id and status = 'running' for update;
  if not found then return null; end if;
  if p ? 'error' then
    update public.ai_jobs set status = case when attempts >= 3 or coalesce((p->>'final')::boolean, false) then 'failed' else 'queued' end,
      run_after = now() + interval '30 seconds', result = left(p->>'error', 500), updated_at = now() where id = j.id;
    if j.attempts >= 3 or coalesce((p->>'final')::boolean, false) then
      update public.wa_conversations set needs_human = true, ai_handoff_reason = 'O atendente IA não conseguiu responder.' where id = j.conversation_id;
    end if;
    return null;
  end if;
  if v_src in ('platform','own') and (p ? 'usage') then
    insert into public.ai_usage (tenant_id, month, source, replies, input_tokens, output_tokens, cache_read_tokens)
    values (j.tenant_id, date_trunc('month', now())::date, v_src, case when v_reply is null then 0 else 1 end,
            coalesce((p->'usage'->>'input_tokens')::bigint, 0), coalesce((p->'usage'->>'output_tokens')::bigint, 0),
            coalesce((p->'usage'->>'cache_read_tokens')::bigint, 0))
    on conflict (tenant_id, month, source) do update set replies = public.ai_usage.replies + excluded.replies,
      input_tokens = public.ai_usage.input_tokens + excluded.input_tokens, output_tokens = public.ai_usage.output_tokens + excluded.output_tokens,
      cache_read_tokens = public.ai_usage.cache_read_tokens + excluded.cache_read_tokens;
  end if;
  select * into c from public.wa_conversations where id = j.conversation_id for update;
  -- a equipe assumiu enquanto a IA pensava: não envia
  if c.needs_human or (c.ai_paused_until is not null and c.ai_paused_until > now()) then
    update public.ai_jobs set status = 'skipped', result = 'A equipe assumiu antes da resposta.', updated_at = now() where id = j.id;
    return null;
  end if;
  if v_reply is not null then
    insert into public.wa_messages (tenant_id, conversation_id, direction, kind, body, status, by_ai)
    values (j.tenant_id, c.id, 'out', 'text', v_reply, 'queued', true) returning id into v_msg;
    update public.wa_conversations set last_message_at = now(), last_preview = left('IA: ' || v_reply, 140) where id = c.id;
  end if;
  if v_handoff then
    update public.wa_conversations set needs_human = true, unread = unread + 1, status = 'open',
      ai_handoff_reason = left(coalesce(nullif(trim(p->>'reason'), ''), 'O cliente precisa falar com a equipe.'), 300) where id = c.id;
  end if;
  update public.ai_jobs set status = 'done', reply_message_id = v_msg, updated_at = now(),
    result = case when v_handoff then left('Passou para a equipe: ' || coalesce(p->>'reason', ''), 500) end where id = j.id;
  return jsonb_build_object('message_id', v_msg);
end $$;

-- ---------- Teste no painel (sem WhatsApp) ----------
create or replace function public.ai_can_preview(p_tenant_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.can_manage(p_tenant_id);
$$;
create or replace function public.ai_preview_context(p_tenant_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare a public.ai_attendants; v_src text; v_limit int; v_store jsonb;
begin
  perform private.assert_service_role();
  select * into a from public.ai_attendants where tenant_id = p_tenant_id;
  if not found then raise exception 'Salve a configuração do atendente antes de testar.'; end if;
  v_src := private.ai_key_source(p_tenant_id);
  if v_src is null then raise exception 'Sem chave da IA: use a da plataforma ou salve e teste a sua.'; end if;
  v_limit := private.ai_limit(p_tenant_id);
  if v_limit is not null and private.ai_used(p_tenant_id, v_src) >= v_limit then raise exception 'Limite de respostas do mês atingido.'; end if;
  v_store := private.ai_store_context(p_tenant_id);
  if v_store is null then raise exception 'Nenhuma loja ativa.'; end if;
  return jsonb_build_object('source', v_src, 'now', now(), 'store', v_store,
    'api_key', (select decrypted_secret from vault.decrypted_secrets where id =
      case v_src when 'own' then a.own_key_secret_id else (select api_key_secret_id from public.ai_platform_settings) end));
end $$;
-- o teste também conta no limite do mês
create or replace function public.ai_preview_usage(p_tenant_id uuid, p_source text, p_usage jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.assert_service_role();
  if p_source not in ('platform','own') then return; end if;
  insert into public.ai_usage (tenant_id, month, source, replies, input_tokens, output_tokens, cache_read_tokens)
  values (p_tenant_id, date_trunc('month', now())::date, p_source, 1, coalesce((p_usage->>'input_tokens')::bigint, 0),
          coalesce((p_usage->>'output_tokens')::bigint, 0), coalesce((p_usage->>'cache_read_tokens')::bigint, 0))
  on conflict (tenant_id, month, source) do update set replies = public.ai_usage.replies + 1,
    input_tokens = public.ai_usage.input_tokens + excluded.input_tokens, output_tokens = public.ai_usage.output_tokens + excluded.output_tokens,
    cache_read_tokens = public.ai_usage.cache_read_tokens + excluded.cache_read_tokens;
end $$;

-- fila parada (worker não acordou): o cron acorda a cada minuto
create or replace function public.ai_cron_tick()
returns void language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.ai_jobs where status = 'queued' and run_after <= now())
     or exists (select 1 from public.ai_jobs where status = 'running' and updated_at < now() - interval '5 minutes') then
    perform private.kick_ai_worker();
  end if;
end $$;
select cron.schedule('domma-atendente', '* * * * *', 'select public.ai_cron_tick()');

-- ---------- Permissões ----------
revoke execute on function private.kick_ai_worker(), private.ai_limit(uuid), private.ai_used(uuid, text), private.ai_key_source(uuid),
  private.ai_on_message(), private.ai_store_context(uuid) from public, anon, authenticated;
revoke execute on function public.ai_worker_secret(), public.ai_key_for_test(text, uuid), public.ai_key_test_result(text, uuid, boolean, text),
  public.ai_jobs_claim(integer), public.ai_jobs_next_due(), public.ai_job_context(bigint), public.ai_job_finish(bigint, jsonb),
  public.ai_preview_context(uuid), public.ai_preview_usage(uuid, text, jsonb), public.ai_cron_tick() from public, anon, authenticated;
grant execute on function public.ai_worker_secret(), public.ai_key_for_test(text, uuid), public.ai_key_test_result(text, uuid, boolean, text),
  public.ai_jobs_claim(integer), public.ai_jobs_next_due(), public.ai_job_context(bigint), public.ai_job_finish(bigint, jsonb),
  public.ai_preview_context(uuid), public.ai_preview_usage(uuid, text, jsonb) to service_role;
revoke execute on function public.ai_conversation_set(uuid, text), public.ai_settings_get(uuid), public.ai_settings_save(uuid, jsonb, text),
  public.admin_ai_settings(), public.admin_ai_save(jsonb, text), public.admin_ai_tenant_limit(uuid, integer),
  public.ai_can_test(text, uuid), public.ai_can_preview(uuid) from public, anon;
grant execute on function public.ai_conversation_set(uuid, text), public.ai_settings_get(uuid), public.ai_settings_save(uuid, jsonb, text),
  public.admin_ai_settings(), public.admin_ai_save(jsonb, text), public.admin_ai_tenant_limit(uuid, integer),
  public.ai_can_test(text, uuid), public.ai_can_preview(uuid) to authenticated;
