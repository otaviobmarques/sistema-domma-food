"use client";
import { useState } from "react";
import { BrowserFrame } from "./frames";

const MODULES = [
  { id: "pedidos", label: "Gestor de pedidos", img: "/marketing/painel-pedidos.webp", title: "Todos os pedidos numa tela só",
    bullets: ["Kanban em tempo real com alerta sonoro e cronômetro por pedido", "Cardápio próprio, WhatsApp, 99Food, Keeta e aiqfome juntos, com selo de origem", "Aceitar, pronto, saiu e concluído em um toque — o cliente acompanha ao vivo"] },
  { id: "dashboard", label: "Dashboard", img: "/marketing/painel-dashboard.webp", title: "O resultado do dia, sem planilha",
    bullets: ["Faturamento, pedidos, ticket médio e tempo de preparo", "Vendas por dia, por hora, por forma de pagamento e por canal", "Ranking dos produtos que mais vendem"] },
  { id: "cardapio", label: "Gestão do cardápio", img: "/marketing/painel-cardapio.webp", title: "Cardápio completo em minutos",
    bullets: ["Fotos, promoções, selos e itens esgotados com um clique", "Complementos com mínimo e máximo, pizza meio a meio pelo maior preço ou média", "Horários por categoria (ex.: executivo só no almoço) e dados fiscais por item"] },
  { id: "clientes", label: "Clientes e CRM", img: "/marketing/painel-clientes.webp", title: "Conheça quem compra de você",
    bullets: ["Histórico, ticket médio e último pedido de cada cliente", "Segmentos automáticos: novos, recorrentes, fiéis, em risco e inativos", "Opt-in de marketing e exportação respeitando a LGPD"] },
  { id: "cupons", label: "Cupons", img: "/marketing/painel-cupons.webp", title: "Promoções que trazem o cliente de volta",
    bullets: ["Percentual, valor fixo ou frete grátis", "Pedido mínimo, 1º pedido, limite total e por cliente", "Validade com data e hora; tudo validado no servidor"] },
  { id: "entregas", label: "Áreas de entrega", img: "/marketing/painel-entregas.webp", title: "Taxa certa para cada região",
    bullets: ["Áreas por raio (km) ou por lista de bairros", "Taxa, tempo estimado e pedido mínimo por área", "Frete grátis acima de um valor"] },
  { id: "integracoes", label: "Integrações", img: "/marketing/painel-integracoes.webp", title: "Marketplaces no mesmo gestor",
    bullets: ["99Food, Keeta e aiqfome pelo padrão aberto Open Delivery", "O status volta sozinho para o marketplace, com novas tentativas automáticas", "Credenciais guardadas em cofre criptografado"] },
];

export function ModuleTabs() {
  const [active, setActive] = useState(0);
  const m = MODULES[active];
  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,320px)_1fr] lg:gap-12">
      <div role="tablist" aria-label="Módulos" className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 pb-1 lg:mx-0 lg:flex-col lg:overflow-visible lg:px-0">
        {MODULES.map((x, i) => (
          <button key={x.id} role="tab" aria-selected={i === active} aria-controls="modulo-painel" onClick={() => setActive(i)}
            className={`group shrink-0 rounded-2xl px-4 py-3 text-left text-sm font-semibold transition lg:py-4 ${i === active
              ? "bg-navy-900 text-white shadow-[0_12px_30px_-12px_rgb(30_16_51/0.6)]"
              : "bg-white text-zinc-700 ring-1 ring-zinc-200 hover:-translate-y-0.5 hover:ring-brand-200"}`}>
            <span className="flex items-center gap-3">
              <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-lg text-xs font-black ${i === active ? "bg-red-brand text-white" : "bg-brand-50 text-brand-700"}`}>{String(i + 1).padStart(2, "0")}</span>
              {x.label}
            </span>
          </button>
        ))}
      </div>
      <div id="modulo-painel" role="tabpanel" aria-live="polite" className="min-w-0">
        <div key={m.id} className="animate-fade-in">
          <h3 className="text-2xl font-black tracking-tight text-navy-900 sm:text-3xl">{m.title}</h3>
          <ul className="mt-4 grid gap-2 sm:grid-cols-3 sm:gap-4">
            {m.bullets.map((b) => (
              <li key={b} className="flex gap-2 text-sm text-zinc-600">
                <svg viewBox="0 0 20 20" className="mt-0.5 h-5 w-5 shrink-0 text-red-brand" fill="currentColor" aria-hidden="true"><path d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm3.7-9.3-4.2 4.2a1 1 0 0 1-1.4 0l-2-2a1 1 0 1 1 1.4-1.4l1.3 1.3 3.5-3.5a1 1 0 1 1 1.4 1.4Z" /></svg>
                {b}
              </li>
            ))}
          </ul>
          <BrowserFrame src={m.img} alt={`Tela do Domma Food: ${m.label}`} className="mt-6" />
        </div>
      </div>
    </div>
  );
}
