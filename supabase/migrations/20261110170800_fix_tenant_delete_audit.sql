-- =====================================================================
-- Domma Food · 009 · Correção: excluir um tenant inteiro (cascata) falhava
-- porque a auditoria tentava registrar linhas de um tenant já removido.
-- =====================================================================
create or replace function private.audit_row()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_old jsonb := case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) end;
  v_new jsonb := case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) end;
  v_tenant uuid := coalesce((v_new->>'tenant_id')::uuid, (v_old->>'tenant_id')::uuid,
                            case when tg_table_name = 'tenants' then coalesce((v_new->>'id')::uuid,(v_old->>'id')::uuid) end);
begin
  if tg_op = 'UPDATE' and v_old - 'updated_at' = v_new - 'updated_at' then
    return new;
  end if;
  -- exclusão em cascata de um tenant: os logs dele também são removidos
  if tg_op = 'DELETE' and (tg_table_name = 'tenants'
      or not exists (select 1 from public.tenants where id = v_tenant)) then
    return old;
  end if;
  insert into public.audit_logs (tenant_id, actor_id, action, entity, entity_id, before, after, ip)
  values (v_tenant, auth.uid(), lower(tg_op), tg_table_name,
          coalesce(v_new->>'id', v_old->>'id', v_new->>'product_id', v_old->>'product_id'),
          v_old, v_new, private.request_ip());
  return coalesce(new, old);
end $$;
