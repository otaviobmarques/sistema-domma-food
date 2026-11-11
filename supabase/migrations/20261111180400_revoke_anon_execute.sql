-- =====================================================================
-- Domma Food · 025 · Defesa em profundidade: as funções abaixo já conferem
-- permissão por dentro, mas anon não deve nem conseguir chamá-las.
-- =====================================================================
revoke execute on function
  public.credit_adjust(uuid, integer, text), public.credit_pay(uuid, integer, text, uuid, text), public.credit_set_limit(uuid, integer),
  public.fin_summary(uuid, uuid, date, date), public.stock_move(uuid, text, numeric, integer, text, boolean),
  public.tab_close(uuid, jsonb, boolean, integer, uuid), public.tab_ack_call(uuid), public.table_qr_rotate(uuid),
  public.fiscal_can_test(uuid), public.fiscal_cancel(uuid, text), public.fiscal_request(uuid, uuid, text),
  public.fiscal_retry(uuid), public.fiscal_save_settings(uuid, jsonb, text)
from public, anon;
revoke execute on function
  public.fiscal_jobs(integer), public.fiscal_job_result(uuid, integer, jsonb), public.fiscal_test_result(uuid, boolean, text),
  public.fiscal_test_token(uuid), public.fiscal_worker_secret()
from public, anon, authenticated;
revoke all on public.fiscal_settings, public.fiscal_documents from anon;
revoke insert, update, delete on public.fiscal_settings, public.fiscal_documents from authenticated;
