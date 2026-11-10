"use client";
import { useCallback, useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { usePanel } from "@/lib/panel/context";
import { Alert, Empty, Field, Modal, Toggle } from "@/components/ui";
import { brl, centsToInput, errorMessage, parseBRL } from "@/lib/format";

type Zone = {
  id: string; name: string; kind: "radius" | "neighborhood"; radius_km: number | null; neighborhoods: string[];
  fee_cents: number; min_order_cents: number; free_above_cents: number | null; eta_min: number; active: boolean;
};

const blank = { name: "", kind: "radius" as Zone["kind"], radius: "3", neighborhoods: "", fee: "5,00", min: "", free: "", eta: "40" };

export default function Entregas() {
  const { unit, tenantId } = usePanel();
  const sb = supabaseBrowser();
  const [zones, setZones] = useState<Zone[]>([]);
  const [hasLocation, setHasLocation] = useState(true);
  const [edit, setEdit] = useState<{ id?: string; f: typeof blank } | null>(null);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    const [{ data, error }, { data: u }] = await Promise.all([
      sb.from("delivery_zones").select("*").eq("unit_id", unit.id).order("kind").order("radius_km").order("fee_cents"),
      sb.from("units").select("lat").eq("id", unit.id).single(),
    ]);
    if (error) setErr(error.message); else setZones(data as Zone[]);
    setHasLocation(u?.lat != null);
  }, [sb, unit.id]);
  useEffect(() => { load(); }, [load]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!edit) return;
    const f = edit.f;
    const row = {
      tenant_id: tenantId, unit_id: unit.id, name: f.name.trim(), kind: f.kind,
      radius_km: f.kind === "radius" ? Number(f.radius.replace(",", ".")) : null,
      neighborhoods: f.kind === "neighborhood" ? f.neighborhoods.split(/[\n,;]/).map((s) => s.trim()).filter(Boolean) : [],
      fee_cents: parseBRL(f.fee), min_order_cents: parseBRL(f.min),
      free_above_cents: f.free ? parseBRL(f.free) : null, eta_min: Number(f.eta) || 40,
    };
    const q = edit.id ? sb.from("delivery_zones").update(row).eq("id", edit.id) : sb.from("delivery_zones").insert(row);
    const { error } = await q;
    if (error) { setErr(errorMessage(error)); return; }
    setEdit(null); setErr(""); load();
  }

  async function toggle(z: Zone) {
    const { error } = await sb.from("delivery_zones").update({ active: !z.active }).eq("id", z.id);
    if (error) setErr(error.message); else load();
  }
  async function remove(z: Zone) {
    if (!confirm(`Excluir a área "${z.name}"?`)) return;
    const { error } = await sb.from("delivery_zones").delete().eq("id", z.id);
    if (error) setErr(error.message); else load();
  }

  const set = (k: keyof typeof blank, v: string) => setEdit((s) => s && { ...s, f: { ...s.f, [k]: v } });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="h1">Áreas de entrega</h1>
        <button className="btn-primary" onClick={() => setEdit({ f: blank })}>+ Nova área</button>
      </div>
      <p className="text-sm text-zinc-600">
        Áreas por <b>raio</b> usam a localização do cliente (quando ele permite). Áreas por <b>bairro</b> usam o bairro digitado.
        O sistema escolhe primeiro o menor raio que atende e depois o bairro.
      </p>
      {!hasLocation && zones.some((z) => z.kind === "radius") && (
        <Alert kind="info">Para as áreas por raio funcionarem, informe a latitude e a longitude da loja em Configurações.</Alert>
      )}
      <Alert>{err}</Alert>
      {zones.length === 0 ? <Empty>Nenhuma área cadastrada. Sem áreas, a loja não aceita pedidos de entrega.</Empty> : (
        <div className="grid gap-3 md:grid-cols-2">
          {zones.map((z) => (
            <div key={z.id} className={`card ${z.active ? "" : "opacity-60"}`}>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h2 className="font-semibold">{z.name}</h2>
                  <p className="text-xs text-zinc-500">
                    {z.kind === "radius" ? `Raio de ${z.radius_km} km` : `${z.neighborhoods.length} bairro(s): ${z.neighborhoods.slice(0, 4).join(", ")}${z.neighborhoods.length > 4 ? "…" : ""}`}
                  </p>
                </div>
                <Toggle checked={z.active} onChange={() => toggle(z)} label="Ativa" />
              </div>
              <dl className="mt-3 grid grid-cols-2 gap-1 text-sm">
                <dt className="text-zinc-500">Taxa</dt><dd>{brl(z.fee_cents)}</dd>
                <dt className="text-zinc-500">Tempo</dt><dd>{z.eta_min} min</dd>
                <dt className="text-zinc-500">Pedido mínimo</dt><dd>{z.min_order_cents ? brl(z.min_order_cents) : "—"}</dd>
                <dt className="text-zinc-500">Frete grátis acima de</dt><dd>{z.free_above_cents ? brl(z.free_above_cents) : "—"}</dd>
              </dl>
              <div className="mt-3 flex gap-2">
                <button className="btn-secondary" onClick={() => setEdit({ id: z.id, f: {
                  name: z.name, kind: z.kind, radius: String(z.radius_km ?? ""), neighborhoods: z.neighborhoods.join("\n"),
                  fee: centsToInput(z.fee_cents), min: z.min_order_cents ? centsToInput(z.min_order_cents) : "",
                  free: z.free_above_cents ? centsToInput(z.free_above_cents) : "", eta: String(z.eta_min) } })}>Editar</button>
                <button className="btn-ghost text-red-600" onClick={() => remove(z)}>Excluir</button>
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? "Editar área" : "Nova área"}>
        {edit && (
          <form onSubmit={save} className="space-y-3">
            <Field label="Nome"><input className="input" required value={edit.f.name} onChange={(e) => set("name", e.target.value)} placeholder="Ex.: Até 5 km" /></Field>
            <Field label="Tipo">
              <select className="input" value={edit.f.kind} onChange={(e) => set("kind", e.target.value)}>
                <option value="radius">Raio (km)</option>
                <option value="neighborhood">Lista de bairros</option>
              </select>
            </Field>
            {edit.f.kind === "radius" ? (
              <Field label="Raio em km"><input className="input" required inputMode="decimal" value={edit.f.radius} onChange={(e) => set("radius", e.target.value)} /></Field>
            ) : (
              <Field label="Bairros" hint="Um por linha ou separados por vírgula. Acentos e maiúsculas não importam.">
                <textarea className="input min-h-28" required value={edit.f.neighborhoods} onChange={(e) => set("neighborhoods", e.target.value)} />
              </Field>
            )}
            <div className="grid grid-cols-2 gap-3">
              <Field label="Taxa (R$)"><input className="input" inputMode="decimal" value={edit.f.fee} onChange={(e) => set("fee", e.target.value)} /></Field>
              <Field label="Tempo estimado (min)"><input className="input" type="number" min={0} max={600} value={edit.f.eta} onChange={(e) => set("eta", e.target.value)} /></Field>
              <Field label="Pedido mínimo (R$)"><input className="input" inputMode="decimal" value={edit.f.min} onChange={(e) => set("min", e.target.value)} /></Field>
              <Field label="Frete grátis acima de (R$)"><input className="input" inputMode="decimal" value={edit.f.free} onChange={(e) => set("free", e.target.value)} /></Field>
            </div>
            <Alert>{err}</Alert>
            <button className="btn-primary w-full">Salvar</button>
          </form>
        )}
      </Modal>
    </div>
  );
}
