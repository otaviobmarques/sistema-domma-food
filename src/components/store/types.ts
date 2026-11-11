export type StoreOption = { id: string; name: string; description: string | null; price_cents: number };
export type StoreGroup = {
  id: string; name: string; min: number; max: number; allow_repeat: boolean;
  price_rule: "sum" | "max" | "avg"; options: StoreOption[];
};
export type StoreProduct = {
  id: string; name: string; description: string | null; image_url: string | null;
  price_cents: number; promo_price_cents: number | null; featured: boolean; tags: string[];
  available: boolean; option_groups: StoreGroup[];
};
export type StoreCategory = { id: string; name: string; description: string | null; position: number; available_now: boolean; products: StoreProduct[] };
export type StoreZone = {
  id: string; name: string; kind: "radius" | "neighborhood"; radius_km: number | null; neighborhoods: string[];
  fee_cents: number; min_order_cents: number; free_above_cents: number | null; eta_min: number;
};
export type StoreUnit = {
  id: string; slug: string; name: string; description: string | null; logo_url: string | null; cover_url: string | null;
  primary_color: string; phone: string | null; whatsapp: string | null; neighborhood: string | null; city: string | null;
  state: string | null; has_location: boolean; is_open: boolean; wa_status?: boolean; opening_hours: Record<string, [string, string][]>;
  accepts_delivery: boolean; accepts_pickup: boolean; accepts_scheduling: boolean; min_order_cents: number;
  prep_time_min: number; pickup_time_min: number; accepted_payments: string[];
  gateway?: StoreGateway | null;
};
export type StoreGateway = { provider: string; pix: boolean; card: boolean; public_key: string; max_installments: number };
export type Store = { unit: StoreUnit; zones: StoreZone[]; menu: StoreCategory[] };

export type CartOption = { option_id: string; name: string; price_cents: number; quantity: number; group: string };
export type CartItem = {
  key: string; product_id: string; name: string; quantity: number; notes: string;
  options: CartOption[]; unit_price_cents: number;
};
