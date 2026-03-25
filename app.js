// ── Configuration ──
const CONFIG = {
  WS_URL: `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`,
  // SF Bay bounding box: Golden Gate approaches → San Pablo Bay, Pacific → East Bay
  BOUNDS: [[37.2, -123.1], [38.2, -121.8]],
  MAP_CENTER: [37.81, -122.40],
  MAP_ZOOM: 12,
  STALE_TIMEOUT_MS: 10 * 60 * 1000,   // Remove ships after 10 min of silence
  CLEANUP_INTERVAL_MS: 30 * 1000,      // Check for stale ships every 30s
  STATS_INTERVAL_MS: 1000,             // Update stats every second
  RECONNECT_BASE_MS: 2000,
  RECONNECT_MAX_MS: 30000,
  LABEL_ZOOM_THRESHOLD: 13,            // Show ship names at this zoom+
};

// ── Map themes ──
const THEMES = [
  {
    id: 'dark',
    name: 'Dark',
    icon: '\u{1F319}',
    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    options: { subdomains: 'abcd', maxZoom: 20 },
    strokeColor: 'rgba(255,255,255,0.25)',
  },
  {
    id: 'satellite',
    name: 'Satellite',
    icon: '\u{1F6F0}\uFE0F',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    options: { maxZoom: 19 },
    strokeColor: 'rgba(255,255,255,0.4)',
  },
  {
    id: 'realistic',
    name: 'Realistic',
    icon: '\u{1F5FA}\uFE0F',
    url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
    options: { subdomains: 'abcd', maxZoom: 20 },
    strokeColor: 'rgba(0,0,0,0.35)',
  },
];

// ── Ship type classification ──
const SHIP_COLORS = {
  cargo:     '#4CAF50',
  tanker:    '#F44336',
  passenger: '#2196F3',
  tug:       '#FF9800',
  fishing:   '#8BC34A',
  sailing:   '#E91E63',
  military:  '#9C27B0',
  highspeed: '#00BCD4',
  default:   '#78909C',
};

const SHIP_TYPE_LABELS = {
  cargo: 'Cargo', tanker: 'Tanker', passenger: 'Passenger',
  tug: 'Tug / Pilot', fishing: 'Fishing', sailing: 'Sailing',
  military: 'Military', highspeed: 'High Speed', default: 'Vessel',
};

// Top-down hull silhouettes per category (24x24 viewBox, bow pointing north)
const SHIP_SHAPES = {
  cargo:     'M12 2 L17 8 L17 18 L15 22 L9 22 L7 18 L7 8 Z',
  tanker:    'M12 2 L18 9 L18 16 L15 22 L9 22 L6 16 L6 9 Z',
  passenger: 'M12 2 L16 6 L18 12 L17 18 L14 22 L10 22 L7 18 L6 12 L8 6 Z',
  tug:       'M12 6 L16 11 L16 18 L14 21 L10 21 L8 18 L8 11 Z',
  fishing:   'M12 4 L16 10 L15 18 L13 22 L11 22 L9 18 L8 10 Z',
  sailing:   'M12 2 L15 8 L15 18 L13 22 L11 22 L9 18 L9 8 Z',
  military:  'M12 1 L17 8 L17 15 L15 21 L12 23 L9 21 L7 15 L7 8 Z',
  highspeed: 'M12 1 L15 7 L15 18 L13 22 L11 22 L9 18 L9 7 Z',
  default:   'M12 3 L16 9 L16 18 L13 22 L11 22 L8 18 L8 9 Z',
};

const SHIP_MARKER_SIZES = {
  cargo: 28, tanker: 28, passenger: 28,
  military: 26, highspeed: 24, default: 24,
  tug: 20, fishing: 20, sailing: 20,
};

function getShipCategory(typeCode) {
  if (typeCode >= 70 && typeCode <= 79) return 'cargo';
  if (typeCode >= 80 && typeCode <= 89) return 'tanker';
  if (typeCode >= 60 && typeCode <= 69) return 'passenger';
  if (typeCode >= 50 && typeCode <= 59) return 'tug';
  if (typeCode === 31 || typeCode === 32) return 'tug';
  if (typeCode === 30) return 'fishing';
  if (typeCode === 36 || typeCode === 37) return 'sailing';
  if (typeCode === 35) return 'military';
  if (typeCode >= 40 && typeCode <= 49) return 'highspeed';
  return 'default';
}

function cleanShipName(name) {
  if (!name) return '';
  return name.replace(/@/g, '').trim();
}

function formatSpeed(sog) {
  if (sog === undefined || sog === null) return '—';
  return sog.toFixed(1) + ' kn';
}

function formatHeading(hdg) {
  if (hdg === undefined || hdg === null || hdg === 511) return '—';
  return Math.round(hdg) + '°';
}

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// ── Dead reckoning ──
const KNOTS_TO_DEG_PER_MS = 1.852 / (3600 * 1000 * 111320); // rough: 1 knot in deg-lat per ms

function extrapolatePosition(lat, lon, cogDeg, sogKnots, elapsedMs) {
  if (!sogKnots || sogKnots < 0.2) return { lat, lon }; // stationary
  const cogRad = cogDeg * Math.PI / 180;
  const distDeg = sogKnots * KNOTS_TO_DEG_PER_MS * elapsedMs;
  const dLat = distDeg * Math.cos(cogRad);
  const dLon = distDeg * Math.sin(cogRad) / Math.cos(lat * Math.PI / 180);
  return { lat: lat + dLat, lon: lon + dLon };
}

// ── Ship Tracker ──
class ShipTracker {
  constructor() {
    this.map = null;
    this.tileLayer = null;
    this.ships = new Map();    // MMSI → ship data object
    this.markers = new Map();  // MMSI → Leaflet marker
    this.ws = null;
    this.reconnectDelay = CONFIG.RECONNECT_BASE_MS;
    this.reconnectTimer = null;
    this.shouldReconnect = true;
    this._socketGen = 0;
    this.showLabels = false;

    // Theme: restore from localStorage or default to 'dark'
    const savedTheme = localStorage.getItem('map_theme') || 'dark';
    this.themeIndex = Math.max(0, THEMES.findIndex(t => t.id === savedTheme));

    this.apiKey = localStorage.getItem('aisstream_api_key') || '';

    this.initMap();
    this.initUI();

    // Always connect to the local server — it manages the AIS connection.
    // The server will tell us if it needs an API key.
    this.connect();

    this.startCleanupLoop();
    this.startStatsLoop();
    this.startInterpolationLoop();
  }

  // ── Map setup ──
  initMap() {
    this.map = L.map('map', {
      center: CONFIG.MAP_CENTER,
      zoom: CONFIG.MAP_ZOOM,
      zoomControl: false,
      attributionControl: false,
    });

    this.applyTheme();

    // Toggle ship name labels based on zoom
    this.map.on('zoomend', () => this.updateLabelVisibility());
  }

  // ── Theme management ──
  get currentTheme() {
    return THEMES[this.themeIndex];
  }

  applyTheme() {
    const theme = this.currentTheme;

    if (this.tileLayer) {
      this.map.removeLayer(this.tileLayer);
    }
    this.tileLayer = L.tileLayer(theme.url, theme.options).addTo(this.map);

    // Update toggle button label
    document.getElementById('theme-icon').textContent = theme.icon;
    document.getElementById('theme-name').textContent = theme.name;

    localStorage.setItem('map_theme', theme.id);

    // Re-render all markers with the right stroke color for this theme
    this.refreshAllMarkers();
  }

  cycleTheme() {
    this.themeIndex = (this.themeIndex + 1) % THEMES.length;
    this.applyTheme();
  }

  refreshAllMarkers() {
    this.ships.forEach((ship) => {
      if (ship.lat !== null && this.markers.has(ship.mmsi)) {
        const heading = this.getDisplayHeading(ship);
        const color = SHIP_COLORS[ship.category] || SHIP_COLORS.default;
        const isMoored = ship.navStatus === 1 || ship.navStatus === 5;
        const icon = this.createShipIcon(heading, color, isMoored, ship.category);
        this.markers.get(ship.mmsi).setIcon(icon);
      }
    });
  }

  // ── UI wiring ──
  initUI() {
    // API key modal
    const submitBtn = document.getElementById('api-key-submit');
    const input = document.getElementById('api-key-input');

    submitBtn.addEventListener('click', () => this.submitApiKey());
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.submitApiKey();
    });

    // Theme toggle
    document.getElementById('theme-toggle').addEventListener('click', () => this.cycleTheme());

    // Settings button to re-enter API key
    const settingsBtn = document.createElement('button');
    settingsBtn.id = 'settings-btn';
    settingsBtn.innerHTML = '&#9881;';
    settingsBtn.title = 'Change API key';
    settingsBtn.addEventListener('click', () => this.showApiKeyModal());
    document.body.appendChild(settingsBtn);
  }

  submitApiKey() {
    const input = document.getElementById('api-key-input');
    const key = input.value.trim();
    if (!key) return;

    this.apiKey = key;
    this.shouldReconnect = true;
    localStorage.setItem('aisstream_api_key', key);
    this.hideApiKeyModal();
    this.connect();
  }

  showApiKeyModal() {
    const modal = document.getElementById('api-key-modal');
    modal.classList.remove('hidden');
    const input = document.getElementById('api-key-input');
    input.value = this.apiKey;
    setTimeout(() => input.focus(), 100);
  }

  hideApiKeyModal() {
    document.getElementById('api-key-modal').classList.add('hidden');
  }

  // ── WebSocket connection ──
  connect() {
    // Guard: if already mid-handshake, don't stomp on it
    if (this.ws && this.ws.readyState === WebSocket.CONNECTING) {
      console.log('[ws] Already connecting, skipping duplicate call');
      return;
    }

    this.stopReconnecting();
    this.destroySocket();

    this.setStatus('connecting', 'Connecting...');
    console.log('[ws] Connecting to', CONFIG.WS_URL);

    const ws = new WebSocket(CONFIG.WS_URL);
    this.ws = ws;

    // Tag this socket so stale callbacks can't fire on a replaced instance
    const socketId = ++this._socketGen;

    ws.onopen = () => {
      if (socketId !== this._socketGen) return;
      console.log('[ws] Connected to server');
      this.reconnectDelay = CONFIG.RECONNECT_BASE_MS;
      this.setStatus('connecting', 'Waiting for AIS data...');
    };

    let msgCount = 0;
    ws.onmessage = (event) => {
      if (socketId !== this._socketGen) return;
      msgCount++;
      if (msgCount <= 5) console.log('[ws] msg #' + msgCount, event.data.substring(0, 100));
      try {
        const data = JSON.parse(event.data);
        if (data._status) {
          if (data._status === 'connected') {
            this.setStatus('connected', 'Live');
          } else if (data._status === 'need_key') {
            this.setStatus('disconnected', 'Need API key');
            this.showApiKeyModal();
          } else if (data._status === 'ais_down') {
            this.setStatus('disconnected', 'AISstream.io is down');
          } else if (data._status === 'connecting') {
            this.setStatus('connecting', 'Connecting to AIS...');
          }
          return;
        }
        if (data.ERROR || data.error) {
          const msg = data.ERROR || data.error;
          console.error('[ws] Server error:', msg);
          this.setStatus('disconnected', msg);
          if (typeof msg === 'string' && msg.toLowerCase().includes('key')) {
            this.shouldReconnect = false;
            this.showApiKeyModal();
          }
          return;
        }
        this.setStatus('connected', 'Live');
        this.handleMessage(data);
      } catch (err) {
        console.error('[ws] Message handling error:', err);
      }
    };

    ws.onclose = (event) => {
      if (socketId !== this._socketGen) return;
      console.log('[ws] Closed:', event.code, event.reason || '');
      if (!this.shouldReconnect) return;
      this.setStatus('disconnected', 'Disconnected');
      this.scheduleReconnect();
    };

    ws.onerror = (err) => {
      if (socketId !== this._socketGen) return;
      console.error('[ws] Error:', err);
    };
  }

  destroySocket() {
    if (!this.ws) return;
    this.ws.onopen = null;
    this.ws.onmessage = null;
    this.ws.onerror = null;
    this.ws.onclose = null;
    try { this.ws.close(); } catch (e) {}
    this.ws = null;
  }

  stopReconnecting() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  scheduleReconnect() {
    this.stopReconnecting();

    this.setStatus('connecting', `Reconnecting in ${Math.round(this.reconnectDelay / 1000)}s...`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelay);

    // Exponential backoff
    this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, CONFIG.RECONNECT_MAX_MS);
  }

  setStatus(state, text) {
    const dot = document.getElementById('status-dot');
    const label = document.getElementById('status-text');
    dot.className = state === 'connected' ? 'connected' : state === 'connecting' ? 'connecting' : '';
    label.textContent = text;
  }

  // ── AIS Message handling ──
  handleMessage(data) {
    const mmsi = data.MetaData?.MMSI;
    if (!mmsi) return;

    const shipName = cleanShipName(data.MetaData.ShipName);

    // Get or create ship record
    if (!this.ships.has(mmsi)) {
      this.ships.set(mmsi, {
        mmsi,
        name: shipName || '',
        category: 'default',
        lat: null,
        lon: null,
        cog: null,
        heading: null,
        speed: null,
        navStatus: null,
        destination: '',
        shipType: null,
        callSign: '',
        imo: null,
        length: null,
        lastUpdate: Date.now(),
      });
    }

    const ship = this.ships.get(mmsi);
    ship.lastUpdate = Date.now();
    if (shipName) ship.name = shipName;

    if (data.MessageType === 'PositionReport') {
      this.handlePositionReport(ship, data.Message.PositionReport);
    } else if (data.MessageType === 'ShipStaticData') {
      this.handleStaticData(ship, data.Message.ShipStaticData);
    }
  }

  handlePositionReport(ship, report) {
    if (!report) return;

    // Store the confirmed AIS position as the dead-reckoning anchor
    ship.anchorLat = report.Latitude;
    ship.anchorLon = report.Longitude;
    ship.anchorTime = Date.now();
    ship.cog = report.Cog;
    ship.speed = report.Sog;
    ship.navStatus = report.NavigationalStatus;

    if (report.TrueHeading !== undefined && report.TrueHeading !== 511) {
      ship.heading = report.TrueHeading;
    }

    // Set display position (interpolation loop will take over from here)
    ship.lat = report.Latitude;
    ship.lon = report.Longitude;

    this.updateMarker(ship);
  }

  handleStaticData(ship, staticData) {
    if (!staticData) return;

    if (staticData.Type !== undefined) {
      ship.shipType = staticData.Type;
      ship.category = getShipCategory(staticData.Type);
    }
    if (staticData.Destination) {
      ship.destination = cleanShipName(staticData.Destination);
    }
    if (staticData.CallSign) {
      ship.callSign = cleanShipName(staticData.CallSign);
    }
    if (staticData.ImoNumber) {
      ship.imo = staticData.ImoNumber;
    }
    if (staticData.Name) {
      ship.name = cleanShipName(staticData.Name);
    }
    if (staticData.Dimension) {
      const d = staticData.Dimension;
      ship.length = (d.A || 0) + (d.B || 0);
    }

    // Update marker appearance if it exists (category/color may have changed)
    if (ship.lat !== null) {
      this.updateMarker(ship);
    }
  }

  // ── Markers ──
  updateMarker(ship) {
    if (ship.lat === null || ship.lon === null) return;

    const heading = this.getDisplayHeading(ship);
    const color = SHIP_COLORS[ship.category] || SHIP_COLORS.default;
    const isMoored = ship.navStatus === 1 || ship.navStatus === 5;
    const icon = this.createShipIcon(heading, color, isMoored, ship.category);

    if (this.markers.has(ship.mmsi)) {
      const marker = this.markers.get(ship.mmsi);
      marker.setLatLng([ship.lat, ship.lon]);
      marker.setIcon(icon);

      // Update tooltip text
      if (ship.name) {
        marker.setTooltipContent(ship.name);
      }

      // Update popup content
      marker.setPopupContent(this.buildPopupHTML(ship));

      // Flash the marker
      const el = marker.getElement();
      if (el) {
        el.classList.remove('ship-updated');
        void el.offsetWidth; // trigger reflow
        el.classList.add('ship-updated');
      }
    } else {
      const marker = L.marker([ship.lat, ship.lon], { icon })
        .addTo(this.map);

      // Popup on click
      marker.bindPopup(this.buildPopupHTML(ship), {
        maxWidth: 260,
        className: '',
      });

      // Permanent tooltip for ship name
      if (ship.name) {
        marker.bindTooltip(ship.name, {
          permanent: true,
          direction: 'bottom',
          className: 'ship-label',
          offset: [0, 8],
        });
      }

      this.markers.set(ship.mmsi, marker);

      // Respect current zoom for label visibility
      this.updateSingleLabelVisibility(marker);
    }
  }

  getDisplayHeading(ship) {
    if (ship.heading !== null && ship.heading !== undefined && ship.heading !== 511) {
      return ship.heading;
    }
    if (ship.cog !== null && ship.cog !== undefined && ship.cog < 360) {
      return ship.cog;
    }
    return 0;
  }

  createShipIcon(heading, color, isMoored, category) {
    const size = SHIP_MARKER_SIZES[category] || 24;
    const stroke = this.currentTheme.strokeColor;
    const glow = hexToRgba(color, 0.4);

    const path = SHIP_SHAPES[category] || SHIP_SHAPES.default;

    if (isMoored) {
      const svg = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
        <path d="${path}" fill="${color}" fill-opacity="0.15" stroke="${color}" stroke-width="1.25" stroke-opacity="0.6"/>
      </svg>`;

      return L.divIcon({
        html: `<div class="ship-marker-inner" style="transform:rotate(${heading}deg);width:${size}px;height:${size}px;--glow:${hexToRgba(color, 0.2)};">${svg}</div>`,
        iconSize: [size, size],
        iconAnchor: [size / 2, size / 2],
        className: 'ship-icon ship-moored',
      });
    }

    const svg = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <path d="${path}" fill="${color}" stroke="${stroke}" stroke-width="0.75"/>
    </svg>`;

    return L.divIcon({
      html: `<div class="ship-marker-inner" style="transform:rotate(${heading}deg);width:${size}px;height:${size}px;--glow:${glow};">${svg}</div>`,
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
      className: 'ship-icon',
    });
  }

  buildPopupHTML(ship) {
    const color = SHIP_COLORS[ship.category] || SHIP_COLORS.default;
    const typeLabel = SHIP_TYPE_LABELS[ship.category] || 'Vessel';
    const name = ship.name || 'Unknown Vessel';

    let rows = '';

    if (ship.mmsi) {
      rows += `<div class="popup-row"><span class="popup-label">MMSI</span><span class="popup-value">${ship.mmsi}</span></div>`;
    }
    if (ship.imo) {
      rows += `<div class="popup-row"><span class="popup-label">IMO</span><span class="popup-value">${ship.imo}</span></div>`;
    }
    if (ship.callSign) {
      rows += `<div class="popup-row"><span class="popup-label">Call Sign</span><span class="popup-value">${ship.callSign}</span></div>`;
    }
    rows += `<div class="popup-row"><span class="popup-label">Speed</span><span class="popup-value">${formatSpeed(ship.speed)}</span></div>`;
    rows += `<div class="popup-row"><span class="popup-label">Heading</span><span class="popup-value">${formatHeading(ship.heading)}</span></div>`;
    if (ship.destination) {
      rows += `<div class="popup-row"><span class="popup-label">Destination</span><span class="popup-value">${ship.destination}</span></div>`;
    }
    if (ship.length) {
      rows += `<div class="popup-row"><span class="popup-label">Length</span><span class="popup-value">${ship.length}m</span></div>`;
    }

    return `
      <div class="popup-name">${name}</div>
      <span class="popup-type" style="background:${color};color:#fff;">${typeLabel}</span>
      ${rows}
    `;
  }

  // ── Label visibility ──
  updateLabelVisibility() {
    const zoom = this.map.getZoom();
    const show = zoom >= CONFIG.LABEL_ZOOM_THRESHOLD;
    if (show === this.showLabels) return;
    this.showLabels = show;

    this.markers.forEach((marker) => {
      if (marker.getTooltip()) {
        if (show) marker.openTooltip();
        else marker.closeTooltip();
      }
    });
  }

  updateSingleLabelVisibility(marker) {
    if (!marker.getTooltip()) return;
    if (this.map.getZoom() >= CONFIG.LABEL_ZOOM_THRESHOLD) {
      marker.openTooltip();
    } else {
      marker.closeTooltip();
    }
  }

  // ── Dead-reckoning interpolation ──
  startInterpolationLoop() {
    const tick = () => {
      const now = Date.now();
      this.ships.forEach((ship) => {
        if (ship.anchorLat === undefined || !ship.speed || ship.speed < 0.2) return;

        const elapsed = now - ship.anchorTime;
        // Don't extrapolate beyond 2 minutes — data is too stale
        if (elapsed > 120000) return;

        const cog = (ship.heading !== null && ship.heading !== undefined && ship.heading !== 511)
          ? ship.heading : ship.cog;
        if (cog === null || cog === undefined) return;

        const pos = extrapolatePosition(ship.anchorLat, ship.anchorLon, cog, ship.speed, elapsed);
        ship.lat = pos.lat;
        ship.lon = pos.lon;

        const marker = this.markers.get(ship.mmsi);
        if (marker) {
          marker.setLatLng([pos.lat, pos.lon]);
        }
      });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  // ── Stale ship cleanup ──
  startCleanupLoop() {
    setInterval(() => this.removeStaleShips(), CONFIG.CLEANUP_INTERVAL_MS);
  }

  removeStaleShips() {
    const now = Date.now();
    const stale = [];

    this.ships.forEach((ship, mmsi) => {
      if (now - ship.lastUpdate > CONFIG.STALE_TIMEOUT_MS) {
        stale.push(mmsi);
      }
    });

    stale.forEach((mmsi) => {
      this.ships.delete(mmsi);
      const marker = this.markers.get(mmsi);
      if (marker) {
        this.map.removeLayer(marker);
        this.markers.delete(mmsi);
      }
    });
  }

  // ── Stats display ──
  startStatsLoop() {
    setInterval(() => this.updateStats(), CONFIG.STATS_INTERVAL_MS);
  }

  updateStats() {
    document.getElementById('vessel-count').textContent = this.ships.size;
  }
}

// ── Boot ──
document.addEventListener('DOMContentLoaded', () => {
  new ShipTracker();
});
