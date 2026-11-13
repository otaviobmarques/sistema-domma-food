/** Relatório da revenda (private.reseller_report), usado no portal e no admin. */
export type ResellerClient = {
  id: string; name: string; plan_id: string; plan_name: string; price_cents: number; status: string; billing_exempt: boolean;
  trial_ends_at: string | null; paid_until: string | null; cancel_at: string | null; created_at: string; reseller_since: string;
  owner_email: string | null; store_slug: string | null; units: number; orders_30d: number; last_paid_at: string | null;
};
export type ResellerMonth = { month: string; received_cents: number; commission_cents: number; paid_cents: number };
export type ResellerReport = {
  reseller: { id: string; name: string; code: string; commission_pct: number; active: boolean; document: string | null;
    contact_email: string | null; phone: string | null; created_at: string };
  totals: { clients: number; active: number; trial: number; past_due: number; suspended: number; mrr_cents: number };
  commission_total_cents: number; paid_total_cents: number; balance_cents: number;
  months: ResellerMonth[];
  clients: ResellerClient[];
  payouts: { id: string; month: string; amount_cents: number; note: string | null; paid_at: string }[];
  members: { user_id: string; email: string; role: "owner" | "staff" }[] | null;
  invites: { email: string; role: "owner" | "staff" }[] | null;
  my_role?: "owner" | "staff";
};

export const CLIENT_STATUS: Record<string, { l: string; c: string }> = {
  trial: { l: "Em teste", c: "bg-amber-100 text-amber-800" }, active: { l: "Ativa", c: "bg-green-100 text-green-800" },
  past_due: { l: "Inadimplente", c: "bg-orange-100 text-orange-800" }, suspended: { l: "Suspensa", c: "bg-red-100 text-red-800" },
};

export const monthLabel = (iso: string) =>
  new Date(iso.slice(0, 10) + "T12:00:00").toLocaleDateString("pt-BR", { month: "long", year: "numeric" });
export const dateBR = (iso: string | null) => (iso ? new Date(iso.length === 10 ? iso + "T12:00:00" : iso).toLocaleDateString("pt-BR") : "—");
export const referralUrl = (code: string) =>
  `${typeof window !== "undefined" ? window.location.origin : "https://domma-food.vercel.app"}/r/${code}`;
