export type Printer = {
  id: string; name: string; connection: "network" | "system" | "browser"; address: string | null; paper_width: 58 | 80;
  stations: string[]; print_receipt: boolean; copies: number; on_event: "accepted" | "created"; active: boolean;
};
export type Agent = { id: string; name: string; last_seen_at: string | null; last_seen_info: string | null; active: boolean; created_at: string };
export type Job = {
  id: number; kind: "kitchen" | "receipt" | "test"; station: string | null; status: "queued" | "printing" | "done" | "failed";
  error: string | null; created_at: string; printed_at: string | null; printer_id: string; orders: { number: number } | null;
};

export const CONNECTION_LABEL: Record<Printer["connection"], string> = {
  network: "Impressora de rede (IP)", system: "Impressora do computador", browser: "Navegador (estação de impressão)",
};
export const JOB_KIND: Record<Job["kind"], string> = { kitchen: "Comanda", receipt: "Via do pedido", test: "Teste" };
export const JOB_STATUS: Record<Job["status"], { label: string; cls: string }> = {
  queued: { label: "Na fila", cls: "bg-zinc-100 text-zinc-700" },
  printing: { label: "Imprimindo", cls: "bg-amber-100 text-amber-800" },
  done: { label: "Impresso", cls: "bg-green-100 text-green-800" },
  failed: { label: "Falhou", cls: "bg-red-100 text-red-800" },
};

export function ago(iso: string | null): string {
  if (!iso) return "nunca";
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 86400)} dia(s)`;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Converte o texto do cupom (com marcadores) em HTML para impressora térmica. */
export function ticketHtml(content: string, paperWidth: number): string {
  const w = paperWidth === 58 ? 48 : 72;
  const body = content.split("\n").map((line) => {
    if (line.startsWith("==")) return "";
    if (line.startsWith("--")) return '<div class="hr"></div>';
    if (line.startsWith("##")) return `<div class="big">${esc(line.slice(2))}</div>`;
    if (line.startsWith("**")) return `<div class="b">${esc(line.slice(2)) || "&nbsp;"}</div>`;
    return `<div>${esc(line) || "&nbsp;"}</div>`;
  }).join("");
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><style>
    @page { size: ${paperWidth}mm auto; margin: 0 }
    html, body { margin: 0; padding: 0 }
    body { width: ${w}mm; padding: 2mm ${(paperWidth - w) / 2}mm; font: ${paperWidth === 58 ? 11 : 12}px/1.3 "Courier New", ui-monospace, monospace; color: #000 }
    div { white-space: pre-wrap; word-break: break-word }
    .b { font-weight: 700 }
    .big { font-weight: 800; font-size: 1.5em; text-align: center; margin: 1mm 0 }
    .hr { border-top: 1px dashed #000; margin: 1.5mm 0 }
  </style></head><body>${body}</body></html>`;
}
