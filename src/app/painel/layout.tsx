import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { supabaseServer } from "@/lib/supabase/server";
import { PanelProvider, type PanelUnit, type Role } from "@/lib/panel/context";
import { Sidebar } from "./sidebar";
import { BillingGate } from "./billing-gate";

export const dynamic = "force-dynamic";

export default async function PanelLayout({ children }: { children: React.ReactNode }) {
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) redirect("/login");

  const loadMemberships = () => sb
    .from("memberships")
    .select("tenant_id, role, unit_ids, tenants(name, status, trial_ends_at, cancel_at)")
    .eq("user_id", user.id);
  let { data: memberships } = await loadMemberships();
  if (!memberships?.length) {
    // convites pendentes para este e-mail viram acesso no primeiro login
    const { data: accepted } = await sb.rpc("accept_invitations");
    if (accepted) ({ data: memberships } = await loadMemberships());
  }
  if (!memberships?.length) {
    const { data: admin } = await sb.from("platform_admins").select("user_id").eq("user_id", user.id).maybeSingle();
    if (admin) redirect("/admin");
    // parceiro de revenda sem loja própria vai para o portal da revenda
    await sb.rpc("reseller_accept_invites");
    const { data: resellers } = await sb.rpc("reseller_my");
    redirect((resellers as unknown[] | null)?.length ? "/revenda" : "/onboarding");
  }

  const { data: units } = await sb.from("units").select("id, name, slug, tenant_id").order("created_at");
  if (!units?.length) redirect("/onboarding");

  const store = await cookies();
  const chosen = store.get("df_unit")?.value;
  const unit = (units.find((u) => u.id === chosen) ?? units[0]) as PanelUnit;
  const m = memberships.find((x) => x.tenant_id === unit.tenant_id)!;
  const tenant = (Array.isArray(m.tenants) ? m.tenants[0] : m.tenants) as { name: string; status: string; trial_ends_at: string; cancel_at: string | null } | null;

  return (
    <PanelProvider value={{
      userId: user.id, email: user.email ?? "", tenantId: unit.tenant_id, tenantName: tenant?.name ?? "",
      role: m.role as Role, unit, units: units as PanelUnit[],
    }}>
      <div className="min-h-screen bg-zinc-50 lg:flex">
        <Sidebar />
        <div className="min-w-0 flex-1">
          <BillingGate status={tenant?.status ?? "active"} trialEndsAt={tenant?.trial_ends_at ?? null} cancelAt={tenant?.cancel_at ?? null} role={m.role}>
            <main className="mx-auto max-w-[1400px] p-4 sm:p-6">{children}</main>
          </BillingGate>
        </div>
      </div>
    </PanelProvider>
  );
}
