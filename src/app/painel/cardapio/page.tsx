"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { canManage, usePanel } from "@/lib/panel/context";
import { Alert, Empty, Field, Modal, Toggle } from "@/components/ui";
import { brl, errorMessage } from "@/lib/format";
import { ProductModal } from "./product-modal";
import { GroupsTab } from "./groups-tab";
import {
  DAY_LABEL, isPaused, nextFiveAM,
  type Category, type MenuData, type Option, type OptionGroup, type Product, type ProductGroupLink,
} from "./types";

export default function CardapioPage() {
  const { tenantId, role } = usePanel();
  const editable = canManage(role);
  const sb = supabaseBrowser();
  const [tab, setTab] = useState<"products" | "groups">("products");
  const [data, setData] = useState<MenuData>({ categories: [], products: [], groups: [], options: [], links: [] });
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [activeCat, setActiveCat] = useState<string | null>(null);
  const [editing, setEditing] = useState<Product | "new" | null>(null);
  const [catModal, setCatModal] = useState<Category | "new" | null>(null);

  const load = useCallback(async () => {
    const [c, p, g, o, l] = await Promise.all([
      sb.from("categories").select("*").eq("tenant_id", tenantId).order("position").order("name"),
      sb.from("products").select("*").eq("tenant_id", tenantId).order("position").order("name"),
      sb.from("option_groups").select("*").eq("tenant_id", tenantId).order("name"),
      sb.from("options").select("*").eq("tenant_id", tenantId).order("position").order("name"),
      sb.from("product_option_groups").select("product_id, group_id, position").eq("tenant_id", tenantId).order("position"),
    ]);
    const firstErr = c.error ?? p.error ?? g.error ?? o.error ?? l.error;
    if (firstErr) setErr(errorMessage(firstErr));
    setData({
      categories: (c.data ?? []) as Category[], products: (p.data ?? []) as Product[],
      groups: (g.data ?? []) as OptionGroup[], options: (o.data ?? []) as Option[],
      links: (l.data ?? []) as ProductGroupLink[],
    });
    setLoading(false);
  }, [sb, tenantId]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!activeCat && data.categories.length) setActiveCat(data.categories[0].id);
    if (activeCat && !data.categories.some((c) => c.id === activeCat)) setActiveCat(data.categories[0]?.id ?? null);
  }, [data.categories, activeCat]);

  async function run(fn: () => PromiseLike<{ error: unknown }>) {
    setErr("");
    const { error } = await fn();
    if (error) { setErr(errorMessage(error)); return false; }
    await load();
    return true;
  }

  async function moveCategory(cat: Category, dir: -1 | 1) {
    const list = [...data.categories];
    const i = list.findIndex((c) => c.id === cat.id);
    const j = i + dir;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    setErr("");
    const results = await Promise.all(list.map((c, idx) =>
      c.position === idx ? Promise.resolve({ error: null }) : sb.from("categories").update({ position: idx }).eq("id", c.id)));
    const e = results.find((r: { error: unknown }) => r.error);
    if (e) setErr(errorMessage(e.error));
    await load();
  }

  async function moveProduct(p: Product, dir: -1 | 1) {
    const list = data.products.filter((x) => x.category_id === p.category_id);
    const i = list.findIndex((x) => x.id === p.id);
    const j = i + dir;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    await Promise.all(list.map((x, idx) =>
      x.position === idx ? Promise.resolve() : sb.from("products").update({ position: idx }).eq("id", x.id)));
    await load();
  }

  async function duplicate(p: Product) {
    setErr("");
    const { id: _id, ...rest } = p;
    const { data: created, error } = await sb.from("products")
      .insert({ ...rest, tenant_id: tenantId, name: `${p.name} (cópia)`.slice(0, 120), position: p.position + 1 })
      .select("id").single();
    if (error) { setErr(errorMessage(error)); return; }
    const links = data.links.filter((l) => l.product_id === p.id)
      .map((l) => ({ product_id: created.id, group_id: l.group_id, position: l.position, tenant_id: tenantId }));
    if (links.length) {
      const r = await sb.from("product_option_groups").insert(links);
      if (r.error) setErr(errorMessage(r.error));
    }
    await load();
  }

  const products = useMemo(
    () => data.products.filter((p) => p.category_id === activeCat),
    [data.products, activeCat]);
  const currentCat = data.categories.find((c) => c.id === activeCat) ?? null;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="h1 mr-auto">Cardápio</h1>
        <div role="tablist" className="inline-flex rounded-lg border border-zinc-300 bg-white p-1">
          {([["products", "Produtos"], ["groups", "Complementos"]] as const).map(([k, l]) => (
            <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
              className={`rounded-md px-3 py-1.5 text-sm font-medium ${tab === k ? "bg-brand-700 text-white" : "text-zinc-700"}`}>{l}</button>
          ))}
        </div>
      </div>
      <div className="mb-4"><Alert>{err}</Alert></div>
      {!editable && <div className="mb-4"><Alert kind="info">Você tem acesso somente leitura ao cardápio.</Alert></div>}

      {loading ? <p className="text-sm text-zinc-500">Carregando...</p> : tab === "groups" ? (
        <GroupsTab data={data} editable={editable} reload={load} onError={setErr} />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
          <section className="card h-fit p-3" aria-label="Categorias">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="font-semibold">Categorias</h2>
              {editable && <button className="btn-ghost px-2 py-1 text-brand-700" onClick={() => setCatModal("new")}>+ Nova</button>}
            </div>
            {data.categories.length === 0 && <p className="text-sm text-zinc-500">Crie a primeira categoria.</p>}
            <ul className="space-y-1">
              {data.categories.map((c, idx) => (
                <li key={c.id} className={`flex items-center gap-1 rounded-lg px-2 py-1.5 ${c.id === activeCat ? "bg-brand-50" : ""}`}>
                  <button className="min-w-0 flex-1 truncate text-left text-sm" onClick={() => setActiveCat(c.id)}>
                    <span className={c.active ? "font-medium" : "text-zinc-400 line-through"}>{c.name}</span>
                    <span className="ml-1 text-xs text-zinc-400">{data.products.filter((p) => p.category_id === c.id).length}</span>
                  </button>
                  {editable && (
                    <>
                      <button className="px-1 text-zinc-400 hover:text-zinc-800 disabled:opacity-30" disabled={idx === 0}
                        onClick={() => void moveCategory(c, -1)} aria-label={`Subir ${c.name}`}>↑</button>
                      <button className="px-1 text-zinc-400 hover:text-zinc-800 disabled:opacity-30" disabled={idx === data.categories.length - 1}
                        onClick={() => void moveCategory(c, 1)} aria-label={`Descer ${c.name}`}>↓</button>
                      <button className="px-1 text-zinc-400 hover:text-zinc-800" onClick={() => setCatModal(c)} aria-label={`Editar ${c.name}`}>✎</button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          </section>

          <section aria-label="Produtos">
            {currentCat && (
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <h2 className="mr-auto text-lg font-semibold">{currentCat.name}</h2>
                {editable && (
                  <>
                    <label className="flex items-center gap-2 text-sm">
                      <Toggle checked={currentCat.active} label="Categoria ativa"
                        onChange={(v) => void run(() => sb.from("categories").update({ active: v }).eq("id", currentCat.id))} />
                      Ativa
                    </label>
                    <button className="btn-primary" onClick={() => setEditing("new")}>+ Produto</button>
                  </>
                )}
              </div>
            )}
            {!currentCat ? <Empty>Crie uma categoria para começar a cadastrar produtos.</Empty>
              : products.length === 0 ? <Empty>Nenhum produto nesta categoria.</Empty> : (
                <ul className="space-y-2">
                  {products.map((p, idx) => {
                    const paused = isPaused(p);
                    const groupsCount = data.links.filter((l) => l.product_id === p.id).length;
                    return (
                      <li key={p.id} className="card flex flex-wrap items-center gap-3 p-3">
                        {p.image_url
                          // eslint-disable-next-line @next/next/no-img-element
                          ? <img src={p.image_url} alt="" className="h-14 w-14 rounded-lg object-cover" />
                          : <div className="grid h-14 w-14 place-items-center rounded-lg bg-zinc-100 text-xs text-zinc-400">sem foto</div>}
                        <div className="min-w-0 flex-1">
                          <p className="font-medium">
                            {p.name}
                            {p.featured && <span className="badge ml-2 bg-brand-100 text-brand-800">Destaque</span>}
                            {paused && <span className="badge ml-2 bg-amber-100 text-amber-800">Esgotado</span>}
                            {!p.active && <span className="badge ml-2 bg-zinc-200 text-zinc-600">Inativo</span>}
                          </p>
                          <p className="text-sm text-zinc-600">
                            {p.promo_price_cents != null
                              ? <><s className="text-zinc-400">{brl(p.price_cents)}</s> <b>{brl(p.promo_price_cents)}</b></>
                              : brl(p.price_cents)}
                            {groupsCount > 0 && <span className="ml-2 text-xs text-zinc-400">{groupsCount} grupo(s) de complementos</span>}
                            {!p.image_url && <span className="ml-2 text-xs text-amber-700">⚠ sem foto</span>}
                          </p>
                        </div>
                        {editable && (
                          <div className="flex flex-wrap items-center gap-2">
                            <Toggle checked={p.active} label={`Ativar ${p.name}`}
                              onChange={(v) => void run(() => sb.from("products").update({ active: v }).eq("id", p.id))} />
                            <button className="btn-secondary px-2 py-1 text-xs"
                              onClick={() => void run(() => sb.from("products").update({ paused_until: paused ? null : nextFiveAM() }).eq("id", p.id))}>
                              {paused ? "Reativar" : "Esgotar hoje"}
                            </button>
                            <button className="btn-ghost px-2 py-1" disabled={idx === 0} onClick={() => void moveProduct(p, -1)} aria-label="Subir">↑</button>
                            <button className="btn-ghost px-2 py-1" disabled={idx === products.length - 1} onClick={() => void moveProduct(p, 1)} aria-label="Descer">↓</button>
                            <button className="btn-ghost px-2 py-1" onClick={() => void duplicate(p)}>Duplicar</button>
                            <button className="btn-secondary px-2 py-1 text-xs" onClick={() => setEditing(p)}>Editar</button>
                            <button className="btn-ghost px-2 py-1 text-red-700"
                              onClick={() => { if (confirm(`Excluir "${p.name}"? Isso não pode ser desfeito.`)) void run(() => sb.from("products").delete().eq("id", p.id)); }}>
                              Excluir
                            </button>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
          </section>
        </div>
      )}

      {editing && (
        <ProductModal product={editing === "new" ? null : editing} defaultCategory={activeCat} data={data}
          onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); await load(); }} />
      )}
      {catModal && (
        <CategoryModal category={catModal === "new" ? null : catModal} nextPosition={data.categories.length}
          onClose={() => setCatModal(null)}
          onSaved={async (id) => { setCatModal(null); await load(); if (id) setActiveCat(id); }} />
      )}
    </div>
  );
}

function CategoryModal({ category, nextPosition, onClose, onSaved }: {
  category: Category | null; nextPosition: number; onClose: () => void; onSaved: (id?: string) => void | Promise<void>;
}) {
  const { tenantId } = usePanel();
  const sb = supabaseBrowser();
  const [name, setName] = useState(category?.name ?? "");
  const [description, setDescription] = useState(category?.description ?? "");
  const [days, setDays] = useState<number[] | null>(category?.available_days ?? null);
  const [from, setFrom] = useState(category?.available_from?.slice(0, 5) ?? "");
  const [to, setTo] = useState(category?.available_to?.slice(0, 5) ?? "");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if ((from && !to) || (!from && to)) { setErr("Preencha os dois horários ou deixe ambos vazios."); return; }
    setBusy(true); setErr("");
    const row = {
      name: name.trim(), description: description.trim() || null,
      available_days: days && days.length < 7 ? days : null,
      available_from: from || null, available_to: to || null,
    };
    const res = category
      ? await sb.from("categories").update(row).eq("id", category.id).select("id").single()
      : await sb.from("categories").insert({ ...row, tenant_id: tenantId, position: nextPosition }).select("id").single();
    setBusy(false);
    if (res.error) { setErr(errorMessage(res.error)); return; }
    await onSaved(res.data?.id);
  }

  async function remove() {
    if (!category) return;
    if (!confirm(`Excluir a categoria "${category.name}" e TODOS os produtos dela?`)) return;
    const { error } = await sb.from("categories").delete().eq("id", category.id);
    if (error) { setErr(errorMessage(error)); return; }
    await onSaved();
  }

  const toggleDay = (d: number) => {
    const cur = days ?? [0, 1, 2, 3, 4, 5, 6];
    setDays(cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d].sort());
  };

  return (
    <Modal open onClose={onClose} title={category ? "Editar categoria" : "Nova categoria"}>
      <form onSubmit={save} className="space-y-4">
        <Field label="Nome"><input className="input" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
        <Field label="Descrição (opcional)"><input className="input" value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
        <fieldset>
          <legend className="label">Dias disponíveis</legend>
          <div className="flex flex-wrap gap-1">
            {DAY_LABEL.map((l, d) => {
              const on = (days ?? [0, 1, 2, 3, 4, 5, 6]).includes(d);
              return (
                <button key={d} type="button" aria-pressed={on} onClick={() => toggleDay(d)}
                  className={`rounded-lg border px-3 py-1 text-sm ${on ? "border-brand-600 bg-brand-50 text-brand-800" : "border-zinc-300 text-zinc-500"}`}>{l}</button>
              );
            })}
          </div>
        </fieldset>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Disponível a partir de" hint="Ex.: executivo só no almoço"><input className="input" type="time" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label="Até"><input className="input" type="time" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        </div>
        <Alert>{err}</Alert>
        <div className="flex gap-2">
          <button className="btn-primary" disabled={busy}>{busy ? "Salvando..." : "Salvar"}</button>
          <button type="button" className="btn-ghost" onClick={onClose}>Cancelar</button>
          {category && <button type="button" className="btn-ghost ml-auto text-red-700" onClick={() => void remove()}>Excluir</button>}
        </div>
      </form>
    </Modal>
  );
}
