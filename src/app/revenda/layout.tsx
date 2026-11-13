import { redirect } from "next/navigation";
import { supabaseServer } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const metadata = { title: "Portal da revenda" };

export default async function ResellerLayout({ children }: { children: React.ReactNode }) {
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) redirect("/login?next=/revenda");
  await sb.rpc("reseller_accept_invites");
  return <div className="min-h-screen bg-zinc-50">{children}</div>;
}
