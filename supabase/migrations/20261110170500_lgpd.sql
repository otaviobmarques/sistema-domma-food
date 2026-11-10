-- =====================================================================
-- Domma Food · 006 · LGPD: exclusão (anonimização) de cliente final
-- O lojista é o controlador; a função apaga dados pessoais e mantém
-- os valores dos pedidos para fins fiscais/contábeis.
-- =====================================================================
create or replace function public.anonymize_customer(p_customer_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare c public.customers;
begin
  select * into c from public.customers where id = p_customer_id;
  if not found or not private.has_role(c.tenant_id, array['owner','manager']::public.member_role[]) then
    raise exception 'Sem permissão.' using errcode = '42501';
  end if;
  update public.orders set customer_name = 'Cliente removido (LGPD)', customer_phone = '00000000000',
         address = null, notes = null, customer_id = null
   where customer_id = c.id;
  delete from public.customers where id = c.id;
  insert into public.audit_logs (tenant_id, actor_id, action, entity, entity_id, before, after, ip)
  values (c.tenant_id, auth.uid(), 'lgpd_erase', 'customers', c.id::text, null, null, private.request_ip());
end $$;
revoke execute on function public.anonymize_customer(uuid) from public, anon;
grant execute on function public.anonymize_customer(uuid) to authenticated;
