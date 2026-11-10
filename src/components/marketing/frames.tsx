// Molduras de navegador e de celular para as capturas reais do sistema.
export function BrowserFrame({ src, alt, className = "", priority = false }: { src: string; alt: string; className?: string; priority?: boolean }) {
  return (
    <div className={`overflow-hidden rounded-2xl border border-zinc-900/10 bg-white shadow-[0_30px_80px_-20px_rgb(30_16_51/0.45)] ${className}`}>
      <div className="flex items-center gap-2 border-b border-zinc-100 bg-zinc-50/90 px-4 py-2.5">
        <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]" /><span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]" /><span className="h-2.5 w-2.5 rounded-full bg-[#28c840]" />
        <span className="ml-3 hidden truncate rounded-md bg-white px-3 py-0.5 text-[11px] text-zinc-400 ring-1 ring-zinc-200 sm:block">app.dommafood.com.br/painel</span>
      </div>
      <img src={src} alt={alt} width={2400} height={1500} loading={priority ? "eager" : "lazy"} decoding="async" className="block h-auto w-full" />
    </div>
  );
}

export function PhoneFrame({ src, alt, className = "", priority = false }: { src: string; alt: string; className?: string; priority?: boolean }) {
  return (
    <div className={`relative rounded-[2.6rem] bg-navy-900 p-2.5 shadow-[0_30px_70px_-15px_rgb(30_16_51/0.55)] ring-1 ring-white/10 ${className}`}>
      <div className="absolute left-1/2 top-4 z-10 h-5 w-20 -translate-x-1/2 rounded-full bg-navy-900" aria-hidden="true" />
      <div className="overflow-hidden rounded-[2.1rem] bg-white">
        <img src={src} alt={alt} width={780} height={1309} loading={priority ? "eager" : "lazy"} decoding="async" className="block h-auto w-full" />
      </div>
    </div>
  );
}
