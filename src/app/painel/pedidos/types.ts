export type OrderItem = {
  id: string; name: string; quantity: number; unit_price_cents: number; total_cents: number;
  options: { group: string; name: string; price_cents: number; quantity: number }[]; notes: string | null;
};
export type Order = {
  id: string; number: number; status: string; type: string; channel: string; public_token?: string;
  customer_name: string; customer_phone: string;
  address: { street?: string; number?: string; complement?: string; neighborhood?: string; city?: string; reference?: string } | null;
  scheduled_for: string | null; subtotal_cents: number; discount_cents: number; delivery_fee_cents: number;
  total_cents: number; payment_method: string; payment_status: string; change_for_cents: number | null;
  coupon_code: string | null; notes: string | null; cancel_reason: string | null;
  accepted_at: string | null; created_at: string; completed_at: string | null; cancelled_at: string | null;
  external_display_id?: string | null; marketplace_cancel_requested?: boolean; tab_id?: string | null;
  order_items: OrderItem[];
  deliveries?: { status: string; couriers: { name: string } | null }[];
};

/** Entregador da entrega ativa (atribuída, em rota ou entregue). */
export const courierOf = (o: Order) =>
  o.deliveries?.find((d) => ["assigned", "picked_up", "delivered"].includes(d.status))?.couriers?.name ?? null;

/** Texto pronto do aviso de status (envio manual pelo WhatsApp da loja). */
export function statusMessage(o: Order, store: string) {
  const first = o.customer_name.trim().split(/\s+/)[0] || "cliente";
  const link = o.public_token ? ` Acompanhe: https://domma-food.vercel.app/pedido/${o.public_token}` : "";
  const courier = courierOf(o);
  switch (o.status) {
    case "pending": case "awaiting_payment": return `Olá, ${first}! Recebemos seu pedido #${o.number} na ${store}.${link}`;
    case "preparing": return `Olá, ${first}! Seu pedido #${o.number} foi aceito e já está em preparo.${link}`;
    case "ready": case "awaiting_pickup":
      return o.type === "pickup" ? `Olá, ${first}! Seu pedido #${o.number} está pronto para retirada na ${store}.`
        : `Olá, ${first}! Seu pedido #${o.number} está pronto e logo sai para entrega.${link}`;
    case "dispatched": return `Olá, ${first}! Seu pedido #${o.number} saiu para entrega${courier ? ` com ${courier.split(" ")[0]}` : ""}.${link}`;
    case "completed": return `Olá, ${first}! Seu pedido #${o.number} foi concluído. Obrigado pela preferência!`;
    case "cancelled": return `Olá, ${first}. Seu pedido #${o.number} foi cancelado${o.cancel_reason ? `. Motivo: ${o.cancel_reason}` : ""}. Qualquer dúvida, fale com a gente por aqui.`;
    default: return `Olá, ${first}! Sobre o seu pedido #${o.number} na ${store}:`;
  }
}
