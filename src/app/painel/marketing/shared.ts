export type Segment = { type: "all" | "inactive" | "new" | "top" | "birthday_month" | "birthday_today" | "crm"; days?: number; min_orders?: number;
  filter?: Record<string, unknown>; name?: string };
export type Campaign = {
  id: string; tenant_id: string; unit_id: string | null; name: string; kind: "manual" | "birthday" | "winback";
  segment: Segment; channel: "manual_links" | "whatsapp_api"; message: string;
  template_name: string | null; template_lang: string; template_params: string[];
  coupon_mode: "none" | "unique" | "shared"; coupon_kind: "percent" | "fixed" | "free_delivery"; coupon_value: number;
  coupon_min_order_cents: number; coupon_valid_days: number; shared_coupon_id: string | null;
  status: "draft" | "sending" | "done" | "active" | "paused"; launched_at: string | null; created_at: string; updated_at: string;
};
export type Stats = { total: number; sent: number; delivered: number; read: number; failed: number; pending: number; converted: number; revenue_cents: number };
export type Message = {
  id: number; campaign_id: string; customer_id: string; phone: string; body: string; coupon_code: string | null;
  status: "queued" | "sending" | "sent" | "delivered" | "read" | "failed" | "manual_pending" | "manual_done" | "skipped";
  error: string | null; sent_at: string | null; converted_order_id: string | null; created_at: string;
  customers?: { name: string } | null;
};
export type Settings = {
  tenant_id: string; wa_enabled: boolean; wa_phone_number_id: string | null; wa_business_account_id: string | null; wa_token_hint: string | null;
  wa_verify_token: string; graph_version: string; frequency_days: number; send_from_hour: number; send_to_hour: number;
  last_test_at: string | null; last_test_ok: boolean | null; last_test_message: string | null;
};

export const SEGMENT_LABEL: Record<Segment["type"], string> = {
  all: "Todos que autorizaram", inactive: "Clientes sumidos", new: "Clientes novos", top: "Clientes frequentes",
  birthday_month: "Aniversariantes do mês", birthday_today: "Aniversariantes do dia", crm: "Filtro do CRM",
};
export function segmentText(s: Segment) {
  if (s.type === "inactive") return `Sem pedir há ${s.days ?? 30}+ dias`;
  if (s.type === "new") return `1º pedido nos últimos ${s.days ?? 30} dias`;
  if (s.type === "top") return `${s.min_orders ?? 5}+ pedidos`;
  if (s.type === "crm") return `CRM: ${s.name ?? "filtro personalizado"}`;
  return SEGMENT_LABEL[s.type] ?? s.type;
}
export const CAMPAIGN_STATUS: Record<Campaign["status"], { label: string; cls: string }> = {
  draft: { label: "Rascunho", cls: "bg-zinc-100 text-zinc-700" }, sending: { label: "Enviando", cls: "bg-amber-100 text-amber-800" },
  done: { label: "Disparada", cls: "bg-green-100 text-green-800" }, active: { label: "Ativa", cls: "bg-green-100 text-green-800" },
  paused: { label: "Pausada", cls: "bg-zinc-100 text-zinc-600" },
};
export const MESSAGE_STATUS: Record<Message["status"], { label: string; cls: string }> = {
  queued: { label: "Na fila", cls: "bg-zinc-100 text-zinc-700" }, sending: { label: "Enviando", cls: "bg-amber-100 text-amber-800" },
  sent: { label: "Enviada", cls: "bg-blue-100 text-blue-800" }, delivered: { label: "Entregue", cls: "bg-green-100 text-green-800" },
  read: { label: "Lida", cls: "bg-green-100 text-green-800" }, failed: { label: "Falhou", cls: "bg-red-100 text-red-800" },
  manual_pending: { label: "A enviar", cls: "bg-amber-100 text-amber-800" }, manual_done: { label: "Enviada", cls: "bg-green-100 text-green-800" },
  skipped: { label: "Pulada", cls: "bg-zinc-100 text-zinc-500" },
};
export const PLACEHOLDERS = [
  { key: "nome", tag: "{nome}", label: "Nome", example: "Ana" },
  { key: "cupom", tag: "{cupom}", label: "Cupom", example: "VOLTA7K2P9Q" },
  { key: "loja", tag: "{loja}", label: "Loja", example: "" },
  { key: "link", tag: "{link}", label: "Link do cardápio", example: "" },
  { key: "cashback", tag: "{cashback}", label: "Cashback", example: "12,50" },
] as const;
export function render(message: string, ex: { store: string; slug: string; coupon?: string }) {
  const vals: Record<string, string> = { nome: "Ana", cupom: ex.coupon ?? "VOLTA7K2P9Q", loja: ex.store, link: `https://domma-food.vercel.app/loja/${ex.slug}`, cashback: "12,50" };
  return message.replace(/\{(nome|cupom|loja|link|cashback)\}/g, (_, k: string) => vals[k] ?? "");
}
export const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—");
