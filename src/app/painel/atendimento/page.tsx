"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { canManage, usePanel } from "@/lib/panel/context";
import { Alert, Empty, Modal } from "@/components/ui";
import { brl, errorMessage, formatPhone } from "@/lib/format";
import { localPhone, WaOrder, type Placed, type Prefill } from "./order";

type Conv = { id: string; wa_id: string; name: string | null; status: "open" | "closed"; unread: number; last_preview: string | null;
  last_message_at: string; window_open: boolean; customer_id: string | null; orders_count: number | null };
type Overview = { wa_enabled: boolean; unread: number; conversations: Conv[] };
type Msg = { id: number; direction: "in" | "out"; kind: string; body: string | null; status: string; error: string | null; created_at: string; order_id: string | null };
type Detail = {
  conversation: { id: string; wa_id: string; name: string | null; status: "open" | "closed"; window_open: boolean; window_closes_at: string | null };
  customer: null | { id: string; name: string; phone: string; orders_count: number; total_spent_cents: number; last_order_at: string | null;
    cashback_cents: number; last_address: Record<string, string> | null;
    recent_orders: { id: string; number: number; status: string; total_cents: number; created_at: string; channel: string }[] };
  messages: Msg[];
};

const KIND_LABEL: Record<string, string> = { image: "📷 Imagem", audio: "🎤 Áudio", video: "🎬 Vídeo", document: "📄 Documento", sticker: "Figurinha",
  location: "📍 Localização", contacts: "👤 Contato", other: "Mensagem não suportada" };
const STATUS_LABEL: Record<string, string> = { pending: "Novo", awaiting_payment: "Aguardando pagamento", preparing: "Em preparo", ready: "Pronto",
  dispatched: "Saiu para entrega", completed: "Concluído", cancelled: "Cancelado" };
const time = (s: string) => new Date(s).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
const when = (s: string) => {
  const d = new Date(s), now = new Date();
  return d.toDateString() === now.toDateString() ? time(s) : d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
};
const waLink = (wa: string, text?: string) => `https://wa.me/${wa}${text ? `?text=${encodeURIComponent(text)}` : ""}`;

function Ticks({ m }: { m: Msg }) {
  if (m.direction === "in") return null;
  if (m.status === "failed") return <span className="text-red-600" title={m.error ?? "Falhou"}>⚠ não enviada</span>;
  if (m.status === "queued" || m.status === "sending") return <span aria-label="Enviando">🕓</span>;
  return <span className={m.status === "read" ? "text-sky-600" : ""} aria-label={m.status === "read" ? "Lida" : m.status === "delivered" ? "Entregue" : "Enviada"}>
    {m.status === "sent" ? "✓" : "✓✓"}</span>;
}

export default function Atendimento() {
  const { tenantId, role, unit } = usePanel();
  const sb = supabaseBrowser();
  const [ov, setOv] = useState<Overview | null>(null);
  const [filter, setFilter] = useState<"open" | "unread" | "closed">("open");
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<string | null>(null);
  const [det, setDet] = useState<Detail | null>(null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState("");
  const [order, setOrder] = useState<Prefill | null>(null);
  const [placed, setPlaced] = useState<{ p: Placed; conv: Detail["conversation"] | null } | null>(null);
  const [sentSummary, setSentSummary] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const selRef = useRef<string | null>(null);
  selRef.current = sel;

  const loadList = useCallback(async () => {
    const { data, error } = await sb.rpc("inbox_overview", { p_tenant_id: tenantId });
    if (error) setErr(errorMessage(error)); else setOv(data as Overview);
  }, [sb, tenantId]);
  const loadConv = useCallback(async (id: string) => {
    const { data, error } = await sb.rpc("inbox_open", { p_conversation_id: id });
    if (error) { setErr(errorMessage(error)); return; }
    if (selRef.current === id) setDet(data as Detail);
  }, [sb]);

  useEffect(() => { void loadList(); }, [loadList]);
  useEffect(() => { setDet(null); if (sel) void loadConv(sel); }, [sel, loadConv]);
  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); }, [det?.messages.length]);

  // tempo real: novas mensagens e mudanças de status
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    const refresh = (convId?: string) => {
      if (t) clearTimeout(t);
      t = setTimeout(() => { void loadList(); if (selRef.current && (!convId || convId === selRef.current)) void loadConv(selRef.current); }, 250);
    };
    const ch = sb.channel(`inbox-${tenantId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "wa_messages", filter: `tenant_id=eq.${tenantId}` },
        (p: { new?: { conversation_id?: string } }) => refresh(p.new?.conversation_id))
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "wa_conversations", filter: `tenant_id=eq.${tenantId}` }, () => refresh())
      .subscribe();
    const poll = setInterval(() => refresh(), 60_000);
    return () => { void sb.removeChannel(ch); clearInterval(poll); if (t) clearTimeout(t); };
  }, [sb, tenantId, loadList, loadConv]);

  const list = useMemo(() => {
    const n = q.trim().toLowerCase(), d = q.replace(/\D/g, "");
    return (ov?.conversations ?? []).filter((c) =>
      (filter === "closed" ? c.status === "closed" : c.status === "open" && (filter === "open" || c.unread > 0))
      && (!n || (c.name ?? "").toLowerCase().includes(n) || (d.length >= 3 && c.wa_id.includes(d))));
  }, [ov, filter, q]);

  async function send(body: string, orderId?: string) {
    if (!det || !body.trim()) return false;
    setSending(true); setErr("");
    const { data, error } = await sb.functions.invoke("marketing/inbox/send", { body: { conversation_id: det.conversation.id, text: body, order_id: orderId ?? null } });
    setSending(false);
    let msg = "";
    if (error) {
      try { msg = (await (error as { context?: Response }).context?.json())?.error ?? ""; } catch { /* ignora */ }
      msg = msg || errorMessage(error);
    } else if (data && (data as { ok: boolean }).ok === false) msg = (data as { error: string }).error;
    if (msg) setErr(msg);
    await loadConv(det.conversation.id);
    return !msg;
  }
  async function submitText(e: React.FormEvent) {
    e.preventDefault();
    if (await send(text)) setText("");
  }
  async function setStatus(s: "open" | "closed") {
    if (!det) return;
    const { error } = await sb.rpc("inbox_set_status", { p_conversation_id: det.conversation.id, p_status: s });
    if (error) setErr(errorMessage(error)); else { await loadList(); await loadConv(det.conversation.id); }
  }

  if (!(canManage(role) || role === "cashier" || role === "attendant")) return <Empty>O atendimento é feito pelo caixa, pelo atendimento e pela gerência.</Empty>;
  const menuLink = typeof window === "undefined" ? "" : `${window.location.origin}/loja/${unit.slug}`;
  const c = det?.conversation;
  const canReply = !!ov?.wa_enabled && !!c?.window_open;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="h1">Atendimento WhatsApp</h1>
          <p className="mt-1 max-w-3xl text-sm text-zinc-600">Converse com os clientes e lance o pedido ali mesmo, com o preço, a taxa de entrega e os cupons do cardápio. O pedido entra direto em preparo.</p>
        </div>
        <button className="btn-primary" onClick={() => setOrder({ conversationId: null, name: "", phone: "", address: null })}>+ Novo pedido</button>
      </div>
      {ov && !ov.wa_enabled && (
        <Alert kind="info">
          A caixa de entrada usa o WhatsApp oficial (API da Meta), que ainda não está ligado.{" "}
          {canManage(role) ? <Link href="/painel/marketing" className="font-semibold underline">Configure em Marketing › WhatsApp</Link> : "Peça à gerência para configurar."}{" "}
          Enquanto isso, use <b>Novo pedido</b> para lançar pedidos que chegam pelo WhatsApp da loja e envie a confirmação pelo próprio app.
        </Alert>
      )}
      <Alert>{err}</Alert>

      <div className="grid min-h-[70vh] overflow-hidden rounded-2xl bg-white ring-1 ring-zinc-200 lg:grid-cols-[300px_1fr_280px]">
        {/* conversas */}
        <aside className={`${sel ? "hidden lg:flex" : "flex"} flex-col border-zinc-200 lg:border-r`}>
          <div className="space-y-2 border-b border-zinc-200 p-3">
            <input className="input" placeholder="Buscar nome ou telefone" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Buscar conversa" />
            <div className="flex gap-1 text-xs" role="tablist">
              {([["open", "Abertas"], ["unread", `Não lidas${ov?.unread ? ` (${ov.unread})` : ""}`], ["closed", "Encerradas"]] as const).map(([k, l]) => (
                <button key={k} role="tab" aria-selected={filter === k} onClick={() => setFilter(k)}
                  className={`rounded-lg px-2.5 py-1 font-medium ${filter === k ? "bg-brand-600 text-white" : "bg-zinc-100 text-zinc-700"}`}>{l}</button>
              ))}
            </div>
          </div>
          <ul className="flex-1 divide-y divide-zinc-100 overflow-y-auto">
            {list.map((x) => (
              <li key={x.id}>
                <button onClick={() => setSel(x.id)} className={`flex w-full gap-3 px-3 py-3 text-left hover:bg-zinc-50 ${sel === x.id ? "bg-brand-50" : ""}`}>
                  <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-emerald-100 font-semibold text-emerald-800">{(x.name ?? "?").slice(0, 1).toUpperCase()}</span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="truncate font-medium text-zinc-900">{x.name ?? formatPhone(localPhone(x.wa_id))}</span>
                      <span className="shrink-0 text-[11px] text-zinc-500">{when(x.last_message_at)}</span>
                    </span>
                    <span className="flex items-center justify-between gap-2">
                      <span className="truncate text-xs text-zinc-500">{x.last_preview}</span>
                      {x.unread > 0 && <span className="grid h-5 min-w-5 place-items-center rounded-full bg-emerald-600 px-1 text-[11px] font-bold text-white">{x.unread}</span>}
                    </span>
                  </span>
                </button>
              </li>
            ))}
            {ov && !list.length && <li className="px-4 py-10 text-center text-sm text-zinc-500">{ov.wa_enabled ? "Nenhuma conversa aqui." : "As conversas aparecem aqui quando o WhatsApp oficial estiver ligado."}</li>}
          </ul>
        </aside>

        {/* conversa */}
        <section className={`${sel ? "flex" : "hidden lg:flex"} min-w-0 flex-col`}>
          {!c ? <div className="m-auto p-8 text-center text-sm text-zinc-500">{sel ? "Carregando..." : "Escolha uma conversa."}</div> : (
            <>
              <header className="flex items-center gap-3 border-b border-zinc-200 px-4 py-3">
                <button className="btn-ghost px-2 lg:hidden" onClick={() => setSel(null)} aria-label="Voltar">←</button>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold">{c.name ?? "Cliente"}</p>
                  <p className="text-xs text-zinc-500">{formatPhone(localPhone(c.wa_id))}{ov?.wa_enabled && (c.window_open
                    ? ` · pode responder até ${c.window_closes_at ? (when(c.window_closes_at) === time(c.window_closes_at) ? "" : when(c.window_closes_at) + " ") + time(c.window_closes_at) : ""}`
                    : " · janela de 24 h fechada")}</p>
                </div>
                <a className="btn-ghost px-2 text-xs" href={waLink(c.wa_id)} target="_blank" rel="noopener">Abrir no app</a>
                {c.status === "open"
                  ? <button className="btn-ghost px-2 text-xs" onClick={() => setStatus("closed")}>Encerrar</button>
                  : <button className="btn-ghost px-2 text-xs" onClick={() => setStatus("open")}>Reabrir</button>}
              </header>
              <div className="flex-1 space-y-2 overflow-y-auto bg-[#f4efe8] p-4" aria-live="polite">
                {det.messages.map((m) => (
                  <div key={m.id} className={`flex ${m.direction === "out" ? "justify-end" : "justify-start"}`}>
                    <div className={`max-w-[80%] whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-sm shadow-sm ${m.direction === "out" ? "rounded-br-md bg-emerald-100" : "rounded-bl-md bg-white"}`}>
                      {m.body ?? <span className="italic text-zinc-500">{KIND_LABEL[m.kind] ?? "Mensagem"} (veja no celular)</span>}
                      <span className="mt-0.5 flex justify-end gap-1 text-[10px] text-zinc-500">{time(m.created_at)} <Ticks m={m} /></span>
                    </div>
                  </div>
                ))}
                <div ref={endRef} />
              </div>
              <div className="border-t border-zinc-200 p-3">
                <div className="mb-2 flex flex-wrap gap-1.5">
                  <button type="button" className="rounded-full bg-zinc-100 px-3 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-200" disabled={!canReply || sending}
                    onClick={() => send(`Nosso cardápio com preços e fotos: ${menuLink}\nSe preferir, me diga o que deseja que eu anoto por aqui. 😊`)}>Enviar cardápio</button>
                  <button type="button" className="rounded-full bg-brand-600 px-3 py-1 text-xs font-medium text-white hover:bg-brand-700"
                    onClick={() => setOrder({ conversationId: c.id, name: det.customer?.name ?? c.name ?? "", phone: c.wa_id, address: det.customer?.last_address ?? null })}>Lançar pedido</button>
                </div>
                {canReply ? (
                  <form onSubmit={submitText} className="flex gap-2">
                    <textarea className="input min-h-[42px] flex-1 resize-none" rows={1} maxLength={4096} placeholder="Escreva uma mensagem" value={text}
                      onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void submitText(e); } }} />
                    <button className="btn-primary" disabled={sending || !text.trim()}>{sending ? "..." : "Enviar"}</button>
                  </form>
                ) : (
                  <p className="rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-800 ring-1 ring-amber-200">
                    {!ov?.wa_enabled ? "WhatsApp oficial desligado: responda pelo app." : "Passaram 24 h da última mensagem do cliente: a Meta só permite responder por modelo aprovado."}{" "}
                    <a className="font-semibold underline" href={waLink(c.wa_id)} target="_blank" rel="noopener">Responder pelo WhatsApp da loja</a>
                  </p>
                )}
              </div>
            </>
          )}
        </section>

        {/* cliente */}
        <aside className="hidden border-l border-zinc-200 p-4 text-sm lg:block">
          {!det ? null : !det.customer ? (
            <p className="text-zinc-500">Cliente novo: ainda sem pedidos com este número.</p>
          ) : (
            <div className="space-y-3">
              <div>
                <p className="font-semibold text-zinc-900">{det.customer.name}</p>
                <p className="text-xs text-zinc-500">{det.customer.orders_count} pedido(s) · {brl(det.customer.total_spent_cents)}{det.customer.cashback_cents > 0 ? ` · cashback ${brl(det.customer.cashback_cents)}` : ""}</p>
              </div>
              {det.customer.last_address && (
                <p className="rounded-lg bg-zinc-50 p-2 text-xs text-zinc-600">
                  {[det.customer.last_address.street, det.customer.last_address.number].filter(Boolean).join(", ")}
                  {det.customer.last_address.neighborhood ? ` · ${det.customer.last_address.neighborhood}` : ""}
                </p>
              )}
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Últimos pedidos</p>
                <ul className="mt-1 space-y-1">
                  {det.customer.recent_orders.map((o) => (
                    <li key={o.id} className="flex justify-between text-xs"><span>#{o.number} · {STATUS_LABEL[o.status] ?? o.status}</span><span className="tabular-nums">{brl(o.total_cents)}</span></li>
                  ))}
                </ul>
              </div>
            </div>
          )}
        </aside>
      </div>

      {order && (
        <WaOrder prefill={order} onClose={() => setOrder(null)}
          onPlaced={(p) => { setPlaced({ p, conv: order.conversationId && det?.conversation.id === order.conversationId ? det.conversation : null }); setSentSummary(""); setOrder(null); void loadList(); }} />
      )}
      {placed && (
        <Modal open onClose={() => setPlaced(null)} title={`Pedido #${placed.p.number} lançado`}>
          <p className="text-sm text-zinc-600">{placed.p.status === "awaiting_payment" ? "Aguardando o Pix: ele entra na cozinha quando o pagamento for confirmado." : "O pedido já está em preparo na tela de Pedidos e no KDS."} Envie a confirmação ao cliente:</p>
          <pre className="mt-3 max-h-64 overflow-y-auto whitespace-pre-wrap rounded-xl bg-zinc-50 p-3 text-xs ring-1 ring-zinc-200">{placed.p.summary}</pre>
          <div className="mt-4 flex flex-wrap justify-end gap-2">
            {placed.conv && ov?.wa_enabled && placed.conv.window_open && (
              <button className="btn-primary" disabled={sending || !!sentSummary} onClick={async () => { if (await send(placed.p.summary, placed.p.order_id)) setSentSummary("ok"); }}>
                {sentSummary ? "Enviado ✓" : "Enviar na conversa"}
              </button>
            )}
            <a className="btn-secondary" target="_blank" rel="noopener" href={waLink(placed.p.wa, placed.p.summary)}>Enviar pelo WhatsApp da loja</a>
            <Link className="btn-ghost" href="/painel/pedidos">Ver em Pedidos</Link>
          </div>
        </Modal>
      )}
    </div>
  );
}
