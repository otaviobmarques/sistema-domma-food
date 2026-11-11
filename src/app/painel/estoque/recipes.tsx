"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { usePanel } from "@/lib/panel/context";
import { Alert, Empty, Field } from "@/components/ui";
import { brl, errorMessage } from "@/lib/format";
import { fmtQty, normalize, parseQty, type StockItem } from "./shared";

type Product = { id: string; name: string; price_cents: number; promo_price_cents: number | null; active: boolean };
type Recipe = { product_id: string; stock_item_id: string; tenant_id: string; qty: number };

export function Recipes() {
  const { tenantId, unit } = usePanel();
  const sb = supabaseBrowser();
  const [products, setProducts] = useState<Product[]>([]);
  const [items, setItems] = useState<StockItem[]>([]);
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [add, setAdd] = useState({ item: "", qty: "" });
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [p, s, r] = await Promise.all([
      sb.from("products").select("id, name, price_cents, promo_price_cents, active").eq("tenant_id", tenantId).order("name"),
      sb.from("stock_items").select("*").eq("unit_id", unit.id).order("name"),
      sb.from("product_recipes").select("*").eq("tenant_id", tenantId),
    ]);
    const e = p.error || s.error || r.error;
    if (e) { setErr(errorMessage(e)); return; }
    setProducts(p.data as Product[]);
    setItems((s.data as StockItem[]).map(normalize));
    setRecipes((r.data as Recipe[]).map((x) => ({ ...x, qty: Number(x.qty) })));
  }, [sb, tenantId, unit.id]);
  useEffect(() => { load(); }, [load]);

  const itemById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  // só conta insumos desta loja (a ficha pode ter insumos de outras unidades)
  const byProduct = useMemo(() => {
    const m = new Map<string, Recipe[]>();
    for (const r of recipes) if (itemById.has(r.stock_item_id)) m.set(r.product_id, [...(m.get(r.product_id) ?? []), r]);
    return m;
  }, [recipes, itemById]);
  const costOf = (pid: string) => (byProduct.get(pid) ?? []).reduce((s, r) => s + r.qty * (itemById.get(r.stock_item_id)?.cost_cents ?? 0), 0);

  const shown = products.filter((p) => !q.trim() || p.name.toLowerCase().includes(q.trim().toLowerCase()));
  const product = products.find((p) => p.id === sel) ?? null;
  const rows = sel ? byProduct.get(sel) ?? [] : [];
  const price = product ? product.promo_price_cents ?? product.price_cents : 0;
  const cost = sel ? costOf(sel) : 0;
  const margin = price > 0 ? ((price - cost) / price) * 100 : 0;
  const available = items.filter((i) => i.active && !rows.some((r) => r.stock_item_id === i.id));

  async function run(p: PromiseLike<{ error: { message: string; code?: string } | null }>) {
    setBusy(true); setErr("");
    const { error } = await p;
    setBusy(false);
    if (error) { setErr(error.code === "23505" ? "Este insumo já está na ficha." : errorMessage(error)); return false; }
    await load();
    return true;
  }

  async function addRow(e: React.FormEvent) {
    e.preventDefault();
    if (!sel || !add.item) return;
    const qty = parseQty(add.qty);
    if (!Number.isFinite(qty) || qty <= 0) { setErr("Quantidade inválida."); return; }
    if (await run(sb.from("product_recipes").insert({ product_id: sel, stock_item_id: add.item, tenant_id: tenantId, qty }))) setAdd({ item: "", qty: "" });
  }

  async function saveQty(r: Recipe) {
    const raw = drafts[r.stock_item_id];
    if (raw === undefined) return;
    const qty = parseQty(raw);
    if (!Number.isFinite(qty) || qty <= 0) { setErr("Quantidade inválida."); return; }
    if (qty !== r.qty && await run(sb.from("product_recipes").update({ qty }).eq("product_id", r.product_id).eq("stock_item_id", r.stock_item_id))) {
      setDrafts((d) => { const n = { ...d }; delete n[r.stock_item_id]; return n; });
    }
  }

  if (items.length === 0) return <Empty>Cadastre os insumos na aba Insumos para montar as fichas técnicas.</Empty>;

  return (
    <div className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
      <aside className="card space-y-3 p-3">
        <input className="input" placeholder="Buscar produto" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Buscar produto" />
        <ul className="max-h-[60vh] divide-y divide-zinc-100 overflow-y-auto">
          {shown.map((p) => {
            const has = byProduct.has(p.id);
            return (
              <li key={p.id}>
                <button onClick={() => { setSel(p.id); setErr(""); setDrafts({}); }}
                  className={`flex w-full items-center justify-between gap-2 rounded-md px-2 py-2 text-left text-sm ${sel === p.id ? "bg-brand-50 text-brand-700" : "hover:bg-zinc-50"}`}>
                  <span className={`truncate ${p.active ? "" : "text-zinc-400"}`}>{p.name}</span>
                  {has ? <span className="badge shrink-0 bg-green-100 text-green-800">Com ficha</span> : <span className="shrink-0 text-xs text-zinc-400">sem ficha</span>}
                </button>
              </li>
            );
          })}
        </ul>
        <p className="px-1 text-xs text-zinc-500">{byProduct.size} de {products.length} produtos com ficha técnica.</p>
      </aside>

      <section className="space-y-4">
        {!product ? <Empty>Escolha um produto para ver ou montar a ficha técnica.</Empty> : (
          <>
            <div className="card flex flex-wrap items-center gap-6">
              <div><p className="text-sm text-zinc-500">Produto</p><p className="font-semibold">{product.name}</p></div>
              <div><p className="text-sm text-zinc-500">Preço de venda</p><p className="font-semibold tabular-nums">{brl(price)}</p></div>
              <div><p className="text-sm text-zinc-500">Custo estimado</p><p className="font-semibold tabular-nums">{brl(Math.round(cost))}</p></div>
              <div>
                <p className="text-sm text-zinc-500">Margem</p>
                <p className={`font-semibold tabular-nums ${!rows.length ? "text-zinc-400" : margin < 50 ? "text-red-700" : margin < 65 ? "text-amber-700" : "text-green-700"}`}>
                  {rows.length ? `${margin.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%` : "—"}
                </p>
              </div>
            </div>

            <Alert>{err}</Alert>

            {rows.length === 0 ? <Empty>Este produto ainda não tem ficha técnica. Adicione os insumos usados em uma unidade vendida.</Empty> : (
              <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white">
                <table className="w-full text-sm">
                  <thead className="bg-zinc-50 text-left text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                    <tr><th className="p-3">Insumo</th><th className="p-3">Quantidade por unidade</th><th className="p-3 text-right">Custo</th><th /></tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-100">
                    {rows.map((r) => {
                      const it = itemById.get(r.stock_item_id)!;
                      return (
                        <tr key={r.stock_item_id}>
                          <td className="p-3 font-medium">{it.name}</td>
                          <td className="p-3">
                            <div className="flex items-center gap-2">
                              <input className="input w-28 text-right tabular-nums" inputMode="decimal" aria-label={`Quantidade de ${it.name}`}
                                value={drafts[r.stock_item_id] ?? fmtQty(r.qty)}
                                onChange={(e) => setDrafts((d) => ({ ...d, [r.stock_item_id]: e.target.value }))}
                                onBlur={() => saveQty(r)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); saveQty(r); } }} />
                              <span className="text-zinc-500">{it.unit}</span>
                            </div>
                          </td>
                          <td className="p-3 text-right tabular-nums">{brl(Math.round(r.qty * it.cost_cents))}</td>
                          <td className="p-3 text-right">
                            <button className="btn-ghost text-red-600" disabled={busy}
                              onClick={() => run(sb.from("product_recipes").delete().eq("product_id", r.product_id).eq("stock_item_id", r.stock_item_id))}>Remover</button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {available.length > 0 && (
              <form onSubmit={addRow} className="card flex flex-wrap items-end gap-3">
                <div className="min-w-48 flex-1">
                  <Field label="Insumo">
                    <select className="input" required value={add.item} onChange={(e) => setAdd({ ...add, item: e.target.value })}>
                      <option value="">Escolha…</option>
                      {available.map((i) => <option key={i.id} value={i.id}>{i.name} ({i.unit})</option>)}
                    </select>
                  </Field>
                </div>
                <div className="w-40">
                  <Field label={`Quantidade${add.item ? ` (${itemById.get(add.item)?.unit})` : ""}`}>
                    <input className="input" required inputMode="decimal" value={add.qty} onChange={(e) => setAdd({ ...add, qty: e.target.value })} placeholder="Ex.: 0,2" />
                  </Field>
                </div>
                <button className="btn-primary" disabled={busy}>Adicionar</button>
              </form>
            )}
          </>
        )}
      </section>
    </div>
  );
}
