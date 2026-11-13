"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { usePanel } from "@/lib/panel/context";
import { Alert, Field, Modal, Toggle } from "@/components/ui";
import { errorMessage } from "@/lib/format";

type Key = { id: string; name: string; prefix: string; scopes: string[]; unit_id: string | null; unit_name: string | null; created_at: string; last_used_at: string | null; calls_today: number };
type Hook = { id: string; url: string; events: string[]; unit_id: string | null; unit_name: string | null; active: boolean; failures: number;
  disabled_reason: string | null; last_success_at: string | null; last_error: string | null };
type Delivery = { id: number; endpoint_id: string; event: string; status: string; attempts: number; response_code: number | null; error: string | null; created_at: string; order_number: number | null };
type Overview = { keys: Key[]; webhooks: Hook[]; deliveries: Delivery[]; units: { id: string; name: string }[] };

export const API_BASE = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/api/v1`;
const SCOPES: [string, string][] = [
  ["orders:read", "Ler pedidos"], ["orders:write", "Mudar status de pedidos"],
  ["menu:read", "Ler cardápio"], ["menu:write", "Esgotar produto e mudar preço"], ["customers:read", "Ler clientes (dados pessoais)"],
];
const EVENTS: [string, string][] = [["order.created", "Pedido criado"], ["order.status_changed", "Status do pedido mudou"], ["order.paid", "Pedido pago"]];
const D_STATUS: Record<string, string> = { queued: "Na fila", sending: "Enviando", sent: "Entregue", failed: "Falhou" };
const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "nunca");

function Secret({ label, value, note }: { label: string; value: string; note: string }) {
  const [ok, setOk] = useState(false);
  return (
    <div>
      <p className="text-sm text-zinc-600">{note}</p>
      <p className="mt-3 text-xs font-medium text-zinc-600">{label}</p>
      <div className="mt-1 flex items-center gap-2">
        <code className="min-w-0 flex-1 break-all rounded bg-zinc-50 px-2 py-1.5 text-xs ring-1 ring-zinc-200">{value}</code>
        <button type="button" className="btn-secondary px-2 py-1 text-xs" onClick={async () => { try { await navigator.clipboard.writeText(value); setOk(true); } catch { /* ignora */ } }}>{ok ? "Copiado ✓" : "Copiar"}</button>
      </div>
    </div>
  );
}

/** Chaves de API e webhooks (só o dono). */
export function ApiCard() {
  const { tenantId, role } = usePanel();
  const sb = supabaseBrowser();
  const [ov, setOv] = useState<Overview | null>(null);
  const [err, setErr] = useState("");
  const [newKey, setNewKey] = useState<{ name: string; scopes: string[]; unit: string } | null>(null);
  const [newHook, setNewHook] = useState<{ url: string; events: string[]; unit: string } | null>(null);
  const [shown, setShown] = useState<{ title: string; label: string; value: string; note: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const { data, error } = await sb.rpc("api_overview", { p_tenant_id: tenantId });
    if (error) setErr(errorMessage(error)); else setOv(data as Overview);
  }, [sb, tenantId]);
  useEffect(() => { if (role === "owner") void load(); }, [load, role]);

  async function call(fn: () => PromiseLike<{ data: unknown; error: unknown }>) {
    setBusy(true); setErr("");
    const { data, error } = await fn();
    setBusy(false);
    if (error) { setErr(errorMessage(error as Error)); return null; }
    await load();
    return data as Record<string, string>;
  }
  async function createKey() {
    if (!newKey) return;
    const d = await call(() => sb.rpc("api_key_create", { p_tenant_id: tenantId, p_name: newKey.name, p_scopes: newKey.scopes, p_unit_id: newKey.unit || null }));
    if (d) { setNewKey(null); setShown({ title: "Chave de API criada", label: "Chave", value: d.key, note: "Copie agora e guarde num lugar seguro (no servidor da integração). Ela não aparece de novo; se perder, revogue e crie outra." }); }
  }
  async function createHook() {
    if (!newHook) return;
    const d = await call(() => sb.rpc("webhook_save", { p_tenant_id: tenantId, p_id: null, p: { url: newHook.url, events: newHook.events, unit_id: newHook.unit || null } }));
    if (d) { setNewHook(null); setShown({ title: "Webhook criado", label: "Segredo de assinatura", value: d.secret, note: "Use este segredo para conferir a assinatura (cabeçalho Domma-Signature) de cada envio. Ele não aparece de novo; dá para gerar outro a qualquer momento." }); }
  }
  async function rotate(h: Hook) {
    if (!confirm("Gerar um novo segredo? O sistema que recebe precisa trocar pelo novo, senão vai recusar os envios.")) return;
    const d = await call(() => sb.rpc("webhook_save", { p_tenant_id: tenantId, p_id: h.id, p: { rotate_secret: true } }));
    if (d) setShown({ title: "Novo segredo do webhook", label: "Segredo de assinatura", value: d.secret, note: "Troque no sistema que recebe os webhooks. O segredo antigo já não vale." });
  }

  if (role !== "owner") return null;
  if (!ov) return err ? <Alert>{err}</Alert> : null;
  const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  return (
    <section className="card space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">API e webhooks</h2>
          <p className="mt-1 max-w-2xl text-sm text-zinc-600">
            Para conectar o Domma a outros sistemas (ERP, BI, automações): a API lê pedidos, cardápio e clientes e muda o status dos pedidos; os webhooks avisam o seu sistema na hora que um pedido entra, muda de status ou é pago.
          </p>
        </div>
        <Link href="/desenvolvedores" target="_blank" className="btn-secondary text-sm">Documentação</Link>
      </div>

      <div>
        <div className="flex items-center justify-between gap-2">
          <h3 className="font-semibold">Chaves de API</h3>
          <button className="btn-secondary text-sm" onClick={() => setNewKey({ name: "", scopes: ["orders:read"], unit: "" })}>Nova chave</button>
        </div>
        <p className="mt-1 text-xs text-zinc-500">Base: <code>{API_BASE}</code> · A chave age em seu nome: as mesmas regras do painel valem para a API.</p>
        {ov.keys.length === 0 ? <p className="mt-2 text-sm text-zinc-500">Nenhuma chave ativa.</p> : (
          <ul className="mt-2 divide-y divide-zinc-100 rounded-xl border border-zinc-200">
            {ov.keys.map((k) => (
              <li key={k.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{k.name} <code className="ml-1 text-xs text-zinc-500">{k.prefix}…</code></p>
                  <p className="text-xs text-zinc-500">{k.scopes.map((s) => SCOPES.find(([v]) => v === s)?.[1] ?? s).join(" · ")} · {k.unit_name ?? "todas as lojas"}</p>
                  <p className="text-[11px] text-zinc-500">Último uso: {fmt(k.last_used_at)} · {k.calls_today} chamada(s) hoje</p>
                </div>
                <button className="btn-ghost px-2 py-1 text-xs text-red-700" disabled={busy}
                  onClick={() => { if (confirm(`Revogar a chave "${k.name}"? O sistema que usa para de funcionar na hora.`)) void call(() => sb.rpc("api_key_revoke", { p_key_id: k.id })); }}>Revogar</button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <div className="flex items-center justify-between gap-2">
          <h3 className="font-semibold">Webhooks</h3>
          <button className="btn-secondary text-sm" onClick={() => setNewHook({ url: "", events: ["order.created", "order.status_changed"], unit: "" })}>Novo webhook</button>
        </div>
        {ov.webhooks.length === 0 ? <p className="mt-2 text-sm text-zinc-500">Nenhum webhook cadastrado.</p> : (
          <ul className="mt-2 space-y-2">
            {ov.webhooks.map((h) => {
              const ds = ov.deliveries.filter((d) => d.endpoint_id === h.id).slice(0, 6);
              return (
                <li key={h.id} className="rounded-xl border border-zinc-200 p-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="break-all text-sm font-medium">{h.url}</p>
                      <p className="text-xs text-zinc-500">{h.events.map((e) => EVENTS.find(([v]) => v === e)?.[1] ?? e).join(" · ")} · {h.unit_name ?? "todas as lojas"}</p>
                      <p className="text-[11px] text-zinc-500">Última entrega: {fmt(h.last_success_at)}{h.failures ? ` · ${h.failures} falha(s) seguidas` : ""}</p>
                      {h.disabled_reason && <p className="text-xs text-red-700">{h.disabled_reason}</p>}
                      {!h.disabled_reason && h.last_error && h.failures > 0 && <p className="text-xs text-amber-800">Último erro: {h.last_error}</p>}
                    </div>
                    <div className="flex items-center gap-2">
                      <Toggle checked={h.active} label="Ligado" onChange={(v) => void call(() => sb.rpc("webhook_save", { p_tenant_id: tenantId, p_id: h.id, p: { active: v } }))} />
                      <button className="btn-ghost px-2 py-1 text-xs" disabled={busy || !h.active} onClick={() => void call(() => sb.rpc("webhook_test", { p_id: h.id }))}>Enviar teste</button>
                      <button className="btn-ghost px-2 py-1 text-xs" disabled={busy} onClick={() => void rotate(h)}>Novo segredo</button>
                      <button className="btn-ghost px-2 py-1 text-xs text-red-700" disabled={busy}
                        onClick={() => { if (confirm("Excluir este webhook?")) void call(() => sb.rpc("webhook_delete", { p_id: h.id })); }}>Excluir</button>
                    </div>
                  </div>
                  {ds.length > 0 && (
                    <ul className="mt-2 space-y-0.5 border-t border-zinc-100 pt-2 text-xs text-zinc-600">
                      {ds.map((d) => (
                        <li key={d.id} className="flex flex-wrap items-center gap-x-2">
                          <span className={d.status === "sent" ? "text-emerald-700" : d.status === "failed" ? "text-red-700" : "text-zinc-500"}>{D_STATUS[d.status] ?? d.status}</span>
                          <span>{d.event}{d.order_number ? ` #${d.order_number}` : ""}</span>
                          <span className="text-zinc-400">{fmt(d.created_at)}{d.response_code ? ` · HTTP ${d.response_code}` : ""}{d.attempts > 1 ? ` · ${d.attempts} tentativas` : ""}</span>
                          {d.status !== "sent" && d.error && <span className="text-zinc-500">· {d.error}</span>}
                          {d.status === "failed" && h.active && (
                            <button className="text-brand-700 underline" onClick={() => void call(() => sb.rpc("webhook_test", { p_id: h.id, p_redeliver: d.id }))}>reenviar</button>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <Alert>{err}</Alert>

      {newKey && (
        <Modal open onClose={() => setNewKey(null)} title="Nova chave de API">
          <div className="space-y-3">
            <Field label="Nome (para você reconhecer)"><input className="input" maxLength={60} value={newKey.name} placeholder="Ex.: ERP da matriz" onChange={(e) => setNewKey({ ...newKey, name: e.target.value })} /></Field>
            <div>
              <p className="label">Permissões</p>
              <div className="space-y-1.5">
                {SCOPES.map(([v, l]) => (
                  <label key={v} className="flex items-center gap-2 text-sm">
                    <input type="checkbox" className="h-4 w-4 accent-brand-600" checked={newKey.scopes.includes(v)} onChange={() => setNewKey({ ...newKey, scopes: toggle(newKey.scopes, v) })} />
                    {l} <code className="text-[11px] text-zinc-400">{v}</code>
                  </label>
                ))}
              </div>
              <p className="mt-1 text-xs text-zinc-500">Dê só o necessário. Ler clientes expõe telefone e e-mail.</p>
            </div>
            {ov.units.length > 1 && (
              <Field label="Lojas"><select className="input" value={newKey.unit} onChange={(e) => setNewKey({ ...newKey, unit: e.target.value })}>
                <option value="">Todas as lojas</option>{ov.units.map((u) => <option key={u.id} value={u.id}>Só {u.name}</option>)}</select></Field>
            )}
            <Alert>{err}</Alert>
            <div className="flex justify-end gap-2">
              <button className="btn-ghost" onClick={() => setNewKey(null)}>Cancelar</button>
              <button className="btn-primary" disabled={busy || newKey.name.trim().length < 2 || !newKey.scopes.length} onClick={() => void createKey()}>Criar chave</button>
            </div>
          </div>
        </Modal>
      )}
      {newHook && (
        <Modal open onClose={() => setNewHook(null)} title="Novo webhook">
          <div className="space-y-3">
            <Field label="Endereço que recebe (https)" hint="Precisa ser público: não aceitamos IP, localhost nem rede interna."><input className="input" value={newHook.url} placeholder="https://seu-sistema.com.br/webhooks/domma" onChange={(e) => setNewHook({ ...newHook, url: e.target.value })} /></Field>
            <div>
              <p className="label">Eventos</p>
              <div className="space-y-1.5">
                {EVENTS.map(([v, l]) => (
                  <label key={v} className="flex items-center gap-2 text-sm">
                    <input type="checkbox" className="h-4 w-4 accent-brand-600" checked={newHook.events.includes(v)} onChange={() => setNewHook({ ...newHook, events: toggle(newHook.events, v) })} />
                    {l} <code className="text-[11px] text-zinc-400">{v}</code>
                  </label>
                ))}
              </div>
            </div>
            {ov.units.length > 1 && (
              <Field label="Lojas"><select className="input" value={newHook.unit} onChange={(e) => setNewHook({ ...newHook, unit: e.target.value })}>
                <option value="">Todas as lojas</option>{ov.units.map((u) => <option key={u.id} value={u.id}>Só {u.name}</option>)}</select></Field>
            )}
            <Alert>{err}</Alert>
            <div className="flex justify-end gap-2">
              <button className="btn-ghost" onClick={() => setNewHook(null)}>Cancelar</button>
              <button className="btn-primary" disabled={busy || !newHook.url.startsWith("https://") || !newHook.events.length} onClick={() => void createHook()}>Criar webhook</button>
            </div>
          </div>
        </Modal>
      )}
      {shown && (
        <Modal open onClose={() => setShown(null)} title={shown.title}>
          <Secret label={shown.label} value={shown.value} note={shown.note} />
          <div className="mt-4 flex justify-end"><button className="btn-primary" onClick={() => setShown(null)}>Pronto, copiei</button></div>
        </Modal>
      )}
    </section>
  );
}
