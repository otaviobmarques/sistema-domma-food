"use client";
import { useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { usePanel } from "@/lib/panel/context";
import { Alert, Empty, Field, Modal, Toggle } from "@/components/ui";
import { errorMessage } from "@/lib/format";
import { CONNECTION_LABEL, type Printer } from "./shared";

type Form = Omit<Printer, "id">;
const blank: Form = { name: "", connection: "network", address: "", paper_width: 80, stations: ["cozinha"], print_receipt: false, copies: 1, on_event: "accepted", active: true };

export function Printers({ printers, onChanged }: { printers: Printer[]; onChanged: () => Promise<void> | void }) {
  const { tenantId, unit } = usePanel();
  const sb = supabaseBrowser();
  const [stations, setStations] = useState<string[]>(["cozinha", "bar"]);
  const [edit, setEdit] = useState<{ id?: string; f: Form } | null>(null);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      const { data } = await sb.from("units").select("kds_stations").eq("id", unit.id).maybeSingle();
      const st = (data as { kds_stations: string[] | null } | null)?.kds_stations;
      if (st?.length) setStations(st);
    })();
  }, [sb, unit.id]);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setEdit((e) => e && { ...e, f: { ...e.f, [k]: v } });

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!edit) return;
    const f = edit.f;
    if (f.connection !== "browser" && !f.address?.trim()) { setErr(f.connection === "network" ? "Informe o IP e a porta da impressora." : "Informe o nome da impressora no computador."); return; }
    if (!f.stations.length && !f.print_receipt) { setErr("Escolha pelo menos um setor ou a via completa do pedido."); return; }
    setBusy(true); setErr("");
    const row = { ...f, name: f.name.trim(), address: f.connection === "browser" ? null : f.address?.trim() || null };
    const { error } = edit.id
      ? await sb.from("printers").update(row).eq("id", edit.id)
      : await sb.from("printers").insert({ ...row, tenant_id: tenantId, unit_id: unit.id });
    setBusy(false);
    if (error) { setErr(errorMessage(error)); return; }
    setEdit(null); setMsg("Impressora salva."); await onChanged();
  }

  async function test(p: Printer) {
    setErr(""); setMsg("");
    const { error } = await sb.rpc("print_test", { p_printer_id: p.id });
    if (error) setErr(errorMessage(error));
    else setMsg(p.connection === "browser" ? `Teste enviado para "${p.name}". Ele sai na tela Estação de impressão.` : `Teste enviado para "${p.name}". Ele sai assim que o computador conectado pegar a fila.`);
    await onChanged();
  }

  async function remove(p: Printer) {
    if (!confirm(`Excluir a impressora "${p.name}"? A fila dela também é apagada.`)) return;
    const { error } = await sb.from("printers").delete().eq("id", p.id);
    if (error) setErr(errorMessage(error)); else { setMsg("Impressora excluída."); await onChanged(); }
  }

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-semibold">Impressoras</h2>
          <p className="text-sm text-zinc-500">Cada impressora recebe as comandas dos setores marcados e, se quiser, a via completa do pedido.</p>
        </div>
        <button className="btn-primary" onClick={() => { setErr(""); setEdit({ f: { ...blank, stations: [stations[0] ?? "cozinha"] } }); }}>+ Nova impressora</button>
      </div>
      <Alert>{err && !edit ? err : ""}</Alert>
      <Alert kind="success">{msg}</Alert>
      {printers.length === 0 ? <Empty>Nenhuma impressora cadastrada. Comece pela da cozinha.</Empty> : (
        <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 text-left text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
              <tr><th className="p-3">Nome</th><th className="p-3">Conexão</th><th className="p-3">Imprime</th><th className="p-3">Quando</th><th className="p-3">Ativa</th><th /></tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {printers.map((p) => (
                <tr key={p.id}>
                  <td className="p-3 font-medium">{p.name}<span className="block text-xs font-normal text-zinc-500">{p.paper_width} mm{p.copies > 1 ? ` · ${p.copies} cópias` : ""}</span></td>
                  <td className="p-3">{CONNECTION_LABEL[p.connection]}{p.address && <span className="block font-mono text-xs text-zinc-500">{p.address}</span>}</td>
                  <td className="p-3">{[...p.stations.map((s) => `Comanda ${s}`), ...(p.print_receipt ? ["Via do pedido"] : [])].join(", ")}</td>
                  <td className="p-3 text-zinc-600">{p.on_event === "accepted" ? "Ao aceitar" : "Ao chegar"}</td>
                  <td className="p-3"><Toggle checked={p.active} label="Ativa" onChange={async (v) => { const { error } = await sb.from("printers").update({ active: v }).eq("id", p.id); if (error) setErr(errorMessage(error)); await onChanged(); }} /></td>
                  <td className="whitespace-nowrap p-3 text-right">
                    <button className="btn-ghost" onClick={() => test(p)}>Imprimir teste</button>
                    <button className="btn-ghost" onClick={() => { setErr(""); setEdit({ id: p.id, f: { name: p.name, connection: p.connection, address: p.address ?? "", paper_width: p.paper_width, stations: p.stations, print_receipt: p.print_receipt, copies: p.copies, on_event: p.on_event, active: p.active } }); }}>Editar</button>
                    <button className="btn-ghost text-red-600" onClick={() => remove(p)}>Excluir</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? "Editar impressora" : "Nova impressora"}>
        {edit && (
          <form onSubmit={save} className="space-y-3">
            <Field label="Nome"><input className="input" required maxLength={60} value={edit.f.name} onChange={(e) => set("name", e.target.value)} placeholder="Ex.: Cozinha, Bar, Balcão" /></Field>
            <Field label="Conexão">
              <select className="input" value={edit.f.connection} onChange={(e) => set("connection", e.target.value as Printer["connection"])}>
                {(Object.keys(CONNECTION_LABEL) as Printer["connection"][]).map((k) => <option key={k} value={k}>{CONNECTION_LABEL[k]}</option>)}
              </select>
            </Field>
            {edit.f.connection === "network" && (
              <Field label="IP e porta" hint="Ex.: 192.168.0.50:9100. A maioria das térmicas de rede usa a porta 9100.">
                <input className="input font-mono" value={edit.f.address ?? ""} onChange={(e) => set("address", e.target.value)} placeholder="192.168.0.50:9100" />
              </Field>
            )}
            {edit.f.connection === "system" && (
              <Field label="Nome da impressora no computador" hint="Exatamente como aparece em Impressoras do Windows (ou no comando lpstat no Mac/Linux).">
                <input className="input" value={edit.f.address ?? ""} onChange={(e) => set("address", e.target.value)} placeholder="Ex.: EPSON TM-T20" />
              </Field>
            )}
            {edit.f.connection === "browser" && <p className="rounded-lg bg-zinc-50 p-3 text-xs text-zinc-600">Deixe a tela Estação de impressão aberta no computador ligado a esta impressora. Não precisa instalar nada.</p>}
            <div className="grid grid-cols-2 gap-3">
              <Field label="Papel">
                <select className="input" value={edit.f.paper_width} onChange={(e) => set("paper_width", Number(e.target.value) as 58 | 80)}>
                  <option value={80}>80 mm</option><option value={58}>58 mm</option>
                </select>
              </Field>
              <Field label="Cópias">
                <select className="input" value={edit.f.copies} onChange={(e) => set("copies", Number(e.target.value))}>
                  {[1, 2, 3].map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </Field>
            </div>
            <div>
              <p className="label">Comandas dos setores</p>
              <div className="flex flex-wrap gap-3">
                {stations.map((s) => (
                  <label key={s} className="flex items-center gap-2 text-sm capitalize">
                    <input type="checkbox" checked={edit.f.stations.includes(s)}
                      onChange={(e) => set("stations", e.target.checked ? [...edit.f.stations, s] : edit.f.stations.filter((x) => x !== s))} /> {s}
                  </label>
                ))}
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={edit.f.print_receipt} onChange={(e) => set("print_receipt", e.target.checked)} /> Imprimir a via completa do pedido (valores, pagamento e endereço)</label>
            <Field label="Quando imprimir">
              <select className="input" value={edit.f.on_event} onChange={(e) => set("on_event", e.target.value as Printer["on_event"])}>
                <option value="accepted">Ao aceitar o pedido (recomendado)</option>
                <option value="created">Assim que o pedido chega</option>
              </select>
            </Field>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={edit.f.active} onChange={(e) => set("active", e.target.checked)} /> Ativa</label>
            <Alert>{err}</Alert>
            <button className="btn-primary w-full" disabled={busy}>{busy ? "Salvando..." : "Salvar"}</button>
          </form>
        )}
      </Modal>
    </section>
  );
}
