export type Category = {
  id: string; tenant_id: string; name: string; description: string | null; position: number; active: boolean;
  available_days: number[] | null; available_from: string | null; available_to: string | null;
};
export type Product = {
  id: string; tenant_id: string; category_id: string; name: string; description: string | null;
  image_url: string | null; price_cents: number; promo_price_cents: number | null; position: number; pdv_code?: string | null;
  active: boolean; paused_until: string | null; featured: boolean; tags: string[];
  station?: string | null;
  sku: string | null; ncm: string | null; cfop: string | null; cest: string | null; csosn: string | null;
  fiscal_origin?: string | null; fiscal_unit?: string | null;
};
export type OptionGroup = {
  id: string; tenant_id: string; name: string; min_select: number; max_select: number;
  allow_repeat: boolean; price_rule: "sum" | "max" | "avg";
};
export type Option = {
  id: string; tenant_id: string; group_id: string; name: string; description: string | null;
  price_cents: number; active: boolean; position: number;
};
export type ProductGroupLink = { product_id: string; group_id: string; position: number };

export const PRICE_RULE_LABEL: Record<OptionGroup["price_rule"], string> = {
  sum: "Soma (cobra cada opção escolhida)",
  max: "Maior valor (ideal para pizza meio a meio)",
  avg: "Média dos valores escolhidos",
};

export const DAY_LABEL = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];

export const isPaused = (p: Product) => !!p.paused_until && new Date(p.paused_until).getTime() > Date.now();

/** Próximas 05:00 no horário local (fim do "dia" de operação). */
export function nextFiveAM() {
  const d = new Date();
  const t = new Date(d);
  t.setHours(5, 0, 0, 0);
  if (t.getTime() <= d.getTime()) t.setDate(t.getDate() + 1);
  return t.toISOString();
}

export type MenuData = {
  categories: Category[]; products: Product[]; groups: OptionGroup[]; options: Option[]; links: ProductGroupLink[];
};
