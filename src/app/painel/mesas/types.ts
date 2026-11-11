export type DTable = { id: string; name: string; area: string; seats: number; position: number; active: boolean; qr_token?: string };
export type TabItem = {
  id: string; name: string; quantity: number; total_cents: number; notes: string | null; kds_status: string;
  options: { name: string; quantity?: number }[] | null;
};
export type TabOrder = { id: string; number: number; status: string; subtotal_cents: number; created_at: string; via_qr?: boolean; notes?: string | null; order_items: TabItem[] };
export type Tab = {
  id: string; table_id: string | null; label: string; customer_name: string | null; people: number;
  service_fee_pct: number; bill_requested_at: string | null; opened_at: string; orders: TabOrder[];
  waiter_called_at?: string | null; opened_via?: string;
};

export const liveOrders = (t: Tab) => t.orders.filter((o) => o.status !== "cancelled");
export const pendingQr = (t: Tab) => t.orders.filter((o) => o.status === "pending");
export const tabSubtotal = (t: Tab) => liveOrders(t).reduce((s, o) => s + o.subtotal_cents, 0);
export const minutesSince = (iso: string, now: number) => Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60000));
export const lastActivity = (t: Tab) => t.orders.reduce((m, o) => (o.created_at > m ? o.created_at : m), t.opened_at);
export const fmtDuration = (min: number) => (min < 60 ? `${min} min` : `${Math.floor(min / 60)}h${String(min % 60).padStart(2, "0")}`);
export const tabTitle = (t: Tab, tables: DTable[]) => {
  const tb = tables.find((x) => x.id === t.table_id);
  return tb ? `Mesa ${tb.name}${t.label ? ` · ${t.label}` : ""}` : `Comanda ${t.label}`;
};
/** Mesa parada: sem pedido novo há 40 min ou mais. */
export const IDLE_MIN = 40;
