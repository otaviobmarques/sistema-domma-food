"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabase/client";
import { usePanel } from "@/lib/panel/context";
import { Alert, Field, Toggle } from "@/components/ui";
import { centsToInput, errorMessage, PAYMENT_LABEL, parseBRL } from "@/lib/format";

type Hours = Record<string, [string, string][]>;
type Unit = {
  id: string; name: string; description: string | null; phone: string | null; whatsapp: string | null;
  street: string | null; number: string | null; complement: string | null; neighborhood: string | null;
  city: string | null; state: string | null; zip: string | null; lat: number | null; lng: number | null;
  opening_hours: Hours; is_open_override: boolean | null; accepts_delivery: boolean; accepts_pickup: boolean;
  accepts_scheduling: boolean; auto_accept: boolean; min_order_cents: number; prep_time_min: number; pickup_time_min: number;
  accepted_payments: string[]; pix_key: string | null; pix_merchant_name: string | null; pix_merchant_city: string | null;
  pix_expires_min: number; service_fee_pct: number; kds_stations: string[]; logo_url: string | null; cover_url: string | null; primary_color: string;
};

const DAYS: [string, string][] = [["mon", "Segunda"], ["tue", "Terça"], ["wed", "Quarta"], ["thu", "Quinta"], ["fri", "Sexta"], ["sat", "Sábado"], ["sun", "Domingo"]];
const PAYMENTS = ["pix", "cash", "card_on_delivery", "voucher"];

export default function Configuracoes() {
  const { unit: current, tenantId, role, tenantName } = usePanel();
  const router = useRouter();
  const sb = supabaseBrowser();
  const [u, setU] = useState<Unit | null>(null);
  const [minOrder, setMinOrder] = useState("");
  const [company, setCompany] = useState({ name: tenantName, cnpj: "" });
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    sb.from("units").select("*").eq("id", current.id).single().then(({ data, error }: { data: unknown; error: { message: string } | null }) => {
      if (error) setErr(error.message);
      else { setU(data as Unit); setMinOrder(centsToInput((data as Unit).min_order_cents)); }
    });
    sb.from("tenants").select("name, cnpj").eq("id", tenantId).single().then(({ data }: { data: { name: string; cnpj: string | null } | null }) => data && setCompany({ name: data.name, cnpj: data.cnpj ?? "" }));
  }, [sb, current.id, tenantId]);

  if (!u) return <p className="text-sm text-zinc-500">{err || "Carregando..."}</p>;
  const set = <K extends keyof Unit>(k: K, v: Unit[K]) => setU({ ...u, [k]: v });

  function setDay(day: string, i: number, pos: 0 | 1, v: string) {
    const h = structuredClone(u!.opening_hours);
    h[day] = h[day] ?? [];
    h[day][i][pos] = v;
    set("opening_hours", h);
  }
  function addInterval(day: string) {
    const h = structuredClone(u!.opening_hours);
    h[day] = [...(h[day] ?? []), ["18:00", "23:00"]];
    set("opening_hours", h);
  }
  function removeInterval(day: string, i: number) {
    const h = structuredClone(u!.opening_hours);
    h[day] = (h[day] ?? []).filter((_, j) => j !== i);
    set("opening_hours", h);
  }

  async function upload(kind: "logo" | "cover", file: File) {
    if (file.size > 5 * 1024 * 1024) { setErr("Imagem acima de 5 MB."); return; }
    const ext = file.type.split("/")[1]?.replace("jpeg", "jpg") ?? "jpg";
    const path = `${tenantId}/store/${kind}-${crypto.randomUUID()}.${ext}`;
    const { error } = await sb.storage.from("media").upload(path, file, { contentType: file.type, upsert: false });
    if (error) { setErr(error.message); return; }
    set(kind === "logo" ? "logo_url" : "cover_url", sb.storage.from("media").getPublicUrl(path).data.publicUrl);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(""); setMsg("");
    const { id: _id, ...rest } = u!;
    const payload = {
      ...rest,
      min_order_cents: parseBRL(minOrder),
      state: rest.state ? rest.state.toUpperCase().slice(0, 2) : null,
      lat: rest.lat === null || (rest.lat as unknown) === "" ? null : Number(rest.lat),
      lng: rest.lng === null || (rest.lng as unknown) === "" ? null : Number(rest.lng),
    };
    const { error } = await sb.from("units").update(payload).eq("id", u!.id);
    let error2 = null;
    if (!error && role === "owner") {
      ({ error: error2 } = await sb.from("tenants").update({ name: company.name, cnpj: company.cnpj.replace(/\D/g, "") || null }).eq("id", tenantId));
    }
    setBusy(false);
    if (error || error2) { setErr(errorMessage(error ?? error2)); return; }
    setMsg("Configurações salvas.");
    router.refresh();
  }

  const openMode = u.is_open_override === null ? "auto" : u.is_open_override ? "open" : "closed";

  return (
    <form onSubmit={save} className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="h1">Configurações</h1>
        <button className="btn-primary" disabled={busy}>{busy ? "Salvando..." : "Salvar alterações"}</button>
      </div>
      <Alert>{err}</Alert>
      <Alert kind="success">{msg}</Alert>

      <section className="card space-y-4">
        <h2 className="font-semibold">Funcionamento agora</h2>
        <div className="flex flex-wrap gap-2" role="radiogroup">
          {([["auto", "Seguir horário"], ["open", "Forçar aberta"], ["closed", "Forçar fechada"]] as const).map(([k, l]) => (
            <button type="button" key={k} role="radio" aria-checked={openMode === k}
              className={openMode === k ? "btn-primary" : "btn-secondary"}
              onClick={() => set("is_open_override", k === "auto" ? null : k === "open")}>{l}</button>
          ))}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {([["accepts_delivery", "Aceita entrega"], ["accepts_pickup", "Aceita retirada"], ["accepts_scheduling", "Aceita agendamento"],
            ["auto_accept", "Aceitar pedidos automaticamente"]] as const).map(([k, l]) => (
            <label key={k} className="flex items-center justify-between gap-3 rounded-lg border border-zinc-200 p-3 text-sm">
              {l}<Toggle checked={u[k]} onChange={(v) => set(k, v)} label={l} />
            </label>
          ))}
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Pedido mínimo (R$)"><input className="input" inputMode="decimal" value={minOrder} onChange={(e) => setMinOrder(e.target.value)} /></Field>
          <Field label="Tempo de preparo (min)"><input className="input" type="number" min={0} max={600} value={u.prep_time_min} onChange={(e) => set("prep_time_min", Number(e.target.value))} /></Field>
          <Field label="Tempo para retirada (min)"><input className="input" type="number" min={0} max={600} value={u.pickup_time_min} onChange={(e) => set("pickup_time_min", Number(e.target.value))} /></Field>
        </div>
      </section>

      <section className="card space-y-3">
        <h2 className="font-semibold">Salão e cozinha</h2>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Taxa de serviço (%)" hint="Sugerida no fechamento da mesa. O cliente pode recusar.">
            <input className="input" type="number" min={0} max={30} step={0.5} value={u.service_fee_pct ?? 10}
              onChange={(e) => set("service_fee_pct", Math.min(30, Math.max(0, Number(e.target.value))))} />
          </Field>
          <div className="sm:col-span-2">
            <span className="label">Setores de preparo (KDS)</span>
            <div className="flex flex-wrap items-center gap-2">
              {(u.kds_stations ?? []).map((st) => (
                <span key={st} className="badge bg-zinc-100 px-2.5 py-1 text-sm capitalize text-zinc-800">
                  {st}
                  {(u.kds_stations ?? []).length > 1 && (
                    <button type="button" className="ml-1.5 text-zinc-500 hover:text-red-600" aria-label={`Remover setor ${st}`}
                      onClick={() => set("kds_stations", u.kds_stations.filter((x) => x !== st))}>✕</button>
                  )}
                </span>
              ))}
              <input className="input w-40" placeholder="Novo setor + Enter" maxLength={30} aria-label="Novo setor"
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return;
                  e.preventDefault();
                  const v = e.currentTarget.value.trim().toLowerCase();
                  if (v && !(u.kds_stations ?? []).includes(v)) set("kds_stations", [...(u.kds_stations ?? []), v]);
                  e.currentTarget.value = "";
                }} />
            </div>
            <span className="mt-1 block text-xs text-zinc-500">Ex.: cozinha, bar, pizzas, chapa. Cada produto é enviado ao seu setor.</span>
          </div>
        </div>
      </section>

      <section className="card space-y-3">
        <h2 className="font-semibold">Horário de funcionamento</h2>
        <p className="text-xs text-zinc-500">Horário de Brasília. Para passar da meia-noite, use por exemplo 18:00 até 02:00.</p>
        {DAYS.map(([k, l]) => (
          <div key={k} className="flex flex-wrap items-center gap-2 border-b border-zinc-100 pb-2">
            <span className="w-20 text-sm font-medium">{l}</span>
            {(u.opening_hours[k] ?? []).length === 0 && <span className="text-sm text-zinc-500">Fechado</span>}
            {(u.opening_hours[k] ?? []).map((iv, i) => (
              <span key={i} className="flex items-center gap-1">
                <input type="time" className="input w-28" value={iv[0]} onChange={(e) => setDay(k, i, 0, e.target.value)} aria-label={`${l} abre`} />
                <span className="text-zinc-400">–</span>
                <input type="time" className="input w-28" value={iv[1]} onChange={(e) => setDay(k, i, 1, e.target.value)} aria-label={`${l} fecha`} />
                <button type="button" className="btn-ghost px-2 text-red-600" onClick={() => removeInterval(k, i)} aria-label="Remover intervalo">✕</button>
              </span>
            ))}
            <button type="button" className="btn-ghost text-xs" onClick={() => addInterval(k)}>+ intervalo</button>
          </div>
        ))}
      </section>

      <section className="card space-y-3">
        <h2 className="font-semibold">Pagamentos</h2>
        <div className="flex flex-wrap gap-2">
          {PAYMENTS.map((p) => {
            const on = u.accepted_payments.includes(p);
            return (
              <button type="button" key={p} aria-pressed={on} className={on ? "btn-primary" : "btn-secondary"}
                onClick={() => set("accepted_payments", on ? u.accepted_payments.filter((x) => x !== p) : [...u.accepted_payments, p])}>
                {PAYMENT_LABEL[p]}
              </button>
            );
          })}
        </div>
        {u.accepted_payments.includes("pix") && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Chave Pix" hint="CPF/CNPJ (só números), e-mail, celular (+55...) ou chave aleatória.">
              <input className="input" required value={u.pix_key ?? ""} onChange={(e) => set("pix_key", e.target.value.trim())} />
            </Field>
            <Field label="Nome do recebedor"><input className="input" required maxLength={25} value={u.pix_merchant_name ?? ""} onChange={(e) => set("pix_merchant_name", e.target.value)} /></Field>
            <Field label="Cidade do recebedor"><input className="input" required maxLength={15} value={u.pix_merchant_city ?? ""} onChange={(e) => set("pix_merchant_city", e.target.value)} /></Field>
            <Field label="Prazo para pagar (min)" hint="Depois disso o pedido é cancelado automaticamente.">
              <input className="input" type="number" min={5} max={1440} value={u.pix_expires_min} onChange={(e) => set("pix_expires_min", Number(e.target.value))} />
            </Field>
          </div>
        )}
        <p className="text-xs text-zinc-500">Pix com QR Code gerado por pedido. A confirmação é feita no gestor de pedidos (botão “Confirmar Pix”). A integração com gateway para confirmação automática e cartão online é a próxima etapa.</p>
      </section>

      <section className="card space-y-3">
        <h2 className="font-semibold">Loja e endereço</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Nome da loja"><input className="input" required value={u.name} onChange={(e) => set("name", e.target.value)} /></Field>
          <Field label="Cor principal"><input className="input h-10 p-1" type="color" value={u.primary_color} onChange={(e) => set("primary_color", e.target.value)} /></Field>
          <Field label="Telefone"><input className="input" value={u.phone ?? ""} onChange={(e) => set("phone", e.target.value)} /></Field>
          <Field label="WhatsApp (com DDD)"><input className="input" value={u.whatsapp ?? ""} onChange={(e) => set("whatsapp", e.target.value.replace(/\D/g, ""))} /></Field>
        </div>
        <Field label="Descrição"><textarea className="input" maxLength={300} value={u.description ?? ""} onChange={(e) => set("description", e.target.value)} /></Field>
        <div className="grid gap-3 sm:grid-cols-4">
          <div className="sm:col-span-2"><Field label="Rua"><input className="input" value={u.street ?? ""} onChange={(e) => set("street", e.target.value)} /></Field></div>
          <Field label="Número"><input className="input" value={u.number ?? ""} onChange={(e) => set("number", e.target.value)} /></Field>
          <Field label="Complemento"><input className="input" value={u.complement ?? ""} onChange={(e) => set("complement", e.target.value)} /></Field>
          <Field label="Bairro"><input className="input" value={u.neighborhood ?? ""} onChange={(e) => set("neighborhood", e.target.value)} /></Field>
          <Field label="Cidade"><input className="input" value={u.city ?? ""} onChange={(e) => set("city", e.target.value)} /></Field>
          <Field label="UF"><input className="input uppercase" maxLength={2} value={u.state ?? ""} onChange={(e) => set("state", e.target.value)} /></Field>
          <Field label="CEP"><input className="input" value={u.zip ?? ""} onChange={(e) => set("zip", e.target.value)} /></Field>
          <Field label="Latitude"><input className="input" inputMode="decimal" value={u.lat ?? ""} onChange={(e) => set("lat", e.target.value as unknown as number)} /></Field>
          <Field label="Longitude"><input className="input" inputMode="decimal" value={u.lng ?? ""} onChange={(e) => set("lng", e.target.value as unknown as number)} /></Field>
          <div className="flex items-end sm:col-span-2">
            <button type="button" className="btn-secondary" onClick={() => navigator.geolocation?.getCurrentPosition(
              (p) => setU({ ...u, lat: Number(p.coords.latitude.toFixed(6)), lng: Number(p.coords.longitude.toFixed(6)) }),
              () => setErr("Não foi possível obter a localização. Copie do Google Maps (clique com o botão direito no mapa)."))}>
              Usar minha localização atual
            </button>
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Logo">
            <div className="flex items-center gap-3">
              {u.logo_url && <img src={u.logo_url} alt="" className="h-14 w-14 rounded-lg object-cover" />}
              <input type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => e.target.files?.[0] && upload("logo", e.target.files[0])} />
            </div>
          </Field>
          <Field label="Capa">
            <div className="flex items-center gap-3">
              {u.cover_url && <img src={u.cover_url} alt="" className="h-14 w-24 rounded-lg object-cover" />}
              <input type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => e.target.files?.[0] && upload("cover", e.target.files[0])} />
            </div>
          </Field>
        </div>
      </section>

      {role === "owner" && (
        <section className="card space-y-3">
          <h2 className="font-semibold">Empresa</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Razão social"><input className="input" required value={company.name} onChange={(e) => setCompany({ ...company, name: e.target.value })} /></Field>
            <Field label="CNPJ"><input className="input" inputMode="numeric" value={company.cnpj} onChange={(e) => setCompany({ ...company, cnpj: e.target.value })} /></Field>
          </div>
        </section>
      )}
    </form>
  );
}
