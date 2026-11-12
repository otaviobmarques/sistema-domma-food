"use client";
import { useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { usePanel } from "@/lib/panel/context";
import { Alert, Field, Modal, Toggle } from "@/components/ui";
import { centsToInput, errorMessage, parseBRL } from "@/lib/format";
import type { MenuData, Product } from "./types";
import { ORIGINS } from "../fiscal/settings";

const TAGS = ["novo", "vegano", "vegetariano", "picante", "sem glúten", "mais pedido"];
const MAX_BYTES = 5 * 1024 * 1024;
const MIME_EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

export function ProductModal({ product, defaultCategory, data, onClose, onSaved }: {
  product: Product | null; defaultCategory: string | null; data: MenuData;
  onClose: () => void; onSaved: () => void | Promise<void>;
}) {
  const { tenantId, unit, units } = usePanel();
  const sb = supabaseBrowser();
  // preço e disponibilidade por loja (vazio = preço padrão da rede)
  const [perUnit, setPerUnit] = useState<Record<string, { price: string; available: boolean }>>({});
  useEffect(() => {
    if (!product || units.length < 2) return;
    void sb.from("product_unit_overrides").select("unit_id, price_cents, available").eq("product_id", product.id)
      .then(({ data: rows }: { data: { unit_id: string; price_cents: number | null; available: boolean }[] | null }) =>
        setPerUnit(Object.fromEntries((rows ?? []).map((r) => [r.unit_id, { price: centsToInput(r.price_cents), available: r.available }]))));
  }, [sb, product, units.length]);
  const [station, setStation] = useState(product?.station ?? "cozinha");
  const [stations, setStations] = useState<string[]>(["cozinha", "bar"]);
  useEffect(() => {
    void sb.from("units").select("kds_stations").eq("id", unit.id).single()
      .then(({ data: u }: { data: { kds_stations: string[] } | null }) => { if (u?.kds_stations?.length) setStations(u.kds_stations); });
  }, [sb, unit.id]);
  const [name, setName] = useState(product?.name ?? "");
  const [description, setDescription] = useState(product?.description ?? "");
  const [price, setPrice] = useState(centsToInput(product?.price_cents ?? null));
  const [promo, setPromo] = useState(centsToInput(product?.promo_price_cents ?? null));
  const [pdvCode, setPdvCode] = useState(product?.pdv_code ?? "");
  const [categoryId, setCategoryId] = useState(product?.category_id ?? defaultCategory ?? data.categories[0]?.id ?? "");
  const [featured, setFeatured] = useState(product?.featured ?? false);
  const [tags, setTags] = useState<string[]>(product?.tags ?? []);
  const [imageUrl, setImageUrl] = useState(product?.image_url ?? null);
  const [sku, setSku] = useState(product?.sku ?? "");
  const [fiscal, setFiscal] = useState({ ncm: product?.ncm ?? "", cfop: product?.cfop ?? "", csosn: product?.csosn ?? "", cest: product?.cest ?? "" });
  const [origin, setOrigin] = useState(product?.fiscal_origin ?? "");
  const [fiscalUnit, setFiscalUnit] = useState(product?.fiscal_unit ?? "UN");
  const [groupIds, setGroupIds] = useState<string[]>(
    product ? data.links.filter((l) => l.product_id === product.id).sort((a, b) => a.position - b.position).map((l) => l.group_id) : []);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function upload(file: File) {
    setErr("");
    const ext = MIME_EXT[file.type];
    if (!ext) { setErr("Use uma imagem JPG, PNG ou WEBP."); return; }
    if (file.size > MAX_BYTES) { setErr("A imagem deve ter no máximo 5 MB."); return; }
    setUploading(true);
    const path = `${tenantId}/products/${crypto.randomUUID()}.${ext}`;
    const { error } = await sb.storage.from("media").upload(path, file, { contentType: file.type, cacheControl: "31536000", upsert: false });
    setUploading(false);
    if (error) { setErr(errorMessage(error)); return; }
    setImageUrl(sb.storage.from("media").getPublicUrl(path).data.publicUrl);
  }

  function moveGroup(id: string, dir: -1 | 1) {
    const i = groupIds.indexOf(id); const j = i + dir;
    if (j < 0 || j >= groupIds.length) return;
    const next = [...groupIds]; [next[i], next[j]] = [next[j], next[i]]; setGroupIds(next);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setErr("");
    const priceCents = parseBRL(price);
    const promoCents = promo.trim() ? parseBRL(promo) : null;
    if (!categoryId) { setErr("Escolha uma categoria."); return; }
    if (promoCents != null && promoCents >= priceCents) { setErr("O preço promocional deve ser menor que o preço normal."); return; }
    setBusy(true);
    const row = {
      name: name.trim(), description: description.trim() || null, price_cents: priceCents, promo_price_cents: promoCents, pdv_code: pdvCode.trim().slice(0, 60) || null,
      category_id: categoryId, featured, tags, image_url: imageUrl, sku: sku.trim() || null, station: station || "cozinha",
      ncm: fiscal.ncm.trim() || null, cfop: fiscal.cfop.trim() || null, csosn: fiscal.csosn.trim() || null, cest: fiscal.cest.trim() || null,
      fiscal_origin: origin || null, fiscal_unit: (fiscalUnit.trim() || "UN").toUpperCase().slice(0, 6),
    };
    const res = product
      ? await sb.from("products").update(row).eq("id", product.id).select("id").single()
      : await sb.from("products").insert({
          ...row, tenant_id: tenantId,
          position: data.products.filter((p) => p.category_id === categoryId).length,
        }).select("id").single();
    if (res.error) { setBusy(false); setErr(errorMessage(res.error)); return; }
    const pid = res.data.id as string;

    // Sincroniza grupos de complementos (apaga e recria na ordem escolhida)
    const del = await sb.from("product_option_groups").delete().eq("product_id", pid);
    if (del.error) { setBusy(false); setErr(errorMessage(del.error)); return; }
    if (groupIds.length) {
      const ins = await sb.from("product_option_groups").insert(
        groupIds.map((g, i) => ({ product_id: pid, group_id: g, position: i, tenant_id: tenantId })));
      if (ins.error) { setBusy(false); setErr(errorMessage(ins.error)); return; }
    }
    // preço por loja: grava só o que difere do padrão
    if (units.length > 1) {
      for (const u of units) {
        const v = perUnit[u.id];
        const cents = v?.price.trim() ? parseBRL(v.price) : null;
        if (!v || (cents == null && v.available)) {
          await sb.from("product_unit_overrides").delete().eq("product_id", pid).eq("unit_id", u.id);
        } else {
          const up = await sb.from("product_unit_overrides").upsert({ product_id: pid, unit_id: u.id, tenant_id: tenantId, price_cents: cents, available: v.available });
          if (up.error) { setBusy(false); setErr(`${u.name}: ${errorMessage(up.error)}`); return; }
        }
      }
    }
    setBusy(false);
    await onSaved();
  }

  const available = data.groups.filter((g) => !groupIds.includes(g.id));

  return (
    <Modal open onClose={onClose} title={product ? "Editar produto" : "Novo produto"} wide>
      <form onSubmit={save} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-[140px_1fr]">
          <div>
            <span className="label">Foto</span>
            {imageUrl
              // eslint-disable-next-line @next/next/no-img-element
              ? <img src={imageUrl} alt="Foto do produto" className="h-32 w-32 rounded-lg object-cover" />
              : <div className="grid h-32 w-32 place-items-center rounded-lg bg-zinc-100 text-xs text-zinc-400">sem foto</div>}
            <label className="btn-secondary mt-2 w-32 cursor-pointer text-xs">
              {uploading ? "Enviando..." : imageUrl ? "Trocar" : "Enviar foto"}
              <input type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" disabled={uploading}
                onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ""; }} />
            </label>
            {imageUrl && <button type="button" className="mt-1 text-xs text-red-700 hover:underline" onClick={() => setImageUrl(null)}>Remover foto</button>}
          </div>
          <div className="space-y-3">
            <Field label="Nome"><input className="input" required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
            <Field label="Descrição"><textarea className="input" rows={3} maxLength={1000} value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <Field label="Preço (R$)"><input className="input" required inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="0,00" /></Field>
              <Field label="Promoção (R$)" hint="Opcional"><input className="input" inputMode="decimal" value={promo} onChange={(e) => setPromo(e.target.value)} placeholder="—" /></Field>
              <Field label="Código no PDV" hint="Opcional: código do produto no PDV (Eclética etc.)"><input className="input" maxLength={60} value={pdvCode} onChange={(e) => setPdvCode(e.target.value)} placeholder="—" /></Field>
              <Field label="Categoria">
                <select className="input" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
                  {data.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </Field>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 text-sm"><Toggle checked={featured} onChange={setFeatured} label="Destaque" /> Destaque no cardápio</label>
          <Field label="Código PDV / SKU"><input className="input w-40" value={sku} onChange={(e) => setSku(e.target.value)} /></Field>
          <Field label="Setor de preparo (KDS)">
            <select className="input w-44 capitalize" value={station} onChange={(e) => setStation(e.target.value)}>
              {[...new Set([...stations, station])].map((st) => <option key={st} value={st}>{st}</option>)}
            </select>
          </Field>
        </div>

        <fieldset>
          <legend className="label">Selos</legend>
          <div className="flex flex-wrap gap-1">
            {TAGS.map((t) => {
              const on = tags.includes(t);
              return (
                <button key={t} type="button" aria-pressed={on} onClick={() => setTags(on ? tags.filter((x) => x !== t) : [...tags, t])}
                  className={`rounded-full border px-3 py-1 text-xs ${on ? "border-brand-600 bg-brand-50 text-brand-800" : "border-zinc-300 text-zinc-600"}`}>{t}</button>
              );
            })}
          </div>
        </fieldset>

        <fieldset className="rounded-lg border border-zinc-200 p-3">
          <legend className="px-1 text-sm font-medium">Complementos deste produto</legend>
          {groupIds.length === 0 && <p className="text-sm text-zinc-500">Nenhum grupo vinculado.</p>}
          <ol className="space-y-1">
            {groupIds.map((id, i) => {
              const g = data.groups.find((x) => x.id === id);
              if (!g) return null;
              return (
                <li key={id} className="flex items-center gap-2 rounded bg-zinc-50 px-2 py-1 text-sm">
                  <span className="flex-1">{g.name} <span className="text-xs text-zinc-500">(mín {g.min_select} · máx {g.max_select})</span></span>
                  <button type="button" className="px-1 disabled:opacity-30" disabled={i === 0} onClick={() => moveGroup(id, -1)} aria-label="Subir">↑</button>
                  <button type="button" className="px-1 disabled:opacity-30" disabled={i === groupIds.length - 1} onClick={() => moveGroup(id, 1)} aria-label="Descer">↓</button>
                  <button type="button" className="px-1 text-red-700" onClick={() => setGroupIds(groupIds.filter((x) => x !== id))} aria-label={`Remover ${g.name}`}>✕</button>
                </li>
              );
            })}
          </ol>
          {available.length > 0 && (
            <select className="input mt-2" value="" aria-label="Adicionar grupo de complementos"
              onChange={(e) => e.target.value && setGroupIds([...groupIds, e.target.value])}>
              <option value="">+ Adicionar grupo...</option>
              {available.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          )}
          {data.groups.length === 0 && <p className="mt-1 text-xs text-zinc-500">Crie grupos na aba “Complementos”.</p>}
        </fieldset>

        <details className="rounded-lg border border-zinc-200 p-3">
          <summary className="cursor-pointer text-sm font-medium">Dados fiscais (NFC-e)</summary>
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {(["ncm", "cfop", "csosn", "cest"] as const).map((k) => (
              <Field key={k} label={k.toUpperCase()}>
                <input className="input" inputMode="numeric" maxLength={10} value={fiscal[k]}
                  onChange={(e) => setFiscal({ ...fiscal, [k]: e.target.value.replace(/[^\d.]/g, "") })} />
              </Field>
            ))}
          </div>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <Field label="Origem">
              <select className="input" value={origin} onChange={(e) => setOrigin(e.target.value)}>
                <option value="">Padrão da loja</option>
                {ORIGINS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </Field>
            <Field label="Unidade"><input className="input uppercase" maxLength={6} value={fiscalUnit} onChange={(e) => setFiscalUnit(e.target.value)} placeholder="UN" /></Field>
          </div>
          <p className="mt-2 text-xs text-zinc-500">Campos vazios usam os padrões da loja definidos em Nota fiscal. Confirme estes códigos com o seu contador.</p>
        </details>

        {units.length > 1 && (
          <fieldset className="rounded-lg border border-zinc-200 p-3">
            <legend className="px-1 text-sm font-medium">Preço e disponibilidade por loja</legend>
            <p className="mb-2 text-xs text-zinc-500">Deixe o preço vazio para usar o padrão da rede. Desmarque para tirar o item do cardápio só daquela loja.</p>
            <div className="space-y-2">
              {units.map((u) => {
                const v = perUnit[u.id] ?? { price: "", available: true };
                const set = (p: Partial<typeof v>) => setPerUnit((x) => ({ ...x, [u.id]: { ...v, ...p } }));
                return (
                  <div key={u.id} className="flex items-center gap-3 text-sm">
                    <span className="min-w-0 flex-1 truncate">{u.name}</span>
                    <input className="input w-28" inputMode="decimal" placeholder={price || "padrão"} aria-label={`Preço em ${u.name}`}
                      value={v.price} onChange={(e) => set({ price: e.target.value })} />
                    <label className="flex items-center gap-1.5 text-xs"><input type="checkbox" checked={v.available} onChange={(e) => set({ available: e.target.checked })} /> Vende</label>
                  </div>
                );
              })}
            </div>
          </fieldset>
        )}
        <Alert>{err}</Alert>
        <div className="flex gap-2">
          <button className="btn-primary" disabled={busy || uploading}>{busy ? "Salvando..." : "Salvar produto"}</button>
          <button type="button" className="btn-ghost" onClick={onClose}>Cancelar</button>
        </div>
      </form>
    </Modal>
  );
}
