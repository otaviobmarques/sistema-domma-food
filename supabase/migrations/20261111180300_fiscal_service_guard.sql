-- =====================================================================
-- Domma Food · 024 · Funções do worker fiscal só para o sistema (service_role).
-- Neste projeto as funções novas ficam executáveis por anon/authenticated por
-- padrão; a trava dentro da função garante o bloqueio independente de GRANT.
-- =====================================================================
create or replace function private.assert_service_role()
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Sem permissão.' using errcode = '42501';
  end if;
end $$;

create or replace function public.fiscal_test_token(p_unit_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.assert_service_role();
  return (select jsonb_build_object('environment', s.environment, 'token', ds.decrypted_secret, 'cnpj', s.cnpj)
          from public.fiscal_settings s left join vault.decrypted_secrets ds on ds.id = s.token_secret_id where s.unit_id = p_unit_id);
end $$;

create or replace function public.fiscal_worker_secret()
returns text language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.assert_service_role();
  return (select decrypted_secret from vault.decrypted_secrets where name = 'fiscal_worker_secret');
end $$;

create or replace function public.fiscal_test_result(p_unit_id uuid, p_ok boolean, p_message text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.assert_service_role();
  update public.fiscal_settings set last_test_at = now(), last_test_ok = p_ok, last_test_message = left(p_message, 300) where unit_id = p_unit_id;
end $$;

create or replace function public.fiscal_jobs(p_limit integer default 10)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r record; v jsonb := '[]'::jsonb; v_payload jsonb; v_token text;
begin
  perform private.assert_service_role();
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

create or replace function public.fiscal_job_result(p_id uuid, p_http integer, p_body jsonb)
returns text language plpgsql security definer set search_path = '' as $$
declare d public.fiscal_documents; st text := p_body->>'status'; v_msg text;
begin
  perform private.assert_service_role();
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
