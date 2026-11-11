"use client";
import { useCallback, useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { usePanel } from "@/lib/panel/context";
import { Alert, Empty, Field, Modal, Toggle } from "@/components/ui";
import { brl, centsToInput, errorMessage, parseBRL } from "@/lib/format";

type Coupon = {
  id: string; code: string; description: string | null; kind: "percent" | "fixed" | "free_delivery"; value: number;
  min_order_cents: number; max_discount_cents: number | null; max_uses: number | null; uses_count: number;
  max_uses_per_customer: number | null; first_order_only: boolean; starts_at: string | null; ends_at: string | null; active: boolean;
};

const blank = { code: "", description: "", kind: "percent" as Coupon["kind"], value: "10", min: "", maxDiscount: "",
  maxUses: "", perCustomer: "1", firstOrder: false, starts: "", ends: "" };

const toLocal = (iso: string | null) => (iso ? new Date(new Date(iso).getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : "");

function describe(c: Coupon) {
  const v = c.kind === "percent" ? `${c.value}% de desconto` : c.kind === "fixed" ? `${brl(c.value)} de desconto` : "Frete grátis";
  const r = [c.min_order_cents ? `acima de ${brl(c.min_order_cents)}` : "", c.first_order_only ? "1º pedido" : "",
    c.max_uses_per_customer ? `${c.max_uses_per_customer}x por cliente` : ""].filter(Boolean).join(" · ");
  return r ? `${v} · ${r}` : v;
}

export default function Cupons() {
  const { tenantId } = usePanel();
  const sb = supabaseBrowser();
  const [list, setList] = useState<Coupon[]>([]);
  const [edit, setEdit] = useState<{ id?: string; f: typeof blank } | null>(null);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    const { data, error } = await sb.from("coupons").select("*").eq("tenant_id", tenantId).order("created_at", { ascending: false });
    if (error) setErr(error.message); else setList(data as Coupon[]);
  }, [sb, tenantId]);
  useEffect(() => { load(); }, [load]);

  const set = (k: keyof typeof blank, v: string | boolean) => setEdit((s) => s && { ...s, f: { ...s.f, [k]: v } });

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!edit) return;
    const f = edit.f;
    const row = {
      tenant_id: tenantId, code: f.code.trim().toUpperCase(), description: f.description || null, kind: f.kind,
      value: f.kind === "percent" ? Number(f.value) : f.kind === "fixed" ? parseBRL(f.value) : 0,
      min_order_cents: parseBRL(f.min), max_discount_cents: f.kind === "percent" && f.maxDiscount ? parseBRL(f.maxDiscount) : null,
      max_uses: f.maxUses ? Number(f.maxUses) : null, max_uses_per_customer: f.perCustomer ? Number(f.perCustomer) : null,
      first_order_only: f.firstOrder,
      starts_at: f.starts ? new Date(f.starts).toISOString() : null, ends_at: f.ends ? new Date(f.ends).toISOString() : null,
    };
    const { error } = edit.id ? await sb.from("coupons").update(row).eq("id", edit.id) : await sb.from("coupons").insert(row);
    if (error) {
      setErr(error.code === "23505" ? "Já existe um cupom com este código." : error.code === "23514" ? "Confira os campos: código só com letras, números, _ ou - (3 a 30) e percentual entre 1 e 100." : errorMessage(error));
      return;
    }
    setEdit(null); setErr(""); load();
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="h1">Cupons</h1>
        <button className="btn-primary" onClick={() => setEdit({ f: blank })}>+ Novo cupom</button>
      </div>
      <Alert>{err && !edit ? err : ""}</Alert>
      {list.length === 0 ? <Empty>Nenhum cupom ainda. Que tal um BEMVINDO10 para o primeiro pedido?</Empty> : (
        <div className="overflow-x-auto rounded-lg border border-zinc-200/70 bg-white shadow-soft">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50/80 text-left text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
              <tr><th className="p-3">Código</th><th className="p-3">Regra</th><th className="p-3">Usos</th><th className="p-3">Validade</th><th className="p-3">Ativo</th><th /></tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {list.map((c) => (
                <tr key={c.id}>
                  <td className="p-3 font-mono font-semibold">{c.code}</td>
                  <td className="p-3">{describe(c)}</td>
                  <td className="p-3 tabular-nums">{c.uses_count}{c.max_uses ? ` / ${c.max_uses}` : ""}</td>
                  <td className="p-3 text-xs text-zinc-600">{c.ends_at ? `até ${new Date(c.ends_at).toLocaleString("pt-BR")}` : "sem prazo"}</td>
                  <td className="p-3"><Toggle checked={c.active} label="Ativo" onChange={async (v) => { await sb.from("coupons").update({ active: v }).eq("id", c.id); load(); }} /></td>
                  <td className="whitespace-nowrap p-3 text-right">
                    <button className="btn-ghost" onClick={() => setEdit({ id: c.id, f: {
                      code: c.code, description: c.description ?? "", kind: c.kind,
                      value: c.kind === "fixed" ? centsToInput(c.value) : String(c.value),
                      min: c.min_order_cents ? centsToInput(c.min_order_cents) : "", maxDiscount: c.max_discount_cents ? centsToInput(c.max_discount_cents) : "",
                      maxUses: c.max_uses ? String(c.max_uses) : "", perCustomer: c.max_uses_per_customer ? String(c.max_uses_per_customer) : "",
                      firstOrder: c.first_order_only, starts: toLocal(c.starts_at), ends: toLocal(c.ends_at) } })}>Editar</button>
                    <button className="btn-ghost text-red-600" onClick={async () => {
                      if (c.uses_count > 0) { setErr("Este cupom já foi usado em pedidos. Desative em vez de excluir, para manter o histórico."); return; }
                      if (!confirm(`Excluir o cupom ${c.code}?`)) return;
                      const { error } = await sb.from("coupons").delete().eq("id", c.id);
                      if (error) setErr("Este cupom já foi usado em pedidos. Desative em vez de excluir."); else load();
                    }}>Excluir</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal open={!!edit} onClose={() => { setEdit(null); setErr(""); }} title={edit?.id ? "Editar cupom" : "Novo cupom"}>
        {edit && (
          <form onSubmit={save} className="space-y-3">
            <Field label="Código"><input className="input font-mono uppercase" required pattern="[A-Za-z0-9_\-]{3,30}" value={edit.f.code} onChange={(e) => set("code", e.target.value.toUpperCase())} /></Field>
            <Field label="Descrição interna"><input className="input" value={edit.f.description} onChange={(e) => set("description", e.target.value)} /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Tipo">
                <select className="input" value={edit.f.kind} onChange={(e) => set("kind", e.target.value)}>
                  <option value="percent">Percentual (%)</option>
                  <option value="fixed">Valor fixo (R$)</option>
                  <option value="free_delivery">Frete grátis</option>
                </select>
              </Field>
              {edit.f.kind !== "free_delivery" && (
                <Field label={edit.f.kind === "percent" ? "Percentual" : "Valor (R$)"}>
                  <input className="input" required inputMode="decimal" value={edit.f.value} onChange={(e) => set("value", e.target.value)} />
                </Field>
              )}
              <Field label="Pedido mínimo (R$)"><input className="input" inputMode="decimal" value={edit.f.min} onChange={(e) => set("min", e.target.value)} /></Field>
              {edit.f.kind === "percent" && (
                <Field label="Desconto máximo (R$)"><input className="input" inputMode="decimal" value={edit.f.maxDiscount} onChange={(e) => set("maxDiscount", e.target.value)} /></Field>
              )}
              <Field label="Limite total de usos"><input className="input" type="number" min={1} value={edit.f.maxUses} onChange={(e) => set("maxUses", e.target.value)} placeholder="Ilimitado" /></Field>
              <Field label="Usos por cliente"><input className="input" type="number" min={1} value={edit.f.perCustomer} onChange={(e) => set("perCustomer", e.target.value)} placeholder="Ilimitado" /></Field>
              <Field label="Início"><input className="input" type="datetime-local" value={edit.f.starts} onChange={(e) => set("starts", e.target.value)} /></Field>
              <Field label="Fim"><input className="input" type="datetime-local" value={edit.f.ends} onChange={(e) => set("ends", e.target.value)} /></Field>
            </div>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={edit.f.firstOrder} onChange={(e) => set("firstOrder", e.target.checked)} /> Válido só no primeiro pedido do cliente</label>
            <Alert>{err}</Alert>
            <button className="btn-primary w-full">Salvar</button>
          </form>
        )}
      </Modal>
    </div>
  );
}
