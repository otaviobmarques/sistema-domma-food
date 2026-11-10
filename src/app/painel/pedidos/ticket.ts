import { brl, formatPhone, PAYMENT_LABEL, TYPE_LABEL } from "@/lib/format";
import type { Order } from "./types";

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

/** Abre uma janela com o cupom de cozinha (80 mm) e dispara a impressão. */
export function printTicket(o: Order, unitName: string) {
  const w = window.open("", "_blank", "width=380,height=640");
  if (!w) { alert("Permita pop-ups para imprimir."); return; }
  const a = o.address;
  const items = o.order_items.map((i) => `
    <div class="item"><b>${i.quantity}x ${esc(i.name)}</b><span>${brl(i.total_cents)}</span></div>
    ${(i.options ?? []).map((op) => `<div class="opt">+ ${op.quantity > 1 ? op.quantity + "x " : ""}${esc(op.name)}</div>`).join("")}
    ${i.notes ? `<div class="note">OBS: ${esc(i.notes)}</div>` : ""}`).join("");
  w.document.write(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Pedido #${o.number}</title>
<style>
  @page { size: 80mm auto; margin: 3mm; }
  body { font-family: ui-monospace, Menlo, monospace; font-size: 12px; width: 74mm; margin: 0; color: #000; }
  h1 { font-size: 20px; text-align: center; margin: 4px 0; }
  .c { text-align: center; } .hr { border-top: 1px dashed #000; margin: 6px 0; }
  .item { display: flex; justify-content: space-between; gap: 6px; margin-top: 4px; }
  .opt { padding-left: 10px; } .note { padding-left: 10px; font-weight: bold; }
  .tot { display: flex; justify-content: space-between; } .big { font-size: 14px; font-weight: bold; }
</style></head><body>
  <div class="c">${esc(unitName)}</div>
  <h1>#${o.number}</h1>
  <div class="c">${esc(TYPE_LABEL[o.type] ?? o.type)} · ${new Date(o.created_at).toLocaleString("pt-BR")}</div>
  ${o.scheduled_for ? `<div class="c big">AGENDADO ${new Date(o.scheduled_for).toLocaleString("pt-BR")}</div>` : ""}
  <div class="hr"></div>
  <div><b>${esc(o.customer_name)}</b> · ${esc(formatPhone(o.customer_phone))}</div>
  ${a ? `<div>${esc(a.street)}, ${esc(a.number)}${a.complement ? " - " + esc(a.complement) : ""}</div>
         <div>${esc(a.neighborhood)}${a.reference ? " · Ref: " + esc(a.reference) : ""}</div>` : ""}
  <div class="hr"></div>${items}<div class="hr"></div>
  ${o.notes ? `<div class="note">OBS PEDIDO: ${esc(o.notes)}</div><div class="hr"></div>` : ""}
  <div class="tot"><span>Subtotal</span><span>${brl(o.subtotal_cents)}</span></div>
  ${o.delivery_fee_cents ? `<div class="tot"><span>Entrega</span><span>${brl(o.delivery_fee_cents)}</span></div>` : ""}
  ${o.discount_cents ? `<div class="tot"><span>Desconto</span><span>-${brl(o.discount_cents)}</span></div>` : ""}
  <div class="tot big"><span>TOTAL</span><span>${brl(o.total_cents)}</span></div>
  <div>Pagamento: ${esc(PAYMENT_LABEL[o.payment_method] ?? o.payment_method)} ${o.payment_status === "paid" ? "(PAGO)" : "(A RECEBER)"}</div>
  ${o.change_for_cents != null ? `<div>Troco para ${brl(o.change_for_cents)}</div>` : ""}
  <script>window.onload = () => { window.print(); setTimeout(() => window.close(), 300); };</script>
</body></html>`);
  w.document.close();
}
