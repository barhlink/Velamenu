/**
 * Velamenu – Hloubětín server
 * ----------------------------
 * Spuštění:
 *   npm install ws
 *   node server.js
 *
 * Tablety se připojí na ws://[IP_TOHOTO_PC]:3000
 * IP zjistíš příkazem: ipconfig (Windows) / ip a (Linux)
 */

const WebSocket = require("ws");
const http      = require("http");

const PORT = 3000;

// ======================================================
// DATA
// TODO: Nahradit načtením z Make denního exportu (JSON soubor / HTTP request)
// Formát: [{ uuid, jmeno, jidlo }]
// ======================================================
const deti = [
  { uuid: "a3f9c21b", jmeno: "Adam Novák",       jidlo: "Svíčková na smetaně" },
  { uuid: "99d4e12f", jmeno: "Jana Svobodová",    jidlo: "Kuřecí řízek s bramborovou kaší" },
  { uuid: "b7e1a55c", jmeno: "Tomáš Krejčí",     jidlo: "Čočka na kyselo s vejcem" },
  { uuid: "c2d8f034", jmeno: "Eliška Marková",   jidlo: "Svíčková na smetaně" },
  { uuid: "e91b3a77", jmeno: "Jakub Dvořák",     jidlo: "Zeleninová polévka a salát" },
  { uuid: "f44c2b19", jmeno: "Lucie Horáková",   jidlo: "Kuřecí řízek s bramborovou kaší" },
  { uuid: "a11b2c3d", jmeno: "Martin Procházka", jidlo: "Svíčková na smetaně" },
  { uuid: "d9e8f7a6", jmeno: "Tereza Nováková",  jidlo: "Čočka na kyselo s vejcem" },
];

// Mapování UUID z 2N čtečky → UUID v poli deti
// TODO: Naplnit podle reálných UUID z 2N Access Unit
const uuidMap = {
  "a3f9c21b": "a3f9c21b",
  "99d4e12f": "99d4e12f",
  "b7e1a55c": "b7e1a55c",
  "c2d8f034": "c2d8f034",
  "e91b3a77": "e91b3a77",
  "f44c2b19": "f44c2b19",
  "a11b2c3d": "a11b2c3d",
  "d9e8f7a6": "d9e8f7a6",
};

// ======================================================
// STAV (resetuje se každý den)
// ======================================================
const vydano = new Set();
const log    = [];

// ======================================================
// SERVER
// ======================================================
const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Velamenu server běží. Vydáno dnes: " + log.length);
});

const wss = new WebSocket.Server({ server: httpServer });
const clients = new Set();

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
  const mappedUuid = uuidMap[uuid];
  const dite       = deti.find(d => d.uuid === mappedUuid);

  if (!dite) {
    // Neznámý otisk — pošle jen odesílateli (čtečce)
    send(ws, { type: "result", status: "err", uuid });
    return;
  }

  if (vydano.has(mappedUuid)) {
    // Již vydáno
    const zaznam = log.find(l => l.uuid === mappedUuid);
    send(ws, { type: "result", status: "warn", dite, vydanoCas: zaznam?.cas });
    // Výdej tablet dostane info ale jen jako varování
    broadcast({ type: "vydej_warn", dite, cas: zaznam?.cas }, ws);
    return;
  }

  // OK — vydej
  vydano.add(mappedUuid);
  const zaznam = zaloguj(dite, false, mappedUuid);

  // Čtečce: krátká potvrzovací zpráva
  send(ws, { type: "result", status: "ok", dite });

  // Výdej tabletu: nový zákazník v queue
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

function zaloguj(dite, override, uuid) {
  const zaznam = {
    uuid,
    jmeno:    dite.jmeno,
    jidlo:    dite.jidlo,
    cas:      cas(),
    override,
  };
  log.unshift(zaznam);
  console.log(`[${zaznam.cas}] Vydáno: ${dite.jmeno} — ${dite.jidlo}${override ? " (ručně)" : ""}`);
  return zaznam;
}

// ======================================================
// POMOCNÉ FUNKCE
// ======================================================
function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function broadcast(obj, exclude) {
  const data = JSON.stringify(obj);
  clients.forEach(c => {
    if (c !== exclude && c.readyState === WebSocket.OPEN) {
      c.send(data);
    }
  });
}

function cas() {
  return new Date().toLocaleTimeString("cs-CZ", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

// Každý den o půlnoci reset stavu
function resetDen() {
  const now  = new Date();
  const msDoPoalvnoci = new Date(
    now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 1, 0
  ) - now;

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
httpServer.listen(PORT, "0.0.0.0", () => {
  console.log("╔══════════════════════════════════════╗");
  console.log("║   Velamenu server — Hloubětín        ║");
  console.log(`║   Port: ${PORT}                            ║`);
  console.log("║                                      ║");
  console.log("║   Zjisti IP tohoto PC:               ║");
  console.log("║   Windows: ipconfig                  ║");
  console.log("║   Linux:   ip a                      ║");
  console.log("║                                      ║");
  console.log("║   Zadej IP do tabletů jako           ║");
  console.log(`║   SERVER_IP v HTML souborech         ║`);
  console.log("╚══════════════════════════════════════╝");
});

resetDen();
