"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { canManage, usePanel } from "@/lib/panel/context";
import { Alert, Empty, Field, Modal } from "@/components/ui";
import { brl, errorMessage } from "@/lib/format";
import { FISCAL_STATUS } from "@/components/fiscal/emit-button";

type Doc = {
  id: string; status: string; environment: string; created_at: string; authorized_at: string | null; total_cents: number | null;
  number: string | null; series: string | null; message: string | null; danfe_url: string | null; xml_url: string | null;
  consumer_doc: string | null; order_id: string | null; tab_id: string | null;
  orders: { number: number } | null; tabs: { label: string; dining_tables: { name: string } | null } | null;
};

const FILTERS: [string, string, string[] | null][] = [
  ["all", "Todas", null], ["authorized", "Autorizadas", ["authorized"]], ["pending", "Emitindo", ["pending", "processing"]],
  ["problem", "Com problema", ["rejected", "error"]], ["cancelled", "Canceladas", ["cancel_requested", "cancelling", "cancelled"]],
];
const when = (iso: string) => new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const CANCEL_MIN = 30;

export function Documents() {
  const { unit, role } = usePanel();
  const sb = supabaseBrowser();
  const manager = canManage(role);
  const [list, setList] = useState<Doc[]>([]);
  const [filter, setFilter] = useState("all");
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [cancel, setCancel] = useState<Doc | null>(null);
  const [reason, setReason] = useState("");
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    const { data, error } = await sb.from("fiscal_documents")
      .select("id, status, environment, created_at, authorized_at, total_cents, number, series, message, danfe_url, xml_url, consumer_doc, order_id, tab_id, orders(number), tabs(label, dining_tables(name))")
      .eq("unit_id", unit.id).order("created_at", { ascending: false }).limit(100);
    if (error) setErr(errorMessage(error)); else { setList(data as unknown as Doc[]); setNow(Date.now()); }
  }, [sb, unit.id]);

  useEffect(() => {
    load();
    const ch = sb.channel(`fiscal-${unit.id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "fiscal_documents", filter: `unit_id=eq.${unit.id}` }, () => { load(); })
      .subscribe();
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => { sb.removeChannel(ch); clearInterval(t); };
  }, [sb, unit.id, load]);

  const shown = useMemo(() => {
    const st = FILTERS.find((x) => x[0] === filter)?.[2];
    return st ? list.filter((d) => st.includes(d.status)) : list;
  }, [list, filter]);

  async function retry(d: Doc) {
    setBusy(d.id); setErr(""); setMsg("");
    const { error } = await sb.rpc("fiscal_retry", { p_doc_id: d.id });
    setBusy(null);
    if (error) setErr(errorMessage(error)); else { setMsg("Nota reenviada para emissão."); load(); }
  }

  async function doCancel(e: React.FormEvent) {
    e.preventDefault();
    if (!cancel) return;
    const r = reason.trim();
    if (r.length < 15 || r.length > 255) { setErr("A justificativa precisa ter de 15 a 255 caracteres."); return; }
    setBusy(cancel.id); setErr("");
    const { error } = await sb.rpc("fiscal_cancel", { p_doc_id: cancel.id, p_reason: r });
    setBusy(null);
    if (error) { setErr(errorMessage(error)); return; }
    setCancel(null); setReason(""); setMsg("Cancelamento enviado ao provedor."); load();
  }

  const origin = (d: Doc) => d.orders ? `Pedido #${d.orders.number}`
    : d.tabs ? (d.tabs.dining_tables ? `Mesa ${d.tabs.dining_tables.name}` : `Comanda ${d.tabs.label}`) : "—";
  const canCancel = (d: Doc) => manager && d.status === "authorized" && !!d.authorized_at
    && now - new Date(d.authorized_at).getTime() < CANCEL_MIN * 60_000;

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-semibold">Notas emitidas</h2>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-lg bg-zinc-100 p-0.5 text-xs font-medium" role="radiogroup" aria-label="Filtrar notas">
            {FILTERS.map(([k, l]) => (
              <button key={k} type="button" role="radio" aria-checked={filter === k} onClick={() => setFilter(k)}
                className={`rounded-md px-2.5 py-1 ${filter === k ? "bg-white shadow-sm" : "text-zinc-500"}`}>{l}</button>
            ))}
          </div>
          <button type="button" className="btn-ghost" onClick={load}>Atualizar</button>
        </div>
      </div>
      <Alert>{err && !cancel ? err : ""}</Alert>
      <Alert kind="success">{msg}</Alert>
      {shown.length === 0 ? <Empty>{list.length ? "Nenhuma nota neste filtro." : "Nenhuma NFC-e emitida ainda."}</Empty> : (
        <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 text-left text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
              <tr><th className="p-3">Data</th><th className="p-3">Origem</th><th className="p-3 text-right">Total</th><th className="p-3">Situação</th><th className="p-3">Nº / série</th><th className="p-3">Mensagem</th><th /></tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {shown.map((d) => {
                const st = FISCAL_STATUS[d.status] ?? { label: d.status, cls: "bg-zinc-100 text-zinc-700" };
                return (
                  <tr key={d.id} className="align-top">
                    <td className="whitespace-nowrap p-3 tabular-nums text-zinc-600">{when(d.created_at)}</td>
                    <td className="p-3">{origin(d)}{d.environment === "homologacao" && <span className="ml-1.5 badge bg-amber-50 text-amber-800">teste</span>}</td>
                    <td className="p-3 text-right tabular-nums">{d.total_cents != null ? brl(d.total_cents) : "—"}</td>
                    <td className="p-3"><span className={`badge ${st.cls}`}>{st.label}</span></td>
                    <td className="p-3 tabular-nums">{d.number ? `${d.number}${d.series ? ` / ${d.series}` : ""}` : "—"}</td>
                    <td className="max-w-xs p-3 text-xs text-zinc-600">{d.message ?? ""}</td>
                    <td className="whitespace-nowrap p-3 text-right">
                      {d.danfe_url && <a className="btn-ghost" href={d.danfe_url} target="_blank" rel="noopener noreferrer">DANFE</a>}
                      {d.xml_url && <a className="btn-ghost" href={d.xml_url} target="_blank" rel="noopener noreferrer">XML</a>}
                      {(d.status === "rejected" || d.status === "error") && (
                        <button className="btn-ghost" disabled={busy === d.id} onClick={() => retry(d)}>Reenviar</button>
                      )}
                      {canCancel(d) && <button className="btn-ghost text-red-600" onClick={() => { setErr(""); setReason(""); setCancel(d); }}>Cancelar</button>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs text-zinc-500">A NFC-e só pode ser cancelada em até {CANCEL_MIN} minutos após a autorização. Depois disso, fale com o seu contador.</p>

      <Modal open={!!cancel} onClose={() => setCancel(null)} title={`Cancelar NFC-e${cancel?.number ? ` nº ${cancel.number}` : ""}`}>
        <form onSubmit={doCancel} className="space-y-3">
          <p className="text-sm text-zinc-600">O cancelamento é enviado à SEFAZ pelo provedor e não pode ser desfeito. O pedido continua registrado no sistema.</p>
          <Field label="Justificativa" hint={`${reason.trim().length}/255 · mínimo de 15 caracteres`}>
            <textarea className="input" rows={3} maxLength={255} autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ex.: venda cancelada a pedido do cliente" />
          </Field>
          <Alert>{err}</Alert>
          <div className="flex gap-2">
            <button type="button" className="btn-ghost" onClick={() => setCancel(null)}>Voltar</button>
            <button className="btn-danger flex-1" disabled={busy === cancel?.id || reason.trim().length < 15}>Confirmar cancelamento</button>
          </div>
        </form>
      </Modal>
    </section>
  );
}
