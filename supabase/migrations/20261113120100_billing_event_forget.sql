-- Domma Food · 038 · Webhook do Asaas: se a consulta da cobrança falhar, o evento volta a valer na reentrega
create or replace function public.billing_event_forget(p_id text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.assert_service_role();
  delete from public.billing_events where id = p_id;
end $$;
grant execute on function public.billing_event_forget(text) to service_role;
revoke execute on function public.billing_event_forget(text) from public, anon, authenticated;
