export const METHODS = ["cash", "pix", "credit_card", "debit_card", "voucher"] as const;
export type Method = (typeof METHODS)[number];
export const METHOD_LABEL: Record<PayMethod, string> = { cash: "Dinheiro", pix: "Pix", credit_card: "Crédito", debit_card: "Débito", voucher: "Vale", credit_account: "Fiado" };
/** formas aceitas no PDV; fiado não entra na contagem do caixa */
export const PAY_METHODS = [...METHODS, "credit_account"] as const;
export type PayMethod = (typeof PAY_METHODS)[number];

export type Totals = Record<Method, number> & { credit_account?: number; credit_received?: number; sales_total: number; supply: number; withdrawal: number; sales_count: number };
export type Move = { id: number; kind: "sale" | "supply" | "withdrawal" | "credit_payment"; method: PayMethod; amount_cents: number; note: string | null; created_at: string };
export type Closing = { id: string; opened_at: string; closed_at: string; expected: Totals; counted: Partial<Record<Method, number>>; difference_cents: number; notes: string | null };
export type CashStatus =
  | { open: false; history: Closing[] }
  | { open: true; id: string; opened_at: string; opening_float_cents: number; opened_by: string | null; expected: Totals; open_tabs: number; moves: Move[] };

export const diffClass = (d: number) => (d === 0 ? "text-green-700" : d < 0 ? "text-red-700" : "text-amber-700");
