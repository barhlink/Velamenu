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
let pendingRegistration = null; // { userId, timestamp } — čeká na /fingerprint/name

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
      if (!uuidMap[userId]) {
        // Neznámý uživatel — ulož pro spárování s /fingerprint/name
        pendingRegistration = { userId, timestamp: Date.now() };
      }
      handleFingerprint(null, userId);
    });
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
    return;
  }

  // 2N Automation push — přijme jméno uživatele a spáruje s čekajícím userId
  if (parsed.pathname === "/fingerprint/name") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => {
      const userName = body.trim();
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");

      if (!pendingRegistration || Date.now() - pendingRegistration.timestamp > 3000) {
        console.log(`[${cas()}] /fingerprint/name bez čekající registrace: ${userName}`);
        return;
      }

      const { userId } = pendingRegistration;
      pendingRegistration = null;

      // Vyhledej dítě v Bubble Data API
      const constraints = JSON.stringify([{ key: "fullname", constraint_type: "equals", value: userName }]);
      const apiPath = `/api/1.1/obj/kids?constraints=${encodeURIComponent(constraints)}`;
      const opts = {
        hostname: "menu.skolavela.cz",
        path:     apiPath,
        headers:  { Authorization: "Bearer c39e7242f33f9be6926edd5c15921c21" },
        timeout:  5000,
      };

      https.get(opts, (r) => {
        let data = "";
        r.on("data", c => data += c);
        r.on("end", () => {
          try {
            const json     = JSON.parse(data);
            const results  = json?.response?.results || [];
            if (results.length === 0) {
              console.log(`[${cas()}] Nenalezen v Bubble: ${userName}`);
              return;
            }
            const kid = results[0];
            const fullname = kid.fullname_text || userName;
            uuidMap[userId] = fullname;
            const uuidmapPath = path.join(__dirname, "data", "uuidmap.json");
            fs.writeFileSync(uuidmapPath, JSON.stringify(uuidMap, null, 2), "utf8");
            console.log(`[${cas()}] Registrován: ${fullname} (userId=${userId})`);
            broadcast({ type: "registrace", jmeno: fullname });
          } catch (err) {
            console.error(`[${cas()}] Chyba Bubble API:`, err.message);
          }
        });
      }).on("error", (err) => {
        console.error(`[${cas()}] Bubble API chyba sítě:`, err.message);
      }).on("timeout", function() { this.destroy(); });
    });
    return;
  }

  // Statické soubory
  const filePath = path.join(__dirname, parsed.pathname);
  if (parsed.pathname !== '/' && fs.existsSync(filePath)) {
    const ext = path.extname(filePath);
    const mime = { '.html': 'text/html; charset=utf-8', '.png': 'image/png' };
    res.writeHead(200, { 'Content-Type': mime[ext] || 'text/plain', 'Cache-Control': 'no-cache' });
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
    // Čeká se na /fingerprint/name — pokud přijde, zaregistruje a příště proběhne normálně
    return;
  }

  const dite = deti.find(d => d.jmeno === jmeno);
  if (!dite) {
    console.log(`[${cas()}] Nemá objednávku: ${jmeno}`);
    const errMsg = { type: "result", status: "err", info: "nema_objednavku", jmeno };
    send(ws, errMsg);
    broadcast(errMsg, ws);
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
  ulozVydano();
  broadcast({ type: "storno", uuid }, null);
}

function zaloguj(dite, override, uuid) {
  const zaznam = { uuid, jmeno: dite.jmeno, jidlo: dite.jidlo, cas: cas(), override };
  log.unshift(zaznam);
  console.log(`[${zaznam.cas}] Vydáno: ${dite.jmeno} — ${dite.jidlo}${override ? " (ručně)" : ""}`);
  ulozVydano();
  return zaznam;
}

function ulozVydano() {
  const datum = new Date().toISOString().slice(0, 10);
  const soubor = path.join(__dirname, "data", "vydano.json");
  fs.writeFileSync(soubor, JSON.stringify({ datum, vydano: [...vydano] }), "utf8");
}

function nactiVydano() {
  const soubor = path.join(__dirname, "data", "vydano.json");
  try {
    const data  = JSON.parse(fs.readFileSync(soubor, "utf8"));
    const dnes  = new Date().toISOString().slice(0, 10);
    if (data.datum !== dnes) return;
    data.vydano.forEach(uuid => vydano.add(uuid));
    console.log(`[${cas()}] Vydano načteno: ${vydano.size} záznamů`);
  } catch {
    // soubor neexistuje nebo je poškozený — začínáme čistě
  }
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
    try { fs.unlinkSync(path.join(__dirname, "data", "vydano.json")); } catch {}
    console.log(`[${cas()}] Nový den — stav resetován.`);
    broadcast({ type: "reset" });
    resetDen();
  }, msDoPoalvnoci);
}

// ======================================================
// START
// ======================================================
nactiVydano();
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
