"use client";
import { useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { canManage, usePanel } from "@/lib/panel/context";
import { Alert, Empty, Field, Modal, Toggle } from "@/components/ui";
import { centsToInput, errorMessage, formatPhone, onlyDigits, parseBRL } from "@/lib/format";
import { courierUrl, feeLabel, VEHICLE, whatsappLink, type Courier } from "./shared";

type Form = { name: string; phone: string; vehicle: string; pix_key: string; fee_mode: Courier["fee_mode"]; fee: string };
const blank: Form = { name: "", phone: "", vehicle: "moto", pix_key: "", fee_mode: "fixed", fee: "5,00" };

export function CouriersTab({ couriers, reload }: { couriers: Courier[]; reload: () => Promise<void> }) {
  const { unit, role } = usePanel();
  const sb = supabaseBrowser();
  const manager = canManage(role);
  const [edit, setEdit] = useState<{ id: string | null; f: Form } | null>(null);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  function open(c?: Courier) {
    setErr("");
    setEdit(c ? { id: c.id, f: { name: c.name, phone: c.phone ? formatPhone(c.phone) : "", vehicle: c.vehicle, pix_key: c.pix_key ?? "",
      fee_mode: c.fee_mode, fee: c.fee_mode === "fixed" ? centsToInput(c.fee_value) : c.fee_mode === "percent" ? String(c.fee_value / 100).replace(".", ",") : "" } }
      : { id: null, f: blank });
  }
  const set = (k: keyof Form, v: string) => setEdit((e) => e && { ...e, f: { ...e.f, [k]: v } });

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!edit) return;
    const f = edit.f;
    const feeValue = f.fee_mode === "fixed" ? parseBRL(f.fee) : f.fee_mode === "percent" ? Math.round((Number(f.fee.replace(",", ".")) || 0) * 100) : 0;
    if (f.fee_mode === "percent" && (feeValue <= 0 || feeValue > 10000)) { setErr("Informe um percentual entre 0 e 100."); return; }
    if (onlyDigits(f.phone) && onlyDigits(f.phone).length < 10) { setErr("Telefone incompleto."); return; }
    setBusy(true); setErr("");
    const { error } = await sb.rpc("courier_save", { p_id: edit.id, p_unit_id: unit.id, p: {
      name: f.name.trim(), phone: onlyDigits(f.phone), vehicle: f.vehicle, pix_key: f.pix_key.trim(), fee_mode: f.fee_mode, fee_value: feeValue } });
    setBusy(false);
    if (error) { setErr(errorMessage(error)); return; }
    setEdit(null); setMsg("Entregador salvo."); await reload();
  }

  async function setActive(c: Courier, v: boolean) {
    setErr("");
    const { error } = await sb.rpc("courier_save", { p_id: c.id, p_unit_id: unit.id, p: { active: v } });
    if (error) setErr(errorMessage(error)); else await reload();
  }

  async function link(c: Courier, mode: "copy" | "wa" | "rotate") {
    setErr(""); setMsg("");
    if (mode === "rotate" && !confirm(`Gerar um novo link para ${c.name}? O link atual para de funcionar na hora e você precisa enviar o novo para ele.`)) return;
    const { data, error } = mode === "rotate" ? await sb.rpc("courier_rotate_link", { p_id: c.id }) : await sb.rpc("courier_link", { p_id: c.id });
    if (error) { setErr(errorMessage(error)); return; }
    const url = courierUrl(data as string);
    if (mode === "wa") { window.open(whatsappLink(c, url, unit.name), "_blank", "noopener,noreferrer"); return; }
    try { await navigator.clipboard.writeText(url); setMsg(mode === "rotate" ? `Novo link de ${c.name} gerado e copiado.` : `Link de ${c.name} copiado.`); }
    catch { setMsg(url); }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-zinc-500">Cada entregador recebe um link pessoal para usar no celular, sem precisar de login. Quem tiver o link vê as entregas dele: não compartilhe.</p>
        {manager && <button className="btn-primary" onClick={() => open()}>+ Novo entregador</button>}
      </div>
      <Alert>{err && !edit ? err : ""}</Alert>
      <Alert kind="success">{msg}</Alert>
      {couriers.length === 0 ? <Empty>Nenhum entregador cadastrado.</Empty> : (
        <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 text-left text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
              <tr><th className="p-3">Nome</th><th className="p-3">Telefone</th><th className="p-3">Veículo</th><th className="p-3">Pagamento</th><th className="p-3">Ativo</th><th /></tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {couriers.map((c) => (
                <tr key={c.id} className={c.active ? "" : "opacity-60"}>
                  <td className="p-3 font-medium">{c.name}</td>
                  <td className="p-3 tabular-nums text-zinc-600">{c.phone ? formatPhone(c.phone) : "—"}</td>
                  <td className="p-3">{VEHICLE[c.vehicle] ?? c.vehicle}</td>
                  <td className="p-3">{feeLabel(c)}</td>
                  <td className="p-3">{manager ? <Toggle checked={c.active} label="Ativo" onChange={(v) => void setActive(c, v)} /> : c.active ? "Sim" : "Não"}</td>
                  <td className="whitespace-nowrap p-3 text-right">
                    {manager && (
                      <>
                        <button className="btn-ghost px-2 text-xs" onClick={() => void link(c, "copy")}>Copiar link</button>
                        <button className="btn-ghost px-2 text-xs" onClick={() => void link(c, "wa")}>WhatsApp</button>
                        <button className="btn-ghost px-2 text-xs text-red-600" onClick={() => void link(c, "rotate")}>Gerar novo link</button>
                        <button className="btn-ghost px-2 text-xs" onClick={() => open(c)}>Editar</button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? "Editar entregador" : "Novo entregador"}>
        {edit && (
          <form onSubmit={save} className="space-y-3">
            <Field label="Nome"><input className="input" required minLength={2} maxLength={80} value={edit.f.name} onChange={(e) => set("name", e.target.value)} /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="WhatsApp"><input className="input" inputMode="tel" value={edit.f.phone} onChange={(e) => set("phone", formatPhone(e.target.value))} placeholder="(31) 99999-9999" /></Field>
              <Field label="Veículo">
                <select className="input" value={edit.f.vehicle} onChange={(e) => set("vehicle", e.target.value)}>
                  {Object.entries(VEHICLE).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
              </Field>
            </div>
            <Field label="Chave Pix (para pagar o entregador)"><input className="input" maxLength={120} value={edit.f.pix_key} onChange={(e) => set("pix_key", e.target.value)} /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Como ele ganha">
                <select className="input" value={edit.f.fee_mode} onChange={(e) => set("fee_mode", e.target.value)}>
                  <option value="fixed">Valor fixo por entrega</option>
                  <option value="delivery_fee">A taxa de entrega cobrada</option>
                  <option value="percent">Percentual da taxa de entrega</option>
                </select>
              </Field>
              {edit.f.fee_mode !== "delivery_fee" && (
                <Field label={edit.f.fee_mode === "fixed" ? "Valor por entrega (R$)" : "Percentual (%)"}>
                  <input className="input text-right tabular-nums" inputMode="decimal" required value={edit.f.fee} onChange={(e) => set("fee", e.target.value)} />
                </Field>
              )}
            </div>
            <Alert>{err}</Alert>
            <button className="btn-primary w-full" disabled={busy}>{busy ? "Salvando..." : "Salvar"}</button>
          </form>
        )}
      </Modal>
    </div>
  );
}
