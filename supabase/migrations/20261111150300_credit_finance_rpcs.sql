-- =====================================================================
-- Domma Food · 020 · Fiado (limite, recebimento, ajuste) e resumo financeiro
-- =====================================================================
create or replace function public.credit_set_limit(p_customer_id uuid, p_limit_cents integer)
returns void language plpgsql security definer set search_path = '' as $$
declare c public.customers;
begin
  select * into c from public.customers where id = p_customer_id for update;
  if not found or not private.can_manage(c.tenant_id) then raise exception 'Sem permissão.' using errcode = '42501'; end if;
  if p_limit_cents is null or p_limit_cents < 0 or p_limit_cents > 100000000 then raise exception 'Limite inválido.'; end if;
  update public.customers set credit_limit_cents = p_limit_cents where id = c.id;
  insert into public.audit_logs (tenant_id, actor_id, action, entity, entity_id, before, after, ip)
  values (c.tenant_id, auth.uid(), 'credit_limit', 'customers', c.id::text, jsonb_build_object('credit_limit_cents', c.credit_limit_cents),
          jsonb_build_object('credit_limit_cents', p_limit_cents), private.request_ip());
end $$;

-- recebimento do fiado; com caixa aberto, entra no caixa na forma recebida
create or replace function public.credit_pay(p_customer_id uuid, p_amount_cents integer, p_method text, p_unit_id uuid default null, p_note text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c public.customers; s uuid; v_bal integer;
begin
  select * into c from public.customers where id = p_customer_id for update;
  if not found or not private.has_role(c.tenant_id, array['owner','manager','cashier']::public.member_role[]) then
    raise exception 'Sem permissão.' using errcode = '42501'; end if;
  if p_method not in ('cash','pix','credit_card','debit_card') then raise exception 'Forma de pagamento inválida.'; end if;
  if p_amount_cents is null or p_amount_cents <= 0 then raise exception 'Informe o valor recebido.'; end if;
  if p_amount_cents > c.credit_balance_cents then
    raise exception 'O valor é maior que a dívida (R$ %).', to_char(c.credit_balance_cents / 100.0, 'FM999990D00'); end if;
  if p_unit_id is not null then
    if not private.can_access_unit(p_unit_id) or not exists (select 1 from public.units where id = p_unit_id and tenant_id = c.tenant_id) then
      raise exception 'Sem permissão.' using errcode = '42501'; end if;
    s := private.open_session(p_unit_id);
  end if;
  if p_method = 'cash' and s is null then raise exception 'Abra o caixa para receber em dinheiro.'; end if;
  v_bal := private.credit_post(c.tenant_id, c.id, 'payment', -p_amount_cents, null, null, p_method, coalesce(nullif(trim(p_note), ''), 'Recebimento'));
  if s is not null then
    insert into public.cash_moves (tenant_id, session_id, kind, method, amount_cents, note, created_by)
    values (c.tenant_id, s, 'credit_payment', p_method::public.payment_method, p_amount_cents, left('Fiado: ' || c.name, 200), auth.uid());
  end if;
  return jsonb_build_object('balance_cents', v_bal, 'in_cash_session', s is not null);
end $$;

create or replace function public.credit_adjust(p_customer_id uuid, p_amount_cents integer, p_note text)
returns integer language plpgsql security definer set search_path = '' as $$
declare c public.customers;
begin
  select * into c from public.customers where id = p_customer_id for update;
  if not found or not private.can_manage(c.tenant_id) then raise exception 'Sem permissão.' using errcode = '42501'; end if;
  if coalesce(p_amount_cents, 0) = 0 then raise exception 'Informe o valor.'; end if;
  if coalesce(trim(p_note), '') = '' then raise exception 'Informe o motivo.'; end if;
  if c.credit_balance_cents + p_amount_cents < 0 then raise exception 'O ajuste deixaria o saldo negativo.'; end if;
  return private.credit_post(c.tenant_id, c.id, 'adjust', p_amount_cents, null, null, null, p_note);
end $$;

-- ---------- Resumo financeiro (resultado do período + contas em aberto) ----------
create or replace function public.fin_summary(p_tenant_id uuid, p_unit_id uuid, p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_tz text; v_a timestamptz; v_b timestamptz; v_today date;
begin
  if not private.can_manage(p_tenant_id) then raise exception 'Sem permissão.' using errcode = '42501'; end if;
  if p_unit_id is not null and (not private.can_access_unit(p_unit_id)
     or not exists (select 1 from public.units where id = p_unit_id and tenant_id = p_tenant_id)) then
    raise exception 'Sem permissão.' using errcode = '42501'; end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 400 then raise exception 'Período inválido.'; end if;
  select timezone into v_tz from public.units where tenant_id = p_tenant_id and (p_unit_id is null or id = p_unit_id) order by id limit 1;
  v_tz := coalesce(v_tz, 'America/Sao_Paulo');
  v_a := p_from::timestamp at time zone v_tz; v_b := (p_to + 1)::timestamp at time zone v_tz;
  v_today := (now() at time zone v_tz)::date;
  return (
    with ok as (select * from public.orders where tenant_id = p_tenant_id and (p_unit_id is null or unit_id = p_unit_id)
                  and created_at >= v_a and created_at < v_b and status <> 'cancelled'),
         tb as (select * from public.tabs where tenant_id = p_tenant_id and (p_unit_id is null or unit_id = p_unit_id)
                  and status = 'closed' and closed_at >= v_a and closed_at < v_b),
         fe as (select * from public.fin_entries where tenant_id = p_tenant_id and (p_unit_id is null or unit_id is null or unit_id = p_unit_id)),
         paid as (select * from fe where paid_at >= v_a and paid_at < v_b),
         tot as (select
           coalesce((select sum(total_cents) from ok), 0)::bigint as sales,
           coalesce((select sum(service_fee_cents) from tb), 0)::bigint as fee,
           coalesce((select sum(discount_cents) from tb), 0)::bigint as tab_disc,
           coalesce((select sum(amount_cents) from paid where kind = 'receivable'), 0)::bigint as other_in,
           coalesce((select sum(amount_cents) from paid where kind = 'payable'), 0)::bigint as expenses,
           coalesce((select round(sum(-m.qty * m.unit_cost_cents)) from public.stock_moves m join public.stock_items si on si.id = m.item_id
                      where m.tenant_id = p_tenant_id and (p_unit_id is null or si.unit_id = p_unit_id)
                        and m.kind in ('sale','sale_reversal') and m.created_at >= v_a and m.created_at < v_b), 0)::bigint as cmv)
    select jsonb_build_object(
      'sales_cents', tot.sales, 'orders', (select count(*) from ok),
      'service_fee_cents', tot.fee, 'tab_discount_cents', tot.tab_disc,
      'delivery_fee_cents', coalesce((select sum(delivery_fee_cents) from ok), 0),
      'discount_cents', coalesce((select sum(discount_cents) from ok), 0),
      'other_income_cents', tot.other_in, 'expenses_cents', tot.expenses, 'cmv_cents', tot.cmv,
      'result_cents', tot.sales + tot.fee - tot.tab_disc + tot.other_in - tot.expenses,
      'expenses_by_category', (select coalesce(jsonb_agg(jsonb_build_object('category', category, 'amount_cents', a) order by a desc), '[]'::jsonb)
                                 from (select category, sum(amount_cents) a from paid where kind = 'payable' group by 1) x),
      'by_method', (select coalesce(jsonb_agg(jsonb_build_object('method', m, 'amount_cents', a) order by a desc), '[]'::jsonb)
                      from (select p.method m, sum(p.amount_cents) a from public.payments p
                            left join public.orders o on o.id = p.order_id left join public.tabs t on t.id = p.tab_id
                            where p.tenant_id = p_tenant_id and p.status = 'paid' and p.created_at >= v_a and p.created_at < v_b
                              and (p_unit_id is null or coalesce(o.unit_id, t.unit_id) = p_unit_id) group by 1) x),
      'by_day', (select coalesce(jsonb_agg(jsonb_build_object('day', d, 'in_cents', i, 'out_cents', o) order by d), '[]'::jsonb)
                   from (select d, sum(i) i, sum(o) o from (
                           select (created_at at time zone v_tz)::date d, total_cents::bigint i, 0::bigint o from ok
                           union all select (paid_at at time zone v_tz)::date, case when kind = 'receivable' then amount_cents else 0 end,
                                            case when kind = 'payable' then amount_cents else 0 end from paid) z group by d) x),
      'payable_open_cents', coalesce((select sum(amount_cents) from fe where kind = 'payable' and paid_at is null), 0),
      'payable_overdue_cents', coalesce((select sum(amount_cents) from fe where kind = 'payable' and paid_at is null and due_date < v_today), 0),
      'payable_week_cents', coalesce((select sum(amount_cents) from fe where kind = 'payable' and paid_at is null and due_date between v_today and v_today + 7), 0),
      'receivable_open_cents', coalesce((select sum(amount_cents) from fe where kind = 'receivable' and paid_at is null), 0),
      'credit_open_cents', coalesce((select sum(credit_balance_cents) from public.customers where tenant_id = p_tenant_id and credit_balance_cents > 0), 0),
      'today', v_today)
    from tot);
end $$;

grant execute on function public.credit_set_limit(uuid, integer) to authenticated;
grant execute on function public.credit_pay(uuid, integer, text, uuid, text) to authenticated;
grant execute on function public.credit_adjust(uuid, integer, text) to authenticated;
grant execute on function public.fin_summary(uuid, uuid, date, date) to authenticated;
