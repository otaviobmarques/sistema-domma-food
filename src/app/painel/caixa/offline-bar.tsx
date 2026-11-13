"use client";
import { useState } from "react";
import { brl, timeHM } from "@/lib/format";
import type { PosQueue } from "@/lib/offline/pos-queue";
import { printReceipt, type Receipt } from "./receipt";

/** Aviso de conexão do caixa e fila de vendas feitas sem internet. */
export function OfflineBar({ queue, canDiscard, cachedAt, netDown = false }: { queue: PosQueue; canDiscard: boolean; cachedAt?: string | null; netDown?: boolean }) {
  const [open, setOpen] = useState(false);
  const { pending, synced, busy } = queue;
  const online = queue.online && !netDown;
  const failed = pending.filter((s) => s.error);
  const recent = synced.filter((s) => Date.now() - new Date(s.at).getTime() < 15 * 60_000);
  if (online && !pending.length && !recent.length) return null;

  return (
    <section className={`rounded-xl px-4 py-3 text-sm ring-1 ${online ? (failed.length ? "bg-red-50 text-red-900 ring-red-200" : "bg-sky-50 text-sky-900 ring-sky-200") : "bg-amber-50 text-amber-900 ring-amber-200"}`}
      role="status" aria-live="polite">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          {!online ? (
            <p><b>Sem internet.</b> O caixa continua vendendo: as vendas ficam guardadas neste aparelho e entram no sistema quando a conexão voltar.
              Imprima o cupom para a cozinha. Fiado, sangria, suprimento e fechamento esperam a conexão.</p>
          ) : pending.length ? (
            <p><b>{pending.length === 1 ? "1 venda feita sem internet" : `${pending.length} vendas feitas sem internet`}</b> {busy ? "sendo enviadas..." : "aguardando envio."}
              {failed.length > 0 && <> {failed.length === 1 ? "1 precisa de atenção." : `${failed.length} precisam de atenção.`}</>}</p>
          ) : (
            <p>Conexão de volta. {recent.length === 1 ? "1 venda feita sem internet foi enviada." : `${recent.length} vendas feitas sem internet foram enviadas.`}</p>
          )}
          {!online && cachedAt && <p className="mt-0.5 text-xs opacity-80">Cardápio e caixa da última atualização ({new Date(cachedAt).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}).</p>}
        </div>
        <div className="flex gap-2">
          {(pending.length > 0 || recent.length > 0) && (
            <button type="button" className="btn-ghost px-2 py-1 text-xs" onClick={() => setOpen((v) => !v)} aria-expanded={open}>{open ? "Ocultar" : "Ver vendas"}</button>
          )}
          {pending.length > 0 && (
            <button type="button" className="btn-secondary px-3 py-1 text-xs" disabled={busy} onClick={() => void queue.sync()}>{busy ? "Enviando..." : "Enviar agora"}</button>
          )}
        </div>
      </div>
      {open && (
        <ul className="mt-2 divide-y divide-black/5 rounded-lg bg-white/70 text-zinc-800">
          {pending.map((s) => (
            <li key={s.ref} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
              <span>
                <b>Venda {s.code}</b> · {timeHM(s.sold_at)} · {brl(s.total_cents)}{s.customer ? ` · ${s.customer}` : ""}
                {s.error ? <span className="block text-xs text-red-700">Não enviada: {s.error}</span> : <span className="block text-xs text-zinc-500">Aguardando envio</span>}
              </span>
              <span className="flex gap-1">
                <button type="button" className="btn-ghost px-2 py-1 text-xs" onClick={() => printReceipt(s.receipt as Receipt)}>Reimprimir</button>
                {s.error && canDiscard && (
                  <button type="button" className="btn-ghost px-2 py-1 text-xs text-red-700"
                    onClick={() => { if (confirm(`Descartar a venda ${s.code} (${brl(s.total_cents)})? Ela não entrará no caixa nem nos relatórios. Lance de novo pelo PDV se o dinheiro foi recebido.`)) queue.discard(s.ref); }}>
                    Descartar</button>
                )}
              </span>
            </li>
          ))}
          {recent.map((s) => (
            <li key={s.ref} className="px-3 py-2 text-zinc-600">Venda {s.code} → <b className="text-zinc-900">Pedido #{s.number}</b></li>
          ))}
        </ul>
      )}
    </section>
  );
}
