-- Ajustes apontados pelos alertas do Supabase (segurança e desempenho). Não muda o que cada perfil pode ver ou fazer.
-- 1) Funções auxiliares com search_path fixo (todas usam nomes completos ou são cálculos puros).
-- 2) Regras de acesso: a regra de escrita "para tudo" (FOR ALL) também valia para leitura e duplicava a de leitura.
--    Vira três regras (inserir, alterar, apagar) com as mesmas condições; a leitura continua só na regra de leitura,
--    que já cobre quem pode escrever.
-- 3) Índice em toda chave estrangeira sem índice (exclusões em cascata e junções ficam baratas).

-- ---------- 1) search_path ----------
alter function private.brl_txt(numeric) set search_path = '';
alter function private.campaign_render(text, public.customers, text, text, text) set search_path = '';
alter function private.courier_fee(public.couriers, public.orders) set search_path = '';
alter function private.fiscal_code(text) set search_path = '';
alter function private.norm_code(text) set search_path = '';
alter function private.safe_https_url(text) set search_path = '';
alter function private.stock_counts(public.order_status) set search_path = '';

-- ---------- 2) Regras de escrita separadas da leitura ----------
do $$ declare r record; v_using text; v_check text; begin
  for r in select * from (values
      ('coupons', 'coupons_write'), ('delivery_zones', 'zones_write'), ('dining_tables', 'dt_write'),
      ('loyalty_settings', 'ls_write'), ('memberships', 'memberships_write'), ('printers', 'pr_write'),
      ('product_recipes', 'pr_write'), ('rewards', 'rw_write')) t(tbl, pol) loop
    select qual, with_check into v_using, v_check from pg_policies
     where schemaname = 'public' and tablename = r.tbl and policyname = r.pol and cmd = 'ALL';
    if v_using is null then raise exception 'Regra %.% não encontrada ou já separada', r.tbl, r.pol; end if;
    v_check := coalesce(v_check, v_using);
    execute format('drop policy %I on public.%I', r.pol, r.tbl);
    execute format('create policy %I on public.%I for insert to authenticated with check (%s)', r.pol || '_ins', r.tbl, v_check);
    execute format('create policy %I on public.%I for update to authenticated using (%s) with check (%s)', r.pol || '_upd', r.tbl, v_using, v_check);
    execute format('create policy %I on public.%I for delete to authenticated using (%s)', r.pol || '_del', r.tbl, v_using);
  end loop;
end $$;

-- ---------- 3) Índices nas chaves estrangeiras ----------
do $$ declare r record; v_name text; v_cols text; begin
  for r in
    select c.conrelid::regclass as tbl, cl.relname, c.conname, c.conkey
    from pg_constraint c join pg_class cl on cl.oid = c.conrelid join pg_namespace n on n.oid = cl.relnamespace
    where c.contype = 'f' and n.nspname = 'public'
      and not exists (
        select 1 from pg_index i
        where i.indrelid = c.conrelid
          and (i.indkey::int2[])[0:array_length(c.conkey, 1) - 1] @> c.conkey
          and (i.indkey::int2[])[0:array_length(c.conkey, 1) - 1] <@ c.conkey)
  loop
    select string_agg(quote_ident(a.attname), ', ' order by k.ord), string_agg(a.attname, '_' order by k.ord)
      into v_cols, v_name
      from unnest(r.conkey) with ordinality k(attnum, ord) join pg_attribute a on a.attrelid = r.tbl and a.attnum = k.attnum;
    v_name := left(r.relname || '_' || v_name, 50) || '_fk' || substr(md5(r.conname), 1, 6);
    execute format('create index if not exists %I on %s (%s)', v_name, r.tbl, v_cols);
  end loop;
end $$;
