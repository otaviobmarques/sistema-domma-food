"use client";
import { JOB_KIND, JOB_STATUS, type Job, type Printer } from "./shared";

export function Jobs({ jobs, printers }: { jobs: Job[]; printers: Printer[] }) {
  const pname = (id: string) => printers.find((p) => p.id === id)?.name ?? "—";
  return (
    <section className="space-y-3">
      <h2 className="font-semibold">Fila recente</h2>
      {jobs.length === 0 ? (
        <p className="rounded-lg border border-dashed border-zinc-300 p-4 text-center text-sm text-zinc-500">Nada impresso ainda. Use &quot;Imprimir teste&quot; numa impressora.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 text-left text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
              <tr><th className="p-3">Horário</th><th className="p-3">Impressora</th><th className="p-3">Tipo</th><th className="p-3">Pedido</th><th className="p-3">Situação</th></tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {jobs.map((j) => (
                <tr key={j.id}>
                  <td className="whitespace-nowrap p-3 tabular-nums text-zinc-600">{new Date(j.created_at).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })}</td>
                  <td className="p-3">{pname(j.printer_id)}</td>
                  <td className="p-3">{JOB_KIND[j.kind]}{j.station ? ` · ${j.station}` : ""}</td>
                  <td className="p-3">{j.orders ? `#${j.orders.number}` : "—"}</td>
                  <td className="p-3">
                    <span className={`badge ${JOB_STATUS[j.status].cls}`}>{JOB_STATUS[j.status].label}</span>
                    {j.error && <span className="block text-xs text-red-700">{j.error}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
