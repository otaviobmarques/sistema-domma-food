import { brl } from "@/lib/format";
import { liveOrders, tabSubtotal, type Tab } from "./types";

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

/** Pré-conta em 80 mm: itens, subtotal, taxa de serviço, total e divisão por pessoa. */
export function printPreBill(tab: Tab, title: string, unitName: string, split: number) {
  const w = window.open("", "_blank", "width=380,height=640");
  if (!w) { alert("Permita pop-ups para imprimir."); return; }
  const sub = tabSubtotal(tab);
  const fee = Math.round((sub * Number(tab.service_fee_pct)) / 100);
  const total = sub + fee;
  const n = Math.max(1, split);
  const items = liveOrders(tab).flatMap((o) => o.order_items).map((i) => `
    <div class="item"><span>${i.quantity}x ${esc(i.name)}</span><span>${brl(i.total_cents)}</span></div>
    ${(i.options ?? []).map((op) => `<div class="opt">+ ${(op.quantity ?? 1) > 1 ? op.quantity + "x " : ""}${esc(op.name)}</div>`).join("")}`).join("");
  w.document.write(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Pré-conta ${esc(title)}</title>
<style>
  @page { size: 80mm auto; margin: 3mm; }
  body { font-family: ui-monospace, Menlo, monospace; font-size: 12px; width: 74mm; margin: 0; color: #000; }
  h1 { font-size: 18px; text-align: center; margin: 4px 0; }
  .c { text-align: center; } .hr { border-top: 1px dashed #000; margin: 6px 0; }
  .item, .tot { display: flex; justify-content: space-between; gap: 6px; margin-top: 3px; }
  .opt { padding-left: 10px; } .big { font-size: 15px; font-weight: bold; }
</style></head><body>
  <div class="c"><b>${esc(unitName)}</b></div>
  <h1>${esc(title)}</h1>
  <div class="c">PRÉ-CONTA · ${new Date().toLocaleString("pt-BR")}</div>
  ${tab.customer_name ? `<div class="c">${esc(tab.customer_name)}</div>` : ""}
  <div class="hr"></div>${items}<div class="hr"></div>
  <div class="tot"><span>Subtotal</span><span>${brl(sub)}</span></div>
  <div class="tot"><span>Taxa de serviço (${Number(tab.service_fee_pct)}%) opcional</span><span>${brl(fee)}</span></div>
  <div class="tot big"><span>TOTAL</span><span>${brl(total)}</span></div>
  ${n > 1 ? `<div class="tot"><span>Por pessoa (${n})</span><span>${brl(Math.ceil(total / n))}</span></div>` : ""}
  <div class="hr"></div>
  <div class="c">Não é documento fiscal</div>
  <script>window.onload = function () { window.print(); };</script>
</body></html>`);
  w.document.close();
}
