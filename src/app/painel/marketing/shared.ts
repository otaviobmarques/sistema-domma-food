export type SegmentType = "all" | "inactive" | "new" | "top" | "birthday_month" | "birthday_today";
export type Segment = { type: SegmentType; days?: number; min_orders?: number };
export type CouponMode = "none" | "unique" | "shared";
export type CouponKind = "percent" | "fixed" | "free_delivery";
export type Channel = "manual_links" | "whatsapp_api";
export type Campaign = {
  id: string; name: string; kind: "manual" | "birthday" | "winback"; segment: Segment; channel: Channel; message: string;
  template_name: string | null; template_lang: string; template_params: string[];
  coupon_mode: CouponMode; coupon_kind: CouponKind; coupon_value: number; coupon_min_order_cents: number; coupon_valid_days: number;
  status: "draft" | "sending" | "done" | "active" | "paused"; launched_at: string | null; created_at: string;
};
export type Settings = {
  tenant_id: string; wa_enabled: boolean; wa_phone_number_id: string | null; wa_business_account_id: string | null; wa_token_hint: string | null;
  wa_verify_token: string; graph_version: string; frequency_days: number; send_from_hour: number; send_to_hour: number;
  last_test_at: string | null; last_test_ok: boolean | null; last_test_message: string | null;
};
export type Stats = { total: number; sent: number; delivered: number; read: number; failed: number; pending: number; converted: number; revenue_cents: number };

export const SEGMENTS: { type: SegmentType; label: string; hint: string }[] = [
  { type: "inactive", label: "Clientes sumidos", hint: "Não pedem há X dias" },
  { type: "new", label: "Clientes novos", hint: "Primeiro pedido nos últimos X dias" },
  { type: "top", label: "Clientes frequentes", hint: "Com pelo menos X pedidos" },
  { type: "birthday_month", label: "Aniversariantes do mês", hint: "Quem informou a data de nascimento" },
  { type: "all", label: "Todos", hint: "Todos que autorizaram marketing" },
];
export const segmentLabel = (s: Segment) => {
  switch (s.type) {
    case "inactive": return `Sem pedir há ${s.days ?? 30} dias`;
    case "new": return `Novos (${s.days ?? 30} dias)`;
    case "top": return `${s.min_orders ?? 5}+ pedidos`;
    case "birthday_month": return "Aniversariantes do mês";
    case "birthday_today": return "Aniversariantes do dia";
    default: return "Todos";
  }
};
export const PLACEHOLDERS = [
  { key: "nome", label: "Nome" }, { key: "cupom", label: "Cupom" }, { key: "loja", label: "Loja" },
  { key: "link", label: "Link do cardápio" }, { key: "cashback", label: "Cashback" },
] as const;
export const STATUS: Record<string, { label: string; cls: string }> = {
  draft: { label: "Rascunho", cls: "bg-zinc-100 text-zinc-700" },
  sending: { label: "Enviando", cls: "bg-amber-100 text-amber-800" },
  done: { label: "Enviada", cls: "bg-green-100 text-green-800" },
  active: { label: "Ativa", cls: "bg-green-100 text-green-800" },
  paused: { label: "Pausada", cls: "bg-zinc-100 text-zinc-700" },
};
export const MSG_STATUS: Record<string, { label: string; cls: string }> = {
  queued: { label: "Na fila", cls: "bg-zinc-100 text-zinc-700" },
  sending: { label: "Enviando", cls: "bg-amber-100 text-amber-800" },
  sent: { label: "Enviada", cls: "bg-blue-100 text-blue-800" },
  delivered: { label: "Entregue", cls: "bg-green-100 text-green-800" },
  read: { label: "Lida", cls: "bg-green-100 text-green-800" },
  failed: { label: "Falhou", cls: "bg-red-100 text-red-800" },
  manual_pending: { label: "A enviar", cls: "bg-amber-100 text-amber-800" },
  manual_done: { label: "Enviada", cls: "bg-green-100 text-green-800" },
  skipped: { label: "Pulada", cls: "bg-zinc-100 text-zinc-500" },
};

export function renderPreview(msg: string, store: string, slug: string, coupon: string | null) {
  return msg.replaceAll("{nome}", "Ana").replaceAll("{cupom}", coupon ?? "")
    .replaceAll("{loja}", store).replaceAll("{link}", `https://domma-food.vercel.app/loja/${slug}`).replaceAll("{cashback}", "8,50");
}
export function couponExample(mode: CouponMode, kind: "manual" | "birthday" | "winback") {
  if (mode === "none") return null;
  if (mode === "shared") return "VOLTA7K2M";
  return (kind === "birthday" ? "NIVER" : kind === "winback" ? "VOLTA" : "DOMMA") + "A1B2C3";
}
export const couponLabel = (c: Pick<Campaign, "coupon_mode" | "coupon_kind" | "coupon_value">) => {
  if (c.coupon_mode === "none") return "Sem cupom";
  const v = c.coupon_kind === "percent" ? `${c.coupon_value}% off` : c.coupon_kind === "fixed" ? `R$ ${(c.coupon_value / 100).toFixed(2).replace(".", ",")} off` : "Frete grátis";
  return `${v} · ${c.coupon_mode === "unique" ? "código único" : "código para todos"}`;
};
