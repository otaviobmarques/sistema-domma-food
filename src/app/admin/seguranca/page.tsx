import { supabaseServer } from "@/lib/supabase/server";
import { PanelProvider } from "@/lib/panel/context";
import SecurityPage from "@/app/painel/seguranca/page";
import Link from "next/link";

// Reaproveita a tela de segurança (2FA e troca de senha) para o Super Admin.
export default async function AdminSecurity() {
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  return (
    <PanelProvider value={{ userId: user!.id, email: user!.email ?? "", tenantId: "", tenantName: "", role: "attendant",
      unit: { id: "", name: "", slug: "", tenant_id: "" }, units: [] }}>
      <main className="mx-auto max-w-3xl p-4 lg:p-6">
        <Link href="/admin" className="text-sm text-brand-700 hover:underline">← Voltar ao Super Admin</Link>
        <div className="mt-3"><SecurityPage /></div>
      </main>
    </PanelProvider>
  );
}
