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
  external: <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />,
  logout: <path d="M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M10 16l4-4-4-4M14 12H4" />,
};

function Svg({ name, className = "h-[18px] w-[18px]" }: { name: string; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICONS[name]}
    </svg>
  );
}

const NAV: { href: string; label: string; icon: string; manage?: boolean; section?: string }[] = [
  { href: "/painel", label: "Dashboard", icon: "dashboard", manage: true, section: "Operação" },
  { href: "/painel/pedidos", label: "Pedidos", icon: "orders" },
  { href: "/painel/caixa", label: "Caixa / PDV", icon: "cash" },
  { href: "/painel/mesas", label: "Mesas e comandas", icon: "tables" },
  { href: "/painel/kds", label: "KDS (cozinha)", icon: "kds" },
  { href: "/painel/historico", label: "Histórico", icon: "history", manage: true },
  { href: "/painel/cardapio", label: "Cardápio", icon: "menu", manage: true },
  { href: "/painel/entregas", label: "Áreas de entrega", icon: "delivery", manage: true },
  { href: "/painel/cupons", label: "Cupons", icon: "coupons", manage: true, section: "Vendas" },
  { href: "/painel/integracoes", label: "Integrações", icon: "plug", manage: true },
  { href: "/painel/clientes", label: "Clientes", icon: "customers", manage: true },
  { href: "/painel/equipe", label: "Equipe", icon: "team", manage: true, section: "Conta" },
  { href: "/painel/configuracoes", label: "Configurações", icon: "settings", manage: true },
  { href: "/painel/seguranca", label: "Segurança", icon: "shield" },
];

export function Sidebar() {
  const { unit, units, role, email } = usePanel();
  const path = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const items = NAV.filter((n) => !n.manage || canManage(role));

  function switchUnit(id: string) {
    document.cookie = `df_unit=${id}; path=/; max-age=31536000; samesite=lax; secure`;
    router.refresh();
  }

  return (
    <>
      <div className="sticky top-0 z-40 flex items-center justify-between bg-wine-900 px-4 py-3 lg:hidden">
        <Logo dark />
        <button className="grid h-10 w-10 place-items-center rounded-xl text-white hover:bg-white/10" onClick={() => setOpen(!open)} aria-label="Menu" aria-expanded={open}>
          <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d={open ? "M6 6l12 12M18 6 6 18" : "M4 7h16M4 12h16M4 17h16"} /></svg>
        </button>
      </div>
      <aside className={`${open ? "block" : "hidden"} bg-gradient-to-b from-wine-900 to-brand-950 text-white/75 lg:sticky lg:top-0 lg:block lg:h-screen lg:w-64 lg:shrink-0`}>
        <div className="flex h-full flex-col p-4">
          <div className="hidden px-2 pt-1 lg:block"><Logo dark /></div>
          <div className="mt-5 rounded-2xl bg-white/[0.06] p-3 ring-1 ring-white/10">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-white/40">Loja</p>
            {units.length > 1 ? (
              <select className="mt-1 w-full rounded-lg bg-white/10 px-2 py-1.5 text-sm font-semibold text-white outline-none" value={unit.id} onChange={(e) => switchUnit(e.target.value)}>
                {units.map((u) => <option key={u.id} value={u.id} className="text-zinc-900">{u.name}</option>)}
              </select>
            ) : (
              <p className="mt-0.5 truncate text-sm font-semibold text-white">{unit.name}</p>
            )}
            <a href={`/loja/${unit.slug}`} target="_blank" rel="noopener" className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-brand-200 hover:text-white">
              <Svg name="external" className="h-3.5 w-3.5" /> Ver cardápio
            </a>
          </div>
          <nav className="mt-5 flex-1 space-y-0.5 overflow-y-auto" aria-label="Menu do painel">
            {items.map((n) => {
              const active = n.href === "/painel" ? path === "/painel" : path.startsWith(n.href);
              return (
                <div key={n.href}>
                  {n.section && <p className="px-3 pb-1.5 pt-4 text-[11px] font-semibold uppercase tracking-wider text-white/35">{n.section}</p>}
                  <Link href={n.href} onClick={() => setOpen(false)} aria-current={active ? "page" : undefined}
                    className={`group relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition ${active ? "bg-brand-600 font-semibold text-white shadow-[0_6px_16px_-6px_rgb(217_38_43/0.8)]" : "hover:bg-white/[0.07] hover:text-white"}`}>
                    <Svg name={n.icon} />{n.label}
                  </Link>
                </div>
              );
            })}
          </nav>
          <div className="mt-3 flex items-center gap-3 rounded-2xl bg-white/[0.06] p-3 ring-1 ring-white/10">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-brand-600 text-sm font-bold uppercase text-white">{email.slice(0, 1)}</span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs text-white/90">{email}</p>
              <button className="mt-0.5 inline-flex items-center gap-1 text-xs text-white/50 hover:text-white"
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
