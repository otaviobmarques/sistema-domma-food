"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { FilterPanel, SEGMENTS, activeCount, describe, type Filter, type Options } from "./filters";
import { supabaseBrowser } from "@/lib/supabase/client";
import { usePanel } from "@/lib/panel/context";
import { Alert, Empty, Field, Modal } from "@/components/ui";
import { brl, errorMessage, formatPhone, parseBRL } from "@/lib/format";

type Customer = {
  id: string; name: string; phone: string; email: string | null; opt_in_marketing: boolean;
  orders_count: number; total_spent_cents: number; first_order_at: string | null; last_order_at: string | null; created_at: string;
  cashback_cents: number; points_balance: number; marketing_opt_out_at?: string | null;
  tags?: string[]; segment?: string; birthday?: string | null; credit_balance_cents?: number;
};
type Ledger = { id: number; kind: "cashback" | "points"; amount: number; reason: string; note: string | null; expires_at: string | null; created_at: string };
type Reward = { id: string; name: string; description: string | null; points_cost: number };

const REASON: Record<string, string> = { earn: "Ganhou", redeem: "Usou", refund: "Devolvido", expire: "Expirou", manual: "Ajuste", reward: "Recompensa" };

function LoyaltyModal({ customer, canAdjust, onClose, onChanged }: { customer: Customer; canAdjust: boolean; onClose: () => void; onChanged: () => void }) {
  const sb = supabaseBrowser();
  const { tenantId } = usePanel();
  const [c, setC] = useState(customer);
  const [ledger, setLedger] = useState<Ledger[]>([]);
  const [rewards, setRewards] = useState<Reward[]>([]);
  const [kind, setKind] = useState<"cashback" | "points">("cashback");
  const [dir, setDir] = useState<"credit" | "debit">("credit");
  const [value, setValue] = useState("");
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [l, r, cu] = await Promise.all([
      sb.from("loyalty_ledger").select("id, kind, amount, reason, note, expires_at, created_at").eq("customer_id", customer.id).order("created_at", { ascending: false }).limit(30),
      sb.from("rewards").select("id, name, description, points_cost").eq("tenant_id", tenantId).eq("active", true).order("points_cost"),
      sb.from("customers").select("*").eq("id", customer.id).single(),
    ]);
    if (l.error) setErr(l.error.message); else setLedger((l.data ?? []) as Ledger[]);
    setRewards((r.data ?? []) as Reward[]);
    if (cu.data) setC(cu.data as Customer);
  }, [sb, customer.id, tenantId]);
  useEffect(() => { load(); }, [load]);

  async function adjust(e: React.FormEvent) {
    e.preventDefault();
    setErr(""); setMsg("");
    const n = kind === "cashback" ? parseBRL(value) : Math.round(Number(value.replace(",", ".")) || 0);
    if (n <= 0) { setErr("Informe um valor maior que zero."); return; }
    if (!note.trim()) { setErr("Informe o motivo do ajuste."); return; }
    setBusy(true);
    const { error } = await sb.rpc("loyalty_adjust", { p_customer_id: customer.id, p_kind: kind, p_amount: dir === "credit" ? n : -n, p_note: note.trim() });
    setBusy(false);
    if (error) { setErr(errorMessage(error)); return; }
    setValue(""); setNote(""); setMsg("Ajuste registrado."); await load(); onChanged();
  }

  async function redeem(r: Reward) {
    if (!confirm(`Resgatar "${r.name}" por ${r.points_cost} pontos?`)) return;
    setErr(""); setMsg(""); setBusy(true);
    const { error } = await sb.rpc("redeem_reward", { p_customer_id: customer.id, p_reward_id: r.id });
    setBusy(false);
    if (error) { setErr(errorMessage(error)); return; }
    setMsg(`Recompensa "${r.name}" resgatada. Entregue ao cliente.`); await load(); onChanged();
  }

  const fmt = (l: Ledger) => l.kind === "cashback" ? brl(Math.abs(l.amount)) : `${Math.abs(l.amount)} pts`;

  return (
    <Modal open onClose={onClose} title={`Fidelidade · ${customer.name}`} wide>
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-xl bg-green-50 p-3"><p className="text-xs font-medium text-green-800">Cashback</p><p className="text-xl font-bold tabular-nums text-green-900">{brl(c.cashback_cents)}</p></div>
          <div className="rounded-xl bg-brand-50 p-3"><p className="text-xs font-medium text-brand-800">Pontos</p><p className="text-xl font-bold tabular-nums text-brand-900">{c.points_balance}</p></div>
        </div>
        <Alert>{err}</Alert>
        <Alert kind="success">{msg}</Alert>

        {rewards.length > 0 && (
          <section>
            <h3 className="mb-2 text-sm font-semibold">Resgatar recompensa</h3>
            <ul className="divide-y divide-zinc-100 rounded-xl border border-zinc-200">
              {rewards.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-3 p-3 text-sm">
                  <span><b>{r.name}</b>{r.description && <span className="block text-xs text-zinc-500">{r.description}</span>}</span>
                  <button className="btn-secondary shrink-0 text-xs" disabled={busy || c.points_balance < r.points_cost} onClick={() => redeem(r)}>
                    {c.points_balance >= r.points_cost ? `Resgatar · ${r.points_cost} pts` : `Faltam ${r.points_cost - c.points_balance} pts`}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {canAdjust && (
          <form onSubmit={adjust} className="space-y-3 rounded-xl border border-zinc-200 p-3">
            <h3 className="text-sm font-semibold">Ajuste manual</h3>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Tipo">
                <select className="input" value={kind} onChange={(e) => setKind(e.target.value as "cashback" | "points")}>
                  <option value="cashback">Cashback (R$)</option><option value="points">Pontos</option>
                </select>
              </Field>
              <Field label="Operação">
                <select className="input" value={dir} onChange={(e) => setDir(e.target.value as "credit" | "debit")}>
                  <option value="credit">Crédito (+)</option><option value="debit">Débito (−)</option>
                </select>
              </Field>
              <Field label={kind === "cashback" ? "Valor (R$)" : "Pontos"}>
                <input className="input" inputMode="decimal" required value={value} onChange={(e) => setValue(e.target.value)} />
              </Field>
            </div>
            <Field label="Motivo"><input className="input" required maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Ex.: cortesia por atraso" /></Field>
            <button className="btn-primary" disabled={busy}>{busy ? "Salvando..." : "Registrar ajuste"}</button>
          </form>
        )}

        <section>
          <h3 className="mb-2 text-sm font-semibold">Extrato</h3>
          {ledger.length === 0 ? <p className="text-sm text-zinc-500">Nenhuma movimentação ainda.</p> : (
            <ul className="divide-y divide-zinc-100 text-sm">
              {ledger.map((l) => (
                <li key={l.id} className="flex items-center justify-between gap-3 py-2">
                  <span>
                    <b>{REASON[l.reason] ?? l.reason}</b> <span className="text-zinc-500">· {l.kind === "cashback" ? "cashback" : "pontos"}</span>
                    {l.note && <span className="text-zinc-500"> · {l.note}</span>}
                    <span className="block text-xs text-zinc-500">
                      {new Date(l.created_at).toLocaleString("pt-BR")}
                      {l.amount > 0 && l.expires_at && ` · vale até ${new Date(l.expires_at).toLocaleDateString("pt-BR")}`}
                    </span>
                  </span>
                  <span className={`shrink-0 font-semibold tabular-nums ${l.amount > 0 ? "text-green-700" : "text-red-700"}`}>{l.amount > 0 ? "+" : "−"}{fmt(l)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </Modal>
  );
}

const SORTS: Record<string, string> = {
  recent: "Último pedido", oldest: "Sumidos há mais tempo", spent: "Maior gasto", orders: "Mais pedidos",
  ticket: "Maior ticket médio", cashback: "Mais cashback", name: "Nome (A–Z)",
};
const PAGE = 50;
type Result = { total: number; summary: { spent_cents: number; orders: number; opted_in: number; cashback_cents: number }; rows: Customer[] };

function TagsModal({ c, onClose, onSaved }: { c: Customer; onClose: () => void; onSaved: () => void }) {
  const sb = supabaseBrowser();
  const [txt, setTxt] = useState((c.tags ?? []).join(", "));
  const [err, setErr] = useState("");
  async function save() {
    const { error } = await sb.rpc("crm_set_tags", { p_customer_id: c.id, p_tags: txt.split(",").map((t) => t.trim()).filter(Boolean) });
    if (error) setErr(errorMessage(error)); else { onSaved(); onClose(); }
  }
  return (
    <Modal open onClose={onClose} title={`Etiquetas · ${c.name}`}>
      <Field label="Etiquetas separadas por vírgula" hint="Ex.: vip, empresa, prefere pizza doce. Até 20.">
        <input className="input" value={txt} onChange={(e) => setTxt(e.target.value)} autoFocus />
      </Field>
      <Alert>{err}</Alert>
      <div className="mt-4 flex justify-end gap-2"><button className="btn-ghost" onClick={onClose}>Cancelar</button><button className="btn-primary" onClick={save}>Salvar</button></div>
    </Modal>
  );
}

export default function Clientes() {
  const { tenantId, role } = usePanel();
  const sb = supabaseBrowser();
  const router = useRouter();
  const [f, setF] = useState<Filter>({});
  const [ver, setVer] = useState(0);               // remonta o painel de filtros ao limpar/carregar
  const [open, setOpen] = useState(false);
  const [sort, setSort] = useState("recent");
  const [res, setRes] = useState<Result | null>(null);
  const [rows, setRows] = useState<Customer[]>([]);
  const [opts, setOpts] = useState<Options | null>(null);
  const [current, setCurrent] = useState<string | null>(null);   // filtro salvo selecionado
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [tag, setTag] = useState("");
  const [loyalty, setLoyalty] = useState<Customer | null>(null);
  const [tagsOf, setTagsOf] = useState<Customer | null>(null);
  const req = useRef(0);
  const manager = role === "owner" || role === "manager";

  const loadOpts = useCallback(async () => {
    const { data, error } = await sb.rpc("crm_options", { p_tenant_id: tenantId });
    if (error) setErr(errorMessage(error)); else setOpts(data as Options);
  }, [sb, tenantId]);
  useEffect(() => { void loadOpts(); }, [loadOpts]);

  const fKey = JSON.stringify(f);
  const load = useCallback(async (offset = 0) => {
    const id = ++req.current;
    setLoading(true);
    const { data, error } = await sb.rpc("crm_search", { p_tenant_id: tenantId, p_filter: f, p_sort: sort, p_limit: PAGE, p_offset: offset });
    if (id !== req.current) return;
    setLoading(false);
    if (error) { setErr(errorMessage(error)); return; }
    const r = data as Result;
    setRes(r); setRows((prev) => (offset ? [...prev, ...r.rows] : r.rows)); setErr("");
  }, [sb, tenantId, fKey, sort]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const t = setTimeout(() => void load(0), 300); return () => clearTimeout(t); }, [load]);

  const patch = (p: Filter) => { setF((x) => { const n = { ...x, ...p }; for (const k of Object.keys(n) as (keyof Filter)[]) if (n[k] === undefined) delete n[k]; return n; }); setCurrent(null); };
  const chips = useMemo(() => describe(f, opts), [f, opts]);
  const n = activeCount(f);

  function applySaved(id: string) {
    const s = opts?.segments.find((x) => x.id === id);
    if (!s) return;
    setF({ ...(s.filter ?? {}) }); setCurrent(s.id); setVer((v) => v + 1);
  }
  function clear() { setF({}); setCurrent(null); setVer((v) => v + 1); }

  async function saveFilter() {
    const s = opts?.segments.find((x) => x.id === current);
    const name = prompt("Nome do filtro (ex.: Sumidos que gastam bem):", s?.name ?? "");
    if (!name?.trim()) return;
    const { data, error } = await sb.rpc("crm_segment_save", { p_tenant_id: tenantId, p_name: name, p_filter: f, p_id: s && s.name === name.trim() ? s.id : null });
    if (error) { setErr(errorMessage(error)); return; }
    await loadOpts(); setCurrent(data as string); setMsg("Filtro salvo. Ele também aparece como público em Marketing › Campanhas.");
  }
  async function deleteFilter() {
    const s = opts?.segments.find((x) => x.id === current);
    if (!s || !confirm(`Apagar o filtro salvo "${s.name}"?`)) return;
    const { error } = await sb.rpc("crm_segment_delete", { p_id: s.id });
    if (error) setErr(errorMessage(error)); else { setCurrent(null); await loadOpts(); }
  }
  async function bulkTag(add: boolean) {
    if (!tag.trim() || !res) return;
    if (!confirm(`${add ? "Adicionar" : "Remover"} a etiqueta "${tag.trim()}" ${add ? "em" : "de"} ${res.total} cliente(s) do filtro?`)) return;
    const { data, error } = await sb.rpc("crm_bulk_tag", { p_tenant_id: tenantId, p_filter: f, p_tag: tag, p_add: add });
    if (error) { setErr(errorMessage(error)); return; }
    setMsg(`${data} cliente(s) atualizados.`); setTag(""); await Promise.all([load(0), loadOpts()]);
  }
  function campaign() {
    const s = opts?.segments.find((x) => x.id === current);
    try { sessionStorage.setItem("df_crm_campaign", JSON.stringify({ type: "crm", name: s?.name ?? "Filtro atual do CRM", filter: f })); } catch { /* ignora */ }
    router.push("/painel/marketing");
  }

  async function exportCsv() {
    const { data, error } = await sb.rpc("crm_search", { p_tenant_id: tenantId, p_filter: f, p_sort: sort, p_limit: 5000, p_offset: 0 });
    if (error) { setErr(errorMessage(error)); return; }
    const list = (data as Result).rows;
    const head = ["nome", "whatsapp", "email", "segmento", "etiquetas", "pedidos", "total_gasto", "ticket_medio", "primeiro_pedido", "ultimo_pedido", "aniversario", "aceita_marketing", "cashback", "pontos"];
    const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = list.map((r) => [r.name, r.phone, r.email, SEGMENTS.find((x) => x[0] === r.segment)?.[1], (r.tags ?? []).join(", "), r.orders_count,
      (r.total_spent_cents / 100).toFixed(2), r.orders_count ? (r.total_spent_cents / r.orders_count / 100).toFixed(2) : "",
      r.first_order_at?.slice(0, 10), r.last_order_at?.slice(0, 10), r.birthday ?? "", r.opt_in_marketing ? "sim" : "nao",
      ((r.cashback_cents ?? 0) / 100).toFixed(2), r.points_balance ?? 0].map(esc).join(";"));
    const blob = new Blob(["\ufeff" + [head.join(";"), ...lines].join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `clientes-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async function erase(c: Customer) {
    if (!confirm(`Excluir os dados pessoais de ${c.name} (pedido de exclusão LGPD)? Os valores dos pedidos ficam para fins fiscais, sem nome, telefone ou endereço. Esta ação não pode ser desfeita.`)) return;
    const { error } = await sb.rpc("anonymize_customer", { p_customer_id: c.id });
    if (error) setErr(error.message); else void load(0);
  }

  if (!manager) return <Empty>O CRM de clientes é usado pelo dono e pela gerência.</Empty>;
  const s = res?.summary;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="h1">Clientes <span className="text-base font-normal text-zinc-500">({res?.total ?? "…"})</span></h1>
          <p className="mt-1 text-sm text-zinc-600">Combine filtros para achar o público certo, salve o filtro e use em campanhas.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button className="btn-secondary" onClick={exportCsv} disabled={!res?.total}>Exportar CSV</button>
          <button className="btn-primary" onClick={campaign} disabled={!res?.total}>Criar campanha</button>
        </div>
      </div>

      {!!opts?.segments.length && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="font-medium text-zinc-500">Filtros salvos:</span>
          {opts.segments.map((x) => (
            <button key={x.id} onClick={() => applySaved(x.id)}
              className={`rounded-full px-2.5 py-1 font-medium ring-1 ${current === x.id ? "bg-zinc-900 text-white ring-zinc-900" : "bg-white text-zinc-700 ring-zinc-200 hover:bg-zinc-50"}`}>{x.name}</button>
          ))}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <input className="input max-w-xs" placeholder="Buscar por nome, telefone ou e-mail" value={f.q ?? ""} onChange={(e) => patch({ q: e.target.value || undefined })} aria-label="Buscar clientes" />
        <select className="input w-auto" value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Ordenar">
          {Object.entries(SORTS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <button className={`btn-secondary ${open ? "ring-2 ring-brand-200" : ""}`} onClick={() => setOpen(!open)} aria-expanded={open}>
          Filtros avançados{n ? ` (${n})` : ""}
        </button>
        {n > 0 && <button className="btn-ghost text-sm" onClick={clear}>Limpar</button>}
        {n > 0 && <button className="btn-ghost text-sm" onClick={saveFilter}>{current ? "Atualizar filtro salvo" : "Salvar filtro"}</button>}
        {current && <button className="btn-ghost text-sm text-red-600" onClick={deleteFilter}>Apagar filtro salvo</button>}
      </div>
      {open && <FilterPanel key={ver} f={f} set={patch} options={opts} />}
      {chips.length > 0 && (
        <div className="flex flex-wrap gap-1.5">{chips.map((c) => <span key={c} className="badge bg-brand-50 text-brand-800 ring-1 ring-brand-100">{c}</span>)}</div>
      )}
      <Alert>{err}</Alert>
      <Alert kind="success">{msg}</Alert>

      {s && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[["Clientes no filtro", String(res!.total)], ["Gasto total", brl(s.spent_cents)],
            ["Ticket médio", s.orders ? brl(Math.round(s.spent_cents / s.orders)) : "—"], ["Autorizaram marketing", String(s.opted_in)]].map(([l, v]) => (
            <div key={l} className="rounded-xl bg-white p-3 ring-1 ring-zinc-200"><p className="text-xs text-zinc-500">{l}</p><p className="text-lg font-bold tabular-nums">{v}</p></div>
          ))}
        </div>
      )}

      {!!res?.total && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-zinc-600">Etiquetar os {res.total} cliente(s) do filtro:</span>
          <input className="input w-48" placeholder="Ex.: vip" maxLength={30} value={tag} onChange={(e) => setTag(e.target.value)} aria-label="Etiqueta" list="crm-tags" />
          <datalist id="crm-tags">{opts?.tags.map((t) => <option key={t} value={t} />)}</datalist>
          <button className="btn-secondary" disabled={!tag.trim()} onClick={() => bulkTag(true)}>Adicionar</button>
          <button className="btn-ghost" disabled={!tag.trim()} onClick={() => bulkTag(false)}>Remover</button>
        </div>
      )}

      {res && rows.length === 0 ? <Empty>{n || f.q ? "Nenhum cliente com esses filtros." : "Os clientes aparecem aqui automaticamente a cada pedido."}</Empty> : (
        <div className="overflow-x-auto rounded-lg border border-zinc-200/70 bg-white shadow-soft">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50/80 text-left text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
              <tr><th className="p-3">Cliente</th><th className="p-3">Segmento</th><th className="p-3">Pedidos</th><th className="p-3">Total gasto</th><th className="p-3">Ticket médio</th><th className="p-3">Cashback</th><th className="p-3">Último pedido</th><th className="p-3">Marketing</th><th /></tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {rows.map((c) => {
                const sg = SEGMENTS.find((x) => x[0] === c.segment);
                return (
                  <tr key={c.id}>
                    <td className="p-3">
                      <p className="font-medium">{c.name}</p>
                      <a className="text-xs text-brand-700 hover:underline" href={`https://wa.me/55${c.phone}`} target="_blank" rel="noopener noreferrer">{formatPhone(c.phone)}</a>
                      {!!c.tags?.length && <div className="mt-1 flex flex-wrap gap-1">{c.tags.map((t) => <span key={t} className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium text-zinc-700">{t}</span>)}</div>}
                    </td>
                    <td className="p-3">{sg && <span className={`badge ${sg[2]}`}>{sg[1]}</span>}</td>
                    <td className="p-3 tabular-nums">{c.orders_count}</td>
                    <td className="p-3 tabular-nums">{brl(c.total_spent_cents)}</td>
                    <td className="p-3 tabular-nums">{c.orders_count ? brl(Math.round(c.total_spent_cents / c.orders_count)) : "—"}</td>
                    <td className="p-3 tabular-nums">{c.cashback_cents ? brl(c.cashback_cents) : "—"}</td>
                    <td className="p-3 text-xs">{c.last_order_at ? new Date(c.last_order_at).toLocaleDateString("pt-BR") : "—"}</td>
                    <td className="p-3 text-xs">
                      {c.opt_in_marketing && !c.marketing_opt_out_at ? <span className="badge bg-green-100 text-green-800">Autorizou</span>
                        : c.marketing_opt_out_at ? <span className="badge bg-red-50 text-red-700">Descadastrado</span>
                        : <span className="badge bg-zinc-100 text-zinc-600">Não autorizou</span>}
                    </td>
                    <td className="whitespace-nowrap p-3 text-right">
                      <button className="btn-ghost text-xs" onClick={() => setTagsOf(c)}>Etiquetas</button>
                      <button className="btn-ghost text-xs" onClick={() => setLoyalty(c)}>Fidelidade</button>
                      {c.opt_in_marketing && !c.marketing_opt_out_at && <button className="btn-ghost text-xs" onClick={async () => {
                        if (!confirm(`Descadastrar ${c.name} do marketing? Ele não receberá mais campanhas.`)) return;
                        const { error } = await sb.rpc("customer_marketing_opt_out", { p_customer_id: c.id });
                        if (error) setErr(error.message); else void load(0);
                      }}>Descadastrar</button>}
                      <button className="btn-ghost text-xs text-red-600" onClick={() => erase(c)}>Excluir dados</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {res && rows.length < res.total && (
        <div className="text-center"><button className="btn-secondary" disabled={loading} onClick={() => load(rows.length)}>{loading ? "Carregando..." : `Mostrar mais (${res.total - rows.length})`}</button></div>
      )}
      {loyalty && <LoyaltyModal customer={loyalty} canAdjust={manager} onClose={() => setLoyalty(null)} onChanged={() => void load(0)} />}
      {tagsOf && <TagsModal c={tagsOf} onClose={() => setTagsOf(null)} onSaved={() => { void load(0); void loadOpts(); }} />}
      <p className="text-xs text-zinc-500">Campanhas só vão para quem autorizou marketing (LGPD), mesmo que o filtro inclua outros clientes.</p>
    </div>
  );
}
