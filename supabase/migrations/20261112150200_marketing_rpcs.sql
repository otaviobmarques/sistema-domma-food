-- =====================================================================
-- Domma Food · 032 · Marketing: painel, automações diárias, fila de envio
-- do WhatsApp (somente service_role), webhook e conversões
-- =====================================================================
do $$ begin
  if not exists (select 1 from vault.secrets where name = 'marketing_worker_secret') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'marketing_worker_secret', 'Domma Food: worker de marketing');
  end if;
  if not exists (select 1 from vault.secrets where name = 'marketing_worker_url') then
    perform vault.create_secret('https://kcwidutqdqbyphrjnlef.supabase.co/functions/v1/marketing/worker', 'marketing_worker_url', 'Domma Food: URL do worker de marketing');
  end if;
end $$;
create or replace function private.kick_marketing_worker()
returns void language plpgsql security definer set search_path = '' as $$
declare v_url text; v_secret text;
begin
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'marketing_worker_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'marketing_worker_secret';
  if v_url is null or v_secret is null then return; end if;
  perform net.http_post(url := v_url, body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type','application/json','x-worker-secret', v_secret), timeout_milliseconds := 25000);
exception when others then null;
end $$;

-- ---------- Configuração ----------
create or replace function public.marketing_save_settings(p_tenant_id uuid, p jsonb, p_token text default null, p_app_secret text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare s public.marketing_settings; v uuid;
begin
  if not private.has_role(p_tenant_id, array['owner']::public.member_role[]) then raise exception 'Só o dono da conta altera o WhatsApp.' using errcode = '42501'; end if;
  insert into public.marketing_settings (tenant_id) values (p_tenant_id) on conflict (tenant_id) do nothing;
  select * into s from public.marketing_settings where tenant_id = p_tenant_id for update;
  if nullif(trim(p_token), '') is not null then
    if char_length(trim(p_token)) not between 20 and 600 then raise exception 'Token do WhatsApp inválido.'; end if;
    if s.wa_token_secret_id is not null then perform vault.update_secret(s.wa_token_secret_id, trim(p_token));
    else v := vault.create_secret(trim(p_token), 'wa_token_' || p_tenant_id, 'Domma Food: WhatsApp Cloud API token');
         update public.marketing_settings set wa_token_secret_id = v where tenant_id = p_tenant_id; end if;
    update public.marketing_settings set wa_token_hint = right(trim(p_token), 4), last_test_ok = null where tenant_id = p_tenant_id;
  end if;
  if nullif(trim(p_app_secret), '') is not null then
    if trim(p_app_secret) !~ '^[0-9a-f]{32}$' then raise exception 'Chave secreta do app inválida (32 caracteres hexadecimais).'; end if;
    if s.wa_app_secret_id is not null then perform vault.update_secret(s.wa_app_secret_id, trim(p_app_secret));
    else v := vault.create_secret(trim(p_app_secret), 'wa_app_secret_' || p_tenant_id, 'Domma Food: WhatsApp app secret');
         update public.marketing_settings set wa_app_secret_id = v where tenant_id = p_tenant_id; end if;
  end if;
  update public.marketing_settings set
    wa_phone_number_id = case when p ? 'wa_phone_number_id' then nullif(trim(p->>'wa_phone_number_id'), '') else wa_phone_number_id end,
    wa_business_account_id = case when p ? 'wa_business_account_id' then nullif(trim(p->>'wa_business_account_id'), '') else wa_business_account_id end,
    graph_version = coalesce(nullif(trim(p->>'graph_version'), ''), graph_version),
    frequency_days = coalesce((p->>'frequency_days')::int, frequency_days),
    send_from_hour = coalesce((p->>'send_from_hour')::int, send_from_hour),
    send_to_hour = coalesce((p->>'send_to_hour')::int, send_to_hour),
    wa_enabled = coalesce((p->>'wa_enabled')::boolean, wa_enabled), updated_at = now()
  where tenant_id = p_tenant_id returning * into s;
  if s.wa_enabled and (s.wa_phone_number_id is null or s.wa_token_secret_id is null) then
    raise exception 'Para ativar, informe o ID do número e o token do WhatsApp.'; end if;
  if s.wa_enabled and coalesce(s.last_test_ok, false) = false then raise exception 'Teste a conexão antes de ativar.'; end if;
  if s.send_from_hour >= s.send_to_hour then raise exception 'Janela de envio inválida.'; end if;
end $$;
create or replace function public.marketing_can_test(p_tenant_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.has_role(p_tenant_id, array['owner']::public.member_role[]);
$$;

-- ---------- Campanhas ----------
create or replace function public.campaign_save(p_id uuid, p_tenant_id uuid, p jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v uuid := p_id; cp public.campaigns;
begin
  if not private.can_manage(p_tenant_id) then raise exception 'Sem permissão.' using errcode = '42501'; end if;
  if v is null then
    insert into public.campaigns (tenant_id, unit_id, name, kind, segment, channel, message, template_name, template_lang, template_params,
      coupon_mode, coupon_kind, coupon_value, coupon_min_order_cents, coupon_valid_days)
    values (p_tenant_id, nullif(p->>'unit_id', '')::uuid, trim(p->>'name'), coalesce(p->>'kind', 'manual'),
      coalesce(p->'segment', '{"type":"inactive","days":30}'), coalesce(p->>'channel', 'manual_links'), trim(p->>'message'),
      nullif(trim(p->>'template_name'), ''), coalesce(nullif(p->>'template_lang', ''), 'pt_BR'),
      coalesce((select array_agg(x) from jsonb_array_elements_text(p->'template_params') x), array['nome']),
      coalesce(p->>'coupon_mode', 'none'), coalesce(p->>'coupon_kind', 'percent'), coalesce((p->>'coupon_value')::int, 10),
      coalesce((p->>'coupon_min_order_cents')::int, 0), coalesce((p->>'coupon_valid_days')::int, 7)) returning id into v;
  else
    select * into cp from public.campaigns where id = v and tenant_id = p_tenant_id for update;
    if not found then raise exception 'Campanha não encontrada.'; end if;
    if cp.kind = 'manual' and cp.status <> 'draft' then raise exception 'Campanha já enviada não pode ser editada. Duplique para criar outra.'; end if;
    update public.campaigns set name = coalesce(nullif(trim(p->>'name'), ''), name), segment = coalesce(p->'segment', segment),
      channel = coalesce(p->>'channel', channel), message = coalesce(nullif(trim(p->>'message'), ''), message),
      template_name = case when p ? 'template_name' then nullif(trim(p->>'template_name'), '') else template_name end,
      template_lang = coalesce(nullif(p->>'template_lang', ''), template_lang),
      template_params = coalesce((select array_agg(x) from jsonb_array_elements_text(p->'template_params') x), template_params),
      coupon_mode = coalesce(p->>'coupon_mode', coupon_mode), coupon_kind = coalesce(p->>'coupon_kind', coupon_kind),
      coupon_value = coalesce((p->>'coupon_value')::int, coupon_value), coupon_min_order_cents = coalesce((p->>'coupon_min_order_cents')::int, coupon_min_order_cents),
      coupon_valid_days = coalesce((p->>'coupon_valid_days')::int, coupon_valid_days),
      status = case when cp.kind <> 'manual' and p ? 'active' then case when (p->>'active')::boolean then 'active' else 'paused' end else status end
    where id = v;
  end if;
  select * into cp from public.campaigns where id = v;
  if cp.coupon_mode <> 'none' and cp.coupon_kind = 'percent' and cp.coupon_value not between 1 and 100 then raise exception 'Percentual do cupom inválido.'; end if;
  if cp.channel = 'whatsapp_api' and cp.template_name is null then raise exception 'Informe o nome do modelo aprovado no WhatsApp.'; end if;
  return v;
end $$;

create or replace function public.campaign_launch(p_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare cp public.campaigns; n int;
begin
  select * into cp from public.campaigns where id = p_id for update;
  if not found or not private.can_manage(cp.tenant_id) then raise exception 'Sem permissão.' using errcode = '42501'; end if;
  if cp.kind <> 'manual' then raise exception 'Automações rodam sozinhas todos os dias.'; end if;
  if cp.status <> 'draft' then raise exception 'Esta campanha já foi disparada.'; end if;
  n := private.campaign_generate(cp.id, '');
  if n = 0 then raise exception 'Nenhum cliente no público (com autorização de marketing e sem mensagem recente).'; end if;
  update public.campaigns set status = case when cp.channel = 'whatsapp_api' then 'sending' else 'done' end, launched_at = now() where id = cp.id;
  if cp.channel = 'whatsapp_api' then perform private.kick_marketing_worker(); end if;
  return jsonb_build_object('messages', n);
end $$;

create or replace function public.campaign_message_mark(p_message_id bigint, p_done boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare m public.campaign_messages;
begin
  select * into m from public.campaign_messages where id = p_message_id;
  if not found or not private.can_manage(m.tenant_id) then raise exception 'Sem permissão.' using errcode = '42501'; end if;
  if m.status not in ('manual_pending','manual_done','skipped') then raise exception 'Mensagem enviada pela API.'; end if;
  update public.campaign_messages set status = case when p_done then 'manual_done' else 'skipped' end,
    sent_at = case when p_done then now() end where id = m.id;
end $$;

create or replace function public.customer_marketing_opt_out(p_customer_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare c public.customers;
begin
  select * into c from public.customers where id = p_customer_id;
  if not found or not private.has_role(c.tenant_id, array['owner','manager','attendant']::public.member_role[]) then raise exception 'Sem permissão.' using errcode = '42501'; end if;
  update public.customers set opt_in_marketing = false, marketing_opt_out_at = now() where id = c.id;
end $$;

create or replace function public.campaign_stats(p_tenant_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.can_manage(p_tenant_id) then raise exception 'Sem permissão.' using errcode = '42501'; end if;
  return coalesce((select jsonb_object_agg(x.campaign_id, x.s) from (
    select m.campaign_id, jsonb_build_object('total', count(*),
      'sent', count(*) filter (where m.status in ('sent','delivered','read','manual_done')),
      'delivered', count(*) filter (where m.status in ('delivered','read')), 'read', count(*) filter (where m.status = 'read'),
      'failed', count(*) filter (where m.status = 'failed'), 'pending', count(*) filter (where m.status in ('queued','sending','manual_pending')),
      'converted', count(*) filter (where m.converted_order_id is not null),
      'revenue_cents', coalesce(sum(o.total_cents) filter (where m.converted_order_id is not null), 0)) s
    from public.campaign_messages m left join public.orders o on o.id = m.converted_order_id
    where m.tenant_id = p_tenant_id group by m.campaign_id) x), '{}'::jsonb);
end $$;

-- ---------- Automações (todo dia) ----------
create or replace function private.marketing_daily()
returns integer language plpgsql security definer set search_path = '' as $$
declare cp public.campaigns; n int := 0; v_period text;
begin
  for cp in select * from public.campaigns where kind <> 'manual' and status = 'active' loop
    begin
      v_period := case cp.kind when 'birthday' then to_char(now() at time zone 'America/Sao_Paulo', 'YYYY') else to_char(now() at time zone 'America/Sao_Paulo', 'YYYY-MM') end;
      n := n + private.campaign_generate(cp.id, v_period);
    exception when others then
      update public.campaigns set status = 'paused' where id = cp.id;   -- configuração quebrada: pausa e avisa no painel
    end;
  end loop;
  if n > 0 then perform private.kick_marketing_worker(); end if;
  return n;
end $$;
select cron.schedule('domma-marketing-daily', '7 13 * * *', $$select private.marketing_daily()$$);   -- 10h07 em Brasília
create or replace function private.marketing_cron_tick()
returns void language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.campaign_messages where status = 'queued') then perform private.kick_marketing_worker(); end if;
end $$;
select cron.schedule('domma-marketing', '*/5 * * * *', $$select private.marketing_cron_tick()$$);

-- ---------- Conversão: cliente que recebeu e pediu em até 7 dias ----------
create or replace function private.marketing_conversion()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.customer_id is null then return null; end if;
  update public.campaign_messages set converted_order_id = new.id, converted_at = now()
   where id = (select id from public.campaign_messages where customer_id = new.customer_id and converted_order_id is null
               and status in ('sent','delivered','read','manual_done') and sent_at > now() - interval '7 days' order by sent_at desc limit 1);
  return null;
exception when others then return null;
end $$;
create trigger orders_marketing_conversion after insert on public.orders for each row execute function private.marketing_conversion();

-- ---------- Worker / webhook (somente service_role) ----------
create or replace function public.marketing_jobs(p_limit integer default 50)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v jsonb; v_ids bigint[];
begin
  perform private.assert_service_role();
  update public.campaign_messages set status = 'queued' where status = 'sending' and sent_at is null and created_at < now() - interval '10 minutes' and attempts < 3;
  with picked as (
    select m.id from public.campaign_messages m join public.marketing_settings s on s.tenant_id = m.tenant_id
    where m.status = 'queued' and s.wa_enabled
      and extract(hour from now() at time zone 'America/Sao_Paulo') >= s.send_from_hour
      and extract(hour from now() at time zone 'America/Sao_Paulo') < s.send_to_hour
    order by m.id limit least(greatest(p_limit, 1), 100) for update of m skip locked)
  , upd as (update public.campaign_messages m set status = 'sending', attempts = attempts + 1 from picked where m.id = picked.id returning m.id)
  select array_agg(id) into v_ids from upd;
  select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'to', m.phone, 'params', m.params, 'template', c.template_name, 'lang', c.template_lang,
      'phone_number_id', s.wa_phone_number_id, 'version', s.graph_version,
      'token', (select decrypted_secret from vault.decrypted_secrets where id = s.wa_token_secret_id))), '[]'::jsonb) into v
  from public.campaign_messages m join public.campaigns c on c.id = m.campaign_id join public.marketing_settings s on s.tenant_id = m.tenant_id
  where m.id = any (coalesce(v_ids, '{}'));
  return v;
end $$;
create or replace function public.marketing_job_result(p_id bigint, p_ok boolean, p_wa_id text, p_error text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.assert_service_role();
  update public.campaign_messages set status = case when p_ok then 'sent' else 'failed' end, wa_message_id = p_wa_id,
    sent_at = case when p_ok then now() end, error = left(p_error, 300) where id = p_id;
  update public.campaigns c set status = 'done' where c.status = 'sending'
    and not exists (select 1 from public.campaign_messages m where m.campaign_id = c.id and m.status in ('queued','sending'));
end $$;
create or replace function public.marketing_webhook_context(p_tenant_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.assert_service_role();
  return (select jsonb_build_object('verify_token', s.wa_verify_token, 'phone_number_id', s.wa_phone_number_id, 'version', s.graph_version,
      'app_secret', (select decrypted_secret from vault.decrypted_secrets where id = s.wa_app_secret_id),
      'token', (select decrypted_secret from vault.decrypted_secrets where id = s.wa_token_secret_id))
    from public.marketing_settings s where s.tenant_id = p_tenant_id);
end $$;
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
end $$;
create or replace function public.marketing_inbound(p_tenant_id uuid, p_from text, p_text text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_phone text := private.only_digits(p_from);
begin
  perform private.assert_service_role();
  if upper(trim(coalesce(p_text, ''))) !~ '^(SAIR|PARAR|STOP|CANCELAR|DESCADASTRAR)' then return false; end if;
  update public.customers set opt_in_marketing = false, marketing_opt_out_at = now()
   where tenant_id = p_tenant_id and (phone = v_phone or '55' || phone = v_phone);
  return found;
end $$;
create or replace function public.marketing_test_context(p_tenant_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.assert_service_role();
  return public.marketing_webhook_context(p_tenant_id);
end $$;
create or replace function public.marketing_test_result(p_tenant_id uuid, p_ok boolean, p_message text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.assert_service_role();
  update public.marketing_settings set last_test_at = now(), last_test_ok = p_ok, last_test_message = left(p_message, 300) where tenant_id = p_tenant_id;
end $$;
create or replace function public.marketing_worker_secret()
returns text language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.assert_service_role();
  return (select decrypted_secret from vault.decrypted_secrets where name = 'marketing_worker_secret');
end $$;

grant execute on function public.marketing_jobs(integer), public.marketing_job_result(bigint, boolean, text, text), public.marketing_webhook_context(uuid),
  public.marketing_status_update(uuid, text, text, text), public.marketing_inbound(uuid, text, text), public.marketing_test_context(uuid),
  public.marketing_test_result(uuid, boolean, text), public.marketing_worker_secret() to service_role;
grant execute on function public.marketing_save_settings(uuid, jsonb, text, text), public.marketing_can_test(uuid), public.campaign_save(uuid, uuid, jsonb),
  public.campaign_launch(uuid), public.campaign_message_mark(bigint, boolean), public.customer_marketing_opt_out(uuid),
  public.campaign_audience_count(uuid, jsonb), public.campaign_stats(uuid) to authenticated;
-- defesa em profundidade (o projeto expõe funções novas a anon por padrão)
revoke execute on function public.marketing_jobs(integer), public.marketing_job_result(bigint, boolean, text, text), public.marketing_webhook_context(uuid),
  public.marketing_status_update(uuid, text, text, text), public.marketing_inbound(uuid, text, text), public.marketing_test_context(uuid),
  public.marketing_test_result(uuid, boolean, text), public.marketing_worker_secret() from public, anon, authenticated;
revoke execute on function public.marketing_save_settings(uuid, jsonb, text, text), public.marketing_can_test(uuid), public.campaign_save(uuid, uuid, jsonb),
  public.campaign_launch(uuid), public.campaign_message_mark(bigint, boolean), public.customer_marketing_opt_out(uuid),
  public.campaign_audience_count(uuid, jsonb), public.campaign_stats(uuid),
  public.print_test(uuid), public.print_reprint(uuid), public.print_agent_create(uuid, text), public.print_agent_revoke(uuid),
  public.print_browser_claim(uuid), public.print_browser_done(bigint, boolean, text) from public, anon;
revoke all on public.marketing_settings, public.campaigns, public.campaign_messages, public.print_agents, public.print_jobs from anon;
revoke insert, update, delete on public.marketing_settings, public.campaigns, public.campaign_messages, public.print_agents, public.print_jobs from authenticated;
revoke all on public.printers from anon;
