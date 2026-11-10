import { redirect } from "next/navigation";
import { supabaseServer } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const metadata = { title: "Super Admin" };

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const sb = await supabaseServer();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) redirect("/login?next=/admin");
  const { data: admin } = await sb.from("platform_admins").select("user_id").eq("user_id", user.id).maybeSingle();
  if (!admin) redirect("/painel");
  return <div className="min-h-screen bg-zinc-50">{children}</div>;
}
