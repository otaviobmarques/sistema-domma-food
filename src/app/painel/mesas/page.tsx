"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { canManage, usePanel } from "@/lib/panel/context";
import { Alert, Empty, Field, Modal, Toggle } from "@/components/ui";
import { usePosCatalog } from "@/components/pos/product-picker";
import { brl, errorMessage } from "@/lib/format";
import { TabPanel } from "./tab-panel";
import { fmtDuration, IDLE_MIN, lastActivity, minutesSince, tabSubtotal, type DTable, type Tab } from "./types";

const SERVE_ROLES = ["owner", "manager", "cashier", "attendant", "waiter"];
const TAB_SELECT = "id, table_id, label, customer_name, people, service_fee_pct, bill_requested_at, opened_at, " +
  "orders(id, number, status, subtotal_cents, created_at, order_items(id, name, quantity, total_cents, notes, kds_status, options))";

type State = "free" | "busy" | "bill" | "idle";
const STATE_UI: Record<State, { label: string; card: string; dot: string }> = {
  free: { label: "Livre", card: "border-zinc-200 bg-white hover:border-zinc-300", dot: "bg-zinc-300" },
  busy: { label: "Ocupada", card: "border-brand-300 bg-brand-50 hover:border-brand-400", dot: "bg-brand-600" },
  bill: { label: "Pediu a conta", card: "border-amber-400 bg-amber-50 hover:border-amber-500", dot: "bg-amber-500" },
  idle: { label: "Sem pedido há um tempo", card: "border-red-400 bg-red-50 hover:border-red-500", dot: "bg-red-500" },
};

function stateOf(tabs: Tab[], now: number): State {
  if (!tabs.length) return "free";
  if (tabs.some((t) => t.bill_requested_at)) return "bill";
  if (tabs.every((t) => minutesSince(lastActivity(t), now) >= IDLE_MIN)) return "idle";
  return "busy";
}

export default function MesasPage() {
  const { unit, tenantId, role } = usePanel();
  const sb = supabaseBrowser();
  const canServe = SERVE_ROLES.includes(role);
  const catalog = usePosCatalog(tenantId, unit.id, "table");
  const [tables, setTables] = useState<DTable[]>([]);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [err, setErr] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [openTabId, setOpenTabId] = useState<string | null>(null);
  const [pickTable, setPickTable] = useState<DTable | null>(null);       // mesa com várias comandas
  const [newTab, setNewTab] = useState<{ table: DTable | null } | null>(null);
  const [manage, setManage] = useState(false);

  const load = useCallback(async () => {
    const [t, tb] = await Promise.all([
      sb.from("dining_tables").select("id, name, area, seats, position, active").eq("unit_id", unit.id).order("area").order("position").order("name"),
      sb.from("tabs").select(TAB_SELECT).eq("unit_id", unit.id).eq("status", "open").order("opened_at"),
    ]);
    if (t.error || tb.error) { setErr((t.error ?? tb.error)!.message); return; }
    setTables((t.data ?? []) as DTable[]);
    setTabs((tb.data ?? []) as unknown as Tab[]);
    setErr(""); setLoaded(true); setNow(Date.now());
  }, [sb, unit.id]);

  useEffect(() => {
    void load();
    const poll = setInterval(() => void load(), 20000);
    const ch = sb.channel(`floor-${unit.id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "tabs", filter: `unit_id=eq.${unit.id}` }, () => void load())
      .on("postgres_changes", { event: "*", schema: "public", table: "orders", filter: `unit_id=eq.${unit.id}` }, () => void load())
      .subscribe();
    return () => { clearInterval(poll); void sb.removeChannel(ch); };
  }, [load, sb, unit.id]);

  const byTable = useMemo(() => {
    const m = new Map<string, Tab[]>();
    tabs.forEach((t) => { if (t.table_id) m.set(t.table_id, [...(m.get(t.table_id) ?? []), t]); });
    return m;
  }, [tabs]);
  const loose = tabs.filter((t) => !t.table_id);
  const areas = useMemo(() => [...new Set(tables.filter((t) => t.active).map((t) => t.area))], [tables]);
  const current = tabs.find((t) => t.id === openTabId) ?? null;
  const occupied = tables.filter((t) => t.active && byTable.has(t.id)).length;
  const openTotal = tabs.reduce((s, t) => s + tabSubtotal(t), 0);

  function clickTable(t: DTable) {
    const list = byTable.get(t.id) ?? [];
    if (!list.length) { if (canServe) setNewTab({ table: t }); return; }
    if (list.length === 1) setOpenTabId(list[0].id); else setPickTable(t);
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="h1">Mesas e comandas</h1>
          <p className="mt-1 text-sm text-zinc-600">
            {occupied} de {tables.filter((t) => t.active).length} mesas ocupadas · {tabs.length} comanda(s) aberta(s) · {brl(openTotal)} em aberto
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canServe && <button className="btn-secondary" onClick={() => setNewTab({ table: null })}>+ Comanda avulsa</button>}
          {canManage(role) && <button className="btn-secondary" onClick={() => setManage(true)}>Gerenciar mesas</button>}
        </div>
      </div>
      <Alert>{err}</Alert>
      <div className="flex flex-wrap gap-3 text-xs text-zinc-600">
        {(Object.keys(STATE_UI) as State[]).map((s) => (
          <span key={s} className="inline-flex items-center gap-1.5"><span className={`h-2.5 w-2.5 rounded-full ${STATE_UI[s].dot}`} />{s === "idle" ? `Sem pedido há ${IDLE_MIN}+ min` : STATE_UI[s].label}</span>
        ))}
      </div>

      {loaded && tables.filter((t) => t.active).length === 0 && loose.length === 0 && (
        <Empty>
          Nenhuma mesa cadastrada.
          {canManage(role) ? <> <button className="font-semibold text-brand-700 underline" onClick={() => setManage(true)}>Cadastrar mesas</button></> : " Peça ao gerente para cadastrar as mesas."}
        </Empty>
      )}

      {areas.map((area) => (
        <section key={area}>
          <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-zinc-500">{area}</h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
            {tables.filter((t) => t.active && t.area === area).map((t) => {
              const list = byTable.get(t.id) ?? [];
              const st = stateOf(list, now);
              const ui = STATE_UI[st];
              const total = list.reduce((s, x) => s + tabSubtotal(x), 0);
              const people = list.reduce((s, x) => s + x.people, 0);
              const oldest = list[0];
              const idle = list.length ? Math.min(...list.map((x) => minutesSince(lastActivity(x), now))) : 0;
              return (
                <button key={t.id} type="button" onClick={() => clickTable(t)} disabled={st === "free" && !canServe}
                  aria-label={`Mesa ${t.name}, ${ui.label}`}
                  className={`flex min-h-32 flex-col rounded-lg border-2 p-3 text-left shadow-soft transition ${ui.card}`}>
                  <span className="flex items-start justify-between gap-2">
                    <span className="text-2xl font-semibold tracking-tight">{t.name}</span>
                    <span className={`mt-1.5 h-3 w-3 rounded-full ${ui.dot}`} />
                  </span>
                  {st === "free" ? (
                    <span className="mt-auto text-xs text-zinc-500">Livre · {t.seats} lugares</span>
                  ) : (
                    <>
                      <span className="mt-1 text-lg font-bold tabular-nums">{brl(total)}</span>
                      <span className="mt-auto text-xs text-zinc-600">
                        {people} pessoa(s) · {fmtDuration(minutesSince(oldest.opened_at, now))}
                        {list.length > 1 && ` · ${list.length} comandas`}
                      </span>
                      {st === "bill" && <span className="mt-1 text-xs font-bold text-amber-800">Pediu a conta</span>}
                      {st === "idle" && <span className="mt-1 text-xs font-bold text-red-700">Sem pedido há {fmtDuration(idle)}</span>}
                    </>
                  )}
                </button>
              );
            })}
          </div>
        </section>
      ))}

      {loose.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-zinc-500">Comandas avulsas</h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
            {loose.map((t) => {
              const ui = STATE_UI[stateOf([t], now)];
              return (
                <button key={t.id} type="button" onClick={() => setOpenTabId(t.id)}
                  className={`flex min-h-28 flex-col rounded-lg border-2 p-3 text-left shadow-soft transition ${ui.card}`}>
                  <span className="text-lg font-semibold">Comanda {t.label}</span>
                  {t.customer_name && <span className="truncate text-xs text-zinc-600">{t.customer_name}</span>}
                  <span className="mt-1 font-bold tabular-nums">{brl(tabSubtotal(t))}</span>
                  <span className="mt-auto text-xs text-zinc-600">{fmtDuration(minutesSince(t.opened_at, now))}{t.bill_requested_at ? " · pediu a conta" : ""}</span>
                </button>
              );
            })}
          </div>
        </section>
      )}

      {current && (
        <TabPanel key={current.id} tab={current} tables={tables} catalog={catalog} now={now}
          onClose={() => { setOpenTabId(null); void load(); }} onChanged={load} />
      )}

      <Modal open={!!pickTable} onClose={() => setPickTable(null)} title={pickTable ? `Mesa ${pickTable.name}` : ""}>
        {pickTable && (
          <div className="space-y-2">
            {(byTable.get(pickTable.id) ?? []).map((t, i) => (
              <button key={t.id} className="flex w-full items-center justify-between rounded-xl border border-zinc-200 p-3 text-left hover:bg-zinc-50"
                onClick={() => { setOpenTabId(t.id); setPickTable(null); }}>
                <span><b>{t.label || `Comanda ${i + 1}`}</b>{t.customer_name ? ` · ${t.customer_name}` : ""}<span className="block text-xs text-zinc-500">{t.people} pessoa(s){t.bill_requested_at ? " · pediu a conta" : ""}</span></span>
                <span className="font-bold tabular-nums">{brl(tabSubtotal(t))}</span>
              </button>
            ))}
            {canServe && <button className="btn-secondary w-full" onClick={() => { setNewTab({ table: pickTable }); setPickTable(null); }}>+ Nova comanda nesta mesa</button>}
          </div>
        )}
      </Modal>

      {newTab && (
        <OpenTabModal table={newTab.table} unitId={unit.id} onClose={() => setNewTab(null)}
          onOpened={async (id) => { setNewTab(null); await load(); setOpenTabId(id); }} />
      )}
      {manage && <ManageTables tables={tables} tenantId={tenantId} unitId={unit.id} busyIds={new Set(byTable.keys())} onClose={() => setManage(false)} onChanged={load} />}
    </div>
  );
}

function OpenTabModal({ table, unitId, onClose, onOpened }: {
  table: DTable | null; unitId: string; onClose: () => void; onOpened: (id: string) => void;
}) {
  const [people, setPeople] = useState("2");
  const [customer, setCustomer] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr("");
    const { data, error } = await supabaseBrowser().rpc("tab_open", {
      p_unit_id: unitId, p_table_id: table?.id ?? null, p_label: label, p_people: Number(people) || 1, p_customer: customer,
    });
    setBusy(false);
    if (error) { setErr(errorMessage(error)); return; }
    onOpened(data as string);
  }
  return (
    <Modal open onClose={onClose} title={table ? `Abrir mesa ${table.name}` : "Nova comanda avulsa"}>
      <form onSubmit={submit} className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Pessoas"><input className="input" type="number" min={1} max={99} required autoFocus value={people} onChange={(e) => setPeople(e.target.value)} /></Field>
          <Field label={table ? "Identificação (opcional)" : "Número ou nome da comanda"} hint={table ? "Ex.: João, cartão 12" : undefined}>
            <input className="input" maxLength={40} required={!table} value={label} onChange={(e) => setLabel(e.target.value)} />
          </Field>
        </div>
        <Field label="Nome do cliente (opcional)"><input className="input" maxLength={80} value={customer} onChange={(e) => setCustomer(e.target.value)} /></Field>
        <Alert>{err}</Alert>
        <button className="btn-primary w-full py-3" disabled={busy}>{busy ? "Abrindo..." : "Abrir comanda"}</button>
      </form>
    </Modal>
  );
}

function ManageTables({ tables, tenantId, unitId, busyIds, onClose, onChanged }: {
  tables: DTable[]; tenantId: string; unitId: string; busyIds: Set<string>; onClose: () => void; onChanged: () => Promise<void> | void;
}) {
  const sb = supabaseBrowser();
  const [name, setName] = useState("");
  const [area, setArea] = useState("Salão");
  const [seats, setSeats] = useState("4");
  const [upTo, setUpTo] = useState("10");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function exec(q: PromiseLike<{ error: { message: string; code?: string } | null }>) {
    setBusy(true); setErr("");
    const { error } = await q;
    setBusy(false);
    if (error) { setErr(error.code === "23505" ? "Já existe uma mesa com esse nome." : errorMessage(error)); return false; }
    await onChanged();
    return true;
  }
  const row = (n: string, pos: number) => ({ tenant_id: tenantId, unit_id: unitId, name: n, area: area.trim() || "Salão", seats: Number(seats) || 4, position: pos });

  async function addOne(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    if (await exec(sb.from("dining_tables").insert(row(name.trim(), tables.length)))) setName("");
  }
  async function addRange() {
    const n = Math.min(100, Math.max(1, Number(upTo) || 0));
    const existing = new Set(tables.map((t) => t.name));
    const rows = Array.from({ length: n }, (_, i) => String(i + 1).padStart(2, "0")).filter((x) => !existing.has(x)).map((x, i) => row(x, tables.length + i));
    if (!rows.length) { setErr("Essas mesas já existem."); return; }
    await exec(sb.from("dining_tables").insert(rows));
  }

  return (
    <Modal open onClose={onClose} title="Gerenciar mesas" wide>
      <div className="space-y-4">
        <Alert>{err}</Alert>
        <div className="grid gap-3 rounded-xl bg-zinc-50 p-3 sm:grid-cols-2">
          <Field label="Ambiente"><input className="input" value={area} onChange={(e) => setArea(e.target.value)} placeholder="Salão, Varanda..." /></Field>
          <Field label="Lugares por mesa"><input className="input" type="number" min={1} max={50} value={seats} onChange={(e) => setSeats(e.target.value)} /></Field>
          <form onSubmit={addOne} className="flex items-end gap-2">
            <div className="flex-1"><Field label="Nova mesa"><input className="input" maxLength={30} value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: 07 ou Deck 1" /></Field></div>
            <button className="btn-primary" disabled={busy || !name.trim()}>Adicionar</button>
          </form>
          <div className="flex items-end gap-2">
            <div className="flex-1"><Field label="Criar mesas de 01 até"><input className="input" type="number" min={1} max={100} value={upTo} onChange={(e) => setUpTo(e.target.value)} /></Field></div>
            <button type="button" className="btn-secondary" disabled={busy} onClick={addRange}>Criar</button>
          </div>
        </div>
        {tables.length === 0 ? <p className="text-sm text-zinc-500">Nenhuma mesa ainda.</p> : (
          <ul className="max-h-80 divide-y divide-zinc-100 overflow-y-auto text-sm">
            {tables.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center gap-2 py-2">
                <input className="input w-24 font-bold" defaultValue={t.name} aria-label="Nome da mesa" maxLength={30}
                  onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== t.name) void exec(sb.from("dining_tables").update({ name: v }).eq("id", t.id)); }} />
                <input className="input w-32" defaultValue={t.area} aria-label="Ambiente"
                  onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== t.area) void exec(sb.from("dining_tables").update({ area: v }).eq("id", t.id)); }} />
                <input className="input w-20" type="number" min={1} max={50} defaultValue={t.seats} aria-label="Lugares"
                  onBlur={(e) => { const v = Number(e.target.value); if (v && v !== t.seats) void exec(sb.from("dining_tables").update({ seats: v }).eq("id", t.id)); }} />
                <span className="flex items-center gap-1.5 text-xs text-zinc-600"><Toggle checked={t.active} label="Ativa" onChange={(v) => void exec(sb.from("dining_tables").update({ active: v }).eq("id", t.id))} /> Ativa</span>
                <button className="btn-ghost ml-auto text-xs text-red-600" disabled={busy || busyIds.has(t.id)}
                  title={busyIds.has(t.id) ? "Mesa com comanda aberta" : undefined}
                  onClick={() => { if (confirm(`Excluir a mesa ${t.name}?`)) void exec(sb.from("dining_tables").delete().eq("id", t.id)); }}>Excluir</button>
              </li>
            ))}
          </ul>
        )}
        <button className="btn-secondary w-full" onClick={onClose}>Concluir</button>
      </div>
    </Modal>
  );
}
