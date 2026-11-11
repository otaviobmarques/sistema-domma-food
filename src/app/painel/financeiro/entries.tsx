"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { usePanel } from "@/lib/panel/context";
import { Alert, Empty, Field, Modal } from "@/components/ui";
import { brl, centsToInput, errorMessage, parseBRL } from "@/lib/format";
import { addMonths, fmtDate, PAID_METHOD, PAYABLE_CATEGORIES, RECEIVABLE_CATEGORIES, ymd, type FinEntry } from "./shared";

type Kind = FinEntry["kind"];
type Filter = "open" | "paid" | "all";
type Form = {
  kind: Kind; description: string; category: string; party: string; amount: string; due: string;
  paid: boolean; method: string; notes: string; repeat: string;
};

const blank = (kind: Kind): Form => ({
  kind, description: "", category: kind === "payable" ? "Fornecedores" : "Outros", party: "", amount: "",
  due: ymd(new Date()), paid: false, method: "pix", notes: "", repeat: "1",
});

export function Entries({ allUnits, today, onChanged }: { allUnits: boolean; today: string; onChanged: () => void }) {
  const { tenantId, unit } = usePanel();
  const sb = supabaseBrowser();
  const [kind, setKind] = useState<Kind>("payable");
  const [filter, setFilter] = useState<Filter>("open");
  const [list, setList] = useState<FinEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [edit, setEdit] = useState<{ id?: string; f: Form } | null>(null);
  const [paying, setPaying] = useState<FinEntry | null>(null);
  const [payMethod, setPayMethod] = useState("pix");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    let q = sb.from("fin_entries").select("*").eq("tenant_id", tenantId).eq("kind", kind);
    if (!allUnits) q = q.or(`unit_id.eq.${unit.id},unit_id.is.null`);
    if (filter === "open") q = q.is("paid_at", null);
    if (filter === "paid") q = q.not("paid_at", "is", null);
    const { data, error } = await q.order("due_date", { ascending: filter !== "paid" }).limit(500);
    setLoading(false);
    if (error) setErr(errorMessage(error)); else setList(data as FinEntry[]);
  }, [sb, tenantId, kind, filter, allUnits, unit.id]);
  useEffect(() => { load(); }, [load]);

  const refresh = useCallback(() => { load(); onChanged(); }, [load, onChanged]);
  const total = useMemo(() => list.reduce((s, e) => s + e.amount_cents, 0), [list]);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setEdit((s) => s && { ...s, f: { ...s.f, [k]: v } });

  async function save(ev: React.FormEvent) {
    ev.preventDefault();
    if (!edit) return;
    const f = edit.f;
    const amount = parseBRL(f.amount);
    if (amount <= 0) { setErr("Informe um valor maior que zero."); return; }
    setBusy(true); setErr("");
    const base = {
      tenant_id: tenantId, kind: f.kind, description: f.description.trim(), category: f.category.trim() || "Outros",
      party: f.party.trim() || null, amount_cents: amount, notes: f.notes.trim() || null,
    };
    let error;
    if (edit.id) {
      ({ error } = await sb.from("fin_entries").update({ ...base, due_date: f.due }).eq("id", edit.id));
    } else {
      const n = Math.min(12, Math.max(1, Number(f.repeat) || 1));
      const rows = Array.from({ length: n }, (_, i) => ({
        ...base, unit_id: allUnits ? null : unit.id, due_date: addMonths(f.due, i),
        description: n > 1 ? `${base.description} (${i + 1}/${n})`.slice(0, 160) : base.description,
        paid_at: f.paid && i === 0 ? new Date().toISOString() : null, paid_method: f.paid && i === 0 ? f.method : null,
      }));
      ({ error } = await sb.from("fin_entries").insert(rows));
    }
    setBusy(false);
    if (error) { setErr(errorMessage(error)); return; }
    setEdit(null); refresh();
  }

  async function markPaid() {
    if (!paying) return;
    setBusy(true);
    const { error } = await sb.from("fin_entries").update({ paid_at: new Date().toISOString(), paid_method: payMethod }).eq("id", paying.id);
    setBusy(false);
    if (error) { setErr(errorMessage(error)); return; }
    setPaying(null); refresh();
  }

  async function undo(e: FinEntry) {
    if (!confirm(`Desfazer o pagamento de "${e.description}"?`)) return;
    const { error } = await sb.from("fin_entries").update({ paid_at: null, paid_method: null }).eq("id", e.id);
    if (error) setErr(errorMessage(error)); else refresh();
  }

  async function remove(e: FinEntry) {
    if (!confirm(`Excluir "${e.description}" (${brl(e.amount_cents)})?`)) return;
    const { error } = await sb.from("fin_entries").delete().eq("id", e.id);
    if (error) setErr(errorMessage(error)); else refresh();
  }

  function exportCsv() {
    const num = (c: number) => (c / 100).toFixed(2).replace(".", ",");
    const esc = (s: string | null) => `"${(s ?? "").replace(/"/g, '""')}"`;
    const head = ["Tipo", "Vencimento", "Descrição", "Categoria", kind === "payable" ? "Fornecedor" : "Cliente", "Valor", "Status", "Pago em", "Forma", "Observações"];
    const rows = list.map((e) => [
      e.kind === "payable" ? "A pagar" : "A receber", fmtDate(e.due_date), esc(e.description), esc(e.category), esc(e.party),
      num(e.amount_cents), e.paid_at ? "Pago" : e.due_date < today ? "Vencida" : "Em aberto",
      e.paid_at ? fmtDate(e.paid_at) : "", e.paid_method ? PAID_METHOD[e.paid_method] ?? e.paid_method : "", esc(e.notes),
    ].join(";"));
    const blob = new Blob(["﻿" + [head.join(";"), ...rows].join("\r\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `contas-${kind === "payable" ? "a-pagar" : "a-receber"}-${today}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const cats = (edit?.f.kind ?? kind) === "payable" ? PAYABLE_CATEGORIES : RECEIVABLE_CATEGORIES;

  return (
    <section className="space-y-3" aria-label="Contas">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-lg bg-zinc-100 p-0.5 text-sm font-medium" role="tablist">
            {([["payable", "A pagar"], ["receivable", "A receber"]] as const).map(([k, l]) => (
              <button key={k} role="tab" aria-selected={kind === k} onClick={() => setKind(k)}
                className={`rounded-md px-3 py-1.5 ${kind === k ? "bg-white text-zinc-900 shadow-sm" : "text-zinc-500"}`}>{l}</button>
            ))}
          </div>
          <select className="input w-auto" value={filter} onChange={(e) => setFilter(e.target.value as Filter)} aria-label="Filtro">
            <option value="open">Em aberto</option>
            <option value="paid">Pagas</option>
            <option value="all">Todas</option>
          </select>
        </div>
        <div className="flex gap-2">
          <button className="btn-secondary" onClick={exportCsv} disabled={!list.length}>Exportar CSV</button>
          <button className="btn-primary" onClick={() => { setErr(""); setEdit({ f: blank(kind) }); }}>
            + {kind === "payable" ? "Nova conta a pagar" : "Nova conta a receber"}
          </button>
        </div>
      </div>
      <Alert>{err && !edit && !paying ? err : ""}</Alert>

      {loading ? <p className="py-8 text-center text-sm text-zinc-500">Carregando...</p> : list.length === 0 ? (
        <Empty>{filter === "open" ? `Nenhuma conta ${kind === "payable" ? "a pagar" : "a receber"} em aberto.` : "Nenhuma conta encontrada."}</Empty>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50/80 text-left text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
              <tr>
                <th className="p-3">Vencimento</th><th className="p-3">Descrição</th><th className="p-3">Categoria</th>
                <th className="p-3">{kind === "payable" ? "Fornecedor" : "Cliente"}</th><th className="p-3 text-right">Valor</th>
                <th className="p-3">Status</th><th />
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {list.map((e) => {
                const overdue = !e.paid_at && e.due_date < today;
                return (
                  <tr key={e.id}>
                    <td className="whitespace-nowrap p-3 tabular-nums">{fmtDate(e.due_date)}</td>
                    <td className="p-3"><span className="font-medium">{e.description}</span>{e.notes && <span className="block text-xs text-zinc-500">{e.notes}</span>}</td>
                    <td className="p-3 text-zinc-600">{e.category}</td>
                    <td className="p-3 text-zinc-600">{e.party ?? "—"}</td>
                    <td className="whitespace-nowrap p-3 text-right font-semibold tabular-nums">{brl(e.amount_cents)}</td>
                    <td className="whitespace-nowrap p-3">
                      {e.paid_at ? (
                        <span className="badge bg-green-100 text-green-800">{kind === "payable" ? "Paga" : "Recebida"} {fmtDate(e.paid_at)}{e.paid_method ? ` · ${PAID_METHOD[e.paid_method] ?? e.paid_method}` : ""}</span>
                      ) : overdue ? <span className="badge bg-red-100 text-red-800">Vencida</span>
                        : e.due_date === today ? <span className="badge bg-amber-100 text-amber-800">Vence hoje</span>
                        : <span className="badge bg-zinc-100 text-zinc-700">Em aberto</span>}
                    </td>
                    <td className="whitespace-nowrap p-3 text-right">
                      {e.paid_at
                        ? <button className="btn-ghost" onClick={() => undo(e)}>Desfazer</button>
                        : <button className="btn-ghost text-green-700" onClick={() => { setErr(""); setPayMethod("pix"); setPaying(e); }}>{kind === "payable" ? "Marcar como paga" : "Marcar como recebida"}</button>}
                      <button className="btn-ghost" onClick={() => { setErr(""); setEdit({ id: e.id, f: {
                        kind: e.kind, description: e.description, category: e.category, party: e.party ?? "", amount: centsToInput(e.amount_cents),
                        due: e.due_date, paid: !!e.paid_at, method: e.paid_method ?? "pix", notes: e.notes ?? "", repeat: "1" } }); }}>Editar</button>
                      <button className="btn-ghost text-red-600" onClick={() => remove(e)}>Excluir</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot className="border-t border-zinc-200 bg-zinc-50/60 text-sm">
              <tr><td className="p-3 font-medium" colSpan={4}>{list.length} conta(s)</td><td className="p-3 text-right font-semibold tabular-nums">{brl(total)}</td><td colSpan={2} /></tr>
            </tfoot>
          </table>
        </div>
      )}

      <Modal open={!!edit} onClose={() => { setEdit(null); setErr(""); }} title={edit?.id ? "Editar conta" : "Nova conta"}>
        {edit && (
          <form onSubmit={save} className="space-y-3">
            {!edit.id && (
              <div className="flex rounded-lg bg-zinc-100 p-0.5 text-sm font-medium" role="radiogroup" aria-label="Tipo">
                {([["payable", "A pagar"], ["receivable", "A receber"]] as const).map(([k, l]) => (
                  <button key={k} type="button" role="radio" aria-checked={edit.f.kind === k}
                    onClick={() => setEdit((s) => s && { ...s, f: { ...s.f, kind: k, category: k === "payable" ? "Fornecedores" : "Outros" } })}
                    className={`flex-1 rounded-md px-3 py-1.5 ${edit.f.kind === k ? "bg-white shadow-sm" : "text-zinc-500"}`}>{l}</button>
                ))}
              </div>
            )}
            <Field label="Descrição"><input className="input" required maxLength={150} value={edit.f.description} onChange={(e) => set("description", e.target.value)} placeholder={edit.f.kind === "payable" ? "Ex.: Aluguel da loja" : "Ex.: Evento corporativo"} /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Categoria">
                <input className="input" list="fin-cats" required maxLength={60} value={edit.f.category} onChange={(e) => set("category", e.target.value)} />
                <datalist id="fin-cats">{cats.map((c) => <option key={c} value={c} />)}</datalist>
              </Field>
              <Field label={edit.f.kind === "payable" ? "Fornecedor" : "Cliente"}><input className="input" maxLength={120} value={edit.f.party} onChange={(e) => set("party", e.target.value)} /></Field>
              <Field label="Valor (R$)"><input className="input" required inputMode="decimal" value={edit.f.amount} onChange={(e) => set("amount", e.target.value)} placeholder="0,00" /></Field>
              <Field label="Vencimento"><input className="input" type="date" required value={edit.f.due} onChange={(e) => set("due", e.target.value)} /></Field>
            </div>
            {!edit.id && (
              <>
                <Field label="Repetir mensalmente" hint="Cria uma conta por mês, com o mesmo dia de vencimento.">
                  <select className="input" value={edit.f.repeat} onChange={(e) => set("repeat", e.target.value)}>
                    {Array.from({ length: 12 }, (_, i) => <option key={i + 1} value={i + 1}>{i === 0 ? "Não repetir" : `${i + 1} meses`}</option>)}
                  </select>
                </Field>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={edit.f.paid} onChange={(e) => set("paid", e.target.checked)} />
                  {edit.f.kind === "payable" ? "Já está paga" : "Já foi recebida"}{Number(edit.f.repeat) > 1 ? " (só a primeira)" : ""}
                </label>
                {edit.f.paid && (
                  <Field label="Forma">
                    <select className="input" value={edit.f.method} onChange={(e) => set("method", e.target.value)}>
                      {Object.entries(PAID_METHOD).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                    </select>
                  </Field>
                )}
              </>
            )}
            <Field label="Observações"><textarea className="input" rows={2} maxLength={500} value={edit.f.notes} onChange={(e) => set("notes", e.target.value)} /></Field>
            <Alert>{err}</Alert>
            <button className="btn-primary w-full" disabled={busy}>{busy ? "Salvando..." : "Salvar"}</button>
          </form>
        )}
      </Modal>

      <Modal open={!!paying} onClose={() => setPaying(null)} title={paying?.kind === "receivable" ? "Registrar recebimento" : "Registrar pagamento"}>
        {paying && (
          <div className="space-y-3">
            <p className="text-sm text-zinc-600"><b className="text-zinc-900">{paying.description}</b> · {brl(paying.amount_cents)} · vence {fmtDate(paying.due_date)}</p>
            <Field label="Forma">
              <div className="grid grid-cols-3 gap-2">
                {Object.entries(PAID_METHOD).map(([k, l]) => (
                  <button key={k} type="button" onClick={() => setPayMethod(k)} aria-pressed={payMethod === k}
                    className={`rounded-lg border px-2 py-2 text-sm font-medium ${payMethod === k ? "border-brand-500 bg-brand-50 text-brand-700" : "border-zinc-300 bg-white text-zinc-700"}`}>{l}</button>
                ))}
              </div>
            </Field>
            <p className="text-xs text-zinc-500">A data registrada é hoje. Lançamentos manuais não movimentam o caixa do PDV.</p>
            <Alert>{err}</Alert>
            <button className="btn-success w-full" disabled={busy} onClick={markPaid}>{busy ? "Salvando..." : "Confirmar"}</button>
          </div>
        )}
      </Modal>
    </section>
  );
}
