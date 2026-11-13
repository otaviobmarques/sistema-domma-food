"use client";
import { useCallback, useEffect, useState } from "react";
import QRCode from "qrcode";
import { supabaseBrowser } from "@/lib/supabase/client";
import { canManage, usePanel } from "@/lib/panel/context";
import { Alert, Empty, Modal, Toggle } from "@/components/ui";
import { errorMessage } from "@/lib/format";
import { PointSetup } from "./point";

type Totem = { id: string; name: string; active: boolean; allow_dine_in: boolean; allow_takeout: boolean; allow_pix: boolean;
  allow_counter: boolean; auto_accept: boolean; last_seen_at: string | null; created_at: string;
  allow_card: boolean; point_terminal_id: string | null };
const BASE = "https://domma-food.vercel.app/totem/";
const online = (t: Totem) => !!t.last_seen_at && Date.now() - new Date(t.last_seen_at).getTime() < 3 * 60_000;

export default function Totens() {
  const { unit, role } = usePanel();
  const sb = supabaseBrowser();
  const [list, setList] = useState<Totem[]>([]);
  const [name, setName] = useState("");
  const [link, setLink] = useState<{ name: string; url: string; qr: string } | null>(null);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    const { data, error } = await sb.from("totems").select("*").eq("unit_id", unit.id).order("created_at");
    if (error) setErr(errorMessage(error)); else setList((data ?? []) as Totem[]);
  }, [sb, unit.id]);
  useEffect(() => { void load(); const t = setInterval(load, 60_000); return () => clearInterval(t); }, [load]);

  async function showLink(n: string, token: string) {
    const url = BASE + token;
    setLink({ name: n, url, qr: await QRCode.toDataURL(url, { margin: 1, width: 320, errorCorrectionLevel: "M" }) });
  }
  async function create(e: React.FormEvent) {
    e.preventDefault(); setErr(""); setMsg("");
    const { data, error } = await sb.rpc("totem_create", { p_unit_id: unit.id, p_name: name || "Totem" });
    if (error) { setErr(errorMessage(error)); return; }
    await showLink(name || "Totem", (data as { token: string }).token); setName(""); await load();
  }
  async function update(t: Totem, p: Partial<Totem>, ok?: string) {
    setErr(""); setMsg("");
    const { error } = await sb.rpc("totem_update", { p_totem_id: t.id, p });
    if (error) setErr(errorMessage(error)); else { if (ok) setMsg(ok); await load(); }
  }
  async function rotate(t: Totem) {
    if (!confirm(`Gerar um novo link para "${t.name}"? O link atual para de funcionar na hora.`)) return;
    const { data, error } = await sb.rpc("totem_rotate", { p_totem_id: t.id });
    if (error) setErr(errorMessage(error)); else { await showLink(t.name, data as string); await load(); }
  }

  if (!canManage(role)) return <Empty>Os totens são configurados pelo dono e pela gerência.</Empty>;
  return (
    <div className="space-y-5">
      <div>
        <h1 className="h1">Totens de autoatendimento</h1>
        <p className="mt-1 max-w-3xl text-sm text-zinc-600">
          Transforme um tablet ou uma tela touch em totem: o cliente monta o pedido, escolhe comer aqui ou levar e paga por Pix na tela
          no caixa ou com cartão na maquininha Mercado Pago Point ao lado. Os pedidos entram em Pedidos e no KDS como qualquer outro, com o selo do totem.
        </p>
      </div>
      <Alert>{err}</Alert>
      <Alert kind="success">{msg}</Alert>

      <form onSubmit={create} className="card flex flex-wrap items-end gap-3">
        <label className="block min-w-[14rem] flex-1"><span className="label">Novo totem</span>
          <input className="input" maxLength={60} placeholder="Ex.: Totem da entrada" value={name} onChange={(e) => setName(e.target.value)} /></label>
        <button className="btn-primary">Criar totem</button>
      </form>

      {list.length === 0 ? <Empty>Nenhum totem ainda.</Empty> : (
        <div className="grid gap-4 lg:grid-cols-2">
          {list.map((t) => (
            <section key={t.id} className={`card space-y-3 ${t.active ? "" : "opacity-60"}`}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h2 className="font-semibold">{t.name}</h2>
                  <p className="text-xs text-zinc-500">
                    {!t.active ? "Desativado" : online(t) ? "Ligado agora" : t.last_seen_at ? `Visto em ${new Date(t.last_seen_at).toLocaleString("pt-BR")}` : "Ainda não foi aberto"}
                  </p>
                </div>
                <span className={`badge ${t.active && online(t) ? "bg-green-100 text-green-800" : "bg-zinc-100 text-zinc-600"}`}>{t.active ? (online(t) ? "Online" : "Offline") : "Desativado"}</span>
              </div>
              <div className="grid gap-2 text-sm sm:grid-cols-2">
                {([["allow_dine_in", "Comer aqui"], ["allow_takeout", "Para levar"], ["allow_pix", "Pix na tela"], ["allow_counter", "Pagar no caixa"],
                  ["auto_accept", "Aceitar pedidos pagos no caixa automaticamente"]] as const).map(([k, l]) => (
                  <label key={k} className="flex items-center justify-between gap-2 rounded-lg bg-zinc-50 px-3 py-2">{l}
                    <Toggle checked={t[k]} label={l} onChange={(v) => void update(t, { [k]: v } as Partial<Totem>)} />
                  </label>
                ))}
              </div>
              {role === "owner" || t.allow_card || t.point_terminal_id ? (
                <PointSetup unitId={unit.id} totemName={t.name} terminalId={t.point_terminal_id} allowCard={t.allow_card}
                  onSave={(p, ok) => update(t, p as Partial<Totem>, ok)} />
              ) : null}
              <div className="flex flex-wrap gap-2">
                <button className="btn-secondary" onClick={() => void rotate(t)}>{t.active ? "Gerar novo link" : "Reativar com novo link"}</button>
                {t.active && <button className="text-sm text-red-700 hover:underline" onClick={() => { if (confirm(`Desativar "${t.name}"? Ele para de aceitar pedidos.`)) void update(t, { active: false }, "Totem desativado."); }}>Desativar</button>}
              </div>
            </section>
          ))}
        </div>
      )}

      <section className="card space-y-2 text-sm text-zinc-600">
        <h2 className="font-semibold text-zinc-900">Como montar o totem</h2>
        <ol className="list-decimal space-y-1 pl-5">
          <li>Abra o link do totem no navegador do aparelho (Chrome) e toque em “Toque para começar”: a tela entra em modo tela cheia.</li>
          <li>Android: use “Fixar app” (Configurações › Segurança) para o cliente não sair do cardápio. iPad: Acesso Guiado (Acessibilidade).</li>
          <li>Computador com tela touch: abra o Chrome com <code className="rounded bg-zinc-100 px-1">--kiosk</code> e o link do totem.</li>
          <li>Pix na tela usa o Mercado Pago configurado em Pagamento online. Pedidos “pagar no caixa” aparecem em Pedidos com o botão Receber.</li>
          <li>Cartão: vincule a maquininha Point à mesma conta Mercado Pago (app do Mercado Pago), busque-a aqui, ative o modo integrado e use no totem.
            No Mercado Pago, em Suas integrações › Webhooks, marque também o evento “Order” no mesmo endereço do Pagamento online.
            Se o cliente desistir ou o cartão for recusado, ele tenta de novo ou passa a pagar no caixa.</li>
          <li>Sem toque por 75 segundos, o totem pergunta se o cliente ainda está ali e recomeça sozinho.</li>
        </ol>
      </section>

      <Modal open={!!link} onClose={() => setLink(null)} title={`Link do ${link?.name ?? "totem"}`}>
        {link && (
          <div className="space-y-3 text-center">
            <p className="text-sm text-amber-800">Guarde este link agora: por segurança ele não é mostrado de novo (dá para gerar outro a qualquer momento).</p>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={link.qr} alt="QR Code do link do totem" className="mx-auto h-56 w-56" />
            <code className="block break-all rounded-lg bg-zinc-100 p-2 text-xs">{link.url}</code>
            <div className="flex justify-center gap-2">
              <button className="btn-primary" onClick={() => { void navigator.clipboard.writeText(link.url); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>{copied ? "Copiado!" : "Copiar link"}</button>
              <a className="btn-secondary" href={link.url} target="_blank" rel="noopener noreferrer">Abrir</a>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
