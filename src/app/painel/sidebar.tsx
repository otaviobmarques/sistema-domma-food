"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { canManage, usePanel } from "@/lib/panel/context";
import { Logo } from "@/components/ui";

const ICONS: Record<string, React.ReactNode> = {
  dashboard: <><rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" /></>,
  orders: <><path d="M6 3h12l1 4H5l1-4Z" /><path d="M5 7h14v12a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7Z" /><path d="M9 11h6M9 15h4" /></>,
  menu: <><path d="M4 19V5a2 2 0 0 1 2-2h12v18H6a2 2 0 0 1-2-2Z" /><path d="M8 7h6M8 11h6" /></>,
  delivery: <><circle cx="6" cy="17" r="3" /><circle cx="18" cy="17" r="3" /><path d="M9 17h6l-3-8H8M15 9h3l3 5" /></>,
  megaphone: <><path d="M3 11v2a1 1 0 0 0 1 1h2l5 4V6L6 10H4a1 1 0 0 0-1 1Z" /><path d="M15 9a3 3 0 0 1 0 6M18 6a7 7 0 0 1 0 12" /></>,
  coupons: <><path d="M3 9a2 2 0 0 0 0 6v3a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-3a2 2 0 0 1 0-6V6a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v3Z" /><path d="m9 15 6-6M9.5 9.5h.01M14.5 14.5h.01" /></>,
  plug: <><path d="M9 2v6m6-6v6M6 8h12v3a6 6 0 0 1-12 0V8Zm6 9v5" /></>,
  customers: <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6 6 0 0 1 3.5 6" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" /></>,
  shield: <><path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6l-8-3Z" /><path d="m9 12 2 2 4-4" /></>,
  cash: <><rect x="3" y="6" width="18" height="12" rx="2" /><circle cx="12" cy="12" r="2.5" /><path d="M6.5 9.5v.01M17.5 14.5v.01" /></>,
  tables: <><path d="M4 9h16M6 9v10M18 9v10M9 9V5h6v4" /></>,
  kds: <><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4M7 8h4M7 11h7" /></>,
  history: <><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 4v4h4M12 7v5l3 2" /></>,
  team: <><circle cx="8" cy="9" r="3" /><circle cx="17" cy="10" r="2.5" /><path d="M2.5 19a5.5 5.5 0 0 1 11 0M14.5 19a4.5 4.5 0 0 1 7 0" /></>,
  heart: <path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10Z" />,
  star: <path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9L12 3Z" />,
  external: <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />,
  box: <><path d="m21 8-9-5-9 5v8l9 5 9-5V8Z" /><path d="m3 8 9 5 9-5M12 13v8" /></>,
  wallet: <><path d="M4 7a2 2 0 0 1 2-2h12v4" /><path d="M4 7v11a2 2 0 0 0 2 2h14V9H6a2 2 0 0 1-2-2Z" /><path d="M16 14.5h.01" /></>,
  ledger: <><path d="M6 3h11a2 2 0 0 1 2 2v16l-3-2-3 2-3-2-3 2V4a1 1 0 0 1 1-1Z" /><path d="M9 8h6M9 12h6M9 16h3" /></>,
  printer: <><path d="M7 8V3h10v5" /><rect x="3" y="8" width="18" height="9" rx="2" /><path d="M7 14h10v7H7z" /><path d="M17 11.5h.01" /></>,
  card: <><rect x="2.5" y="5" width="19" height="14" rx="2" /><path d="M2.5 10h19M6 15h4" /></>,
  receipt: <><path d="M6 3h12v18l-2.5-1.5L13 21l-2.5-1.5L8 21l-2-1.5V3Z" /><path d="M9 8h6M9 12h6M9 16h4" /></>,
  rider: <><circle cx="5.5" cy="17.5" r="2.5" /><circle cx="18.5" cy="17.5" r="2.5" /><path d="M8 17.5h7l2-6h-4l-2 3H7M13 5h3l2.5 6.5M9 8h4" /></>,
  badge: <><path d="M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5l-8-3Z" /><path d="M9 11.5h6M12 8.5v6" /></>,
  chat: <><path d="M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9l-5 4v-4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z" /><path d="M8 10h8M8 13h5" /></>,
  totem: <><rect x="6" y="2.5" width="12" height="15" rx="2" /><path d="M9 21.5h6M12 17.5v4M9 7h6M9 10.5h4" /></>,
  logout: <path d="M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M10 16l4-4-4-4M14 12H4" />,
};

function Svg({ name, className = "h-[18px] w-[18px]" }: { name: string; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICONS[name]}
    </svg>
  );
}

const NAV: { href: string; label: string; icon: string; manage?: boolean; cashier?: boolean; staff?: boolean; owner?: boolean; section?: string }[] = [
  { href: "/painel", label: "Dashboard", icon: "dashboard", manage: true, section: "Operação" },
  { href: "/painel/pedidos", label: "Pedidos", icon: "orders" },
  { href: "/painel/atendimento", label: "Atendimento WhatsApp", icon: "chat", staff: true },
  { href: "/painel/caixa", label: "Caixa / PDV", icon: "cash" },
  { href: "/painel/mesas", label: "Mesas e comandas", icon: "tables" },
  { href: "/painel/kds", label: "KDS (cozinha)", icon: "kds" },
  { href: "/painel/totens", label: "Totens", icon: "totem", manage: true },
  { href: "/painel/historico", label: "Histórico", icon: "history", manage: true },
  { href: "/painel/cardapio", label: "Cardápio", icon: "menu", manage: true },
  { href: "/painel/entregas", label: "Áreas de entrega", icon: "delivery", manage: true },
  { href: "/painel/entregadores", label: "Entregadores", icon: "rider", staff: true },
  { href: "/painel/estoque", label: "Estoque", icon: "box", manage: true, section: "Gestão" },
  { href: "/painel/financeiro", label: "Financeiro", icon: "wallet", manage: true },
  { href: "/painel/fiado", label: "Fiado", icon: "ledger", cashier: true },
  { href: "/painel/cupons", label: "Cupons", icon: "coupons", manage: true, section: "Vendas" },
  { href: "/painel/marketing", label: "Marketing", icon: "megaphone", manage: true },
  { href: "/painel/fidelidade", label: "Fidelidade", icon: "heart", manage: true },
  { href: "/painel/avaliacoes", label: "Avaliações", icon: "star", manage: true },
  { href: "/painel/integracoes", label: "Integrações", icon: "plug", manage: true },
  { href: "/painel/clientes", label: "Clientes", icon: "customers", manage: true },
  { href: "/painel/equipe", label: "Equipe", icon: "team", manage: true, section: "Conta" },
  { href: "/painel/impressao", label: "Impressão", icon: "printer", manage: true },
  { href: "/painel/pagamentos", label: "Pagamento online", icon: "card", manage: true },
  { href: "/painel/fiscal", label: "Nota fiscal", icon: "receipt", manage: true },
  { href: "/painel/configuracoes", label: "Configurações", icon: "settings", manage: true },
  { href: "/painel/assinatura", label: "Assinatura", icon: "badge", owner: true },
  { href: "/painel/seguranca", label: "Segurança", icon: "shield" },
];

export function Sidebar() {
  const { unit, units, role, email } = usePanel();
  const path = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const items = NAV.filter((n) => n.owner ? role === "owner" : n.staff ? canManage(role) || role === "cashier" || role === "attendant"
    : n.cashier ? canManage(role) || role === "cashier" : !n.manage || canManage(role));

  function switchUnit(id: string) {
    document.cookie = `df_unit=${id}; path=/; max-age=31536000; samesite=lax; secure`;
    router.refresh();
  }

  return (
    <>
      <div className="sticky top-0 z-40 flex items-center justify-between border-b border-zinc-200 bg-white px-4 py-2.5 lg:hidden">
        <Logo className="h-8" />
        <button className="grid h-10 w-10 place-items-center rounded-lg text-zinc-700 hover:bg-zinc-100" onClick={() => setOpen(!open)} aria-label="Menu" aria-expanded={open}>
          <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d={open ? "M6 6l12 12M18 6 6 18" : "M4 7h16M4 12h16M4 17h16"} /></svg>
        </button>
      </div>
      <aside className={`${open ? "block" : "hidden"} border-r border-zinc-200 bg-white text-zinc-600 lg:sticky lg:top-0 lg:block lg:h-screen lg:w-64 lg:shrink-0`}>
        <div className="flex h-full flex-col p-4">
          <div className="hidden px-2 pt-1 lg:block"><Logo className="h-8" /></div>
          <div className="mt-5 rounded-lg border border-zinc-200 bg-zinc-50 p-3">
            <p className="text-[11px] font-medium uppercase tracking-wider text-zinc-400">Loja</p>
            {units.length > 1 ? (
              <select className="mt-1 w-full rounded-md border border-zinc-200 bg-white px-2 py-1.5 text-sm font-medium text-zinc-900 outline-none" value={unit.id} onChange={(e) => switchUnit(e.target.value)}>
                {units.map((u) => <option key={u.id} value={u.id} className="text-zinc-900">{u.name}</option>)}
              </select>
            ) : (
              <p className="mt-0.5 truncate text-sm font-semibold text-zinc-900">{unit.name}</p>
            )}
            <a href={`/loja/${unit.slug}`} target="_blank" rel="noopener" className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-brand-700 hover:underline">
              <Svg name="external" className="h-3.5 w-3.5" /> Ver cardápio
            </a>
          </div>
          <nav className="mt-5 flex-1 space-y-0.5 overflow-y-auto" aria-label="Menu do painel">
            {items.map((n) => {
              const active = n.href === "/painel" ? path === "/painel" : path.startsWith(n.href);
              return (
                <div key={n.href}>
                  {n.section && <p className="px-3 pb-1.5 pt-4 text-[11px] font-medium uppercase tracking-wider text-zinc-400">{n.section}</p>}
                  <Link href={n.href} onClick={() => setOpen(false)} aria-current={active ? "page" : undefined}
                    className={`group relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition ${active ? "bg-brand-50 font-semibold text-brand-700" : "hover:bg-zinc-100 hover:text-zinc-900"}`}>
                    <Svg name={n.icon} />{n.label}
                  </Link>
                </div>
              );
            })}
          </nav>
          <div className="mt-3 flex items-center gap-3 border-t border-zinc-200 px-1 pt-3">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-zinc-100 text-sm font-semibold uppercase text-zinc-700">{email.slice(0, 1)}</span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs text-zinc-700">{email}</p>
              <button className="mt-0.5 inline-flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-900"
                onClick={async () => { await supabaseBrowser().auth.signOut(); router.replace("/login"); router.refresh(); }}>
                <Svg name="logout" className="h-3.5 w-3.5" /> Sair
              </button>
            </div>
          </div>
        </div>
      </aside>
    </>
  );
}
