"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { Modal } from "@/components/ui";
import { brl } from "@/lib/format";

export type PosOption = { id: string; name: string; price_cents: number };
export type PosGroup = { id: string; name: string; min: number; max: number; allow_repeat: boolean; price_rule: "sum" | "max" | "avg"; options: PosOption[] };
export type PosProduct = { id: string; category_id: string; name: string; description: string | null; image_url: string | null; price_cents: number; available: boolean; groups: PosGroup[] };
export type PosCategory = { id: string; name: string };
export type PosCatalog = { loading: boolean; error: string; categories: PosCategory[]; products: PosProduct[]; reload: () => void };
export type PosLineOption = { option_id: string; name: string; price_cents: number; quantity: number; group: string };
export type PosLine = { key: string; product_id: string; name: string; quantity: number; unit_price_cents: number; notes: string; options: PosLineOption[] };

export const linesToPayload = (lines: PosLine[]) => lines.map((l) => ({
  product_id: l.product_id, quantity: l.quantity, notes: l.notes || undefined,
  options: l.options.map((o) => ({ option_id: o.option_id, quantity: o.quantity })),
}));
export const linesTotal = (lines: PosLine[]) => lines.reduce((s, l) => s + l.unit_price_cents * l.quantity, 0);

// Mesma regra do servidor (private.price_items): soma, maior valor ou média (arredondada para cima)
export function groupPrice(g: PosGroup, sel: Record<string, number>): number {
  const prices: number[] = [];
  for (const o of g.options) for (let i = 0; i < (sel[o.id] ?? 0); i++) prices.push(o.price_cents);
  if (!prices.length) return 0;
  if (g.price_rule === "max") return Math.max(...prices);
  if (g.price_rule === "avg") return Math.ceil(prices.reduce((a, b) => a + b, 0) / prices.length);
  return prices.reduce((a, b) => a + b, 0);
}

/** Carrega o cardápio para venda interna (balcão ou mesa), já com preço por loja. */
export function usePosCatalog(tenantId: string, unitId: string, channel: "counter" | "table"): PosCatalog {
  const [state, setState] = useState<Omit<PosCatalog, "reload">>({ loading: true, error: "", categories: [], products: [] });
  const load = useCallback(async () => {
    const sb = supabaseBrowser();
    const [cats, prods, groups, opts, links, ovs] = await Promise.all([
      sb.from("categories").select("id, name, position").eq("tenant_id", tenantId).eq("active", true).order("position"),
      sb.from("products").select("id, category_id, name, description, image_url, price_cents, promo_price_cents, paused_until, position")
        .eq("tenant_id", tenantId).eq("active", true).contains("channels", [channel]).order("position").order("name"),
      sb.from("option_groups").select("id, name, min_select, max_select, allow_repeat, price_rule").eq("tenant_id", tenantId),
      sb.from("options").select("id, group_id, name, price_cents, position").eq("tenant_id", tenantId).eq("active", true).order("position"),
      sb.from("product_option_groups").select("product_id, group_id, position").eq("tenant_id", tenantId).order("position"),
      sb.from("product_unit_overrides").select("product_id, price_cents, available").eq("unit_id", unitId),
    ]);
    const err = cats.error ?? prods.error ?? groups.error ?? opts.error ?? links.error ?? ovs.error;
    if (err) { setState((s) => ({ ...s, loading: false, error: err.message })); return; }
    type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    const gmap = new Map<string, PosGroup>((groups.data as Row[]).map((g) => [g.id, {
      id: g.id, name: g.name, min: g.min_select, max: g.max_select, allow_repeat: g.allow_repeat, price_rule: g.price_rule,
      options: (opts.data as Row[]).filter((o) => o.group_id === g.id).map((o) => ({ id: o.id, name: o.name, price_cents: o.price_cents })),
    }]));
    const omap = new Map<string, Row>((ovs.data as Row[]).map((o) => [o.product_id, o]));
    const now = Date.now();
    const products: PosProduct[] = (prods.data as Row[]).map((p) => {
      const ov = omap.get(p.id);
      return {
        id: p.id, category_id: p.category_id, name: p.name, description: p.description, image_url: p.image_url,
        price_cents: ov?.price_cents ?? p.promo_price_cents ?? p.price_cents,
        available: (ov?.available ?? true) && !(p.paused_until && new Date(p.paused_until).getTime() > now),
        groups: (links.data as Row[]).filter((l) => l.product_id === p.id).map((l) => gmap.get(l.group_id)).filter(Boolean) as PosGroup[],
      };
    });
    const used = new Set(products.map((p) => p.category_id));
    setState({ loading: false, error: "", products, categories: (cats.data as Row[]).filter((c) => used.has(c.id)).map((c) => ({ id: c.id, name: c.name })) });
  }, [tenantId, unitId, channel]);
  useEffect(() => { load(); }, [load]);
  return { ...state, reload: load };
}

function Qty({ value, onChange, min = 0, max = 99, label }: { value: number; onChange: (v: number) => void; min?: number; max?: number; label: string }) {
  return (
    <span className="inline-flex items-center rounded-lg border border-zinc-300 bg-white">
      <button type="button" className="h-9 w-9 text-lg disabled:opacity-30" disabled={value <= min} onClick={() => onChange(value - 1)} aria-label={`Diminuir ${label}`}>−</button>
      <span className="w-7 text-center text-sm font-semibold tabular-nums">{value}</span>
      <button type="button" className="h-9 w-9 text-lg disabled:opacity-30" disabled={value >= max} onClick={() => onChange(value + 1)} aria-label={`Aumentar ${label}`}>+</button>
    </span>
  );
}

function ProductDialog({ product, onClose, onAdd }: { product: PosProduct; onClose: () => void; onAdd: (l: PosLine) => void }) {
  const [sel, setSel] = useState<Record<string, Record<string, number>>>({});
  const [qty, setQty] = useState(1);
  const [notes, setNotes] = useState("");
  const count = (g: PosGroup) => Object.values(sel[g.id] ?? {}).reduce((a, b) => a + b, 0);
  const unit = product.price_cents + product.groups.reduce((s, g) => s + groupPrice(g, sel[g.id] ?? {}), 0);
  const valid = product.groups.every((g) => count(g) >= g.min && count(g) <= g.max);

  function setOpt(g: PosGroup, id: string, n: number) {
    setSel((s) => {
      const cur = { ...(s[g.id] ?? {}) };
      if (g.max === 1 && n > 0) return { ...s, [g.id]: { [id]: 1 } };
      if (n <= 0) delete cur[id]; else cur[id] = n;
      return { ...s, [g.id]: cur };
    });
  }
  function add() {
    const options: PosLineOption[] = product.groups.flatMap((g) => g.options.filter((o) => (sel[g.id]?.[o.id] ?? 0) > 0)
      .map((o) => ({ option_id: o.id, name: o.name, price_cents: o.price_cents, quantity: sel[g.id][o.id], group: g.name })));
    onAdd({ key: crypto.randomUUID(), product_id: product.id, name: product.name, quantity: qty, unit_price_cents: unit, notes: notes.trim(), options });
    onClose();
  }

  return (
    <Modal open onClose={onClose} title={product.name}>
      <div className="space-y-4">
        {product.groups.map((g) => {
          const c = count(g); const full = c >= g.max;
          return (
            <fieldset key={g.id}>
              <legend className="mb-1 flex w-full items-center justify-between rounded-lg bg-zinc-100 px-3 py-2 text-sm font-semibold">
                <span>{g.name}</span>
                <span className={`badge ${c < g.min ? "bg-amber-100 text-amber-800" : "bg-zinc-200 text-zinc-700"}`}>
                  {g.min > 0 ? `Obrigatório · ${g.min === g.max ? g.min : `${g.min} a ${g.max}`}` : `Opcional · até ${g.max}`}
                </span>
              </legend>
              <ul className="divide-y divide-zinc-100">
                {g.options.map((o) => {
                  const n = sel[g.id]?.[o.id] ?? 0;
                  return (
                    <li key={o.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                      <span>{o.name}{o.price_cents > 0 && <span className="ml-2 text-xs font-semibold text-brand-700">+ {brl(o.price_cents)}</span>}</span>
                      {g.allow_repeat && g.max > 1 ? (
                        <Qty value={n} max={n + (g.max - c)} onChange={(v) => setOpt(g, o.id, v)} label={o.name} />
                      ) : (
                        <input type={g.max === 1 ? "radio" : "checkbox"} name={g.id} className="h-5 w-5 accent-[#d9262b]" checked={n > 0}
                          disabled={g.max > 1 && full && n === 0} aria-label={o.name}
                          onChange={(e) => setOpt(g, o.id, e.target.checked ? 1 : 0)}
                          onClick={() => { if (g.max === 1 && g.min === 0 && n > 0) setOpt(g, o.id, 0); }} />
                      )}
                    </li>
                  );
                })}
              </ul>
            </fieldset>
          );
        })}
        <label className="block">
          <span className="label">Observação</span>
          <input className="input" maxLength={300} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Ex.: sem cebola" />
        </label>
        <div className="flex items-center gap-3">
          <Qty value={qty} min={1} onChange={setQty} label="quantidade" />
          <button type="button" className="btn-primary flex-1" disabled={!valid} onClick={add}>Adicionar · {brl(unit * qty)}</button>
        </div>
      </div>
    </Modal>
  );
}

export function ProductPicker({ catalog, onAdd }: { catalog: PosCatalog; onAdd: (line: PosLine) => void }) {
  const [cat, setCat] = useState<string>("all");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<PosProduct | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "F2") { e.preventDefault(); searchRef.current?.focus(); searchRef.current?.select(); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const list = useMemo(() => {
    const t = q.trim().toLowerCase();
    return catalog.products.filter((p) => (t ? p.name.toLowerCase().includes(t) : cat === "all" || p.category_id === cat));
  }, [catalog.products, cat, q]);

  function pick(p: PosProduct) {
    if (!p.available) return;
    if (p.groups.length) setOpen(p);
    else onAdd({ key: crypto.randomUUID(), product_id: p.id, name: p.name, quantity: 1, unit_price_cents: p.price_cents, notes: "", options: [] });
  }

  if (catalog.loading) return <p className="p-6 text-sm text-zinc-500">Carregando cardápio...</p>;
  if (catalog.error) return <p className="p-6 text-sm text-red-700">{catalog.error}</p>;

  return (
    <div className="space-y-3">
      <input ref={searchRef} className="input" placeholder="Buscar produto (F2)" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Buscar produto"
        onKeyDown={(e) => { if (e.key === "Enter" && list.length === 1) { pick(list[0]); setQ(""); } }} />
      <div className="no-scrollbar flex gap-2 overflow-x-auto pb-1">
        {[{ id: "all", name: "Todos" }, ...catalog.categories].map((c) => (
          <button key={c.id} type="button" onClick={() => { setCat(c.id); setQ(""); }}
            className={`shrink-0 rounded-full px-3.5 py-1.5 text-sm font-semibold ${cat === c.id && !q ? "bg-brand-600 text-white" : "bg-white text-zinc-700 ring-1 ring-zinc-200"}`}>
            {c.name}
          </button>
        ))}
      </div>
      {list.length === 0 ? <p className="py-8 text-center text-sm text-zinc-500">Nenhum produto encontrado.</p> : (
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 xl:grid-cols-4">
          {list.map((p) => (
            <button key={p.id} type="button" onClick={() => pick(p)} disabled={!p.available}
              className="overflow-hidden rounded-xl border border-zinc-200 bg-white text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-md disabled:opacity-50 disabled:hover:translate-y-0">
              {p.image_url
                ? <img src={p.image_url} alt="" loading="lazy" className="h-20 w-full object-cover" />
                : <div className="grid h-20 w-full place-items-center bg-brand-50 text-xl font-extrabold text-brand-300">{p.name[0]}</div>}
              <div className="p-2">
                <p className="line-clamp-2 min-h-[2.5rem] text-sm font-semibold leading-tight">{p.name}</p>
                <p className="mt-1 text-sm font-bold text-brand-700">{p.available ? brl(p.price_cents) : "Esgotado"}</p>
              </div>
            </button>
          ))}
        </div>
      )}
      {open && <ProductDialog product={open} onClose={() => setOpen(null)} onAdd={onAdd} />}
    </div>
  );
}
