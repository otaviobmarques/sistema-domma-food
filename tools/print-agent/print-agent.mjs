#!/usr/bin/env node
// Domma Food · Agente de impressão (rode no computador da loja; Node.js 18+, sem dependências)
//   node print-agent.mjs --token dfp_...            → imprime os pedidos automaticamente
//   node print-agent.mjs --token dfp_... --once     → busca uma vez e sai (teste)
// Impressora de rede: envia ESC/POS direto para IP:9100. Impressora do computador: usa o spooler
// (Windows: PowerShell Out-Printer; macOS/Linux: lp). O agente só fala com o Domma Food por HTTPS.
import net from "node:net";
import os from "node:os";
import { execFile } from "node:child_process";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SUPABASE_URL = process.env.DOMMA_SUPABASE_URL || "https://kcwidutqdqbyphrjnlef.supabase.co";
const PUBLIC_KEY = process.env.DOMMA_PUBLIC_KEY || "sb_publishable_kdh6RaaQsW-V51zMkFrCgQ_l9GNRBia";
const args = process.argv.slice(2);
const arg = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const TOKEN = arg("--token") || process.env.DOMMA_PRINT_TOKEN;
const ONCE = args.includes("--once");
const INTERVAL = Math.max(2, Number(arg("--interval") || 3)) * 1000;
if (!TOKEN || !/^dfp_[0-9a-f]{48}$/.test(TOKEN)) {
  console.error("Informe a chave do agente: node print-agent.mjs --token dfp_...  (gere em Painel › Impressão › Conectar computador)");
  process.exit(1);
}
const log = (...m) => console.log(new Date().toLocaleTimeString("pt-BR"), ...m);

async function rpc(fn, body) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST", headers: { apikey: PUBLIC_KEY, Authorization: `Bearer ${PUBLIC_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${fn}: HTTP ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

// ---- ESC/POS ----
const ESC = 0x1b, GS = 0x1d;
// impressoras térmicas comuns usam a página de código 860 (português) ou 850; trocamos acentos por equivalentes seguros
const strip = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\x20-\x7e\n]/g, "?");
function escpos(content, width) {
  const cols = width === 58 ? 32 : 42;
  const out = [Buffer.from([ESC, 0x40])];                       // inicializa
  for (const raw of content.split("\n")) {
    if (raw.startsWith("==")) { out.push(Buffer.from("\n\n\n\n")); out.push(Buffer.from([GS, 0x56, 0x42, 0x00])); continue; } // corte
    if (raw.startsWith("--")) { out.push(Buffer.from("-".repeat(cols) + "\n")); continue; }
    if (raw.startsWith("##")) {
      out.push(Buffer.from([ESC, 0x61, 0x01, GS, 0x21, 0x11, ESC, 0x45, 0x01]));  // centro, dupla altura/largura, negrito
      out.push(Buffer.from(strip(raw.slice(2)).slice(0, Math.floor(cols / 2)) + "\n"));
      out.push(Buffer.from([GS, 0x21, 0x00, ESC, 0x45, 0x00, ESC, 0x61, 0x00]));
      continue;
    }
    if (raw.startsWith("**")) { out.push(Buffer.from([ESC, 0x45, 0x01])); out.push(Buffer.from(strip(raw.slice(2)) + "\n")); out.push(Buffer.from([ESC, 0x45, 0x00])); continue; }
    out.push(Buffer.from(strip(raw) + "\n"));
  }
  return Buffer.concat(out);
}
const plain = (content) => content.split("\n").filter((l) => !l.startsWith("==")).map((l) =>
  l.startsWith("--") ? "-".repeat(32) : l.replace(/^(##|\*\*)/, "")).join("\n") + "\n\n\n";

function sendNetwork(address, data) {
  const [host, port = "9100"] = String(address || "").split(":");
  if (!/^[\w.-]+$/.test(host)) return Promise.reject(new Error("Endereço da impressora inválido"));
  return new Promise((resolve, reject) => {
    const s = net.createConnection({ host, port: Number(port), timeout: 8000 }, () => s.end(data, resolve));
    s.on("timeout", () => { s.destroy(); reject(new Error(`Sem resposta de ${host}:${port}`)); });
    s.on("error", reject);
  });
}
async function sendSystem(name, content) {
  const file = join(tmpdir(), `domma-${Date.now()}.txt`);
  await writeFile(file, plain(content), "utf8");
  const run = (cmd, a) => new Promise((res, rej) => execFile(cmd, a, { timeout: 20000 }, (e) => (e ? rej(e) : res())));
  try {
    if (process.platform === "win32") {
      const ps = `Get-Content -Encoding UTF8 -LiteralPath '${file.replace(/'/g, "''")}' | Out-Printer` + (name ? ` -Name '${String(name).replace(/'/g, "''")}'` : "");
      await run("powershell.exe", ["-NoProfile", "-Command", ps]);
    } else {
      await run("lp", name ? ["-d", String(name), file] : [file]);
    }
  } finally { unlink(file).catch(() => {}); }
}

async function tick() {
  const r = await rpc("print_agent_poll", { p_token: TOKEN, p_info: `${os.hostname()} · ${process.platform} · node ${process.version}` });
  for (const j of r.jobs || []) {
    try {
      if (j.printer.connection === "network") await sendNetwork(j.printer.address, escpos(j.content, j.printer.paper_width));
      else await sendSystem(j.printer.address, j.content);
      await rpc("print_agent_done", { p_token: TOKEN, p_job_id: j.id, p_ok: true, p_error: null });
      log(`Impresso #${j.id} em ${j.printer.name}`);
    } catch (e) {
      await rpc("print_agent_done", { p_token: TOKEN, p_job_id: j.id, p_ok: false, p_error: String(e.message || e) }).catch(() => {});
      log(`Falhou #${j.id} em ${j.printer.name}: ${e.message || e}`);
    }
  }
  return r;
}

log("Domma Food · agente de impressão iniciado. Deixe esta janela aberta.");
let warned = false;
do {
  try { const r = await tick(); if (!warned) { log(`Conectado como "${r.agent}".`); warned = true; } }
  catch (e) { log("Sem conexão com o Domma Food:", e.message || e); }
  if (!ONCE) await new Promise((res) => setTimeout(res, INTERVAL));
} while (!ONCE);
