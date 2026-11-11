export type OrderItem = {
  id: string; name: string; quantity: number; unit_price_cents: number; total_cents: number;
  options: { group: string; name: string; price_cents: number; quantity: number }[]; notes: string | null;
};
export type Order = {
  id: string; number: number; status: string; type: string; channel: string;
  customer_name: string; customer_phone: string;
  address: { street?: string; number?: string; complement?: string; neighborhood?: string; city?: string; reference?: string } | null;
  scheduled_for: string | null; subtotal_cents: number; discount_cents: number; delivery_fee_cents: number;
  total_cents: number; payment_method: string; payment_status: string; change_for_cents: number | null;
  coupon_code: string | null; notes: string | null; cancel_reason: string | null;
  accepted_at: string | null; created_at: string; completed_at: string | null; cancelled_at: string | null;
  external_display_id?: string | null; marketplace_cancel_requested?: boolean; tab_id?: string | null;
  order_items: OrderItem[];
};
