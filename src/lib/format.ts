export const brl = (cents: number | null | undefined) =>
  ((cents ?? 0) / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

/** "29,90" | "29.90" | "29" -> 2990 */
export function parseBRL(value: string): number {
  const clean = value.replace(/[^\d,.-]/g, "").replace(/\.(?=\d{3}(\D|$))/g, "").replace(",", ".");
  const n = Number.parseFloat(clean);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

export const centsToInput = (cents: number | null | undefined) =>
  cents == null ? "" : (cents / 100).toFixed(2).replace(".", ",");

export const onlyDigits = (s: string) => s.replace(/\D/g, "");

export function formatPhone(s: string) {
  const d = onlyDigits(s).slice(0, 11);
  if (d.length <= 2) return d;
  if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
  if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
}

export const slugify = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50);

export const STATUS_LABEL: Record<string, string> = {
  awaiting_payment: "Aguardando Pix",
  pending: "Aguardando aceite",
  preparing: "Em preparo",
  ready: "Pronto",
  dispatched: "Saiu para entrega",
  awaiting_pickup: "Pronto para retirada",
  completed: "Concluído",
  cancelled: "Cancelado",
};

export const PAYMENT_LABEL: Record<string, string> = {
  pix: "Pix",
  cash: "Dinheiro",
  card_on_delivery: "Cartão na entrega",
  voucher: "Vale-refeição",
  online_card: "Cartão online",
  credit_card: "Crédito",
  debit_card: "Débito",
  credit_account: "Fiado",
};

export const TYPE_LABEL: Record<string, string> = {
  delivery: "Entrega",
  pickup: "Retirada",
  dine_in: "Salão",
};

export const timeHM = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) : "";

export function errorMessage(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) return String((e as { message: string }).message);
  return "Algo deu errado. Tente novamente.";
}

export const ROLE_LABEL: Record<string, string> = {
  owner: "Dono", manager: "Gerente", cashier: "Caixa", attendant: "Atendente",
  kitchen: "Cozinha", waiter: "Garçom", courier: "Entregador",
};
