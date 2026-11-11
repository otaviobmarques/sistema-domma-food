-- =====================================================================
-- Domma Food · 036 · Avisos de status: painel, teste, fila do worker
-- =====================================================================

-- ---------- Painel ----------
create or replace function public.status_save_settings(p_tenant_id uuid, p_enabled boolean, p_templates jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare s public.marketing_settings; e jsonb; v_params text[];
begin
  if not private.can_manage(p_tenant_id) then raise exception 'Sem permissão.' using errcode = '42501'; end if;
  if jsonb_typeof(coalesce(p_templates, '[]'::jsonb)) <> 'array' then raise exception 'Modelos inválidos.'; end if;
  for e in select * from jsonb_array_elements(coalesce(p_templates, '[]'::jsonb)) loop
    select coalesce(array_agg(x), '{}') into v_params from jsonb_array_elements_text(coalesce(e->'params', '[]'::jsonb)) x;
    if coalesce((e->>'enabled')::boolean, false) and nullif(trim(e->>'template_name'), '') is null then
      raise exception 'Informe o nome do modelo aprovado para cada aviso ativo.'; end if;
    insert into public.status_templates (tenant_id, event, enabled, template_name, template_lang, template_params, updated_at)
    values (p_tenant_id, e->>'event', coalesce((e->>'enabled')::boolean, false), nullif(lower(trim(e->>'template_name')), ''),
            coalesce(nullif(trim(e->>'template_lang'), ''), 'pt_BR'), v_params, now())
    on conflict (tenant_id, event) do update set enabled = excluded.enabled, template_name = excluded.template_name,
      template_lang = excluded.template_lang, template_params = excluded.template_params, updated_at = now();
  end loop;
  insert into public.marketing_settings (tenant_id) values (p_tenant_id) on conflict (tenant_id) do nothing;
  select * into s from public.marketing_settings where tenant_id = p_tenant_id;
  if coalesce(p_enabled, false) and not s.wa_enabled then
    raise exception 'Conecte e ative a API oficial do WhatsApp (Marketing › Configurações) antes de ligar os avisos.'; end if;
  update public.marketing_settings set status_enabled = coalesce(p_enabled, false), updated_at = now() where tenant_id = p_tenant_id;
end $$;

create or replace function public.status_overview(p_tenant_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.can_manage(p_tenant_id) then raise exception 'Sem permissão.' using errcode = '42501'; end if;
  return jsonb_build_object(
    'wa_enabled', coalesce((select wa_enabled from public.marketing_settings where tenant_id = p_tenant_id), false),
    'status_enabled', coalesce((select status_enabled from public.marketing_settings where tenant_id = p_tenant_id), false),
    'templates', coalesce((select jsonb_agg(jsonb_build_object('event', event, 'enabled', enabled, 'template_name', template_name,
        'template_lang', template_lang, 'params', to_jsonb(template_params))) from public.status_templates where tenant_id = p_tenant_id), '[]'::jsonb),
    'stats', (select jsonb_build_object(
        'sent', count(*) filter (where status in ('sent','delivered','read')),
        'read', count(*) filter (where status = 'read'),
        'failed', count(*) filter (where status = 'failed'),
        'queued', count(*) filter (where status in ('queued','sending')))
      from public.order_notifications where tenant_id = p_tenant_id and created_at > now() - interval '30 days' and order_id is not null),
    'log', coalesce((select jsonb_agg(x order by x->>'created_at' desc) from (
        select jsonb_build_object('id', n.id, 'event', n.event, 'status', n.status, 'error', n.error, 'phone', n.phone,
          'created_at', n.created_at, 'sent_at', n.sent_at, 'order_number', o.number, 'customer', o.customer_name) x
        from public.order_notifications n left join public.orders o on o.id = n.order_id
        where n.tenant_id = p_tenant_id order by n.id desc limit 40) q), '[]'::jsonb));
end $$;

-- envio de teste para um número (com valores de exemplo)
create or replace function public.status_test(p_tenant_id uuid, p_event text, p_phone text)
returns bigint language plpgsql security definer set search_path = '' as $$
declare t public.status_templates; s public.marketing_settings; u public.units; v_phone text := private.only_digits(p_phone);
  v_params jsonb := '[]'::jsonb; k text; v bigint;
begin
  if not private.can_manage(p_tenant_id) then raise exception 'Sem permissão.' using errcode = '42501'; end if;
  select * into s from public.marketing_settings where tenant_id = p_tenant_id;
  if not found or not s.wa_enabled then raise exception 'Conecte e ative a API oficial do WhatsApp primeiro.'; end if;
  select * into t from public.status_templates where tenant_id = p_tenant_id and event = p_event;
  if not found or t.template_name is null then raise exception 'Salve o nome do modelo deste aviso antes de testar.'; end if;
  if v_phone !~ '^[0-9]{10,13}$' then raise exception 'Telefone inválido.'; end if;
  if length(v_phone) <= 11 then v_phone := '55' || v_phone; end if;
  if (select count(*) from public.order_notifications where tenant_id = p_tenant_id and order_id is null and created_at > now() - interval '1 hour') >= 10 then
    raise exception 'Limite de testes atingido. Tente de novo em uma hora.'; end if;
  select * into u from public.units where tenant_id = p_tenant_id order by id limit 1;
  foreach k in array t.template_params loop
    v_params := v_params || to_jsonb(case k when 'nome' then 'Maria' when 'numero' then '123' when 'loja' then coalesce(u.name, 'Loja')
      when 'link' then 'https://domma-food.vercel.app/loja/' || coalesce(u.slug, '') when 'previsao' then '19:30'
      when 'entregador' then 'Carlos' when 'total' then 'R$ 59,90' when 'motivo' then 'teste de envio' else '' end);
  end loop;
  insert into public.order_notifications (tenant_id, order_id, event, phone, template_name, template_lang, params)
  values (p_tenant_id, null, p_event, v_phone, t.template_name, t.template_lang, v_params) returning id into v;
  perform private.kick_marketing_worker();
  return v;
end $$;

-- ---------- Worker (somente service_role) ----------
create or replace function public.status_jobs(p_limit integer default 50)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v jsonb; v_ids bigint[];
begin
  perform private.assert_service_role();
  -- aviso atrasado perde o sentido ("saiu para entrega" horas depois): descarta
  update public.order_notifications set status = 'skipped', error = 'Não enviado a tempo (mais de 30 minutos na fila).'
   where status = 'queued' and created_at < now() - interval '30 minutes';
  update public.order_notifications set status = 'queued' where status = 'sending' and sent_at is null
   and created_at > now() - interval '30 minutes' and created_at < now() - interval '2 minutes' and attempts < 3;
  with picked as (
    select n.id from public.order_notifications n join public.marketing_settings s on s.tenant_id = n.tenant_id
    where n.status = 'queued' and s.wa_enabled and (s.status_enabled or n.order_id is null)
    order by n.id limit least(greatest(p_limit, 1), 100) for update of n skip locked)
  , upd as (update public.order_notifications n set status = 'sending', attempts = attempts + 1 from picked where n.id = picked.id returning n.id)
  select array_agg(id) into v_ids from upd;
  select coalesce(jsonb_agg(jsonb_build_object('id', n.id, 'to', n.phone, 'params', n.params, 'template', n.template_name, 'lang', n.template_lang,
      'phone_number_id', s.wa_phone_number_id, 'version', s.graph_version,
      'token', (select decrypted_secret from vault.decrypted_secrets where id = s.wa_token_secret_id))), '[]'::jsonb) into v
  from public.order_notifications n join public.marketing_settings s on s.tenant_id = n.tenant_id
  where n.id = any (coalesce(v_ids, '{}'));
  return v;
end $$;
create or replace function public.status_job_result(p_id bigint, p_ok boolean, p_wa_id text, p_error text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.assert_service_role();
  update public.order_notifications set status = case when p_ok then 'sent' else 'failed' end, wa_message_id = p_wa_id,
    sent_at = case when p_ok then now() end, error = left(p_error, 300) where id = p_id;
end $$;

-- webhook: status de entrega/leitura vale para campanhas e avisos
create or replace function public.marketing_status_update(p_tenant_id uuid, p_wa_id text, p_status text, p_error text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.assert_service_role();
  update public.campaign_messages set
    status = case when p_status = 'read' then 'read' when p_status = 'delivered' and status <> 'read' then 'delivered'
                  when p_status = 'failed' then 'failed' else status end,
    delivered_at = case when p_status in ('delivered','read') then coalesce(delivered_at, now()) else delivered_at end,
    read_at = case when p_status = 'read' then now() else read_at end,
    error = case when p_status = 'failed' then left(p_error, 300) else error end
  where tenant_id = p_tenant_id and wa_message_id = p_wa_id;
  update public.order_notifications set
    status = case when p_status = 'read' then 'read' when p_status = 'delivered' and status <> 'read' then 'delivered'
                  when p_status = 'failed' then 'failed' else status end,
    delivered_at = case when p_status in ('delivered','read') then coalesce(delivered_at, now()) else delivered_at end,
    read_at = case when p_status = 'read' then now() else read_at end,
    error = case when p_status = 'failed' then left(p_error, 300) else error end
  where tenant_id = p_tenant_id and wa_message_id = p_wa_id;
end $$;

create or replace function private.marketing_cron_tick()
returns void language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.campaign_messages where status = 'queued')
     or exists (select 1 from public.order_notifications where status = 'queued') then perform private.kick_marketing_worker(); end if;
end $$;

grant execute on function public.status_jobs(integer), public.status_job_result(bigint, boolean, text, text) to service_role;
grant execute on function public.status_save_settings(uuid, boolean, jsonb), public.status_overview(uuid), public.status_test(uuid, text, text) to authenticated;
revoke execute on function public.status_jobs(integer), public.status_job_result(bigint, boolean, text, text) from public, anon, authenticated;
revoke execute on function public.status_save_settings(uuid, boolean, jsonb), public.status_overview(uuid), public.status_test(uuid, text, text) from public, anon;
revoke execute on function private.status_enqueue(uuid, text), private.status_store_flag(uuid) from public, anon, authenticated;
revoke all on public.status_templates, public.order_notifications from anon;
revoke insert, update, delete on public.status_templates, public.order_notifications from authenticated;
