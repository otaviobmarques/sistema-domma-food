"use client";
import { useMemo, useState } from "react";
import { Modal } from "@/components/ui";
import { brl } from "@/lib/format";
import { effectivePrice, groupPrice } from "./cart";
import type { CartItem, StoreProduct } from "./types";

export function ProductModal({ product, onClose, onAdd, color }: {
  product: StoreProduct; onClose: () => void; onAdd: (i: CartItem) => void; color: string;
}) {
  // selected[groupId][optionId] = quantidade
  const [sel, setSel] = useState<Record<string, Record<string, number>>>({});
  const [qty, setQty] = useState(1);
  const [notes, setNotes] = useState("");

  const counts = useMemo(() => Object.fromEntries(product.option_groups.map((g) =>
    [g.id, Object.values(sel[g.id] ?? {}).reduce((a, b) => a + b, 0)])), [sel, product]);

  const unitPrice = effectivePrice(product) +
    product.option_groups.reduce((s, g) => s + groupPrice(g, sel[g.id] ?? {}), 0);
  const missing = product.option_groups.find((g) => counts[g.id] < g.min);

  function setOpt(gid: string, oid: string, q: number, single: boolean) {
    setSel((prev) => {
      const g = single ? {} : { ...(prev[gid] ?? {}) };
      if (q <= 0) delete g[oid]; else g[oid] = q;
      return { ...prev, [gid]: g };
    });
  }

  function add() {
    const options = product.option_groups.flatMap((g) => g.options
      .filter((o) => (sel[g.id]?.[o.id] ?? 0) > 0)
      .map((o) => ({ option_id: o.id, name: o.name, price_cents: o.price_cents, quantity: sel[g.id][o.id], group: g.name })));
    const key = product.id + "|" + options.map((o) => `${o.option_id}x${o.quantity}`).sort().join(",") + "|" + notes.trim();
    onAdd({ key, product_id: product.id, name: product.name, quantity: qty, notes: notes.trim(), options, unit_price_cents: unitPrice });
  }

  return (
    <Modal open onClose={onClose} title={product.name}>
      {product.image_url && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={product.image_url} alt="" className="mb-3 h-48 w-full rounded-xl object-cover" />
      )}
      {product.description && <p className="mb-4 text-sm text-zinc-600">{product.description}</p>}

      <div className="space-y-5">
        {product.option_groups.map((g) => {
          const single = g.max === 1;
          const full = counts[g.id] >= g.max;
          return (
            <fieldset key={g.id}>
              <legend className="flex w-full items-center justify-between rounded-lg bg-zinc-100 px-3 py-2">
                <span className="font-semibold">{g.name}</span>
                <span className={`badge ${g.min > 0 ? "bg-amber-100 text-amber-800" : "bg-zinc-200 text-zinc-700"}`}>
                  {g.min > 0 ? `Obrigatório · ${counts[g.id]}/${g.max}` : `Opcional · até ${g.max}`}
                </span>
              </legend>
              <div className="divide-y divide-zinc-100">
                {g.options.map((o) => {
                  const q = sel[g.id]?.[o.id] ?? 0;
                  return (
                    <div key={o.id} className="flex items-center justify-between gap-3 py-2">
                      <div className="min-w-0">
                        <p className="text-sm font-medium">{o.name}</p>
                        {o.description && <p className="text-xs text-zinc-500">{o.description}</p>}
                        {o.price_cents > 0 && <p className="text-xs text-zinc-600">+ {brl(o.price_cents)}</p>}
                      </div>
                      {single ? (
                        <input type="radio" name={`g-${g.id}`} aria-label={o.name} className="h-5 w-5 accent-brand-700"
                          checked={q > 0} onChange={() => setOpt(g.id, o.id, 1, true)} />
                      ) : g.allow_repeat ? (
                        <Stepper value={q} label={o.name} onChange={(v) => setOpt(g.id, o.id, v, false)} canInc={!full} />
                      ) : (
                        <input type="checkbox" aria-label={o.name} className="h-5 w-5 accent-brand-700"
                          checked={q > 0} disabled={!q && full} onChange={(e) => setOpt(g.id, o.id, e.target.checked ? 1 : 0, false)} />
                      )}
                    </div>
                  );
                })}
              </div>
            </fieldset>
          );
        })}

        <label className="block">
          <span className="label">Alguma observação?</span>
          <textarea className="input" rows={2} maxLength={300} placeholder="Ex.: sem cebola" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>
      </div>

      <div className="sticky bottom-0 -mx-5 -mb-5 mt-5 flex items-center gap-3 border-t border-zinc-200 bg-white p-4">
        <Stepper value={qty} label="Quantidade" min={1} onChange={setQty} canInc={qty < 99} />
        <button className="btn flex-1 py-3 text-white" style={{ background: color }} disabled={!!missing} onClick={add}>
          {missing ? `Escolha ${g2(missing.name)}` : `Adicionar · ${brl(unitPrice * qty)}`}
        </button>
      </div>
    </Modal>
  );
}

const g2 = (n: string) => `"${n}"`;

export function Stepper({ value, onChange, label, min = 0, canInc = true }: {
  value: number; onChange: (v: number) => void; label: string; min?: number; canInc?: boolean;
}) {
  return (
    <div className="inline-flex items-center rounded-lg border border-zinc-300" role="group" aria-label={label}>
      <button type="button" className="px-3 py-1.5 text-lg disabled:opacity-30" aria-label={`Diminuir ${label}`}
        disabled={value <= min} onClick={() => onChange(value - 1)}>−</button>
      <span className="w-6 text-center text-sm font-semibold" aria-live="polite">{value}</span>
      <button type="button" className="px-3 py-1.5 text-lg disabled:opacity-30" aria-label={`Aumentar ${label}`}
        disabled={!canInc} onClick={() => onChange(value + 1)}>+</button>
    </div>
  );
}
