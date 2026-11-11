"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { canManage, usePanel } from "@/lib/panel/context";
import { Alert, Empty } from "@/components/ui";
import { brl, errorMessage } from "@/lib/format";
import { courierUrl, DELIVERY_STATUS, minutesAgo, whatsappLink, type Courier } from "./shared";

type DOrder = {
  id: string; number: number; status: string; customer_name: string; created_at: string;
  address: { neighborhood?: string; street?: string; number?: string } | null;
  total_cents: number; payment_method: string; payment_status: string;
  deliveries: { status: string; courier_id: string }[];
};
type Active = {
  id: string; courier_id: string; batch_id: string; seq: number; status: string; assigned_at: string;
  orders: { number: number; customer_name: string; address: { neighborhood?: string; street?: string; number?: string } | null } | null;
};

const ACTIVE = ["assigned", "picked_up", "delivered"];
const MAX = 15;

export function Dispatch({ couriers }: { couriers: Courier[] }) {
  const { unit, role } = usePanel();
  const sb = supabaseBrowser();
  const manager = canManage(role);
  const [orders, setOrders] = useState<DOrder[]>([]);
  const [active, setActive] = useState<Active[]>([]);
  const [sel, setSel] = useState<string[]>([]);
  const [courier, setCourier] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [, tick] = useState(0);
  const activeCouriers = couriers.filter((c) => c.active);

  const load = useCallback(async () => {
    const [o, d] = await Promise.all([
      sb.from("orders").select("id, number, status, customer_name, address, total_cents, payment_method, payment_status, created_at, deliveries(status, courier_id)")
        .eq("unit_id", unit.id).eq("type", "delivery").in("status", ["preparing", "ready"]).order("created_at"),
      sb.from("deliveries").select("id, courier_id, batch_id, seq, status, assigned_at, orders(number, customer_name, address)")
        .eq("unit_id", unit.id).in("status", ["assigned", "picked_up"]).order("assigned_at").order("seq"),
    ]);
    if (o.error || d.error) { setErr(errorMessage(o.error ?? d.error)); return; }
    const free = ((o.data ?? []) as unknown as DOrder[]).filter((x) => !x.deliveries?.some((dl) => ACTIVE.includes(dl.status)));
    setOrders(free);
    setSel((cur) => cur.filter((id) => free.some((x) => x.id === id)));
    setActive((d.data ?? []) as unknown as Active[]);
  }, [sb, unit.id]);

  useEffect(() => {
    void load();
    const poll = setInterval(() => { void load(); tick((n) => n + 1); }, 20000);
    const ch = sb.channel(`dispatch-${unit.id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "deliveries", filter: `unit_id=eq.${unit.id}` }, () => void load())
      .on("postgres_changes", { event: "*", schema: "public", table: "orders", filter: `unit_id=eq.${unit.id}` }, () => void load())
      .subscribe();
    return () => { clearInterval(poll); void sb.removeChannel(ch); };
  }, [load, sb, unit.id]);

  useEffect(() => { if (!courier && activeCouriers[0]) setCourier(activeCouriers[0].id); }, [activeCouriers, courier]);

  function toggle(id: string) {
    setSel((cur) => cur.includes(id) ? cur.filter((x) => x !== id) : cur.length >= MAX ? cur : [...cur, id]);
  }

  async function assign() {
    if (!sel.length || !courier) return;
    setBusy(true); setErr(""); setMsg("");
    const { error } = await sb.rpc("courier_assign", { p_order_ids: sel, p_courier_id: courier });
    setBusy(false);
    if (error) { setErr(errorMessage(error)); return; }
    const c = couriers.find((x) => x.id === courier);
    setMsg(`Rota com ${sel.length} pedido(s) atribuída a ${c?.name ?? "entregador"}.`);
    setSel([]); await load();
  }

  async function unassign(id: string) {
    setErr("");
    const { error } = await sb.rpc("courier_unassign", { p_delivery_id: id });
    if (error) setErr(errorMessage(error)); else await load();
  }

  async function link(c: Courier, mode: "copy" | "wa") {
    setErr(""); setMsg("");
    const { data, error } = await sb.rpc("courier_link", { p_id: c.id });
    if (error) { setErr(errorMessage(error)); return; }
    const url = courierUrl(data as string);
    if (mode === "copy") {
      try { await navigator.clipboard.writeText(url); setMsg(`Link de ${c.name} copiado.`); } catch { setMsg(url); }
    } else window.open(whatsappLink(c, url, unit.name), "_blank", "noopener,noreferrer");
  }

  const byCourier = useMemo(() => {
    const m = new Map<string, Map<string, Active[]>>();
    active.forEach((d) => {
      const bm = m.get(d.courier_id) ?? new Map<string, Active[]>();
      bm.set(d.batch_id, [...(bm.get(d.batch_id) ?? []), d].sort((a, b) => a.seq - b.seq));
      m.set(d.courier_id, bm);
    });
    return m;
  }, [active]);

  const hood = (a: DOrder["address"]) => a?.neighborhood || [a?.street, a?.number].filter(Boolean).join(", ") || "Sem endereço";

  return (
    <div className="space-y-3">
      <Alert>{err}</Alert>
      <Alert kind="success">{msg}</Alert>
      <div className="grid gap-4 lg:grid-cols-2">
        <section className="card space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">Prontos para despachar</h2>
            <span className="text-xs text-zinc-500">{sel.length}/{MAX} selecionados</span>
          </div>
          {orders.length === 0 ? <p className="rounded-lg border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500">Nenhuma entrega aguardando entregador.</p> : (
            <ul className="divide-y divide-zinc-100 rounded-lg border border-zinc-200">
              {orders.map((o) => {
                const checked = sel.includes(o.id);
                const toCollect = o.payment_status !== "paid";
                return (
                  <li key={o.id}>
                    <label className={`flex cursor-pointer items-start gap-3 p-3 text-sm hover:bg-zinc-50 ${checked ? "bg-brand-50" : ""}`}>
                      <input type="checkbox" className="mt-1" checked={checked} disabled={!checked && sel.length >= MAX} onChange={() => toggle(o.id)} />
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-2">
                          <b>#{o.number}</b><span className="truncate">{o.customer_name}</span>
                          <span className={`badge ${o.status === "ready" ? "bg-green-100 text-green-800" : "bg-amber-100 text-amber-800"}`}>{o.status === "ready" ? "Pronto" : "Em preparo"}</span>
                        </span>
                        <span className="block text-xs text-zinc-500">{hood(o.address)} · há {minutesAgo(o.created_at)} min</span>
                      </span>
                      <span className="text-right tabular-nums">
                        <b>{brl(o.total_cents)}</b>
                        {toCollect && <span className="block text-xs font-medium text-amber-700">a cobrar</span>}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
          {activeCouriers.length === 0 ? (
            <p className="text-sm text-zinc-500">Cadastre um entregador na aba &quot;Entregadores&quot; para despachar.</p>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <select className="input w-auto flex-1" value={courier} onChange={(e) => setCourier(e.target.value)} aria-label="Entregador">
                {activeCouriers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <button className="btn-primary" disabled={busy || !sel.length || !courier} onClick={assign}>
                {busy ? "Atribuindo..." : `Atribuir rota${sel.length ? ` (${sel.length})` : ""}`}
              </button>
            </div>
          )}
          <p className="text-xs text-zinc-500">A ordem da rota é sugerida pela proximidade a partir da loja. O pedido sai quando o entregador marca a saída no app.</p>
        </section>

        <section className="card space-y-3">
          <h2 className="font-semibold">Em rota</h2>
          {byCourier.size === 0 ? <Empty>Nenhuma entrega em andamento.</Empty> : (
            <div className="space-y-3">
              {[...byCourier.entries()].map(([cid, batches]) => {
                const c = couriers.find((x) => x.id === cid);
                return (
                  <div key={cid} className="rounded-lg border border-zinc-200">
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-100 bg-zinc-50 px-3 py-2">
                      <b className="text-sm">{c?.name ?? "Entregador"}</b>
                      {manager && c && (
                        <span className="flex gap-1">
                          <button className="btn-ghost px-2 py-1 text-xs" onClick={() => void link(c, "copy")}>Copiar link</button>
                          <button className="btn-ghost px-2 py-1 text-xs" onClick={() => void link(c, "wa")}>Enviar link pelo WhatsApp</button>
                        </span>
                      )}
                    </div>
                    {[...batches.entries()].map(([bid, list], bi) => (
                      <div key={bid} className="px-3 py-2">
                        {batches.size > 1 && <p className="mb-1 text-xs font-medium text-zinc-500">Rota {bi + 1}</p>}
                        <ol className="space-y-1.5 text-sm">
                          {list.map((d) => (
                            <li key={d.id} className="flex items-center gap-2">
                              <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-zinc-100 text-xs font-semibold">{d.seq}</span>
                              <span className="min-w-0 flex-1 truncate">#{d.orders?.number} · {d.orders?.address?.neighborhood || d.orders?.customer_name}</span>
                              <span className={`badge ${d.status === "picked_up" ? "bg-brand-100 text-brand-800" : "bg-zinc-100 text-zinc-700"}`}>{DELIVERY_STATUS[d.status] ?? d.status}</span>
                              {d.status === "assigned" && <button className="btn-ghost px-2 py-1 text-xs text-red-600" onClick={() => void unassign(d.id)}>Remover</button>}
                            </li>
                          ))}
                        </ol>
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
