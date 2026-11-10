// O login aceita e-mail ou nome de usuário. Usuários sem e-mail (ex.: "Admin")
// usam um endereço interno que não recebe mensagens.
export const USERNAME_DOMAIN = "dommafood.local";

export function loginIdToEmail(id: string): string {
  const v = id.trim().toLowerCase();
  if (v.includes("@")) return v;
  return `${v.replace(/[^a-z0-9._-]/g, "")}@${USERNAME_DOMAIN}`;
}
