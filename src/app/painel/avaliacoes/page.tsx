"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabaseBrowser } from "@/lib/supabase/client";
import { canManage, usePanel } from "@/lib/panel/context";
import { Alert, Empty, Toggle } from "@/components/ui";
import { errorMessage } from "@/lib/format";

type Review = {
  id: string; customer_name: string; rating: number; comment: string | null; reply: string | null;
  replied_at: string | null; is_public: boolean; created_at: string;
  orders: { number: number } | { number: number }[] | null;
};

function Stars({ n, size = "text-base" }: { n: number; size?: string }) {
  const full = Math.round(n);
  return (
    <span className={`${size} leading-none`} role="img" aria-label={`${n} de 5 estrelas`}>
      <span className="text-amber-500">{"★".repeat(full)}</span><span className="text-zinc-300">{"★".repeat(5 - full)}</span>
    </span>
  );
}

export default function Avaliacoes() {
  const { unit, role } = usePanel();
  const sb = supabaseBrowser();
  const [rows, setRows] = useState<Review[]>([]);
  const [rating, setRating] = useState("all");
  const [onlyComment, setOnlyComment] = useState(false);
  const [onlyUnanswered, setOnlyUnanswered] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [savingId, setSavingId] = useState("");
  const [err, setErr] = useState("");
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    const { data, error } = await sb.from("reviews")
      .select("id, customer_name, rating, comment, reply, replied_at, is_public, created_at, orders(number)")
      .eq("unit_id", unit.id).order("created_at", { ascending: false }).limit(1000);
    if (error) setErr(error.message); else setRows((data ?? []) as unknown as Review[]);
    setLoaded(true);
  }, [sb, unit.id]);
  useEffect(() => { load(); }, [load]);

  const stats = useMemo(() => {
    const total = rows.length;
    const dist = [5, 4, 3, 2, 1].map((n) => ({ n, count: rows.filter((r) => r.rating === n).length }));
    const avg = total ? rows.reduce((a, r) => a + r.rating, 0) / total : 0;
    const positive = total ? Math.round((rows.filter((r) => r.rating >= 4).length / total) * 100) : 0;
    return { total, dist, avg, positive, pending: rows.filter((r) => r.comment && !r.reply).length };
  }, [rows]);

  const filtered = useMemo(() => rows.filter((r) =>
    (rating === "all" || r.rating === Number(rating)) && (!onlyComment || !!r.comment) && (!onlyUnanswered || !r.reply)),
  [rows, rating, onlyComment, onlyUnanswered]);

  if (!canManage(role)) return <p className="card">Apenas o dono ou o gerente acessam as avaliações.</p>;

  async function saveReply(r: Review) {
    const text = (drafts[r.id] ?? r.reply ?? "").trim();
    setSavingId(r.id); setErr("");
    const { error } = await sb.from("reviews").update({ reply: text || null, replied_at: text ? new Date().toISOString() : null }).eq("id", r.id);
    setSavingId("");
    if (error) { setErr(errorMessage(error)); return; }
    setDrafts((d) => { const n = { ...d }; delete n[r.id]; return n; });
    load();
  }

  async function togglePublic(r: Review, v: boolean) {
    const { error } = await sb.from("reviews").update({ is_public: v }).eq("id", r.id);
    if (error) setErr(errorMessage(error)); else load();
  }

  return (
    <div className="space-y-4">
      <h1 className="h1">Avaliações</h1>
      <Alert>{err}</Alert>

      {loaded && stats.total === 0 ? (
        <Empty>Nenhuma avaliação ainda. O cliente avalia na página de acompanhamento do pedido, depois que o pedido é concluído.</Empty>
      ) : (
        <>
          <div className="grid gap-4 lg:grid-cols-3">
            <section className="card flex flex-col items-center justify-center text-center">
              <p className="text-5xl font-extrabold tabular-nums">{stats.avg.toFixed(1).replace(".", ",")}</p>
              <Stars n={stats.avg} size="text-2xl" />
              <p className="mt-2 text-sm text-zinc-600">{stats.total} avaliação(ões) · {stats.positive}% positivas</p>
              {stats.pending > 0 && <p className="mt-1 text-xs font-semibold text-amber-700">{stats.pending} comentário(s) sem resposta</p>}
            </section>
            <section className="card lg:col-span-2">
              <h2 className="mb-3 font-semibold">Distribuição das notas</h2>
              <ul className="space-y-2">
                {stats.dist.map((d) => (
                  <li key={d.n} className="grid grid-cols-[3rem_1fr_3rem] items-center gap-2 text-sm">
                    <span className="text-zinc-600">{d.n} ★</span>
                    <span className="h-3 rounded bg-zinc-100">
                      <span className={`block h-3 rounded ${d.n >= 4 ? "bg-green-500" : d.n === 3 ? "bg-amber-400" : "bg-red-500"}`}
                        style={{ width: `${stats.total ? (d.count / stats.total) * 100 : 0}%` }} />
                    </span>
                    <span className="text-right tabular-nums">{d.count}</span>
                  </li>
                ))}
              </ul>
            </section>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <select className="input w-auto" value={rating} onChange={(e) => setRating(e.target.value)} aria-label="Filtrar por nota">
              <option value="all">Todas as notas</option>
              {[5, 4, 3, 2, 1].map((n) => <option key={n} value={n}>{n} estrela{n > 1 ? "s" : ""}</option>)}
            </select>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={onlyComment} onChange={(e) => setOnlyComment(e.target.checked)} /> Com comentário</label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={onlyUnanswered} onChange={(e) => setOnlyUnanswered(e.target.checked)} /> Sem resposta</label>
            <span className="text-sm text-zinc-500">{filtered.length} resultado(s)</span>
          </div>

          <ul className="space-y-3">
            {filtered.map((r) => {
              const o = Array.isArray(r.orders) ? r.orders[0] : r.orders;
              const low = r.rating <= 2;
              const draft = drafts[r.id] ?? r.reply ?? "";
              const dirty = draft.trim() !== (r.reply ?? "");
              return (
                <li key={r.id} className={`card ${low ? "border-red-300 bg-red-50/40" : ""}`}>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="flex flex-wrap items-center gap-2 font-semibold">
                        {r.customer_name} <Stars n={r.rating} />
                        {low && <span className="badge bg-red-100 text-red-800">Nota baixa</span>}
                      </p>
                      <p className="text-xs text-zinc-500">
                        {new Date(r.created_at).toLocaleString("pt-BR")}
                        {o && <> · <Link className="text-brand-700 hover:underline" href="/painel/historico">Pedido #{o.number}</Link></>}
                      </p>
                    </div>
                    <label className="flex items-center gap-2 text-xs text-zinc-600">
                      Visível no cardápio <Toggle checked={r.is_public} onChange={(v) => togglePublic(r, v)} label="Visível no cardápio" />
                    </label>
                  </div>
                  {r.comment ? <p className="mt-3 whitespace-pre-wrap text-sm text-zinc-800">“{r.comment}”</p>
                    : <p className="mt-3 text-sm text-zinc-500">Sem comentário.</p>}
                  <div className="mt-3">
                    <label className="label" htmlFor={`reply-${r.id}`}>Resposta da loja {r.replied_at && <span className="font-normal text-zinc-500">· enviada em {new Date(r.replied_at).toLocaleDateString("pt-BR")}</span>}</label>
                    <textarea id={`reply-${r.id}`} className="input min-h-16" maxLength={1000} value={draft} placeholder="Agradeça ou explique o que aconteceu. O cliente vê a resposta na página do pedido."
                      onChange={(e) => setDrafts((d) => ({ ...d, [r.id]: e.target.value }))} />
                    <div className="mt-2 flex gap-2">
                      <button className="btn-primary" disabled={!dirty || savingId === r.id} onClick={() => saveReply(r)}>
                        {savingId === r.id ? "Salvando..." : r.reply ? "Atualizar resposta" : "Responder"}
                      </button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
          {filtered.length === 0 && <p className="text-sm text-zinc-500">Nenhuma avaliação com esses filtros.</p>}
        </>
      )}
    </div>
  );
}
