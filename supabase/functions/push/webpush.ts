// Web Push sem dependências: criptografia aes128gcm (RFC 8291) e VAPID (RFC 8292) com WebCrypto.
const enc = new TextEncoder();

export function b64urlEncode(buf: ArrayBuffer | Uint8Array): string {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function b64urlDecode(s: string): Uint8Array {
  const t = s.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  const bin = atob(t + "===".slice((t.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
}
/** Chave pública P-256 crua (65 bytes) → JWK (x, y). */
function rawToJwk(raw: Uint8Array) {
  if (raw.length !== 65 || raw[0] !== 4) throw new Error("Chave pública inválida");
  return { kty: "EC", crv: "P-256", x: b64urlEncode(raw.slice(1, 33)), y: b64urlEncode(raw.slice(33, 65)) };
}

export type VapidKeys = { publicKey: string; privateJwk: JsonWebKey };

export async function generateVapidKeys(): Promise<VapidKeys> {
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
  return { publicKey: b64urlEncode(raw), privateJwk: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, d: jwk.d } };
}

/** Cabeçalho Authorization VAPID para o endpoint (válido por 12 h). */
export async function vapidAuth(endpoint: string, keys: VapidKeys, subject: string, nowSec = Math.floor(Date.now() / 1000)): Promise<string> {
  const aud = new URL(endpoint).origin;
  const header = b64urlEncode(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64urlEncode(enc.encode(JSON.stringify({ aud, exp: nowSec + 12 * 3600, sub: subject })));
  const key = await crypto.subtle.importKey("jwk", { ...keys.privateJwk, ext: true }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(`${header}.${claims}`));
  return `vapid t=${header}.${claims}.${b64urlEncode(sig)}, k=${keys.publicKey}`;
}

/** Corpo cifrado (aes128gcm, um único registro). `ephemeral` e `salt` só para testes. */
export async function encryptPayload(
  plaintext: Uint8Array, uaPublicB64: string, authB64: string,
  test?: { ephemeralPrivate: JsonWebKey; ephemeralPublic: Uint8Array; salt: Uint8Array },
): Promise<Uint8Array> {
  const uaPublic = b64urlDecode(uaPublicB64);
  const authSecret = b64urlDecode(authB64);
  if (authSecret.length !== 16) throw new Error("Segredo de autenticação inválido");
  let asPrivate: CryptoKey, asPublic: Uint8Array;
  if (test) {
    asPrivate = await crypto.subtle.importKey("jwk", { ...test.ephemeralPrivate, ext: true }, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    asPublic = test.ephemeralPublic;
  } else {
    const kp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
    asPrivate = kp.privateKey;
    asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  }
  const uaKey = await crypto.subtle.importKey("jwk", { ...rawToJwk(uaPublic), ext: true }, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, asPrivate, 256));
  const ikm = await hkdf(authSecret, shared, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const salt = test?.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, concat(plaintext, new Uint8Array([2]))));
  const rs = new Uint8Array([0, 0, 0x10, 0]);   // 4096
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, cipher);
}

/** Só serviços de push conhecidos (o endpoint vem do navegador do cliente). */
export const PUSH_HOST_RE = /^https:\/\/(fcm\.googleapis\.com|android\.googleapis\.com|jmt17\.google\.com|updates\.push\.services\.mozilla\.com|push\.services\.mozilla\.com|[a-z0-9-]+(\.[a-z0-9-]+)*\.push\.apple\.com|[a-z0-9-]+(\.[a-z0-9-]+)*\.notify\.windows\.com)\//;

export type SendResult = { ok: boolean; gone: boolean; status: number; error?: string };

export async function sendPush(
  sub: { endpoint: string; p256dh: string; auth: string }, payload: unknown, keys: VapidKeys, subject: string,
  opts: { ttl?: number; urgency?: "normal" | "high" } = {},
): Promise<SendResult> {
  if (!PUSH_HOST_RE.test(sub.endpoint)) return { ok: false, gone: true, status: 0, error: "Serviço de push não permitido" };
  const body = await encryptPayload(enc.encode(JSON.stringify(payload)), sub.p256dh, sub.auth);
  const r = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      Authorization: await vapidAuth(sub.endpoint, keys, subject),
      "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream",
      TTL: String(opts.ttl ?? 3600), Urgency: opts.urgency ?? "normal",
    },
    body, redirect: "manual", signal: AbortSignal.timeout(15_000),
  });
  if (r.ok) return { ok: true, gone: false, status: r.status };
  const text = (await r.text().catch(() => "")).slice(0, 200);
  return { ok: false, gone: r.status === 404 || r.status === 410, status: r.status, error: `${r.status} ${text}`.trim() };
}
