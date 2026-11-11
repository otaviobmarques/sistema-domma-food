import type { PosLine } from "@/components/pos/product-picker";

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const money = (c: number) => (c / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

export type Receipt = {
  store: string; number: number; lines: PosLine[]; subtotal: number; discount: number; total: number;
  payments: { label: string; amount: number }[]; change: number; customer?: string; type: string; notes?: string;
};

/** Cupom simples de 80 mm (não fiscal). */
export function printReceipt(r: Receipt) {
  const w = window.open("", "_blank", "width=380,height=640");
  if (!w) return;
  const items = r.lines.map((l) => `
    <tr><td>${l.quantity}x ${esc(l.name)}</td><td class="r">${money(l.unit_price_cents * l.quantity)}</td></tr>
    ${l.options.map((o) => `<tr class="s"><td colspan="2">+ ${o.quantity > 1 ? o.quantity + "x " : ""}${esc(o.name)}</td></tr>`).join("")}
    ${l.notes ? `<tr class="s"><td colspan="2"><b>Obs.: ${esc(l.notes)}</b></td></tr>` : ""}`).join("");
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Pedido #${r.number}</title><style>
    @page{size:80mm auto;margin:4mm} body{font:13px/1.35 monospace;width:72mm;margin:0;color:#000}
    h1{font-size:16px;text-align:center;margin:0} .c{text-align:center} .r{text-align:right;white-space:nowrap}
    table{width:100%;border-collapse:collapse} td{vertical-align:top;padding:1px 0} .s td{font-size:12px;padding-left:10px}
    hr{border:0;border-top:1px dashed #000;margin:6px 0} .big{font-size:20px;font-weight:bold}
  </style></head><body>
    <h1>${esc(r.store)}</h1><p class="c">${new Date().toLocaleString("pt-BR")}</p>
    <p class="c big">PEDIDO #${r.number}</p><p class="c">${esc(r.type)}${r.customer ? " · " + esc(r.customer) : ""}</p><hr>
    <table>${items}</table><hr>
    <table><tr><td>Subtotal</td><td class="r">${money(r.subtotal)}</td></tr>
    ${r.discount ? `<tr><td>Desconto</td><td class="r">- ${money(r.discount)}</td></tr>` : ""}
    <tr><td><b>TOTAL</b></td><td class="r"><b>${money(r.total)}</b></td></tr>
    ${r.payments.map((p) => `<tr><td>${esc(p.label)}</td><td class="r">${money(p.amount)}</td></tr>`).join("")}
    ${r.change ? `<tr><td>Troco</td><td class="r">${money(r.change)}</td></tr>` : ""}</table>
    ${r.notes ? `<hr><p><b>Obs.: ${esc(r.notes)}</b></p>` : ""}
    <hr><p class="c">Não é documento fiscal</p>
    <script>window.onload=function(){window.print();setTimeout(function(){window.close()},300)}</script>
  </body></html>`);
  w.document.close();
}
