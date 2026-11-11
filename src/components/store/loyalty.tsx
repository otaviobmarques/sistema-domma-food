"use client";
import { useEffect, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { brl } from "@/lib/format";
import { Modal } from "@/components/ui";

export type LoyaltyInfo = {
  cashback_enabled: boolean; cashback_pct_today?: number; cashback_expires_days?: number; cashback_max_use_pct?: number;
  points_enabled: boolean; points_per_real?: number; known_device?: boolean;
  cashback_cents?: number | null; points?: number | null;
  rewards?: { name: string; description: string | null; points_cost: number }[];
};
export type StoreReviews = {
  average: number | null; count: number;
  recent: { name: string; rating: number; comment: string | null; reply: string | null; created_at: string }[];
};

const deviceKey = (slug: string) => `df_device_${slug}`;
export function getDeviceToken(slug: string): string | null {
  try { return localStorage.getItem(deviceKey(slug)); } catch { return null; }
}
export function setDeviceToken(slug: string, token: string | null | undefined) {
  if (!token) return;
  try { localStorage.setItem(deviceKey(slug), token); } catch { /* ignora */ }
}
export function rememberedPhone(): string | null {
  try { return (JSON.parse(localStorage.getItem("df_customer") ?? "{}") ?? {}).phone ?? null; } catch { return null; }
}

export async function fetchLoyalty(slug: string, phone?: string | null): Promise<LoyaltyInfo | null> {
  const token = getDeviceToken(slug);
  const digits = (phone ?? "").replace(/\D/g, "");
  const { data, error } = await supabaseBrowser().rpc("loyalty_info", {
    p_slug: slug, p_phone: digits.length >= 10 ? digits : null, p_device_token: digits.length >= 10 ? token : null,
  });
  if (error || !data) return null;
  return data as LoyaltyInfo;
}

const pct = (n: number | undefined) => String(Number(n ?? 0)).replace(".", ",");
const fmtAvg = (n: number) => Number(n).toFixed(1).replace(".", ",");

export function Stars({ value, size = "h-4 w-4" }: { value: number; size?: string }) {
  return (
    <span className="inline-flex" role="img" aria-label={`${value} de 5 estrelas`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <svg key={n} viewBox="0 0 24 24" className={`${size} ${n <= Math.round(value) ? "text-amber-400" : "text-zinc-300"}`} fill="currentColor" aria-hidden="true">
          <path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9L12 3Z" />
        </svg>
      ))}
    </span>
  );
}

/** Seletor de nota acessível (grupo de rádio). */
export function StarInput({ value, onChange, disabled }: { value: number; onChange: (n: number) => void; disabled?: boolean }) {
  return (
    <div role="radiogroup" aria-label="Sua nota" className="flex justify-center gap-1">
      {[1, 2, 3, 4, 5].map((n) => (
        <button key={n} type="button" role="radio" aria-checked={value === n} aria-label={`${n} ${n === 1 ? "estrela" : "estrelas"}`}
          disabled={disabled} onClick={() => onChange(n)}
          className="rounded-full p-1.5 transition hover:scale-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-500 disabled:opacity-60">
          <svg viewBox="0 0 24 24" className={`h-9 w-9 ${n <= value ? "text-amber-400" : "text-zinc-300"}`} fill="currentColor" aria-hidden="true">
            <path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9L12 3Z" />
          </svg>
        </button>
      ))}
    </div>
  );
}

/** Dados de fidelidade e avaliações da loja (buscados no cliente; a página não espera por eles). */
export function useStoreExtras(slug: string) {
  const [loyalty, setLoyalty] = useState<LoyaltyInfo | null>(null);
  const [reviews, setReviews] = useState<StoreReviews | null>(null);
  useEffect(() => {
    let alive = true;
    fetchLoyalty(slug, rememberedPhone()).then((l) => { if (alive) setLoyalty(l); });
    supabaseBrowser().rpc("store_reviews", { p_slug: slug }).then(({ data }: { data: StoreReviews | null }) => { if (alive && data) setReviews(data); });
    return () => { alive = false; };
  }, [slug]);
  return { loyalty, reviews };
}

export function RatingChip({ reviews, storeName }: { reviews: StoreReviews | null; storeName: string }) {
  const [open, setOpen] = useState(false);
  if (!reviews || !reviews.count || reviews.average == null) return null;
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-3 py-1.5 font-semibold text-amber-900 ring-1 ring-amber-200 transition hover:bg-amber-100"
        aria-label={`Nota ${fmtAvg(reviews.average)} de 5, ${reviews.count} avaliações. Ver avaliações`}>
        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 text-amber-500" fill="currentColor" aria-hidden="true"><path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9L12 3Z" /></svg>
        {fmtAvg(reviews.average)} · {reviews.count} {reviews.count === 1 ? "avaliação" : "avaliações"}
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title={`Avaliações de ${storeName}`}>
        <div className="mb-4 flex items-center gap-3 rounded-2xl bg-amber-50 p-4">
          <span className="text-4xl font-black text-amber-900">{fmtAvg(reviews.average)}</span>
          <div><Stars value={reviews.average} size="h-5 w-5" /><p className="text-xs text-amber-900/80">{reviews.count} {reviews.count === 1 ? "avaliação" : "avaliações"} de pedidos reais</p></div>
        </div>
        {reviews.recent.length === 0 ? <p className="text-sm text-zinc-500">Ainda não há comentários.</p> : (
          <ul className="space-y-4">
            {reviews.recent.map((r, i) => (
              <li key={i} className="border-b border-zinc-100 pb-4 last:border-0">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-bold">{r.name}</span>
                  <span className="text-xs text-zinc-400">{new Date(r.created_at).toLocaleDateString("pt-BR")}</span>
                </div>
                <Stars value={r.rating} />
                {r.comment && <p className="mt-1 text-sm text-zinc-700">{r.comment}</p>}
                {r.reply && <p className="mt-2 rounded-xl bg-zinc-50 p-3 text-sm text-zinc-700"><b>Resposta da loja:</b> {r.reply}</p>}
              </li>
            ))}
          </ul>
        )}
      </Modal>
    </>
  );
}

export function LoyaltyBanner({ loyalty, color }: { loyalty: LoyaltyInfo | null; color: string }) {
  const [showRewards, setShowRewards] = useState(false);
  if (!loyalty || (!loyalty.cashback_enabled && !loyalty.points_enabled)) return null;
  const balance = loyalty.known_device ? loyalty.cashback_cents ?? 0 : 0;
  const points = loyalty.known_device ? loyalty.points ?? 0 : null;
  const rewards = loyalty.rewards ?? [];
  return (
    <div className="mt-4 rounded-2xl p-3.5 text-sm ring-1" style={{ background: `${color}0d`, ["--tw-ring-color" as string]: `${color}33` }}>
      <div className="flex items-start gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-white" style={{ background: color }} aria-hidden="true">
          <svg viewBox="0 0 24 24" className="h-4 w-4" fill="currentColor"><path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10Z" /></svg>
        </span>
        <div className="min-w-0 flex-1">
          {loyalty.cashback_enabled && (
            balance > 0
              ? <p className="font-bold text-zinc-900">Você tem {brl(balance)} de cashback <span className="font-medium text-zinc-600">· use no checkout</span></p>
              : <p className="font-bold text-zinc-900">Ganhe {pct(loyalty.cashback_pct_today)}% de cashback em cada pedido</p>
          )}
          {loyalty.cashback_enabled && balance > 0 && <p className="text-xs text-zinc-600">E ganhe mais {pct(loyalty.cashback_pct_today)}% neste pedido.</p>}
          {loyalty.points_enabled && (
            <p className={loyalty.cashback_enabled ? "mt-0.5 text-xs text-zinc-700" : "font-bold text-zinc-900"}>
              {points != null && points > 0 ? <><b>{points} pontos</b> acumulados</> : <>Junte pontos: {pct(loyalty.points_per_real)} por real</>}
              {rewards.length > 0 && (
                <> · <button type="button" className="font-semibold underline underline-offset-2" style={{ color }} aria-expanded={showRewards} onClick={() => setShowRewards(!showRewards)}>
                  {showRewards ? "ocultar recompensas" : "ver recompensas"}</button></>
              )}
            </p>
          )}
          {showRewards && rewards.length > 0 && (
            <ul className="mt-2 space-y-1.5">
              {rewards.map((r, i) => (
                <li key={i} className="flex items-center justify-between gap-3 rounded-xl bg-white px-3 py-2 text-xs ring-1 ring-zinc-200/70">
                  <span><b>{r.name}</b>{r.description ? <span className="text-zinc-500"> · {r.description}</span> : null}</span>
                  <span className="shrink-0 font-bold" style={{ color }}>{r.points_cost} pts</span>
                </li>
              ))}
              <li className="text-[11px] text-zinc-500">Para resgatar, fale com a loja informando seu WhatsApp.</li>
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
