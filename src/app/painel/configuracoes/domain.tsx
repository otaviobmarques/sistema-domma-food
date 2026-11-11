"use client";
import { useCallback, useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { usePanel } from "@/lib/panel/context";
import { Alert } from "@/components/ui";
import { errorMessage } from "@/lib/format";

type Rec = { type: string; name: string; value: string; reason?: string };
type Ov = { ready: boolean; slug: string; domain: null | { domain: string; status: "pending" | "active" | "error"; dns: Rec[] | null;
  last_check_at: string | null; last_error: string | null; verified_at: string | null } };

/** Domínio próprio do cardápio (ex.: pedidos.minhaloja.com.br). */
export function DomainCard() {
  const { unit } = usePanel();
  const sb = supabaseBrowser();
  const [ov, setOv] = useState<Ov | null>(null);
  const [domain, setDomain] = useState("");
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [copied, setCopied] = useState("");

  const load = useCallback(async () => {
    const { data, error } = await sb.rpc("domain_overview", { p_unit_id: unit.id });
    if (error) setErr(errorMessage(error)); else setOv(data as Ov);
  }, [sb, unit.id]);
  useEffect(() => { void load(); }, [load]);

  async function fn(path: string, body: Record<string, unknown> = {}) {
    setBusy(path); setErr(""); setMsg("");
    const { data, error } = await sb.functions.invoke(`domains/${path}`, { body: { unit_id: unit.id, ...body } });
    setBusy("");
    if (error) {
      let m = errorMessage(error);
      try { const b = await (error as { context?: Response }).context?.json(); if (b?.error) m = b.error; } catch { /* sem corpo */ }
      setErr(m); return null;
    }
    if (data?.error) { setErr(data.error); return null; }
    await load();
    return data as { status?: string };
  }
  function copy(v: string, k: string) { void navigator.clipboard.writeText(v); setCopied(k); setTimeout(() => setCopied(""), 1500); }

  if (!ov) return null;
  const d = ov.domain;
  const badge = !d ? null : d.status === "active" ? { t: "Ativo", c: "bg-green-100 text-green-800" }
    : d.status === "error" ? { t: "Com erro", c: "bg-red-100 text-red-800" } : { t: "Aguardando DNS", c: "bg-amber-100 text-amber-800" };

  return (
    <section className="card space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold">Domínio próprio do cardápio</h2>
          <p className="text-sm text-zinc-600">
            Use o endereço da sua marca, como <b>pedidos.suapizzaria.com.br</b>. O HTTPS (cadeado) é emitido automaticamente.
            O endereço atual continua funcionando: <span className="font-mono text-xs">domma-food.vercel.app/loja/{ov.slug}</span>.
          </p>
        </div>
        {badge && <span className={`badge ${badge.c}`}>{badge.t}</span>}
      </div>
      <Alert>{err}</Alert>
      <Alert kind="success">{msg}</Alert>

      {!ov.ready ? (
        <p className="text-sm text-zinc-500">O domínio próprio está sendo liberado pela plataforma.</p>
      ) : !d ? (
        <div className="flex flex-wrap gap-2">
          <input className="input max-w-sm font-mono" placeholder="pedidos.suaempresa.com.br" value={domain}
            onChange={(e) => setDomain(e.target.value.trim().toLowerCase())} aria-label="Domínio" />
          <button type="button" className="btn-primary" disabled={!domain || !!busy}
            onClick={async () => { const r = await fn("add", { domain }); if (r) setMsg(r.status === "active" ? "Domínio ativo!" : "Domínio cadastrado. Agora configure o DNS abaixo."); }}>
            {busy === "add" ? "Cadastrando..." : "Usar este domínio"}
          </button>
          <p className="w-full text-xs text-zinc-500">Dica: um subdomínio (pedidos., cardapio., delivery.) é mais simples e não mexe no site ou no e-mail da empresa.</p>
        </div>
      ) : (
        <div className="space-y-3 text-sm">
          <p className="flex flex-wrap items-center gap-2">
            <a className="font-mono font-semibold text-brand-700 hover:underline" href={`https://${d.domain}`} target="_blank" rel="noopener noreferrer">{d.domain} ↗</a>
            {d.last_check_at && <span className="text-xs text-zinc-500">conferido em {new Date(d.last_check_at).toLocaleString("pt-BR")}</span>}
          </p>
          {d.status !== "active" && (
            <>
              {d.last_error && <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">{d.last_error}</p>}
              <p>No painel de DNS de onde o domínio foi registrado (Registro.br, GoDaddy, Hostinger, Cloudflare...), crie:</p>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="text-left text-zinc-500"><tr><th className="py-1">Tipo</th><th>Nome</th><th>Valor</th><th /></tr></thead>
                  <tbody className="divide-y divide-zinc-100 font-mono">
                    {(d.dns ?? []).map((r, i) => (
                      <tr key={i}>
                        <td className="py-1.5 pr-3">{r.type}</td><td className="pr-3">{r.name}</td><td className="break-all pr-3">{r.value}</td>
                        <td><button type="button" className="font-sans font-medium text-brand-700 hover:underline" onClick={() => copy(r.value, String(i))}>{copied === String(i) ? "Copiado!" : "Copiar"}</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-xs text-zinc-500">A propagação costuma levar de minutos a algumas horas. Conferimos sozinhos a cada 10 minutos; ao ativar, o cardápio abre no novo endereço.
                Se usar Cloudflare, deixe o registro como “DNS only” (nuvem cinza).</p>
            </>
          )}
          {d.status === "active" && <p className="text-zinc-600">Tudo certo: o cardápio, o checkout e o acompanhamento do pedido já abrem por este endereço, e os links enviados pelo WhatsApp passam a usá-lo.</p>}
          <div className="flex flex-wrap gap-2">
            {d.status !== "active" && <button type="button" className="btn-secondary" disabled={!!busy}
              onClick={async () => { const r = await fn("check"); if (r) setMsg(r.status === "active" ? "Domínio ativo!" : "Ainda não apontado. Tente de novo em alguns minutos."); }}>
              {busy === "check" ? "Conferindo..." : "Conferir agora"}</button>}
            <button type="button" className="text-xs text-red-700 hover:underline" disabled={!!busy}
              onClick={async () => { if (confirm("Remover o domínio próprio? O cardápio continua no endereço do Domma.")) { if (await fn("remove")) setMsg("Domínio removido."); } }}>Remover domínio</button>
          </div>
        </div>
      )}
    </section>
  );
}
