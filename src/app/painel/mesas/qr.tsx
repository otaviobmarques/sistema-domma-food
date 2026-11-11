"use client";
import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { supabaseBrowser } from "@/lib/supabase/client";
import { Alert, Modal, Toggle } from "@/components/ui";
import { brl, errorMessage } from "@/lib/format";
import { minutesSince, pendingQr, type DTable, type Tab } from "./types";

const mesaUrl = (token: string) => `${window.location.origin}/mesa/${token}`;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function beep() {
  try {
    if (localStorage.getItem("df_mute") === "1") return;
    const ctx = new AudioContext();
    [0, 0.18].forEach((t) => {
      const o = ctx.createOscillator(); const g = ctx.createGain();
      o.frequency.value = 880; g.gain.value = 0.12;
      o.connect(g); g.connect(ctx.destination);
      o.start(ctx.currentTime + t); o.stop(ctx.currentTime + t + 0.12);
    });
  } catch { /* sem áudio */ }
}

/** Avisos do salão: garçom chamado e pedidos do QR esperando aceite. */
export function QrAlerts({ tabs, tables, now, onOpen, onChanged }: {
  tabs: Tab[]; tables: DTable[]; now: number; onOpen: (tabId: string) => void; onChanged: () => Promise<void> | void;
}) {
  const sb = supabaseBrowser();
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const name = (t: Tab) => { const tb = tables.find((x) => x.id === t.table_id); return tb ? `Mesa ${tb.name}` : `Comanda ${t.label}`; };
  const calls = tabs.filter((t) => t.waiter_called_at);
  const pend = tabs.flatMap((t) => pendingQr(t).map((o) => ({ tab: t, order: o })));
  const count = calls.length + pend.length;
  const prev = useRef(count);
  useEffect(() => { if (count > prev.current) beep(); prev.current = count; }, [count]);

  async function run(key: string, fn: () => PromiseLike<{ error: { message: string } | null }>) {
    setBusy(key); setErr("");
    const { error } = await fn();
    setBusy("");
    if (error) setErr(errorMessage(error)); else await onChanged();
  }

  if (!count) return null;
  return (
    <section className="rounded-lg border border-violet-200 bg-violet-50 p-3" aria-live="polite">
      <h2 className="mb-2 text-sm font-semibold text-violet-900">Precisam de atenção ({count})</h2>
      <Alert>{err}</Alert>
      <ul className="space-y-2">
        {calls.map((t) => (
          <li key={`c-${t.id}`} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-white p-2.5 text-sm ring-1 ring-violet-200">
            <span><b>{name(t)}</b> chamou o garçom · há {minutesSince(t.waiter_called_at!, now)} min</span>
            <span className="flex gap-2">
              <button className="btn-ghost" onClick={() => onOpen(t.id)}>Abrir</button>
              <button className="btn-primary" disabled={busy === `c-${t.id}`} onClick={() => run(`c-${t.id}`, () => sb.rpc("tab_ack_call", { p_tab_id: t.id }))}>Atendido</button>
            </span>
          </li>
        ))}
        {pend.map(({ tab, order }) => (
          <li key={order.id} className="rounded-lg bg-white p-2.5 text-sm ring-1 ring-violet-200">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <p><b>{name(tab)}</b> · pedido #{order.number} pelo QR Code · {brl(order.subtotal_cents)}</p>
                <p className="text-xs text-zinc-600">{order.order_items.map((i) => `${i.quantity}x ${i.name}`).join(", ")}</p>
                {order.notes && <p className="text-xs font-medium text-amber-800">Obs.: {order.notes}</p>}
              </div>
              <span className="flex gap-2">
                <button className="btn-ghost text-red-600" disabled={busy === order.id} onClick={() => {
                  const reason = prompt("Motivo da recusa (o cliente verá o pedido como cancelado):", "Item indisponível");
                  if (reason) void run(order.id, () => sb.rpc("set_order_status", { p_order_id: order.id, p_status: "cancelled", p_reason: reason }));
                }}>Recusar</button>
                <button className="btn-success" disabled={busy === order.id}
                  onClick={() => run(order.id, () => sb.rpc("set_order_status", { p_order_id: order.id, p_status: "preparing", p_reason: null }))}>Aceitar e enviar à cozinha</button>
              </span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Configuração do QR na mesa e impressão das plaquinhas. */
export function QrModal({ tables, unitId, unitName, onClose, onChanged }: {
  tables: DTable[]; unitId: string; unitName: string; onClose: () => void; onChanged: () => Promise<void> | void;
}) {
  const sb = supabaseBrowser();
  const [cfg, setCfg] = useState<{ table_qr_enabled: boolean; table_qr_auto_accept: boolean } | null>(null);
  const [codes, setCodes] = useState<Record<string, string>>({});
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const active = tables.filter((t) => t.active && t.qr_token);

  useEffect(() => {
    (async () => {
      const { data, error } = await sb.from("units").select("table_qr_enabled, table_qr_auto_accept").eq("id", unitId).single();
      if (error) setErr(errorMessage(error)); else setCfg(data as { table_qr_enabled: boolean; table_qr_auto_accept: boolean });
    })();
  }, [sb, unitId]);

  useEffect(() => {
    let alive = true;
    void Promise.all(active.map(async (t) => [t.id, await QRCode.toDataURL(mesaUrl(t.qr_token!), { margin: 1, width: 360, errorCorrectionLevel: "M" })] as const))
      .then((pairs) => { if (alive) setCodes(Object.fromEntries(pairs)); });
    return () => { alive = false; };
  }, [active.map((t) => t.qr_token).join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

  async function setOpt(k: "table_qr_enabled" | "table_qr_auto_accept", v: boolean) {
    setErr("");
    const { error } = await sb.from("units").update({ [k]: v }).eq("id", unitId);
    if (error) setErr(errorMessage(error)); else setCfg((c) => c && { ...c, [k]: v });
  }

  async function rotate(t: DTable) {
    if (!confirm(`Gerar um novo QR Code para a mesa ${t.name}? A plaquinha atual deixa de funcionar e precisa ser reimpressa.`)) return;
    const { error } = await sb.rpc("table_qr_rotate", { p_table_id: t.id });
    if (error) { setErr(errorMessage(error)); return; }
    setMsg(`Novo QR Code gerado para a mesa ${t.name}. Imprima a plaquinha de novo.`);
    await onChanged();
  }

  function print(list: DTable[]) {
    const w = window.open("", "_blank", "width=900,height=700");
    if (!w) { setErr("Libere pop-ups para imprimir."); return; }
    const cards = list.filter((t) => codes[t.id]).map((t) => `
      <div class="card"><p class="store">${esc(unitName)}</p><p class="mesa">Mesa ${esc(t.name)}</p>
      <img src="${codes[t.id]}" alt=""/><p class="cta">Aponte a câmera do celular</p>
      <p class="sub">Veja o cardápio, peça e chame o garçom</p></div>`).join("");
    w.document.write(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>QR Code das mesas</title><style>
      @page{size:A4;margin:10mm}body{font-family:system-ui,sans-serif;margin:0;color:#18181b}
      .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8mm}
      .card{border:1.5px dashed #d4d4d8;border-radius:12px;padding:6mm;text-align:center;break-inside:avoid}
      .store{font-size:12px;color:#71717a;margin:0}.mesa{font-size:26px;font-weight:800;margin:2mm 0;color:#d9262b}
      img{width:100%;max-width:48mm}.cta{font-weight:700;margin:2mm 0 0;font-size:13px}.sub{font-size:11px;color:#52525b;margin:1mm 0 0}
      </style></head><body><div class="grid">${cards}</div><script>window.onload=()=>{window.print()}<\/script></body></html>`);
    w.document.close();
  }

  return (
    <Modal open onClose={onClose} title="QR Code das mesas" wide>
      <div className="space-y-4">
        <p className="text-sm text-zinc-600">Cada mesa tem um QR Code próprio. O cliente abre o cardápio no celular, faz o pedido direto na comanda da mesa, chama o garçom e pede a conta. O pagamento continua com a equipe.</p>
        <Alert>{err}</Alert>
        <Alert kind="success">{msg}</Alert>
        {cfg && (
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex items-center justify-between gap-3 rounded-lg border border-zinc-200 p-3 text-sm">
              <span><b className="font-medium">Pedidos pelo QR Code</b><span className="block text-xs text-zinc-500">Desligado, o cliente só vê o cardápio.</span></span>
              <Toggle checked={cfg.table_qr_enabled} onChange={(v) => void setOpt("table_qr_enabled", v)} label="Pedidos pelo QR Code" />
            </label>
            <label className="flex items-center justify-between gap-3 rounded-lg border border-zinc-200 p-3 text-sm">
              <span><b className="font-medium">Enviar direto para a cozinha</b><span className="block text-xs text-zinc-500">Desligado, a equipe aceita cada pedido antes (recomendado).</span></span>
              <Toggle checked={cfg.table_qr_auto_accept} onChange={(v) => void setOpt("table_qr_auto_accept", v)} label="Enviar direto para a cozinha" />
            </label>
          </div>
        )}
        {active.length === 0 ? <p className="text-sm text-zinc-500">Cadastre mesas em &quot;Gerenciar mesas&quot; para gerar os QR Codes.</p> : (
          <>
            <div className="flex justify-end"><button className="btn-primary" onClick={() => print(active)} disabled={Object.keys(codes).length === 0}>Imprimir todas ({active.length})</button></div>
            <ul className="grid max-h-[50vh] grid-cols-2 gap-3 overflow-y-auto sm:grid-cols-3 lg:grid-cols-4">
              {active.map((t) => (
                <li key={t.id} className="rounded-lg border border-zinc-200 p-3 text-center">
                  <p className="font-semibold">Mesa {t.name}</p>
                  {codes[t.id]
                    // eslint-disable-next-line @next/next/no-img-element
                    ? <img src={codes[t.id]} alt={`QR Code da mesa ${t.name}`} className="mx-auto my-2 w-32" />
                    : <div className="mx-auto my-2 h-32 w-32 animate-pulse rounded bg-zinc-100" />}
                  <div className="flex flex-wrap justify-center gap-1">
                    <button className="btn-ghost px-2 text-xs" onClick={() => print([t])}>Imprimir</button>
                    <a className="btn-ghost px-2 text-xs" href={mesaUrl(t.qr_token!)} target="_blank" rel="noopener noreferrer">Abrir</a>
                    <button className="btn-ghost px-2 text-xs text-red-600" onClick={() => void rotate(t)}>Novo QR</button>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </Modal>
  );
}
