"use client";
import { useCallback, useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { usePanel } from "@/lib/panel/context";
import { Alert, Field } from "@/components/ui";
import { brl, errorMessage } from "@/lib/format";

type Cfg = { meta_pixel_id: string; ga4_id: string; ads_id: string; ads_label: string };
type Report = {
  days: number;
  steps: { visit: number; view_item: number; add_to_cart: number; checkout: number; order: number; order_value_cents: number };
  sources: { source: string; visits: number; orders: number; value_cents: number }[];
  daily: { day: string; visits: number; orders: number }[];
  web_orders: number;
};
const EMPTY: Cfg = { meta_pixel_id: "", ga4_id: "", ads_id: "", ads_label: "" };
const STEPS: [keyof Report["steps"], string][] = [
  ["visit", "Visitaram o cardápio"], ["view_item", "Abriram um produto"], ["add_to_cart", "Colocaram na sacola"],
  ["checkout", "Foram para o checkout"], ["order", "Fizeram o pedido"],
];
const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 1000) / 10}%` : "—");

export function TrackingSettings() {
  const { unit } = usePanel();
  const sb = supabaseBrowser();
  const [cfg, setCfg] = useState<Cfg>(EMPTY);
  const [saved, setSaved] = useState<Cfg>(EMPTY);
  const [days, setDays] = useState(30);
  const [rep, setRep] = useState<Report | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [copied, setCopied] = useState("");

  const load = useCallback(async () => {
    const { data, error } = await sb.rpc("tracking_get", { p_unit_id: unit.id });
    if (error) { setErr(errorMessage(error)); return; }
    const d = data as Partial<Record<keyof Cfg, string | null>>;
    const c = { meta_pixel_id: d.meta_pixel_id ?? "", ga4_id: d.ga4_id ?? "", ads_id: d.ads_id ?? "", ads_label: d.ads_label ?? "" };
    setCfg(c); setSaved(c);
  }, [sb, unit.id]);
  const loadReport = useCallback(async () => {
    const { data, error } = await sb.rpc("funnel_report", { p_unit_id: unit.id, p_days: days });
    if (error) setErr(errorMessage(error)); else setRep(data as Report);
  }, [sb, unit.id, days]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void loadReport(); }, [loadReport]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(""); setMsg("");
    const { error } = await sb.rpc("tracking_save", { p_unit_id: unit.id, p: cfg });
    setBusy(false);
    if (error) { setErr(errorMessage(error)); return; }
    setMsg("Salvo. O cardápio já usa as novas configurações.");
    await load();
  }
  const dirty = JSON.stringify(cfg) !== JSON.stringify(saved);
  const set = (k: keyof Cfg) => (e: React.ChangeEvent<HTMLInputElement>) => setCfg({ ...cfg, [k]: e.target.value });

  const base = typeof window === "undefined" ? "" : `${window.location.origin}/loja/${unit.slug}`;
  const links = ["instagram", "facebook", "google", "whatsapp"].map((s) => [s, `${base}?utm_source=${s}`]);
  async function copy(v: string) {
    try { await navigator.clipboard.writeText(v); setCopied(v); setTimeout(() => setCopied(""), 1500); } catch { /* ignora */ }
  }
  const s = rep?.steps;
  const top = Math.max(1, s?.visit ?? 0);

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <section className="card space-y-4 p-5">
        <div>
          <h2 className="font-semibold">Funil do cardápio · {unit.name}</h2>
          <p className="mt-1 text-sm text-zinc-600">Contagem própria do Domma, anônima e sem cookies: cada sessão do navegador conta uma vez por etapa.</p>
        </div>
        <div className="flex gap-1" role="group" aria-label="Período">
          {[7, 30, 90].map((d) => (
            <button key={d} type="button" onClick={() => setDays(d)} aria-pressed={days === d}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium ${days === d ? "bg-brand-600 text-white" : "bg-zinc-100 text-zinc-700 hover:bg-zinc-200"}`}>{d} dias</button>
          ))}
        </div>
        {s && (
          <ol className="space-y-2.5">
            {STEPS.map(([k, label], i) => {
              const v = s[k];
              const prev = i === 0 ? null : s[STEPS[i - 1][0]];
              return (
                <li key={k}>
                  <div className="flex items-baseline justify-between text-sm">
                    <span className="font-medium text-zinc-800">{label}</span>
                    <span className="tabular-nums text-zinc-600"><b className="text-zinc-900">{v}</b>{prev != null && <span className="ml-2 text-xs">({pct(v, prev)} da etapa anterior)</span>}</span>
                  </div>
                  <div className="mt-1 h-2.5 overflow-hidden rounded-full bg-zinc-100">
                    <div className="h-full rounded-full bg-brand-600" style={{ width: `${Math.max(v > 0 ? 2 : 0, (v / top) * 100)}%` }} />
                  </div>
                </li>
              );
            })}
          </ol>
        )}
        {s && (
          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="rounded-xl bg-zinc-50 p-3"><p className="text-xs text-zinc-500">Conversão</p><p className="text-lg font-bold tabular-nums">{pct(s.order, s.visit)}</p></div>
            <div className="rounded-xl bg-zinc-50 p-3"><p className="text-xs text-zinc-500">Vendido pelo cardápio</p><p className="text-lg font-bold tabular-nums">{brl(s.order_value_cents)}</p></div>
            <div className="rounded-xl bg-zinc-50 p-3"><p className="text-xs text-zinc-500">Pedidos online (total)</p><p className="text-lg font-bold tabular-nums">{rep.web_orders}</p></div>
          </div>
        )}
        {rep && rep.sources.length > 0 && (
          <div>
            <h3 className="text-sm font-semibold text-zinc-800">De onde vieram</h3>
            <table className="mt-2 w-full text-sm">
              <thead><tr className="text-left text-xs text-zinc-500"><th className="py-1 font-medium">Origem</th><th className="py-1 text-right font-medium">Visitas</th><th className="py-1 text-right font-medium">Pedidos</th><th className="py-1 text-right font-medium">Valor</th></tr></thead>
              <tbody>
                {rep.sources.map((r) => (
                  <tr key={r.source} className="border-t border-zinc-100">
                    <td className="py-1.5">{r.source}</td>
                    <td className="py-1.5 text-right tabular-nums">{r.visits}</td>
                    <td className="py-1.5 text-right tabular-nums">{r.orders}</td>
                    <td className="py-1.5 text-right tabular-nums">{brl(r.value_cents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {s && s.visit === 0 && <p className="text-sm text-zinc-500">Ainda não há visitas neste período.</p>}
        <div>
          <h3 className="text-sm font-semibold text-zinc-800">Links com origem</h3>
          <p className="mt-1 text-xs text-zinc-500">Use estes links na bio, nos anúncios e nas mensagens para saber de onde vêm os pedidos.</p>
          <ul className="mt-2 space-y-1.5">
            {links.map(([s2, l]) => (
              <li key={s2} className="flex items-center gap-2 text-xs">
                <code className="min-w-0 flex-1 truncate rounded bg-zinc-50 px-2 py-1 ring-1 ring-zinc-200">{l}</code>
                <button type="button" className="btn-ghost shrink-0 px-2 py-1 text-xs" onClick={() => copy(l)}>{copied === l ? "Copiado ✓" : "Copiar"}</button>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <form onSubmit={save} className="card space-y-4 p-5">
        <div>
          <h2 className="font-semibold">Pixel do Meta e Google</h2>
          <p className="mt-1 text-sm text-zinc-600">
            Informe os IDs das suas contas. O cardápio envia visita, produto visto, adicionar à sacola, início do checkout e compra (com valor),
            para seus anúncios medirem e otimizarem as vendas. As ferramentas só carregam depois que o cliente aceita os cookies.
          </p>
        </div>
        <Field label="ID do Pixel do Meta" hint="Gerenciador de Eventos da Meta → Fontes de dados. Só números.">
          <input className="input" inputMode="numeric" value={cfg.meta_pixel_id} onChange={set("meta_pixel_id")} placeholder="1234567890123456" maxLength={20} />
        </Field>
        <Field label="ID de métricas do Google Analytics 4" hint="Analytics → Administrador → Fluxos de dados. Começa com G-.">
          <input className="input" value={cfg.ga4_id} onChange={set("ga4_id")} placeholder="G-AB12CD34EF" maxLength={18} />
        </Field>
        <details className="rounded-xl bg-zinc-50 p-3 text-sm" open={!!(saved.ads_id || saved.ads_label)}>
          <summary className="cursor-pointer font-medium text-zinc-800">Conversão do Google Ads (opcional)</summary>
          <div className="mt-3 space-y-3">
            <Field label="ID da conversão" hint="Google Ads → Metas → Conversões → Configurar tag. Começa com AW-.">
              <input className="input" value={cfg.ads_id} onChange={set("ads_id")} placeholder="AW-123456789" maxLength={18} />
            </Field>
            <Field label="Rótulo da conversão de compra" hint="O texto depois da barra em send_to (AW-123456789/rótulo).">
              <input className="input" value={cfg.ads_label} onChange={set("ads_label")} placeholder="AbCdEfGh123" maxLength={40} />
            </Field>
          </div>
        </details>
        <Alert>{err}</Alert>
        <Alert kind="success">{msg}</Alert>
        <div className="flex justify-end">
          <button className="btn-primary" disabled={busy || !dirty}>{busy ? "Salvando..." : "Salvar"}</button>
        </div>
        <p className="text-xs text-zinc-500">
          Dica: no Gerenciador de Eventos da Meta, use “Testar eventos” e abra o cardápio para ver os eventos chegando.
          No Google Analytics, veja em Relatórios → Tempo real.
        </p>
      </form>
    </div>
  );
}
