const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

// Load .env
const envPath = path.join(__dirname, '.env');
try {
  const envFile = fs.readFileSync(envPath, 'utf8');
  for (const line of envFile.split('\n')) {
    const match = line.match(/^\s*([^#=]+?)\s*=\s*(.*)\s*$/);
    if (match) process.env[match[1]] = match[2];
  }
} catch (e) {}

const PORT = 8080;
const AIS_URL = 'wss://stream.aisstream.io/v0/stream';
const BOUNDS = [[37.2, -123.1], [38.2, -121.8]];

const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
};

// ── API key ──
function loadApiKey() {
  return process.env.AISSTREAM_API_KEY || null;
}

// ── Static file server ──
const server = http.createServer((req, res) => {
  const filePath = path.join(__dirname, req.url === '/' ? 'index.html' : req.url);
  const ext = path.extname(filePath);

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

// ── Persistent AISstream connection ──
let aisSocket = null;
let aisReady = false;
let apiKey = loadApiKey();
let reconnectTimer = null;
let reconnectDelay = 5000;
const RECONNECT_MAX = 60000;
let aisActivityTimer = null;
const AIS_ACTIVITY_TIMEOUT = 30000; // Force reconnect if no data for 30s

const browserClients = new Set();

function buildSubscription() {
  return {
    APIKey: apiKey,
    BoundingBoxes: [BOUNDS],
    FiltersShipMMSI: [],
    FilterMessageTypes: ['PositionReport', 'ShipStaticData'],
  };
}

function resetAisActivityTimer(ws) {
  if (aisActivityTimer) clearTimeout(aisActivityTimer);
  aisActivityTimer = setTimeout(() => {
    console.log('[ais] No data for ' + (AIS_ACTIVITY_TIMEOUT / 1000) + 's — connection is dead, forcing reconnect');
    aisActivityTimer = null;
    if (ws && ws.readyState !== WebSocket.CLOSED) {
      ws.terminate();
    }
  }, AIS_ACTIVITY_TIMEOUT);
}

function connectToAIS() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  if (!apiKey) {
    console.log('[ais] No API key — waiting for browser to provide one');
    // Tell all connected browsers we need a key
    broadcast(JSON.stringify({ _status: 'need_key' }));
    return;
  }

  console.log('[ais] Connecting to AISstream...');
  aisReady = false;

  const ws = new WebSocket(AIS_URL);
  aisSocket = ws;

  ws.on('open', () => {
    console.log('[ais] Connected — sending subscription');
    reconnectDelay = 5000;
    aisReady = true;
    ws.send(JSON.stringify(buildSubscription()));
    broadcast(JSON.stringify({ _status: 'connected' }));
    resetAisActivityTimer(ws);
  });

  let aisMessageCount = 0;
  ws.on('message', (data) => {
    resetAisActivityTimer(ws);
    const msg = data.toString();
    aisMessageCount++;
    if (aisMessageCount <= 3 || aisMessageCount % 100 === 0) {
      console.log(`[ais] Message #${aisMessageCount}:`, msg.substring(0, 120));
    }

    // Check for API key errors from AISstream
    try {
      const parsed = JSON.parse(msg);
      if (parsed.error && parsed.error.toLowerCase().includes('key')) {
        console.error('[ais] Invalid API key:', parsed.error);
        apiKey = null;
        broadcast(JSON.stringify({ _status: 'need_key' }));
        ws.close();
        return;
      }
    } catch (e) {}

    broadcast(msg);
  });

  ws.on('close', () => {
    console.log('[ais] Disconnected — reconnecting in', reconnectDelay / 1000, 's');
    if (aisActivityTimer) { clearTimeout(aisActivityTimer); aisActivityTimer = null; }
    aisReady = false;
    aisSocket = null;
    scheduleReconnect();
  });

  ws.on('error', (err) => {
    console.error('[ais] Error:', err.message);
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectToAIS();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 1.5, RECONNECT_MAX);
}

function broadcast(msg) {
  let sent = 0;
  for (const client of browserClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
      sent++;
    }
  }
  if (sent > 0 && !msg.includes('_status')) {
    // Log every 50th data message to confirm flow without spam
    broadcast._count = (broadcast._count || 0) + 1;
    if (broadcast._count % 50 === 1) {
      console.log(`[broadcast] Sent msg #${broadcast._count} to ${sent} client(s)`);
    }
  }
}

// ── Browser WebSocket connections ──
const wss = new WebSocket.Server({ server, path: '/ws' });

wss.on('connection', (client) => {
  console.log('[ws] Browser connected (' + (browserClients.size + 1) + ' total)');
  browserClients.add(client);

  // Tell the browser the current state immediately
  if (aisReady) {
    client.send(JSON.stringify({ _status: 'connected' }));
  } else if (!apiKey) {
    client.send(JSON.stringify({ _status: 'need_key' }));
  } else {
    client.send(JSON.stringify({ _status: 'connecting' }));
  }

  // Browser can send an API key if we don't have one
  client.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.APIKey) {
        const needsConnect = !apiKey || msg.APIKey !== apiKey;
        apiKey = msg.APIKey;

        if (needsConnect) {
          if (aisSocket) {
            aisSocket.onclose = null;
            aisSocket.close();
            aisSocket = null;
          }
          connectToAIS();
        }
      }
    } catch (e) {}
  });

  client.on('close', () => {
    browserClients.delete(client);
    console.log('[ws] Browser disconnected (' + browserClients.size + ' remaining)');
  });

  client.on('error', () => {
    browserClients.delete(client);
  });
});

// ── Start ──
server.listen(PORT, () => {
  console.log(`Ship tracker running at http://localhost:${PORT}`);
  if (apiKey) {
    console.log('[ais] API key loaded from disk — connecting...');
    connectToAIS();
  } else {
    console.log('[ais] No API key found — open browser to configure');
  }
});
