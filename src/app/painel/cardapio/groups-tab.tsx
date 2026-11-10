"use client";
import { useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { usePanel } from "@/lib/panel/context";
import { Alert, Empty, Field, Modal, Toggle } from "@/components/ui";
import { brl, centsToInput, errorMessage, parseBRL } from "@/lib/format";
import { PRICE_RULE_LABEL, type MenuData, type Option, type OptionGroup } from "./types";

export function GroupsTab({ data, editable, reload, onError }: {
  data: MenuData; editable: boolean; reload: () => Promise<void>; onError: (m: string) => void;
}) {
  const sb = supabaseBrowser();
  const [editing, setEditing] = useState<OptionGroup | "new" | null>(null);

  async function run(fn: () => PromiseLike<{ error: unknown }>) {
    onError("");
    const { error } = await fn();
    if (error) onError(errorMessage(error));
    await reload();
  }

  async function moveOption(o: Option, dir: -1 | 1) {
    const list = data.options.filter((x) => x.group_id === o.group_id);
    const i = list.findIndex((x) => x.id === o.id); const j = i + dir;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    await Promise.all(list.map((x, idx) => x.position === idx ? Promise.resolve() : sb.from("options").update({ position: idx }).eq("id", x.id)));
    await reload();
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-zinc-600">Grupos reutilizáveis: bordas, sabores, adicionais, ponto da carne...</p>
        {editable && <button className="btn-primary" onClick={() => setEditing("new")}>+ Grupo</button>}
      </div>
      {data.groups.length === 0 && <Empty>Nenhum grupo de complementos ainda.</Empty>}
      {data.groups.map((g) => {
        const opts = data.options.filter((o) => o.group_id === g.id);
        const usedBy = data.links.filter((l) => l.group_id === g.id)
          .map((l) => data.products.find((p) => p.id === l.product_id)?.name).filter(Boolean);
        return (
          <section key={g.id} className="card" aria-label={g.name}>
            <div className="flex flex-wrap items-start gap-2">
              <div className="mr-auto">
                <h3 className="font-semibold">{g.name}</h3>
                <p className="text-xs text-zinc-500">
                  {g.min_select > 0 ? `Obrigatório · mín ${g.min_select}` : "Opcional"} · máx {g.max_select}
                  {g.allow_repeat && " · permite repetir"} · {PRICE_RULE_LABEL[g.price_rule]}
                </p>
                <p className="mt-1 text-xs text-zinc-500">
                  Usado em: {usedBy.length ? usedBy.join(", ") : <i>nenhum produto</i>}
                </p>
              </div>
              {editable && (
                <>
                  <button className="btn-secondary px-2 py-1 text-xs" onClick={() => setEditing(g)}>Editar grupo</button>
                  <button className="btn-ghost px-2 py-1 text-xs text-red-700"
                    onClick={() => { if (confirm(`Excluir o grupo "${g.name}"? Ele sai de todos os produtos.`)) void run(() => sb.from("option_groups").delete().eq("id", g.id)); }}>
                    Excluir
                  </button>
                </>
              )}
            </div>
            <ul className="mt-3 divide-y divide-zinc-100">
              {opts.map((o, idx) => (
                <OptionRow key={o.id} o={o} editable={editable} first={idx === 0} last={idx === opts.length - 1}
                  onMove={(d) => void moveOption(o, d)}
                  onSave={(row) => run(() => sb.from("options").update(row).eq("id", o.id))}
                  onDelete={() => { if (confirm(`Excluir "${o.name}"?`)) void run(() => sb.from("options").delete().eq("id", o.id)); }} />
              ))}
            </ul>
            {editable && <NewOption group={g} position={opts.length} onCreated={reload} onError={onError} />}
          </section>
        );
      })}
      {editing && (
        <GroupModal group={editing === "new" ? null : editing} onClose={() => setEditing(null)}
          onSaved={async () => { setEditing(null); await reload(); }} />
      )}
    </div>
  );
}

function OptionRow({ o, editable, first, last, onMove, onSave, onDelete }: {
  o: Option; editable: boolean; first: boolean; last: boolean;
  onMove: (d: -1 | 1) => void; onSave: (row: Partial<Option>) => Promise<void>; onDelete: () => void;
}) {
  const [name, setName] = useState(o.name);
  const [price, setPrice] = useState(centsToInput(o.price_cents));
  const dirty = name.trim() !== o.name || parseBRL(price) !== o.price_cents;
  if (!editable) {
    return (
      <li className="flex justify-between py-2 text-sm">
        <span className={o.active ? "" : "text-zinc-400 line-through"}>{o.name}</span>
        <span>{o.price_cents ? `+ ${brl(o.price_cents)}` : "grátis"}</span>
      </li>
    );
  }
  return (
    <li className="flex flex-wrap items-center gap-2 py-2">
      <input className="input min-w-0 flex-1" aria-label="Nome da opção" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
      <input className="input w-24" aria-label="Preço da opção" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
      {dirty && <button className="btn-primary px-2 py-1 text-xs" disabled={!name.trim()}
        onClick={() => void onSave({ name: name.trim(), price_cents: parseBRL(price) })}>Salvar</button>}
      <Toggle checked={o.active} label={`Ativar ${o.name}`} onChange={(v) => void onSave({ active: v })} />
      <button className="px-1 disabled:opacity-30" disabled={first} onClick={() => onMove(-1)} aria-label="Subir">↑</button>
      <button className="px-1 disabled:opacity-30" disabled={last} onClick={() => onMove(1)} aria-label="Descer">↓</button>
      <button className="px-1 text-red-700" onClick={onDelete} aria-label={`Excluir ${o.name}`}>✕</button>
    </li>
  );
}

function NewOption({ group, position, onCreated, onError }: {
  group: OptionGroup; position: number; onCreated: () => Promise<void>; onError: (m: string) => void;
}) {
  const { tenantId } = usePanel();
  const sb = supabaseBrowser();
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [busy, setBusy] = useState(false);
  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true); onError("");
    const { error } = await sb.from("options").insert({
      tenant_id: tenantId, group_id: group.id, name: name.trim(), price_cents: price ? parseBRL(price) : 0, position,
    });
    setBusy(false);
    if (error) { onError(errorMessage(error)); return; }
    setName(""); setPrice("");
    await onCreated();
  }
  return (
    <form onSubmit={add} className="mt-2 flex flex-wrap gap-2 border-t border-zinc-100 pt-2">
      <input className="input min-w-0 flex-1" placeholder="Nova opção (ex.: Catupiry)" maxLength={80} aria-label="Nova opção"
        value={name} onChange={(e) => setName(e.target.value)} />
      <input className="input w-24" placeholder="0,00" inputMode="decimal" aria-label="Preço" value={price} onChange={(e) => setPrice(e.target.value)} />
      <button className="btn-secondary" disabled={busy || !name.trim()}>Adicionar</button>
    </form>
  );
}

function GroupModal({ group, onClose, onSaved }: { group: OptionGroup | null; onClose: () => void; onSaved: () => Promise<void> }) {
  const { tenantId } = usePanel();
  const sb = supabaseBrowser();
  const [name, setName] = useState(group?.name ?? "");
  const [min, setMin] = useState(group?.min_select ?? 0);
  const [max, setMax] = useState(group?.max_select ?? 1);
  const [repeat, setRepeat] = useState(group?.allow_repeat ?? false);
  const [rule, setRule] = useState<OptionGroup["price_rule"]>(group?.price_rule ?? "sum");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (max < 1 || min < 0 || max < min) { setErr("O máximo deve ser pelo menos 1 e maior ou igual ao mínimo."); return; }
    setBusy(true); setErr("");
    const row = { name: name.trim(), min_select: min, max_select: max, allow_repeat: repeat, price_rule: rule };
    const { error } = group
      ? await sb.from("option_groups").update(row).eq("id", group.id)
      : await sb.from("option_groups").insert({ ...row, tenant_id: tenantId });
    setBusy(false);
    if (error) { setErr(errorMessage(error)); return; }
    await onSaved();
  }

  return (
    <Modal open onClose={onClose} title={group ? "Editar grupo" : "Novo grupo de complementos"}>
      <form onSubmit={save} className="space-y-4">
        <Field label="Nome do grupo"><input className="input" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Sabores, Borda, Adicionais" autoFocus /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Mínimo" hint="0 = opcional"><input className="input" type="number" min={0} max={50} value={min} onChange={(e) => setMin(Number(e.target.value))} /></Field>
          <Field label="Máximo"><input className="input" type="number" min={1} max={50} value={max} onChange={(e) => setMax(Number(e.target.value))} /></Field>
        </div>
        <label className="flex items-center gap-2 text-sm"><Toggle checked={repeat} onChange={setRepeat} label="Permitir repetir" /> Permitir repetir a mesma opção (ex.: 2x bacon)</label>
        <fieldset>
          <legend className="label">Como cobrar</legend>
          <div className="space-y-2">
            {(Object.keys(PRICE_RULE_LABEL) as OptionGroup["price_rule"][]).map((k) => (
              <label key={k} className="flex items-center gap-2 text-sm">
                <input type="radio" name="rule" checked={rule === k} onChange={() => setRule(k)} /> {PRICE_RULE_LABEL[k]}
              </label>
            ))}
          </div>
          <p className="mt-2 text-xs text-zinc-500">
            Pizza meio a meio: deixe o preço do produto em R$ 0,00, cadastre cada sabor com o preço da pizza inteira e use “Maior valor” ou “Média”.
          </p>
        </fieldset>
        <Alert>{err}</Alert>
        <div className="flex gap-2">
          <button className="btn-primary" disabled={busy}>{busy ? "Salvando..." : "Salvar"}</button>
          <button type="button" className="btn-ghost" onClick={onClose}>Cancelar</button>
        </div>
      </form>
    </Modal>
  );
}
