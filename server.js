/**
 * Velamenu – Hloubětín server
 * ----------------------------
 * Spuštění:
 *   npm install ws
 *   node server.js
 *
 * Tablety se připojí na ws://[IP_TOHOTO_PC]:3000
 * IP zjistíš příkazem: ipconfig (Windows) / ip a (Linux)
 *
 * Denní export z Make:
 *   Ulož soubor jako data/export.json  → [{ uuid, jmeno, jidlo }]
 *   UUID mapu  jako data/uuidmap.json  → { "2n_id": "bubble_uuid" }
 *   Pak zavolej: curl http://localhost:3000/reload
 *   nebo pošli:  kill -HUP <pid serveru>
 */

const WebSocket = require("ws");
const http      = require("http");
const https     = require("https");
const fs        = require("fs");
const path      = require("path");
const url       = require("url");

const PORT = 3000;

// ======================================================
// KONFIGURACE 2N Access Unit
// Změň IP, uživatele a heslo podle svého nastavení
// ======================================================
const CFG = {
  twonIp:    "192.168.1.227",  // ← IP adresa 2N čtečky v síti školy
  twonToken: "3tchR+/tFUe3ch/SxZ4bkpzkKg/+XfDRwy2pwhoZdgNfWgpK",          // ← Bearer token (nebo heslo) pro 2N HTTP API
};

// ======================================================
// STAV (resetuje se každý den)
// ======================================================
const vydano  = new Set();
const log     = [];
const clients = new Set();

// ======================================================
// DATA — načítá se ze souborů při startu nebo /reload
// ======================================================
let deti    = [];
let uuidMap = {};

function loadData() {
  try {
    const exportPath  = path.join(__dirname, "data", "export.json");
    const uuidmapPath = path.join(__dirname, "data", "uuidmap.json");
    deti    = JSON.parse(fs.readFileSync(exportPath,  "utf8"));
    uuidMap = JSON.parse(fs.readFileSync(uuidmapPath, "utf8"));
    console.log(`[${cas()}] Data načtena: ${deti.length} dětí, ${Object.keys(uuidMap).length} UUID mapování`);
    // Pošle aktualizovaný seznam dětí všem připojeným klientům
    broadcast({ type: "init", log, deti });
  } catch (err) {
    console.error(`[${cas()}] Chyba při načítání dat:`, err.message);
  }
}

// Reload dat bez restartu serveru: kill -HUP <pid>
process.on("SIGHUP", () => {
  console.log(`[${cas()}] SIGHUP — přenačítám data...`);
  loadData();
});

// ======================================================
// HTTP SERVER
// ======================================================
const httpServer = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);

  // GET /reload — přenačte export.json a uuidmap.json za běhu
  if (parsed.pathname === "/reload") {
    loadData();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, deti: deti.length, uuidMap: Object.keys(uuidMap).length }));
    return;
  }

  // GET /api/2n-poll — nahrazen 2N Automation push přes /fingerprint, polling se nepoužívá
  if (parsed.pathname === "/api/2n-poll") {
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ events: [] }));
    return;
  }

  // 2N Automation push — přijme User ID při otisku prstu
  if (parsed.pathname === "/fingerprint") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => {
      const userId = body.trim();
      console.log(`[${cas()}] 2N otisk: userId=${userId}`);
      handleFingerprint(null, userId);
    });
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
    return;
  }

  // Statické soubory
  const filePath = path.join(__dirname, parsed.pathname);
  if (parsed.pathname !== '/' && fs.existsSync(filePath)) {
    const ext = path.extname(filePath);
    const mime = { '.html': 'text/html; charset=utf-8', '.png': 'image/png' };
    res.writeHead(200, { 'Content-Type': mime[ext] || 'text/plain' });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  // Default — stavová stránka
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Velamenu server běží. Vydáno dnes: " + log.length);
});

const wss = new WebSocket.Server({ server: httpServer });

wss.on("connection", (ws, req) => {
  clients.add(ws);
  const ip = req.socket.remoteAddress;
  console.log(`[${cas()}] Připojen klient: ${ip} (celkem: ${clients.size})`);

  // Nový klient dostane aktuální stav (log + seznam dětí)
  send(ws, { type: "init", log, deti });

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    console.log(`[${cas()}] Zpráva:`, msg);

    switch (msg.type) {
      case "fingerprint":
        handleFingerprint(ws, msg.uuid);
        break;
      case "override":
        handleOverride(ws, msg.uuid);
        break;
      case "storno":
        handleStorno(msg.uuid);
        break;

      case "ping":
        send(ws, { type: "pong" });
        break;
    }
  });

  ws.on("close", () => {
    clients.delete(ws);
    console.log(`[${cas()}] Klient odpojen (celkem: ${clients.size})`);
  });

  ws.on("error", (err) => console.error(`[${cas()}] WS chyba:`, err.message));
});

// ======================================================
// LOGIKA VÝDEJE
// ======================================================
function handleFingerprint(ws, uuid) {
  const jmeno = uuidMap[uuid];
  if (!jmeno) {
    console.log(`[${cas()}] Neznámý userId: ${uuid}`);
    send(ws, { type: "result", status: "err", uuid });
    broadcast({ type: "result", status: "err", info: "neznamy_uzivatel" }, ws);
    return;
  }

  const dite = deti.find(d => d.jmeno === jmeno);
  if (!dite) {
    console.log(`[${cas()}] Nemá objednávku: ${jmeno}`);
    send(ws, { type: "result", status: "err", uuid });
    broadcast({ type: "result", status: "err", info: "nema_objednavku", jmeno }, ws);
    return;
  }

  if (vydano.has(dite.uuid)) {
    const zaznam = log.find(l => l.uuid === dite.uuid);
    send(ws, { type: "result", status: "warn", dite, vydanoCas: zaznam?.cas });
    broadcast({ type: "vydej_warn", dite, cas: zaznam?.cas }, ws);
    return;
  }

  vydano.add(dite.uuid);
  const zaznam = zaloguj(dite, false, dite.uuid);

  send(ws, { type: "result", status: "ok", dite });
  broadcast({ type: "vydej_new", dite, cas: zaznam.cas }, ws);
}

function handleOverride(ws, uuid) {
  const dite = deti.find(d => d.uuid === uuid);
  if (!dite) return;

  vydano.add(uuid);
  const zaznam = zaloguj(dite, true, uuid);

  send(ws, { type: "result", status: "ok", dite, override: true });
  broadcast({ type: "vydej_new", dite, cas: zaznam.cas, override: true }, ws);
}

function handleStorno(uuid) {
  vydano.delete(uuid);
  const idx = log.findIndex(l => l.uuid === uuid);
  const jmeno = idx !== -1 ? log[idx].jmeno : uuid;
  if (idx !== -1) log.splice(idx, 1);
  console.log(`[${cas()}] Storno: ${jmeno}`);
  // Informovat všechny klienty (ctecka i vydej)
  broadcast({ type: "storno", uuid }, null);
}

function zaloguj(dite, override, uuid) {
  const zaznam = { uuid, jmeno: dite.jmeno, jidlo: dite.jidlo, cas: cas(), override };
  log.unshift(zaznam);
  console.log(`[${zaznam.cas}] Vydáno: ${dite.jmeno} — ${dite.jidlo}${override ? " (ručně)" : ""}`);
  return zaznam;
}

// ======================================================
// POMOCNÉ FUNKCE
// ======================================================
function send(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function broadcast(obj, exclude) {
  const data = JSON.stringify(obj);
  clients.forEach(c => {
    if (c !== exclude && c.readyState === WebSocket.OPEN) c.send(data);
  });
}

function cas() {
  return new Date().toLocaleTimeString("cs-CZ", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

// Každý den o půlnoci reset stavu
function resetDen() {
  const now = new Date();
  const msDoPoalvnoci = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 1, 0) - now;
  setTimeout(() => {
    vydano.clear();
    log.length = 0;
    console.log(`[${cas()}] Nový den — stav resetován.`);
    broadcast({ type: "reset" });
    resetDen();
  }, msDoPoalvnoci);
}

// ======================================================
// START
// ======================================================
loadData();

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log("╔══════════════════════════════════════╗");
  console.log("║   Velamenu server — Hloubětín        ║");
  console.log(`║   Port: ${PORT}                            ║`);
  console.log("║                                      ║");
  console.log("║   Zjisti IP tohoto PC:               ║");
  console.log("║   Windows: ipconfig                  ║");
  console.log("║   Linux:   ip a                      ║");
  console.log("║                                      ║");
  console.log("║   Data:  data/export.json            ║");
  console.log("║          data/uuidmap.json           ║");
  console.log("║   Reload: GET /reload                ║");
  console.log("╚══════════════════════════════════════╝");
});

resetDen();
