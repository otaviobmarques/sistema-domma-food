"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { errorMessage } from "@/lib/format";

/* Modo offline do caixa
   - Venda feita sem internet fica guardada neste aparelho (localStorage, por loja) com um identificador próprio.
   - Quando a conexão volta, as vendas são enviadas em ordem para pos_sale, que não duplica um envio repetido.
   - Cardápio e situação do caixa ficam em cache para o PDV abrir e vender sem internet. */

export type OfflineSale = {
  ref: string;              // identificador da venda (client_ref no banco)
  code: string;             // código provisório mostrado no cupom
  sold_at: string;
  total_cents: number;
  customer?: string;
  payload: Record<string, unknown>;
  receipt: unknown;         // cupom para reimprimir
  attempts: number;
  error?: string;
};
export type SyncedSale = { ref: string; code: string; number: number; at: string };

const qKey = (unit: string) => `df_pos_queue:${unit}`;
const sKey = (unit: string) => `df_pos_synced:${unit}`;
const SYNC_TIMEOUT_MS = 20_000;

export const saleCode = (ref: string) => ref.replace(/-/g, "").slice(0, 6).toUpperCase();

function read<T>(key: string, fallback: T): T {
  try { const v = localStorage.getItem(key); return v ? (JSON.parse(v) as T) : fallback; } catch { return fallback; }
}
function write(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}

/** Cache simples (cardápio, situação do caixa) para abrir o PDV sem internet. */
export function cacheSet(key: string, data: unknown) { write(`df_cache:${key}`, { at: new Date().toISOString(), data }); }
export function cacheGet<T>(key: string): { at: string; data: T } | null { return read<{ at: string; data: T } | null>(`df_cache:${key}`, null); }

/** Erro de conexão (sem internet, servidor fora do ar ou tempo esgotado), e não erro de regra do sistema. */
export function isNetworkError(e: unknown): boolean {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return true;
  if (!e) return false;
  const m = typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : String(e);
  const code = typeof e === "object" && "code" in e ? String((e as { code: unknown }).code ?? "") : "";
  return /failed to fetch|networkerror|network request failed|load failed|fetch failed|timed? ?out|aborted|abort/i.test(m) || (code === "" && /typeerror/i.test(m));
}

let syncing = false; // uma sincronização por aba

export type PosQueue = ReturnType<typeof usePosQueue>;

export function usePosQueue(unitId: string, onSynced?: () => void) {
  const [pending, setPending] = useState<OfflineSale[]>([]);
  const [synced, setSynced] = useState<SyncedSale[]>([]);
  const [online, setOnline] = useState(true);
  const [busy, setBusy] = useState(false);
  const onSyncedRef = useRef(onSynced);
  onSyncedRef.current = onSynced;

  const refresh = useCallback(() => {
    setPending(read<OfflineSale[]>(qKey(unitId), []));
    setSynced(read<SyncedSale[]>(sKey(unitId), []));
  }, [unitId]);

  /** Marca a conexão como caída ou de volta (além do aviso do navegador, que nem sempre percebe). */
  const setNet = useCallback((up: boolean) => setOnline(up && (typeof navigator === "undefined" || navigator.onLine !== false)), []);

  const add = useCallback((sale: Omit<OfflineSale, "attempts">) => {
    const list = read<OfflineSale[]>(qKey(unitId), []);
    if (!list.some((s) => s.ref === sale.ref)) list.push({ ...sale, attempts: 0 });
    const ok = write(qKey(unitId), list);
    refresh();
    return ok;
  }, [unitId, refresh]);

  const discard = useCallback((ref: string) => {
    write(qKey(unitId), read<OfflineSale[]>(qKey(unitId), []).filter((s) => s.ref !== ref));
    refresh();
  }, [unitId, refresh]);

  const sync = useCallback(async () => {
    if (syncing) return;
    const list = read<OfflineSale[]>(qKey(unitId), []);
    if (!list.length) return;
    syncing = true; setBusy(true);
    let sent = 0;
    try {
      for (const sale of list) {
        const { data, error } = await supabaseBrowser().rpc("pos_sale", { p: sale.payload }).abortSignal(AbortSignal.timeout(SYNC_TIMEOUT_MS));
        const cur = read<OfflineSale[]>(qKey(unitId), []);
        if (error) {
          if (isNetworkError(error)) { setNet(false); break; }
          write(qKey(unitId), cur.map((s) => (s.ref === sale.ref ? { ...s, attempts: s.attempts + 1, error: errorMessage(error) } : s)));
          continue;
        }
        setNet(true);
        sent++;
        write(qKey(unitId), cur.filter((s) => s.ref !== sale.ref));
        const done = read<SyncedSale[]>(sKey(unitId), []);
        done.unshift({ ref: sale.ref, code: sale.code, number: (data as { number: number }).number, at: new Date().toISOString() });
        write(sKey(unitId), done.slice(0, 30));
      }
    } finally {
      syncing = false; setBusy(false); refresh();
      if (sent) onSyncedRef.current?.();
    }
  }, [unitId, refresh, setNet]);

  useEffect(() => {
    refresh();
    setNet(true);
    const up = () => { setNet(true); void sync(); };
    const down = () => setNet(false);
    const other = (e: StorageEvent) => { if (e.key === qKey(unitId) || e.key === sKey(unitId)) refresh(); };
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    window.addEventListener("storage", other);
    void sync();
    // pede ao navegador para não apagar os dados deste site quando faltar espaço
    void navigator.storage?.persist?.().catch(() => undefined);
    const t = setInterval(() => { if (read<OfflineSale[]>(qKey(unitId), []).length) void sync(); }, 30_000);
    return () => {
      window.removeEventListener("online", up); window.removeEventListener("offline", down);
      window.removeEventListener("storage", other); clearInterval(t);
    };
  }, [unitId, refresh, sync, setNet]);

  return { pending, synced, online, busy, add, discard, sync, setNet };
}
