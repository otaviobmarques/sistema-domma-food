-- =====================================================================
-- Domma Food · 033 · Cupom impresso: valores com vírgula (R$ 54,90)
-- independentemente do idioma do servidor
-- =====================================================================
create or replace function private.brl_txt(p_cents numeric)
returns text language sql immutable as $$
  select replace(to_char(p_cents / 100.0, 'FM999999990D00'), '.', ',');
$$;
do $$ declare d text; begin
  d := pg_get_functiondef('private.print_ticket(uuid, text, text, integer)'::regprocedure);
  d := regexp_replace(d, 'to_char\(([a-z_.]+) / 100\.0, ''FM999G990D00''\)', 'private.brl_txt(\1)', 'g');
  if position('FM999G990D00' in d) > 0 then raise exception 'print_ticket: formato não substituído'; end if;
  execute d;
end $$;
