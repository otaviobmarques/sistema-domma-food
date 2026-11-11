import { brl } from "@/lib/format";

export type Courier = {
  id: string; name: string; phone: string | null; vehicle: string; pix_key: string | null;
  fee_mode: "fixed" | "delivery_fee" | "percent"; fee_value: number; active: boolean; created_at: string;
};
export const COURIER_COLS = "id, name, phone, vehicle, pix_key, fee_mode, fee_value, active, created_at";

export const VEHICLE: Record<string, string> = { moto: "Moto", bike: "Bicicleta", carro: "Carro", a_pe: "A pé" };
export const DELIVERY_STATUS: Record<string, string> = {
  assigned: "Atribuída", picked_up: "Saiu", delivered: "Entregue", returned: "Devolvida", cancelled: "Cancelada",
};
export const COLLECT_LABEL: Record<string, string> = {
  cash: "Dinheiro", card_on_delivery: "Cartão", voucher: "Vale", pix: "Pix",
};

export function feeLabel(c: Pick<Courier, "fee_mode" | "fee_value">) {
  if (c.fee_mode === "fixed") return `${brl(c.fee_value)} por entrega`;
  if (c.fee_mode === "delivery_fee") return "Taxa de entrega cobrada";
  return `${(c.fee_value / 100).toLocaleString("pt-BR", { maximumFractionDigits: 2 })}% da taxa de entrega`;
}

export const courierUrl = (token: string) => `${window.location.origin}/entregador/${token}`;

export function whatsappLink(c: Pick<Courier, "name" | "phone">, url: string, store: string) {
  const msg = `Olá, ${c.name.split(" ")[0]}! Este é o seu link de entregas da ${store}: ${url}\nAbra no celular para ver as rotas, marcar a saída e as entregas. Não compartilhe este link.`;
  const phone = c.phone ? `55${c.phone.replace(/^55/, "")}` : "";
  return `https://wa.me/${phone}?text=${encodeURIComponent(msg)}`;
}

export const minutesAgo = (iso: string) => Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
