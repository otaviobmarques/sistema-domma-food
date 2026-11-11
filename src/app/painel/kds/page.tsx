"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { usePanel } from "@/lib/panel/context";
import { ChannelBadge } from "@/components/channel-badge";
import { errorMessage, TYPE_LABEL } from "@/lib/format";

type Item = {
  id: string; name: string; quantity: number; notes: string | null; station: string | null;
  kds_status: "pending" | "preparing" | "done";
  options: { name: string; quantity?: number }[] | null;
};
type KOrder = {
  id: string; number: number; channel: string; type: string; customer_name: string; notes: string | null;
  accepted_at: string | null; created_at: string; scheduled_for: string | null; order_items: Item[];
};

const ACT_ROLES = ["owner", "manager", "cashier", "attendant", "kitchen"];
const stationOf = (i: Item) => i.station ?? "cozinha";
const ls = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* sem armazenamento */ } },
};

function beep() {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    [0, 0.22].forEach((t) => {
      const o = ctx.createOscillator(); const g = ctx.createGain();
      o.type = "square"; o.frequency.value = 880; g.gain.value = 0.08;
      o.connect(g); g.connect(ctx.destination);
      o.start(ctx.currentTime + t); o.stop(ctx.currentTime + t + 0.15);
    });
    setTimeout(() => void ctx.close(), 800);
  } catch { /* navegador sem áudio */ }
}

export default function KdsPage() {
  const { unit, role } = usePanel();
  const sb = supabaseBrowser();
  const canAct = ACT_ROLES.includes(role);
  const [orders, setOrders] = useState<KOrder[]>([]);
  const [stations, setStations] = useState<string[]>(["cozinha", "bar"]);
  const [station, setStation] = useState("all");
  const [compact, setCompact] = useState(false);
  const [muted, setMuted] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [full, setFull] = useState(false);
  const known = useRef<Set<string> | null>(null);
  const mutedRef = useRef(false);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setStation(ls.get(`df_kds_station_${unit.id}`) ?? "all");
    setCompact(ls.get("df_kds_compact") === "1");
    const m = ls.get("df_kds_mute") === "1"; setMuted(m); mutedRef.current = m;
    void sb.from("units").select("kds_stations").eq("id", unit.id).single()
      .then(({ data }: { data: { kds_stations: string[] } | null }) => { if (data?.kds_stations?.length) setStations(data.kds_stations); });
  }, [sb, unit.id]);

  const load = useCallback(async () => {
    const { data, error } = await sb.from("orders")
      .select("id, number, channel, type, customer_name, notes, accepted_at, created_at, scheduled_for, order_items(id, name, quantity, notes, station, kds_status, options)")
      .eq("unit_id", unit.id).eq("status", "preparing").order("accepted_at", { ascending: true }).limit(80);
    if (error) { setErr(error.message); return; }
    const list = (data ?? []) as KOrder[];
    const ids = new Set(list.map((o) => o.id));
    if (known.current && !mutedRef.current && list.some((o) => !known.current!.has(o.id))) beep();
    known.current = ids;
    setOrders(list); setErr("");
  }, [sb, unit.id]);

  useEffect(() => {
    void load();
    const poll = setInterval(() => void load(), 8000);
    const tick = setInterval(() => setNow(Date.now()), 15000);
    const ch = sb.channel(`kds-${unit.id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "orders", filter: `unit_id=eq.${unit.id}` }, () => void load())
      .subscribe();
    const onFs = () => setFull(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFs);
    return () => { clearInterval(poll); clearInterval(tick); void sb.removeChannel(ch); document.removeEventListener("fullscreenchange", onFs); };
  }, [load, sb, unit.id]);

  const allStations = useMemo(() => {
    const extra = new Set<string>();
    orders.forEach((o) => o.order_items.forEach((i) => { if (!stations.includes(stationOf(i))) extra.add(stationOf(i)); }));
    return [...stations, ...extra];
  }, [orders, stations]);

  const cards = useMemo(() => orders.map((o) => {
    const mine = o.order_items.filter((i) => i.kds_status !== "done" && (station === "all" || stationOf(i) === station));
    const others = o.order_items.filter((i) => i.kds_status !== "done" && station !== "all" && stationOf(i) !== station).length;
    return { o, mine, others };
  }).filter((c) => c.mine.length > 0), [orders, station]);

  async function setItems(items: Item[], status: Item["kds_status"]) {
    if (!canAct || !items.length) return;
    setBusy((b) => new Set([...b, ...items.map((i) => i.id)]));
    // otimista
    setOrders((os) => os.map((o) => ({ ...o, order_items: o.order_items.map((i) => items.some((x) => x.id === i.id) ? { ...i, kds_status: status } : i) })));
    for (const i of items) {
      const { error } = await sb.rpc("kds_set_item", { p_item_id: i.id, p_status: status });
      if (error) { setErr(errorMessage(error)); break; }
    }
    setBusy((b) => { const n = new Set(b); items.forEach((i) => n.delete(i.id)); return n; });
    void load();
  }

  function toggleFull() {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void wrap.current?.requestFullscreen?.().catch(() => setErr("Seu navegador não permitiu a tela cheia."));
  }

  const pill = (active: boolean) => `rounded-full px-4 py-2.5 text-sm font-bold capitalize transition ${active ? "bg-white text-zinc-900" : "bg-white/10 text-white hover:bg-white/20"}`;

  return (
    <div ref={wrap} className={`-m-4 min-h-screen bg-zinc-950 p-4 text-white lg:-m-6 lg:p-6 ${full ? "overflow-y-auto" : ""}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">KDS · Cozinha <span className="ml-2 text-base font-medium text-white/50">{cards.length} pedido(s)</span></h1>
        <div className="flex flex-wrap gap-2">
          <button className={pill(false)} onClick={() => { const v = !compact; setCompact(v); ls.set("df_kds_compact", v ? "1" : "0"); }}>{compact ? "Layout normal" : "Layout compacto"}</button>
          <button className={pill(false)} aria-pressed={muted} onClick={() => { const v = !muted; setMuted(v); mutedRef.current = v; ls.set("df_kds_mute", v ? "1" : "0"); if (!v) beep(); }}>{muted ? "Som desligado" : "Som ligado"}</button>
          <button className={pill(false)} onClick={toggleFull}>{full ? "Sair da tela cheia" : "Tela cheia"}</button>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-2" role="tablist" aria-label="Setores">
        {["all", ...allStations].map((s) => {
          const n = orders.reduce((a, o) => a + o.order_items.filter((i) => i.kds_status !== "done" && (s === "all" || stationOf(i) === s)).length, 0);
          return (
            <button key={s} role="tab" aria-selected={station === s} className={pill(station === s)}
              onClick={() => { setStation(s); ls.set(`df_kds_station_${unit.id}`, s); }}>
              {s === "all" ? "Todos" : s} <span className="ml-1 opacity-60">{n}</span>
            </button>
          );
        })}
      </div>

      {err && <p role="alert" className="mt-4 rounded-xl bg-red-500/20 px-4 py-3 text-sm font-semibold text-red-200">{err}</p>}
      {!canAct && <p className="mt-4 text-sm text-white/50">Seu perfil pode acompanhar a produção, mas não alterar os itens.</p>}

      {cards.length === 0 ? (
        <div className="mt-16 text-center text-white/40">
          <p className="text-5xl">✓</p>
          <p className="mt-3 text-lg font-semibold">Nenhum item para preparar{station !== "all" ? ` em ${station}` : ""}.</p>
          <p className="text-sm">Os pedidos aceitos aparecem aqui automaticamente.</p>
        </div>
      ) : (
        <div className={`mt-5 grid gap-4 ${compact ? "sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-5" : "sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4"}`}>
          {cards.map(({ o, mine, others }) => {
            const min = Math.max(0, Math.floor((now - new Date(o.accepted_at ?? o.created_at).getTime()) / 60000));
            const tone = min < 10 ? "bg-emerald-500 text-emerald-950" : min < 20 ? "bg-amber-400 text-amber-950" : "bg-red-500 text-white";
            const border = min < 10 ? "border-emerald-500/40" : min < 20 ? "border-amber-400/60" : "border-red-500";
            return (
              <article key={o.id} className={`flex flex-col rounded-lg border-2 bg-zinc-900 ${border}`}>
                <header className="flex items-start justify-between gap-2 border-b border-white/10 p-3">
                  <div className="min-w-0">
                    <p className={`font-semibold ${compact ? "text-lg" : "text-2xl"}`}>#{o.number}</p>
                    <p className="flex flex-wrap items-center gap-1.5 text-sm text-white/70">
                      <ChannelBadge channel={o.channel === "table" || o.channel === "counter" ? "web" : o.channel} />
                      <span className="truncate font-semibold text-white">{o.channel === "table" || o.channel === "counter" ? o.customer_name : o.customer_name.split(" ")[0]}</span>
                      <span>· {o.channel === "counter" ? "Balcão" : TYPE_LABEL[o.type] ?? o.type}</span>
                    </p>
                  </div>
                  <span className={`shrink-0 rounded-full px-3 py-1 text-sm font-semibold tabular-nums ${tone}`} aria-label={`${min} minutos`}>{min} min</span>
                </header>
                {o.notes && <p className="mx-3 mt-3 rounded-lg bg-amber-400 px-3 py-2 text-sm font-bold text-amber-950">OBS: {o.notes}</p>}
                <ul className="flex-1 space-y-2 p-3">
                  {mine.map((i) => {
                    const prep = i.kds_status === "preparing";
                    return (
                      <li key={i.id}>
                        <button type="button" disabled={!canAct || busy.has(i.id)}
                          onClick={() => void setItems([i], prep ? "done" : "preparing")}
                          className={`w-full rounded-xl border px-3 text-left transition disabled:opacity-60 ${compact ? "py-2" : "py-3"} ${prep ? "border-sky-400 bg-sky-500/20" : "border-white/15 bg-white/5 hover:bg-white/10"}`}>
                          <span className="flex items-start justify-between gap-2">
                            <span className={`font-bold ${compact ? "text-base" : "text-lg"}`}>{i.quantity}× {i.name}</span>
                            <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold uppercase ${prep ? "bg-sky-400 text-sky-950" : "bg-white/15 text-white/80"}`}>{prep ? "Preparando" : "Na fila"}</span>
                          </span>
                          {(i.options ?? []).length > 0 && (
                            <span className="mt-1 block text-sm text-white/70">
                              {(i.options ?? []).map((op, k) => <span key={k} className="block">+ {(op.quantity ?? 1) > 1 ? `${op.quantity}× ` : ""}{op.name}</span>)}
                            </span>
                          )}
                          {i.notes && <span className="mt-1.5 block rounded-md bg-amber-400 px-2 py-1 text-sm font-bold text-amber-950">⚠ {i.notes}</span>}
                          {station === "all" && <span className="mt-1 block text-[11px] uppercase tracking-wide text-white/40">{stationOf(i)}</span>}
                          {canAct && <span className="mt-1 block text-xs text-white/50">{prep ? "Toque para concluir" : "Toque para iniciar"}</span>}
                        </button>
                      </li>
                    );
                  })}
                </ul>
                <footer className="space-y-2 p-3 pt-0">
                  {others > 0 && <p className="text-xs text-white/50">Outros setores: {others} item(ns) pendente(s)</p>}
                  {canAct && (
                    <button className="w-full rounded-xl bg-emerald-500 py-3 text-base font-semibold text-emerald-950 transition hover:bg-emerald-400 disabled:opacity-60"
                      disabled={mine.some((i) => busy.has(i.id))} onClick={() => void setItems(mine, "done")}>
                      Concluir todos
                    </button>
                  )}
                </footer>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
