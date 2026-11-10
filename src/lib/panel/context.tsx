"use client";
import { createContext, useContext } from "react";

export type Role = "owner" | "manager" | "cashier" | "attendant" | "kitchen" | "waiter" | "courier";
export type PanelUnit = { id: string; name: string; slug: string; tenant_id: string };
export type PanelCtx = {
  userId: string;
  email: string;
  tenantId: string;
  tenantName: string;
  role: Role;
  unit: PanelUnit;
  units: PanelUnit[];
};

const Ctx = createContext<PanelCtx | null>(null);

export function PanelProvider({ value, children }: { value: PanelCtx; children: React.ReactNode }) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function usePanel() {
  const v = useContext(Ctx);
  if (!v) throw new Error("usePanel fora do painel");
  return v;
}

export const canManage = (r: Role) => r === "owner" || r === "manager";
