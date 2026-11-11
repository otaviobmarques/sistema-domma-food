"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { usePanel } from "@/lib/panel/context";
import { Alert, Empty, Field, Modal, Toggle } from "@/components/ui";
import { brl, errorMessage, parseBRL } from "@/lib/format";
import { fmtQty, normalize, parseQty, UNIT_LABEL, UNITS, type StockItem } from "./shared";

type MoveKind = "purchase" | "loss" | "adjust";
const MOVE_TITLE: Record<MoveKind, string> = { purchase: "Entrada de mercadoria", loss: "Registrar perda", adjust: "Contagem de estoque" };

const blank = { name: "", unit: "un", min: "" };

function status(i: StockItem) {
  if (i.qty < 0) return <span className="badge bg-red-100 text-red-800">Negativo</span>;
  if (i.qty === 0) return <span className="badge bg-zinc-200 text-zinc-700">Zerado</span>;
  if (i.qty < i.min_qty) return <span className="badge bg-red-100 text-red-800">Abaixo do mínimo</span>;
  return <span className="badge bg-green-100 text-green-800">OK</span>;
}

export function Items() {
  const { tenantId, unit } = usePanel();
  const sb = supabaseBrowser();
  const [list, setList] = useState<StockItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [q, setQ] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [edit, setEdit] = useState<{ id?: string; active?: boolean; f: typeof blank } | null>(null);
  const [move, setMove] = useState<{ item: StockItem; kind: MoveKind } | null>(null);
  const [mf, setMf] = useState({ qty: "", total: "", note: "", expense: true });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const { data, error } = await sb.from("stock_items").select("*").eq("unit_id", unit.id).order("name");
    if (error) setErr(errorMessage(error)); else setList((data as StockItem[]).map(normalize));
    setLoaded(true);
  }, [sb, unit.id]);
  useEffect(() => { load(); }, [load]);

  const visible = useMemo(() => {
    const s = q.trim().toLowerCase();
    return list.filter((i) => (showInactive || i.active) && (!s || i.name.toLowerCase().includes(s)));
  }, [list, q, showInactive]);

  const active = list.filter((i) => i.active);
  const totalValue = active.reduce((s, i) => s + Math.max(0, i.qty) * i.cost_cents, 0);
  const below = active.filter((i) => i.qty < i.min_qty).length;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!edit) return;
    const min = edit.f.min.trim() ? parseQty(edit.f.min) : 0;
    if (!Number.isFinite(min) || min < 0) { setErr("Estoque mínimo inválido."); return; }
    setBusy(true); setErr("");
    const row = { name: edit.f.name.trim(), unit: edit.f.unit, min_qty: min };
    const { error } = edit.id
      ? await sb.from("stock_items").update(row).eq("id", edit.id)
      : await sb.from("stock_items").insert({ ...row, tenant_id: tenantId, unit_id: unit.id });
    setBusy(false);
    if (error) { setErr(error.code === "23505" ? "Já existe um insumo com esse nome nesta loja." : errorMessage(error)); return; }
    setEdit(null); setMsg(edit.id ? "Insumo atualizado." : "Insumo cadastrado."); load();
  }

  function openMove(item: StockItem, kind: MoveKind) {
    setErr(""); setMsg("");
    setMf({ qty: kind === "adjust" ? fmtQty(item.qty) : "", total: "", note: "", expense: true });
    setMove({ item, kind });
  }

  async function submitMove(e: React.FormEvent) {
    e.preventDefault();
    if (!move) return;
    const qty = parseQty(mf.qty);
    if (!Number.isFinite(qty) || qty < 0) { setErr("Quantidade inválida."); return; }
    if (move.kind !== "adjust" && qty === 0) { setErr("Informe a quantidade."); return; }
    if (move.kind === "loss" && !mf.note.trim()) { setErr("Informe o motivo da perda."); return; }
    const total = move.kind === "purchase" && mf.total.trim() ? parseBRL(mf.total) : null;
    setBusy(true); setErr("");
    const { error } = await sb.rpc("stock_move", {
      p_item_id: move.item.id, p_kind: move.kind, p_qty: qty, p_total_cost_cents: total,
      p_note: mf.note.trim() || null, p_expense: move.kind === "purchase" && !!total && mf.expense,
    });
    setBusy(false);
    if (error) { setErr(errorMessage(error)); return; }
    setMsg(`${MOVE_TITLE[move.kind]} registrada: ${move.item.name}.`);
    setMove(null); load();
  }

  async function remove(i: StockItem) {
    const { count } = await sb.from("stock_moves").select("id", { count: "exact", head: true }).eq("item_id", i.id);
    if ((count ?? 0) > 0) { setErr(`${i.name} já tem movimentações. Desative o insumo em vez de excluir, para manter o histórico e o CMV.`); return; }
    if (!confirm(`Excluir o insumo ${i.name}?`)) return;
    const { error } = await sb.from("stock_items").delete().eq("id", i.id);
    if (error) setErr(errorMessage(error)); else { setMsg("Insumo excluído."); load(); }
  }

  async function setActive(i: StockItem, v: boolean) {
    const { error } = await sb.from("stock_items").update({ active: v }).eq("id", i.id);
    if (error) setErr(errorMessage(error)); else load();
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="card"><p className="text-sm text-zinc-500">Valor em estoque</p><p className="mt-1 text-2xl font-semibold tabular-nums">{brl(Math.round(totalValue))}</p></div>
        <div className="card"><p className="text-sm text-zinc-500">Abaixo do mínimo</p><p className={`mt-1 text-2xl font-semibold tabular-nums ${below ? "text-red-700" : ""}`}>{below}</p></div>
        <div className="card"><p className="text-sm text-zinc-500">Insumos ativos</p><p className="mt-1 text-2xl font-semibold tabular-nums">{active.length}</p></div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <input className="input max-w-xs" placeholder="Buscar insumo" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Buscar insumo" />
        <label className="flex items-center gap-2 text-sm text-zinc-600">
          <Toggle checked={showInactive} onChange={setShowInactive} label="Mostrar inativos" /> Mostrar inativos
        </label>
        <button className="btn-primary ml-auto" onClick={() => { setErr(""); setEdit({ f: blank }); }}>+ Novo insumo</button>
      </div>

      <Alert>{err && !edit && !move ? err : ""}</Alert>
      <Alert kind="success">{msg}</Alert>

      {!loaded ? null : visible.length === 0 ? (
        <Empty>{list.length === 0 ? "Nenhum insumo cadastrado. Comece pelos itens que mais pesam no custo: queijo, carne, embalagens." : "Nenhum insumo encontrado."}</Empty>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 text-left text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
              <tr>
                <th className="p-3">Insumo</th><th className="p-3 text-right">Quantidade</th><th className="p-3 text-right">Mínimo</th>
                <th className="p-3 text-right">Custo médio</th><th className="p-3 text-right">Valor</th><th className="p-3">Situação</th><th />
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {visible.map((i) => (
                <tr key={i.id} className={i.active ? "" : "opacity-50"}>
                  <td className="p-3 font-medium">{i.name}{!i.active && <span className="ml-2 text-xs text-zinc-500">(inativo)</span>}</td>
                  <td className={`p-3 text-right tabular-nums ${i.qty < i.min_qty ? "font-semibold text-red-700" : ""}`}>{fmtQty(i.qty)} {i.unit}</td>
                  <td className="p-3 text-right tabular-nums text-zinc-600">{fmtQty(i.min_qty)} {i.unit}</td>
                  <td className="p-3 text-right tabular-nums">{brl(Math.round(i.cost_cents))}<span className="text-xs text-zinc-500">/{i.unit}</span></td>
                  <td className="p-3 text-right tabular-nums">{brl(Math.round(Math.max(0, i.qty) * i.cost_cents))}</td>
                  <td className="p-3">{status(i)}</td>
                  <td className="whitespace-nowrap p-3 text-right">
                    <button className="btn-ghost text-emerald-700" onClick={() => openMove(i, "purchase")}>Entrada</button>
                    <button className="btn-ghost" onClick={() => openMove(i, "loss")}>Perda</button>
                    <button className="btn-ghost" onClick={() => openMove(i, "adjust")}>Contagem</button>
                    <button className="btn-ghost" onClick={() => { setErr(""); setEdit({ id: i.id, active: i.active, f: { name: i.name, unit: i.unit, min: i.min_qty ? fmtQty(i.min_qty) : "" } }); }}>Editar</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal open={!!edit} onClose={() => { setEdit(null); setErr(""); }} title={edit?.id ? "Editar insumo" : "Novo insumo"}>
        {edit && (
          <form onSubmit={save} className="space-y-3">
            <Field label="Nome"><input className="input" required maxLength={80} autoFocus value={edit.f.name} onChange={(e) => setEdit({ ...edit, f: { ...edit.f, name: e.target.value } })} placeholder="Ex.: Mussarela" /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Unidade de medida">
                <select className="input" value={edit.f.unit} onChange={(e) => setEdit({ ...edit, f: { ...edit.f, unit: e.target.value } })}>
                  {UNITS.map((u) => <option key={u} value={u}>{u} · {UNIT_LABEL[u]}</option>)}
                </select>
              </Field>
              <Field label="Estoque mínimo" hint="Avisa quando ficar abaixo disso.">
                <input className="input" inputMode="decimal" value={edit.f.min} onChange={(e) => setEdit({ ...edit, f: { ...edit.f, min: e.target.value } })} placeholder="0" />
              </Field>
            </div>
            {!edit.id && <p className="text-xs text-zinc-500">A quantidade e o custo entram pela primeira Entrada ou Contagem.</p>}
            <Alert>{err}</Alert>
            <button className="btn-primary w-full" disabled={busy}>{busy ? "Salvando..." : "Salvar"}</button>
            {edit.id && (
              <div className="flex items-center justify-between border-t border-zinc-100 pt-3">
                <button type="button" className="btn-ghost" onClick={async () => { const it = list.find((x) => x.id === edit.id); if (it) { await setActive(it, !it.active); setEdit(null); } }}>
                  {edit.active ? "Desativar insumo" : "Reativar insumo"}
                </button>
                <button type="button" className="btn-ghost text-red-600" onClick={async () => { const it = list.find((x) => x.id === edit.id); if (it) { setEdit(null); await remove(it); } }}>Excluir</button>
              </div>
            )}
          </form>
        )}
      </Modal>

      <Modal open={!!move} onClose={() => { setMove(null); setErr(""); }} title={move ? `${MOVE_TITLE[move.kind]} · ${move.item.name}` : ""}>
        {move && (
          <form onSubmit={submitMove} className="space-y-3">
            <p className="text-sm text-zinc-600">Saldo atual: <b className="tabular-nums">{fmtQty(move.item.qty)} {move.item.unit}</b> · custo médio {brl(Math.round(move.item.cost_cents))}/{move.item.unit}</p>
            <Field label={move.kind === "adjust" ? `Quantidade contada (${move.item.unit})` : `Quantidade (${move.item.unit})`}
              hint={move.kind === "adjust" ? "O sistema ajusta o saldo para o que você contou." : undefined}>
              <input className="input" required inputMode="decimal" autoFocus value={mf.qty} onChange={(e) => setMf({ ...mf, qty: e.target.value })} />
            </Field>
            {move.kind === "purchase" && (
              <>
                <Field label="Valor total pago (R$)" hint="Opcional. Atualiza o custo médio do insumo.">
                  <input className="input" inputMode="decimal" value={mf.total} onChange={(e) => setMf({ ...mf, total: e.target.value })} placeholder="0,00" />
                </Field>
                {mf.total.trim() && parseBRL(mf.total) > 0 && (
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={mf.expense} onChange={(e) => setMf({ ...mf, expense: e.target.checked })} />
                    Lançar como despesa paga no Financeiro
                  </label>
                )}
              </>
            )}
            <Field label={move.kind === "loss" ? "Motivo" : "Observação"}>
              <input className="input" maxLength={200} required={move.kind === "loss"} value={mf.note} onChange={(e) => setMf({ ...mf, note: e.target.value })}
                placeholder={move.kind === "loss" ? "Ex.: vencido, queimou, caiu" : move.kind === "purchase" ? "Ex.: NF 1234, fornecedor" : "Ex.: inventário semanal"} />
            </Field>
            <Alert>{err}</Alert>
            <button className="btn-primary w-full" disabled={busy}>{busy ? "Registrando..." : "Registrar"}</button>
          </form>
        )}
      </Modal>
    </div>
  );
}
