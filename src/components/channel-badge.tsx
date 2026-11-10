// Selo de origem do pedido. Pedidos do cardápio próprio (web) não recebem selo.
// Para usar o logotipo oficial de um marketplace, coloque o arquivo do kit de
// parceiro em public/marketplaces/<canal>.svg e adicione o canal em LOGO_FILES.
const STYLE: Record<string, { label: string; cls: string; mark?: string }> = {
  "99food": { label: "99Food", cls: "bg-yellow-300 text-zinc-900 ring-yellow-400", mark: "99" },
  keeta: { label: "Keeta", cls: "bg-zinc-900 text-yellow-300 ring-zinc-900", mark: "K" },
  aiqfome: { label: "aiqfome", cls: "bg-purple-700 text-white ring-purple-800", mark: "aiq" },
  ifood: { label: "iFood", cls: "bg-red-600 text-white ring-red-700", mark: "iF" },
  marketplace: { label: "Marketplace", cls: "bg-sky-700 text-white ring-sky-800", mark: "OD" },
  whatsapp: { label: "WhatsApp", cls: "bg-green-600 text-white ring-green-700", mark: "WA" },
  counter: { label: "Balcão", cls: "bg-zinc-200 text-zinc-800 ring-zinc-300", mark: "B" },
  table: { label: "Mesa", cls: "bg-zinc-200 text-zinc-800 ring-zinc-300", mark: "M" },
  totem: { label: "Totem", cls: "bg-zinc-200 text-zinc-800 ring-zinc-300", mark: "T" },
  phone: { label: "Telefone", cls: "bg-zinc-200 text-zinc-800 ring-zinc-300", mark: "☎" },
};
const LOGO_FILES: Record<string, string> = {}; // ex.: { "99food": "/marketplaces/99food.svg" }

export const isMarketplace = (channel: string) => ["99food", "keeta", "aiqfome", "ifood", "marketplace"].includes(channel);
export const channelLabel = (channel: string) => (channel === "web" ? "Cardápio próprio" : STYLE[channel]?.label ?? channel);

export function ChannelBadge({ channel, size = "sm" }: { channel: string; size?: "sm" | "md" }) {
  if (channel === "web") return null;
  const s = STYLE[channel] ?? { label: channel, cls: "bg-zinc-200 text-zinc-800 ring-zinc-300", mark: "?" };
  const logo = LOGO_FILES[channel];
  const pad = size === "md" ? "px-2.5 py-1 text-xs" : "px-2 py-0.5 text-[11px]";
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 rounded-full font-extrabold ring-1 ${pad} ${s.cls}`} title={`Pedido via ${s.label}`}>
      {logo && <img src={logo} alt="" className="h-3.5 w-auto" />}
      <span>{s.label}</span>
    </span>
  );
}
