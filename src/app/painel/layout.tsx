import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { supabaseServer } from "@/lib/supabase/server";
import { PanelProvider, type PanelUnit, type Role } from "@/lib/panel/context";
import { Sidebar } from "./sidebar";

export const dynamic = "force-dynamic";

export default async function PanelLayout({ children }: { children: React.ReactNode }) {
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) redirect("/login");

  const { data: memberships } = await sb
    .from("memberships")
    .select("tenant_id, role, unit_ids, tenants(name, status, trial_ends_at)")
    .eq("user_id", user.id);
  if (!memberships?.length) {
    const { data: admin } = await sb.from("platform_admins").select("user_id").eq("user_id", user.id).maybeSingle();
    redirect(admin ? "/admin" : "/onboarding");
  }

  const { data: units } = await sb.from("units").select("id, name, slug, tenant_id").order("created_at");
  if (!units?.length) redirect("/onboarding");

  const store = await cookies();
  const chosen = store.get("df_unit")?.value;
  const unit = (units.find((u) => u.id === chosen) ?? units[0]) as PanelUnit;
  const m = memberships.find((x) => x.tenant_id === unit.tenant_id)!;
  const tenant = (Array.isArray(m.tenants) ? m.tenants[0] : m.tenants) as { name: string; status: string; trial_ends_at: string } | null;

  return (
    <PanelProvider value={{
      userId: user.id, email: user.email ?? "", tenantId: unit.tenant_id, tenantName: tenant?.name ?? "",
      role: m.role as Role, unit, units: units as PanelUnit[],
    }}>
      <div className="min-h-screen bg-cream lg:flex">
        <Sidebar />
        <div className="min-w-0 flex-1">
          {tenant?.status === "trial" && (
            <div className="flex items-center justify-center gap-2 border-b border-amber-200/70 bg-amber-50 px-4 py-2 text-center text-xs text-amber-900">
              <span className="badge bg-amber-200/70 text-amber-900">Teste grátis</span>
              Aproveite todos os recursos até {new Date(tenant.trial_ends_at).toLocaleDateString("pt-BR")}.
            </div>
          )}
          <main className="mx-auto max-w-7xl p-4 sm:p-6 lg:p-8">{children}</main>
        </div>
      </div>
    </PanelProvider>
  );
}
