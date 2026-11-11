-- =====================================================================
-- Domma Food · 023 · NFC-e: pedido de emissão/cancelamento, fila do worker,
-- emissão automática e agendamento
-- =====================================================================
do $$ begin
  if not exists (select 1 from vault.secrets where name = 'fiscal_worker_secret') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'fiscal_worker_secret', 'Domma Food: worker fiscal');
  end if;
  if not exists (select 1 from vault.secrets where name = 'fiscal_worker_url') then
    perform vault.create_secret('https://kcwidutqdqbyphrjnlef.supabase.co/functions/v1/fiscal/worker', 'fiscal_worker_url', 'Domma Food: URL do worker fiscal');
  end if;
end $$;

create or replace function private.kick_fiscal_worker()
returns void language plpgsql security definer set search_path = '' as $$
declare v_url text; v_secret text;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'fiscal_worker_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'fiscal_worker_secret';
  if v_url is null or v_secret is null then return; end if;
  perform net.http_post(url := v_url, body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type','application/json','x-worker-secret', v_secret), timeout_milliseconds := 25000);
exception when others then null; -- nunca travar a venda por causa da nota
end $$;

-- cria o documento (uso interno: botão e emissão automática)
create or replace function private.fiscal_enqueue(p_unit uuid, p_order uuid, p_tab uuid, p_doc text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare s public.fiscal_settings; v uuid;
begin
  select * into s from public.fiscal_settings where unit_id = p_unit;
  if not found or not s.enabled then raise exception 'A NFC-e não está ativada nesta loja. Configure em Configurações › Fiscal.'; end if;
  if s.token_secret_id is null or s.cnpj is null then raise exception 'Configuração fiscal incompleta.'; end if;
  insert into public.fiscal_documents (tenant_id, unit_id, order_id, tab_id, environment, consumer_doc)
  values (s.tenant_id, p_unit, p_order, p_tab, s.environment, nullif(private.only_digits(p_doc), ''))
  returning id into v;
  perform private.kick_fiscal_worker();
  return v;
end $$;

create or replace function public.fiscal_request(p_order_id uuid default null, p_tab_id uuid default null, p_consumer_doc text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_unit uuid; v_tenant uuid; v_ok boolean; v_doc text := nullif(private.only_digits(p_consumer_doc), '');
begin
  if (p_order_id is null) = (p_tab_id is null) then raise exception 'Informe o pedido ou a conta da mesa.'; end if;
  if v_doc is not null and length(v_doc) not in (11, 14) then raise exception 'CPF ou CNPJ inválido.'; end if;
  if p_order_id is not null then
    select unit_id, tenant_id, status <> 'cancelled' and tab_id is null and payment_status = 'paid' into v_unit, v_tenant, v_ok
      from public.orders where id = p_order_id;
    if v_unit is not null and not v_ok then raise exception 'Só é possível emitir para pedido pago e não cancelado (pedidos de mesa: emita pela conta da mesa).'; end if;
  else
    select unit_id, tenant_id, status = 'closed' into v_unit, v_tenant, v_ok from public.tabs where id = p_tab_id;
    if v_unit is not null and not v_ok then raise exception 'Feche a conta da mesa antes de emitir a nota.'; end if;
  end if;
  if v_unit is null or not private.can_access_unit(v_unit) or not private.has_role(v_tenant, array['owner','manager','cashier']::public.member_role[]) then
    raise exception 'Sem permissão.' using errcode = '42501'; end if;
  if exists (select 1 from public.fiscal_documents where (order_id = p_order_id or tab_id = p_tab_id) and status not in ('rejected','error','cancelled')) then
    raise exception 'Já existe NFC-e para esta venda.'; end if;
  return private.fiscal_enqueue(v_unit, p_order_id, p_tab_id, v_doc);
end $$;

-- reenvia uma nota rejeitada (depois de corrigir o cadastro)
create or replace function public.fiscal_retry(p_doc_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare d public.fiscal_documents;
begin
  select * into d from public.fiscal_documents where id = p_doc_id;
  if not found or not private.can_access_unit(d.unit_id) or not private.has_role(d.tenant_id, array['owner','manager','cashier']::public.member_role[]) then
    raise exception 'Sem permissão.' using errcode = '42501'; end if;
  if d.status not in ('rejected','error') then raise exception 'Só notas rejeitadas ou com erro podem ser reenviadas.'; end if;
  return private.fiscal_enqueue(d.unit_id, d.order_id, d.tab_id, d.consumer_doc);
end $$;

create or replace function public.fiscal_cancel(p_doc_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare d public.fiscal_documents;
begin
  select * into d from public.fiscal_documents where id = p_doc_id for update;
  if not found or not private.can_access_unit(d.unit_id) or not private.can_manage(d.tenant_id) then
    raise exception 'Só a gerência cancela nota fiscal.' using errcode = '42501'; end if;
  if d.status <> 'authorized' then raise exception 'Só notas autorizadas podem ser canceladas.'; end if;
  if char_length(trim(coalesce(p_reason, ''))) not between 15 and 255 then raise exception 'A justificativa precisa ter de 15 a 255 caracteres.'; end if;
  if d.authorized_at < now() - interval '30 minutes' then
    raise exception 'O prazo de cancelamento da NFC-e (30 minutos) acabou. Procure seu contador.'; end if;
  update public.fiscal_documents set status = 'cancel_requested', cancel_reason = trim(p_reason), next_attempt_at = now() where id = d.id;
  insert into public.audit_logs (tenant_id, actor_id, action, entity, entity_id, after, ip)
  values (d.tenant_id, auth.uid(), 'fiscal_cancel', 'fiscal_documents', d.id::text, jsonb_build_object('reason', trim(p_reason)), private.request_ip());
  perform private.kick_fiscal_worker();
end $$;

-- ---------- Worker (somente service_role) ----------
create or replace function public.fiscal_jobs(p_limit integer default 10)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r record; v jsonb := '[]'::jsonb; v_payload jsonb; v_token text;
begin
  -- itens presos em processamento (queda do worker) voltam para a fila
  update public.fiscal_documents set status = case status when 'processing' then 'pending' else 'cancel_requested' end
   where status in ('processing','cancelling') and next_attempt_at < now() - interval '3 minutes';
  for r in select d.*, s.token_secret_id from public.fiscal_documents d join public.fiscal_settings s on s.unit_id = d.unit_id
           where d.status in ('pending','cancel_requested') and d.next_attempt_at <= now()
           order by d.next_attempt_at limit least(greatest(p_limit, 1), 25) for update of d skip locked loop
    select decrypted_secret into v_token from vault.decrypted_secrets where id = r.token_secret_id;
    if r.status = 'pending' then
      begin
        v_payload := private.fiscal_payload(r.id);
      exception when others then
        update public.fiscal_documents set status = 'rejected', message = sqlerrm where id = r.id;
        continue;
      end;
      update public.fiscal_documents set status = 'processing', attempts = attempts + 1, next_attempt_at = now(),
             payload = v_payload - '_total_cents', total_cents = (v_payload->>'_total_cents')::int where id = r.id;
      v := v || jsonb_build_object('id', r.id, 'action', case when r.attempts > 0 then 'emit_or_consult' else 'emit' end,
        'environment', r.environment, 'ref', r.ref, 'token', v_token, 'payload', v_payload - '_total_cents');
    else
      update public.fiscal_documents set status = 'cancelling', attempts = attempts + 1, next_attempt_at = now() where id = r.id;
      v := v || jsonb_build_object('id', r.id, 'action', 'cancel', 'environment', r.environment, 'ref', r.ref, 'token', v_token,
        'reason', r.cancel_reason);
    end if;
  end loop;
  return v;
end $$;

-- resultado devolvido pelo worker
create or replace function public.fiscal_job_result(p_id uuid, p_http integer, p_body jsonb)
returns text language plpgsql security definer set search_path = '' as $$
declare d public.fiscal_documents; st text := p_body->>'status'; v_msg text;
begin
  select * into d from public.fiscal_documents where id = p_id for update;
  if not found then return 'missing'; end if;
  v_msg := left(coalesce(p_body->>'mensagem_sefaz', p_body->>'mensagem', p_body->>'erro', 'HTTP ' || p_http), 500);
  if d.status = 'processing' then
    if st = 'autorizado' then
      update public.fiscal_documents set status = 'authorized', authorized_at = now(), message = v_msg, response = p_body,
        number = p_body->>'numero', series = p_body->>'serie', access_key = p_body->>'chave_nfe', protocol = p_body->>'protocolo',
        xml_url = p_body->>'caminho_xml_nota_fiscal', danfe_url = p_body->>'caminho_danfe',
        qrcode_url = p_body->>'qrcode_url', consult_url = p_body->>'url_consulta_nf' where id = d.id;
    elsif st in ('erro_autorizacao','denegado') or (p_http between 400 and 499 and p_http not in (408, 429)) then
      update public.fiscal_documents set status = 'rejected', message = v_msg, response = p_body where id = d.id;
    elsif d.attempts >= 6 then
      update public.fiscal_documents set status = 'error', message = 'Provedor indisponível: ' || v_msg, response = p_body where id = d.id;
    else  -- processando no provedor, falha de rede ou 5xx: tenta de novo com espera crescente
      update public.fiscal_documents set status = 'pending', message = v_msg, response = p_body,
        next_attempt_at = now() + make_interval(secs => least(30 * power(2, d.attempts), 1800)::int) where id = d.id;
    end if;
  elsif d.status = 'cancelling' then
    if st = 'cancelado' then
      update public.fiscal_documents set status = 'cancelled', cancelled_at = now(), message = v_msg,
        cancel_xml_url = p_body->>'caminho_xml_cancelamento' where id = d.id;
    elsif p_http between 500 and 599 or p_http = 0 then
      update public.fiscal_documents set status = 'cancel_requested', message = v_msg,
        next_attempt_at = now() + interval '1 minute' where id = d.id;
    else
      update public.fiscal_documents set status = 'authorized', message = 'Cancelamento recusado: ' || v_msg where id = d.id;
    end if;
  end if;
  return (select status from public.fiscal_documents where id = d.id);
end $$;

create or replace function public.fiscal_test_result(p_unit_id uuid, p_ok boolean, p_message text)
returns void language sql security definer set search_path = '' as $$
  update public.fiscal_settings set last_test_at = now(), last_test_ok = p_ok, last_test_message = left(p_message, 300) where unit_id = p_unit_id;
$$;
create or replace function public.fiscal_test_token(p_unit_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('environment', s.environment, 'token', ds.decrypted_secret, 'cnpj', s.cnpj)
  from public.fiscal_settings s left join vault.decrypted_secrets ds on ds.id = s.token_secret_id where s.unit_id = p_unit_id;
$$;
create or replace function public.fiscal_worker_secret()
returns text language sql stable security definer set search_path = '' as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'fiscal_worker_secret';
$$;
-- confere se o usuário pode testar a conexão (chamado pela Edge Function com o JWT do usuário)
create or replace function public.fiscal_can_test(p_unit_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.can_access_unit(p_unit_id) and private.has_role((select tenant_id from public.units where id = p_unit_id), array['owner']::public.member_role[]);
$$;

-- ---------- Emissão automática ----------
create or replace function private.fiscal_auto()
returns trigger language plpgsql security definer set search_path = '' as $$
declare s public.fiscal_settings;
begin
  select * into s from public.fiscal_settings where unit_id = new.unit_id;
  if not found or not s.enabled or not s.auto_emit or s.token_secret_id is null then return null; end if;
  if tg_table_name = 'orders' then
    if new.tab_id is not null or new.status = 'cancelled' or new.payment_status <> 'paid' then return null; end if;
    if not s.include_marketplace and new.channel::text in ('ifood','keeta','99food','aiqfome','marketplace') then return null; end if;
    -- PDV: na venda; demais canais: quando concluído
    if not ((new.channel = 'counter') or new.status = 'completed') then return null; end if;
    if exists (select 1 from public.fiscal_documents where order_id = new.id) then return null; end if;
    perform private.fiscal_enqueue(new.unit_id, new.id, null, null);
  else
    if new.status <> 'closed' or exists (select 1 from public.fiscal_documents where tab_id = new.id) then return null; end if;
    perform private.fiscal_enqueue(new.unit_id, null, new.id, null);
  end if;
  return null;
exception when others then return null; -- a venda nunca falha por causa da nota
end $$;
create trigger orders_fiscal_auto after insert or update of status, payment_status on public.orders
  for each row execute function private.fiscal_auto();
create trigger tabs_fiscal_auto after update of status on public.tabs
  for each row when (new.status = 'closed' and old.status <> 'closed') execute function private.fiscal_auto();

-- rede de segurança: a cada minuto, se houver fila
create or replace function private.fiscal_cron_tick()
returns void language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.fiscal_documents where status in ('pending','cancel_requested') and next_attempt_at <= now()) then
    perform private.kick_fiscal_worker();
  end if;
end $$;
select cron.schedule('domma-fiscal', '* * * * *', $$select private.fiscal_cron_tick()$$);

revoke execute on function public.fiscal_jobs(integer), public.fiscal_job_result(uuid, integer, jsonb), public.fiscal_test_result(uuid, boolean, text),
  public.fiscal_test_token(uuid), public.fiscal_worker_secret() from public, anon, authenticated;
grant execute on function public.fiscal_jobs(integer), public.fiscal_job_result(uuid, integer, jsonb), public.fiscal_test_result(uuid, boolean, text),
  public.fiscal_test_token(uuid), public.fiscal_worker_secret() to service_role;
grant execute on function public.fiscal_save_settings(uuid, jsonb, text), public.fiscal_request(uuid, uuid, text),
  public.fiscal_retry(uuid), public.fiscal_cancel(uuid, text), public.fiscal_can_test(uuid) to authenticated;
