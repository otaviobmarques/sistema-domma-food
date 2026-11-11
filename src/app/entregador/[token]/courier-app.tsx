"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { Alert, Modal } from "@/components/ui";
import { brl, errorMessage, formatPhone, onlyDigits, PAYMENT_LABEL } from "@/lib/format";

type Address = {
  street?: string | null; number?: string | null; complement?: string | null; neighborhood?: string | null;
  city?: string | null; reference?: string | null; lat?: number | null; lng?: number | null;
} | null;
export type Delivery = {
  id: string; batch_id: string; seq: number; status: "assigned" | "picked_up"; fee_cents: number;
  collect_cents: number; collect_method: string | null; change_for_cents: number | null;
  order_number: number; order_status: string; customer_name: string; customer_phone: string;
  address: Address; notes: string | null; items: number | null;
};
export type Portal = {
  courier: { name: string; vehicle: string };
  store: { name: string; phone: string | null; lat: number | null; lng: number | null; address: string | null };
  deliveries: Delivery[];
  today: { delivered: number; fees_cents: number; cash_cents: number };
};

const PAY_OPTIONS = [
  { k: "cash", l: "Dinheiro" }, { k: "card_on_delivery", l: "Cartão" }, { k: "pix", l: "Pix" }, { k: "voucher", l: "Vale" },
] as const;
const FAIL_REASONS = ["Cliente ausente", "Endereço não encontrado", "Cliente recusou", "Outro"] as const;

const addrLine = (a: Address) => {
  if (!a) return "";
  return [[a.street, a.number].filter(Boolean).join(", "), a.complement, a.neighborhood, a.city].filter(Boolean).join(" · ");
};
const addrQuery = (a: Address) =>
  a?.lat != null && a?.lng != null ? `${a.lat},${a.lng}` : encodeURIComponent([a?.street, a?.number, a?.neighborhood, a?.city].filter(Boolean).join(", "));
const mapsOne = (a: Address) => `https://www.google.com/maps/dir/?api=1&destination=${addrQuery(a)}&travelmode=driving`;
function mapsRoute(store: Portal["store"], stops: Delivery[]) {
  const origin = store.lat != null && store.lng != null ? `${store.lat},${store.lng}` : encodeURIComponent(store.address ?? "");
  const dest = addrQuery(stops[stops.length - 1].address);
  const way = stops.slice(0, -1).map((d) => addrQuery(d.address)).join("|");
  return `https://www.google.com/maps/dir/?api=1${origin ? `&origin=${origin}` : ""}&destination=${dest}${way ? `&waypoints=${way}` : ""}&travelmode=driving`;
}
const waLink = (phone: string) => { const d = onlyDigits(phone); return `https://wa.me/${d.startsWith("55") ? d : "55" + d}`; };

export function CourierApp({ token, initial }: { token: string; initial: Portal | null }) {
  const sb = supabaseBrowser();
  const [portal, setPortal] = useState<Portal | null>(initial);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState("");
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [paying, setPaying] = useState<Delivery | null>(null);
  const [payMethod, setPayMethod] = useState("cash");
  const [failing, setFailing] = useState<Delivery | null>(null);
  const [reason, setReason] = useState<string>(FAIL_REASONS[0]);
  const [other, setOther] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    const { data, error } = await sb.rpc("courier_portal", { p_token: token });
    setLoading(false);
    if (!error) setPortal((data as Portal | null) ?? null);
  }, [sb, token]);

  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 20000);
    const v = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", v);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", v); };
  }, [refresh]);

  const batches = useMemo(() => {
    const m = new Map<string, Delivery[]>();
    for (const d of portal?.deliveries ?? []) m.set(d.batch_id, [...(m.get(d.batch_id) ?? []), d]);
    return [...m.values()].map((l) => l.sort((a, b) => a.seq - b.seq));
  }, [portal]);

  async function act(d: Delivery, action: "pickup" | "deliver" | "fail", method?: string | null, why?: string | null) {
    setBusy(d.id); setMsg("");
    const { error } = await sb.rpc("courier_action", { p_token: token, p_delivery_id: d.id, p_action: action, p_method: method ?? null, p_reason: why ?? null });
    setBusy("");
    if (error) { setErrs((e) => ({ ...e, [d.id]: errorMessage(error) })); return false; }
    setErrs((e) => { const n = { ...e }; delete n[d.id]; return n; });
    return true;
  }

  async function pickupAll(list: Delivery[]) {
    let ok = 0;
    for (const d of list.filter((x) => x.status === "assigned")) if (await act(d, "pickup")) ok++;
    if (ok) setMsg(`${ok} entrega(s) marcada(s) como saindo.`);
    await refresh();
  }

  async function confirmDeliver() {
    if (!paying) return;
    const d = paying;
    if (await act(d, "deliver", d.collect_cents > 0 ? payMethod : null)) { setPaying(null); setMsg(`Pedido #${d.order_number} entregue.`); }
    await refresh();
  }

  async function confirmFail() {
    if (!failing) return;
    const why = reason === "Outro" ? other.trim() : reason;
    if (!why) return;
    const d = failing;
    if (await act(d, "fail", null, why)) { setFailing(null); setOther(""); setMsg(`Pedido #${d.order_number} volta para a loja.`); }
    await refresh();
  }

  if (!portal) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md items-center px-4">
        <div className="card w-full text-center">
          <p className="text-lg font-semibold">Link inválido ou desativado.</p>
          <p className="mt-1 text-sm text-zinc-600">Peça um novo link à loja.</p>
        </div>
      </main>
    );
  }

  const first = portal.courier.name.split(" ")[0];
  return (
    <main className="mx-auto min-h-screen max-w-md bg-zinc-50 px-4 pb-10 pt-5">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-zinc-900">Olá, {first}</h1>
          <p className="text-sm text-zinc-600">{portal.store.name}</p>
        </div>
        <button className="btn-secondary" onClick={() => void refresh()} disabled={loading}>{loading ? "Atualizando..." : "Atualizar"}</button>
      </header>

      <section className="mt-4 grid grid-cols-3 gap-2" aria-label="Resumo de hoje">
        <div className="rounded-lg border border-zinc-200 bg-white p-3"><p className="text-[11px] text-zinc-500">Entregas hoje</p><p className="text-lg font-semibold tabular-nums">{portal.today.delivered}</p></div>
        <div className="rounded-lg border border-zinc-200 bg-white p-3"><p className="text-[11px] text-zinc-500">Ganhos do dia</p><p className="text-lg font-semibold tabular-nums text-green-700">{brl(portal.today.fees_cents)}</p></div>
        <div className="rounded-lg border border-zinc-200 bg-white p-3"><p className="text-[11px] text-zinc-500">Dinheiro em mãos</p><p className="text-lg font-semibold tabular-nums">{brl(portal.today.cash_cents)}</p></div>
      </section>
      <p className="mt-1.5 text-xs text-zinc-500">Acerte o dinheiro com a loja no fim do turno.</p>

      <div className="mt-3"><Alert kind="success">{msg}</Alert></div>

      {batches.length === 0 ? (
        <div className="mt-6 rounded-lg border border-dashed border-zinc-300 bg-white p-8 text-center text-sm text-zinc-500">
          Nenhuma entrega agora. Esta tela atualiza sozinha.
        </div>
      ) : batches.map((list, bi) => (
        <section key={list[0].batch_id} className="mt-5" aria-label={`Rota ${bi + 1}`}>
          <div className="mb-2 flex items-center justify-between gap-2">
            <h2 className="font-semibold">Rota {bi + 1} · {list.length} parada(s)</h2>
          </div>
          <div className="grid gap-2">
            <a className="btn-secondary w-full py-3" href={mapsRoute(portal.store, list)} target="_blank" rel="noopener noreferrer">Abrir rota no mapa</a>
            {list.some((d) => d.status === "assigned") && (
              <button className="btn-primary w-full py-3 text-base" disabled={!!busy} onClick={() => void pickupAll(list)}>Saí para entrega (todas)</button>
            )}
          </div>

          <ul className="mt-3 space-y-3">
            {list.map((d) => (
              <li key={d.id} className="card space-y-3 p-4">
                <div className="flex items-start gap-3">
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-brand-600 text-sm font-semibold text-white">{d.seq}</span>
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 font-semibold">
                      #{d.order_number} · {d.customer_name}
                      <span className={`badge ${d.status === "picked_up" ? "bg-brand-50 text-brand-700" : "bg-zinc-100 text-zinc-600"}`}>
                        {d.status === "picked_up" ? "Em rota" : d.order_status === "preparing" ? "Em preparo" : "Aguardando saída"}
                      </span>
                    </p>
                    <p className="mt-1 text-sm text-zinc-700">{addrLine(d.address) || "Endereço não informado"}</p>
                    {d.address?.reference && <p className="text-xs text-zinc-500">Ref.: {d.address.reference}</p>}
                    <p className="mt-1 text-xs text-zinc-500">{d.items ?? 0} item(ns)</p>
                    {d.notes && <p className="mt-1 text-xs font-medium text-amber-800">Obs.: {d.notes}</p>}
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-2">
                  <a className="btn-secondary py-2.5" href={`tel:${onlyDigits(d.customer_phone)}`}>Ligar</a>
                  <a className="btn-secondary py-2.5" href={waLink(d.customer_phone)} target="_blank" rel="noopener noreferrer">WhatsApp</a>
                  <a className="btn-secondary py-2.5" href={mapsOne(d.address)} target="_blank" rel="noopener noreferrer">Mapa</a>
                </div>
                <p className="text-xs text-zinc-500">Telefone: {formatPhone(d.customer_phone)}</p>

                {d.collect_cents > 0 ? (
                  <div className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900 ring-1 ring-amber-200">
                    <p className="font-semibold">Cobrar {brl(d.collect_cents)} — {PAYMENT_LABEL[d.collect_method ?? ""] ?? d.collect_method}</p>
                    {d.change_for_cents ? (
                      <p className="mt-0.5">Levar troco para {brl(d.change_for_cents)} (troco {brl(Math.max(0, d.change_for_cents - d.collect_cents))})</p>
                    ) : null}
                  </div>
                ) : (
                  <div className="rounded-lg bg-green-50 p-3 text-sm font-medium text-green-800 ring-1 ring-green-200">Já pago online — não cobrar</div>
                )}

                {errs[d.id] && <Alert>{errs[d.id]}</Alert>}

                {d.status === "assigned" ? (
                  <button className="btn-primary w-full py-3 text-base" disabled={busy === d.id}
                    onClick={async () => { if (await act(d, "pickup")) setMsg(`Pedido #${d.order_number} saiu para entrega.`); await refresh(); }}>
                    {busy === d.id ? "Enviando..." : "Peguei, saindo"}
                  </button>
                ) : (
                  <button className="btn-success w-full py-3 text-base" disabled={busy === d.id}
                    onClick={() => { setPayMethod(d.collect_method && PAY_OPTIONS.some((o) => o.k === d.collect_method) ? d.collect_method : "cash"); setPaying(d); }}>
                    Entreguei
                  </button>
                )}
                <button className="btn-ghost w-full text-red-600" disabled={busy === d.id} onClick={() => { setReason(FAIL_REASONS[0]); setOther(""); setFailing(d); }}>
                  Não consegui entregar
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}

      <Modal open={!!paying} onClose={() => setPaying(null)} title={paying ? `Entregar pedido #${paying.order_number}` : ""}>
        {paying && (
          <div className="space-y-4">
            {paying.collect_cents > 0 ? (
              <>
                <p className="text-sm">Como o cliente pagou {brl(paying.collect_cents)}?</p>
                <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Forma de pagamento">
                  {PAY_OPTIONS.map((o) => (
                    <button key={o.k} type="button" role="radio" aria-checked={payMethod === o.k} onClick={() => setPayMethod(o.k)}
                      className={`rounded-lg border px-3 py-3 text-sm font-semibold ${payMethod === o.k ? "border-brand-600 bg-brand-50 text-brand-700" : "border-zinc-300 bg-white"}`}>
                      {o.l}
                    </button>
                  ))}
                </div>
              </>
            ) : <p className="text-sm text-zinc-600">Pedido já pago online. Confirme a entrega.</p>}
            {errs[paying.id] && <Alert>{errs[paying.id]}</Alert>}
            <button className="btn-success w-full py-3 text-base" disabled={busy === paying.id} onClick={() => void confirmDeliver()}>
              {busy === paying.id ? "Enviando..." : "Confirmar entrega"}
            </button>
          </div>
        )}
      </Modal>

      <Modal open={!!failing} onClose={() => setFailing(null)} title={failing ? `Pedido #${failing.order_number} não entregue` : ""}>
        {failing && (
          <div className="space-y-3">
            <div className="grid gap-2" role="radiogroup" aria-label="Motivo">
              {FAIL_REASONS.map((r) => (
                <button key={r} type="button" role="radio" aria-checked={reason === r} onClick={() => setReason(r)}
                  className={`rounded-lg border px-3 py-3 text-left text-sm font-medium ${reason === r ? "border-brand-600 bg-brand-50 text-brand-700" : "border-zinc-300 bg-white"}`}>
                  {r}
                </button>
              ))}
            </div>
            {reason === "Outro" && (
              <input className="input" maxLength={200} placeholder="Descreva o motivo" value={other} onChange={(e) => setOther(e.target.value)} autoFocus />
            )}
            {errs[failing.id] && <Alert>{errs[failing.id]}</Alert>}
            <button className="btn-danger w-full py-3" disabled={busy === failing.id || (reason === "Outro" && !other.trim())} onClick={() => void confirmFail()}>
              {busy === failing.id ? "Enviando..." : "Confirmar e voltar para a loja"}
            </button>
          </div>
        )}
      </Modal>
    </main>
  );
}
