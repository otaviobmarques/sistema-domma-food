"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/client";
import { canManage, usePanel } from "@/lib/panel/context";
import { Alert, Empty, Field, Modal } from "@/components/ui";
import { brl, errorMessage } from "@/lib/format";
import { channelLabel } from "@/components/channel-badge";

type UnitRow = { id: string; name: string; slug: string; active: boolean; city: string | null; is_open: boolean; revenue_cents: number; orders: number;
  avg_ticket_cents: number; cancelled: number; avg_prep_min: number | null; open_orders: number };
type Overview = {
  limit: number | null; units_total: number;
  totals: { revenue_cents: number; orders: number; avg_ticket_cents: number; cancelled: number };
  units: UnitRow[];
  by_channel: { channel: string; orders: number; revenue_cents: number }[];
  by_day: { day: string; orders: number; revenue_cents: number }[];
  top_products: { name: string; quantity: number; revenue_cents: number }[];
};
const PERIODS = [{ id: "today", label: "Hoje", days: 0 }, { id: "7d", label: "7 dias", days: 7 }, { id: "30d", label: "30 dias", days: 30 }] as const;
const slugify = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50);

function NewUnit({ units, onClose, onCreated }: { units: { id: string; name: string }[]; onClose: () => void; onCreated: (id: string) => void }) {
  const { tenantId, unit } = usePanel();
  const sb = supabaseBrowser();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [touched, setTouched] = useState(false);
  const [from, setFrom] = useState(unit.id);
  const [zones, setZones] = useState(true);
  const [prices, setPrices] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr("");
    const { data, error } = await sb.rpc("unit_create", { p_tenant_id: tenantId, p_name: name, p_slug: slug, p_copy_from: from || null, p_copy_zones: zones, p_copy_prices: prices });
    setBusy(false);
    if (error) { setErr(errorMessage(error)); return; }
    onCreated((data as { unit_id: string }).unit_id);
  }
  return (
    <Modal open onClose={onClose} title="Nova loja">
      <form onSubmit={save} className="space-y-3">
        <Field label="Nome da loja"><input className="input" required maxLength={120} value={name} placeholder="Ex.: Bella Massa — Savassi"
          onChange={(e) => { setName(e.target.value); if (!touched) setSlug(slugify(e.target.value)); }} /></Field>
        <Field label="Endereço do cardápio" hint={slug ? `${typeof window === "undefined" ? "" : window.location.origin}/loja/${slug}` : "Letras minúsculas, números e hífen."}>
          <input className="input" required value={slug} onChange={(e) => { setTouched(true); setSlug(slugify(e.target.value)); }} /></Field>
        <Field label="Copiar configurações de" hint="Horários, formas de pagamento, tempos, cores, logo e taxa de serviço. O cardápio é o mesmo da rede.">
          <select className="input" value={from} onChange={(e) => setFrom(e.target.value)}>
            <option value="">Não copiar (começar do zero)</option>
            {units.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        </Field>
        {from && (
          <div className="space-y-1 text-sm">
            <label className="flex items-center gap-2"><input type="checkbox" checked={zones} onChange={(e) => setZones(e.target.checked)} /> Copiar as áreas de entrega</label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={prices} onChange={(e) => setPrices(e.target.checked)} /> Copiar preços e itens pausados desta loja</label>
          </div>
        )}
        <p className="text-xs text-zinc-500">Depois de criar, complete o endereço, o Pix e o telefone em Configurações (com a nova loja selecionada).</p>
        <Alert>{err}</Alert>
        <div className="flex justify-end gap-2"><button type="button" className="btn-ghost" onClick={onClose}>Cancelar</button>
          <button className="btn-primary" disabled={busy}>{busy ? "Criando..." : "Criar loja"}</button></div>
      </form>
    </Modal>
  );
}

export default function Rede() {
  const { tenantId, role, units, unit } = usePanel();
  const sb = supabaseBrowser();
  const router = useRouter();
  const [period, setPeriod] = useState<(typeof PERIODS)[number]["id"]>("7d");
  const [ov, setOv] = useState<Overview | null>(null);
  const [err, setErr] = useState("");
  const [creating, setCreating] = useState(false);
  const owner = role === "owner";

  const load = useCallback(async () => {
    const days = PERIODS.find((p) => p.id === period)!.days;
    const from = new Date(); from.setHours(0, 0, 0, 0); if (days) from.setDate(from.getDate() - (days - 1));
    const { data, error } = await sb.rpc("network_overview", { p_tenant_id: tenantId, p_from: from.toISOString(), p_to: new Date(Date.now() + 60_000).toISOString() });
    if (error) setErr(errorMessage(error)); else { setOv(data as Overview); setErr(""); }
  }, [sb, tenantId, period]);
  useEffect(() => { void load(); }, [load]);

  function switchTo(id: string, path = "/painel") {
    document.cookie = `df_unit=${id}; path=/; max-age=31536000; samesite=lax; secure`;
    router.push(path); router.refresh();
  }
  async function toggle(u: UnitRow) {
    if (u.active && !confirm(`Desativar ${u.name}? O cardápio dela sai do ar e ela deixa de receber pedidos.`)) return;
    const { error } = await sb.rpc("unit_set_active", { p_unit_id: u.id, p_active: !u.active });
    if (error) setErr(errorMessage(error)); else { await load(); router.refresh(); }
  }

  const max = useMemo(() => Math.max(1, ...(ov?.units ?? []).map((u) => u.revenue_cents)), [ov]);
  const share = (c: number) => (ov?.totals.revenue_cents ? Math.round((c / ov.totals.revenue_cents) * 100) : 0);
  if (!canManage(role)) return <Empty>A visão da rede é do dono e da gerência.</Empty>;
  const atLimit = ov?.limit != null && ov.units_total >= ov.limit;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="h1">Rede de lojas</h1>
          <p className="mt-1 text-sm text-zinc-600">Todas as suas lojas lado a lado. O cardápio é único para a rede; preço e disponibilidade podem mudar por loja no Cardápio.</p>
        </div>
        {owner && (
          <div className="text-right">
            <button className="btn-primary" disabled={atLimit} onClick={() => setCreating(true)}>+ Nova loja</button>
            {ov && <p className="mt-1 text-xs text-zinc-500">{ov.units_total}{ov.limit != null ? ` de ${ov.limit}` : ""} loja(s) ativa(s){atLimit ? " · mude de plano em Assinatura para abrir mais" : ""}</p>}
          </div>
        )}
      </div>

      <div className="flex gap-1" role="group" aria-label="Período">
        {PERIODS.map((p) => (
          <button key={p.id} onClick={() => setPeriod(p.id)} aria-pressed={period === p.id}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium ${period === p.id ? "bg-brand-600 text-white" : "bg-zinc-100 text-zinc-700 hover:bg-zinc-200"}`}>{p.label}</button>
        ))}
      </div>
      <Alert>{err}</Alert>

      {ov && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[["Faturamento da rede", brl(ov.totals.revenue_cents)], ["Pedidos", String(ov.totals.orders)],
              ["Ticket médio", brl(ov.totals.avg_ticket_cents)], ["Cancelados", String(ov.totals.cancelled)]].map(([l, v]) => (
              <div key={l} className="rounded-xl bg-white p-4 ring-1 ring-zinc-200"><p className="text-xs text-zinc-500">{l}</p><p className="mt-1 text-xl font-bold tabular-nums">{v}</p></div>
            ))}
          </div>

          <section className="overflow-x-auto rounded-xl bg-white ring-1 ring-zinc-200">
            <table className="w-full text-sm">
              <thead className="bg-zinc-50/80 text-left text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                <tr><th className="p-3">Loja</th><th className="p-3">Faturamento</th><th className="p-3 text-right">Pedidos</th><th className="p-3 text-right">Ticket</th>
                  <th className="p-3 text-right">Cancel.</th><th className="p-3 text-right">Preparo</th><th className="p-3 text-right">Em aberto</th><th /></tr>
              </thead>
              <tbody className="divide-y divide-zinc-100">
                {ov.units.map((u) => (
                  <tr key={u.id} className={u.active ? "" : "opacity-60"}>
                    <td className="p-3">
                      <p className="font-medium">{u.name} {u.id === unit.id && <span className="badge ml-1 bg-zinc-100 text-zinc-600">atual</span>}</p>
                      <p className="text-xs text-zinc-500">{!u.active ? "Desativada" : u.is_open ? "🟢 Aberta agora" : "Fechada"}{u.city ? ` · ${u.city}` : ""}</p>
                    </td>
                    <td className="p-3">
                      <div className="flex items-center gap-2">
                        <div className="h-2 w-28 overflow-hidden rounded-full bg-zinc-100"><div className="h-full rounded-full bg-brand-600" style={{ width: `${(u.revenue_cents / max) * 100}%` }} /></div>
                        <span className="tabular-nums">{brl(u.revenue_cents)}</span><span className="text-xs text-zinc-500">{share(u.revenue_cents)}%</span>
                      </div>
                    </td>
                    <td className="p-3 text-right tabular-nums">{u.orders}</td>
                    <td className="p-3 text-right tabular-nums">{u.orders ? brl(u.avg_ticket_cents) : "—"}</td>
                    <td className="p-3 text-right tabular-nums">{u.cancelled}</td>
                    <td className="p-3 text-right tabular-nums">{u.avg_prep_min != null ? `${u.avg_prep_min} min` : "—"}</td>
                    <td className="p-3 text-right tabular-nums">{u.open_orders}</td>
                    <td className="whitespace-nowrap p-3 text-right">
                      {u.id !== unit.id && u.active && <button className="btn-ghost text-xs" onClick={() => switchTo(u.id)}>Abrir painel</button>}
                      {u.active && <a className="btn-ghost text-xs" href={`/loja/${u.slug}`} target="_blank" rel="noopener">Cardápio ↗</a>}
                      {owner && <button className="btn-ghost text-xs" onClick={() => void toggle(u)}>{u.active ? "Desativar" : "Reativar"}</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <div className="grid gap-4 lg:grid-cols-2">
            <section className="rounded-xl bg-white p-4 ring-1 ring-zinc-200">
              <h2 className="font-semibold">Canais na rede</h2>
              {ov.by_channel.length === 0 ? <p className="mt-2 text-sm text-zinc-500">Sem pedidos no período.</p> : (
                <ul className="mt-2 space-y-1.5 text-sm">
                  {ov.by_channel.map((c) => (
                    <li key={c.channel} className="flex justify-between gap-2"><span>{channelLabel(c.channel)}</span>
                      <span className="tabular-nums text-zinc-600">{c.orders} pedidos · <b className="text-zinc-900">{brl(c.revenue_cents)}</b></span></li>
                  ))}
                </ul>
              )}
            </section>
            <section className="rounded-xl bg-white p-4 ring-1 ring-zinc-200">
              <h2 className="font-semibold">Mais vendidos na rede</h2>
              {ov.top_products.length === 0 ? <p className="mt-2 text-sm text-zinc-500">Sem vendas no período.</p> : (
                <ol className="mt-2 space-y-1.5 text-sm">
                  {ov.top_products.map((p, i) => (
                    <li key={p.name} className="flex justify-between gap-2"><span className="truncate">{i + 1}. {p.name}</span>
                      <span className="shrink-0 tabular-nums text-zinc-600">{p.quantity} un · {brl(p.revenue_cents)}</span></li>
                  ))}
                </ol>
              )}
            </section>
          </div>
          {units.length < ov.units.length && <p className="text-xs text-zinc-500">Você vê só as lojas liberadas para o seu usuário.</p>}
        </>
      )}
      {creating && <NewUnit units={(ov?.units ?? []).filter((u) => u.active)} onClose={() => setCreating(false)}
        onCreated={(id) => { setCreating(false); switchTo(id, "/painel/configuracoes"); }} />}
    </div>
  );
}
