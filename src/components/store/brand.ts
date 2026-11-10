export const BRAND_RED = "#d9262b";
const LEGACY_DEFAULT = "#6d28d9";

/** Cor da loja; o antigo padrão roxo (ou vazio) vira o vermelho Domma. */
export function storeColor(c: string | null | undefined): string {
  if (!c || c.toLowerCase() === LEGACY_DEFAULT) return BRAND_RED;
  return c;
}
