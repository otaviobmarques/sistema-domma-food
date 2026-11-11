export type StockItem = {
  id: string; tenant_id: string; unit_id: string; name: string; unit: string;
  qty: number; min_qty: number; cost_cents: number; active: boolean;
};

export const UNITS = ["un", "kg", "g", "l", "ml", "cx", "pct"] as const;
export const UNIT_LABEL: Record<string, string> = {
  un: "unidade", kg: "quilo", g: "grama", l: "litro", ml: "mililitro", cx: "caixa", pct: "pacote",
};

export const MOVE_LABEL: Record<string, string> = {
  purchase: "Entrada", adjust: "Contagem", loss: "Perda", sale: "Venda", sale_reversal: "Estorno",
};

/** Aceita "1,5", "1.5", "1.234,5". */
export function parseQty(v: string): number {
  const s = v.trim();
  if (!s) return NaN;
  const norm = s.includes(",") ? s.replace(/\./g, "").replace(",", ".") : s;
  return Number(norm);
}

export const fmtQty = (n: number) =>
  Number(n).toLocaleString("pt-BR", { maximumFractionDigits: 3 });

export const toNum = (v: unknown) => Number(v ?? 0);

export function normalize(row: StockItem): StockItem {
  return { ...row, qty: toNum(row.qty), min_qty: toNum(row.min_qty), cost_cents: toNum(row.cost_cents) };
}
