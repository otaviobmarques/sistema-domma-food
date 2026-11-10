import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Domma Food", template: "%s · Domma Food" },
  description: "Cardápio digital, delivery e gestão completa para restaurantes. Sem comissão por pedido.",
  applicationName: "Domma Food",
};

export const viewport: Viewport = { themeColor: "#6d28d9", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
