/* ═══════════════════════════════════════════════════════════════════════════
   DUNGEON FRONT — client game.js
   Phaser 3.60 + Socket.io
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

// ── Global state ─────────────────────────────────────────────────────────────
let socket;
let myId = null;
let localPlayer = null;   // mirror of our entry in gameState.players

let gameState = {
  players: [],
  monsters: [],
  territories: [],
  projectiles: [],
};

let damageNumbers = [];   // { x, y, amount, alpha, vy, id, isMonster }
let notifications = [];   // { el, timer }
let respawnCountdown = 0;
let respawnTimer = null;

// ── Faction / class colours ──────────────────────────────────────────────────
const FACTION_COLOR = {
  order:  0x2255cc,
  chaos:  0xcc2222,
  nature: 0x22aa44,
};
const FACTION_CSS = {
  order:  '#6688ff',
  chaos:  '#ff6666',
  nature: '#66dd88',
};
const FACTION_NAME_CSS = {
  order:  '#2255cc',
  chaos:  '#cc2222',
  nature: '#22aa44',
};
const CLASS_ICON = { warrior: '⚔️', mage: '🔮', ranger: '🏹' };

// ── Territory definitions (must match server) ────────────────────────────────
const TERRITORY_DEFS = [
  { id: 'order_hq',       name: 'Order Keep',     x: 400,  y: 1500, w: 700,  h: 600 },
  { id: 'chaos_hq',       name: 'Chaos Fortress', x: 3600, y: 1500, w: 700,  h: 600 },
  { id: 'nature_hq',      name: 'Nature Grove',   x: 2000, y: 400,  w: 700,  h: 500 },
  { id: 'west_plains',    name: 'Western Plains', x: 1100, y: 1500, w: 600,  h: 500 },
  { id: 'east_valley',    name: 'Eastern Valley', x: 2900, y: 1500, w: 600,  h: 500 },
  { id: 'north_ruins',    name: 'Northern Ruins', x: 2000, y: 1050, w: 600,  h: 500 },
  { id: 'center_dungeon', name: 'Dark Dungeon',   x: 2000, y: 1500, w: 700,  h: 700 },
  { id: 'sw_forest',      name: 'Shadow Forest',  x: 1100, y: 2200, w: 600,  h: 500 },
  { id: 'se_canyon',      name: 'Fire Canyon',    x: 2900, y: 2200, w: 600,  h: 500 },
];

// ── Road connections ──────────────────────────────────────────────────────────
const ROADS = [
  ['order_hq', 'west_plains'],
  ['west_plains', 'center_dungeon'],
  ['center_dungeon', 'east_valley'],
  ['east_valley', 'chaos_hq'],
  ['nature_hq', 'north_ruins'],
  ['north_ruins', 'center_dungeon'],
  ['center_dungeon', 'sw_forest'],
  ['center_dungeon', 'se_canyon'],
  ['west_plains', 'sw_forest'],
  ['east_valley', 'se_canyon'],
];

const TERR_BY_ID = {};
for (const t of TERRITORY_DEFS) TERR_BY_ID[t.id] = t;

// ── Lobby UI setup ────────────────────────────────────────────────────────────
let selectedFaction = null;
let selectedClass   = null;

document.querySelectorAll('.faction-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.faction-btn').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    selectedFaction = btn.dataset.faction;
    updateEnterButton();
  });
});

document.querySelectorAll('.class-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.class-btn').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    selectedClass = btn.dataset.class;
    updateEnterButton();
  });
});

function updateEnterButton() {
  const name = document.getElementById('playerName').value.trim();
  const ok = selectedFaction && selectedClass && name.length > 0;
  document.getElementById('enterBattle').disabled = !ok;
}
document.getElementById('playerName').addEventListener('input', updateEnterButton);

document.getElementById('enterBattle').addEventListener('click', () => {
  const name = document.getElementById('playerName').value.trim() || 'Hero';
  if (!selectedFaction || !selectedClass) return;
  socket.emit('join_game', { name, faction: selectedFaction, class: selectedClass });
});

// ── Socket init ───────────────────────────────────────────────────────────────
function initSocket() {
  socket = io();

  socket.on('connect', () => {
    console.log('Connected:', socket.id);
    showNotification('Connected to Dungeon Front', '#aaaaff', 3000);
  });

  socket.on('disconnect', () => {
    showNotification('Disconnected from server', '#ff6666', 5000);
  });

  socket.on('joined', ({ id, player, mapWidth, mapHeight }) => {
    myId = id;
    localPlayer = { ...player };
    document.getElementById('lobby').classList.add('hidden');
    document.getElementById('hud').classList.remove('hidden');
    document.getElementById('playerInfo').classList.remove('hidden');
    updatePlayerInfoHUD();
    showNotification('Welcome to Dungeon Front!', '#ffdd88', 4000);
  });

  socket.on('game_state', (state) => {
    gameState = state;

    // Sync local player from server
    if (myId) {
      const serverMe = state.players.find(p => p.id === myId);
      if (serverMe) {
        if (!localPlayer) localPlayer = { ...serverMe };
        // Always sync HP and dead state from server
        localPlayer.hp   = serverMe.hp;
        localPlayer.maxHp = serverMe.maxHp;
        localPlayer.dead  = serverMe.dead;
        // Only sync position when dead (server is authoritative on respawn)
        if (serverMe.dead) {
          localPlayer.x = serverMe.x;
          localPlayer.y = serverMe.y;
        }
      }
    }

    // Process damage numbers from server
    if (state.damageNumbers && state.damageNumbers.length) {
      for (const dn of state.damageNumbers) {
        damageNumbers.push({
          x: dn.x, y: dn.y,
          amount: dn.amount,
          alpha: 1.0,
          vy: -40,
          id: dn.id,
        });
      }
    }

    updateFactionScores();
    updateMinimapCanvas();
    updatePlayerInfoHUD();
    updateTerritoryInfoHUD();

    // Update online count
    document.getElementById('onlineCount').textContent = state.players.length;
  });

  socket.on('you_died', ({ respawnIn }) => {
    respawnCountdown = respawnIn;
    document.getElementById('deathOverlay').classList.remove('hidden');
    updateRespawnText();
    if (respawnTimer) clearInterval(respawnTimer);
    respawnTimer = setInterval(() => {
      respawnCountdown--;
      updateRespawnText();
      if (respawnCountdown <= 0) {
        clearInterval(respawnTimer);
        respawnTimer = null;
      }
    }, 1000);
  });

  socket.on('respawned', ({ x, y }) => {
    if (localPlayer) { localPlayer.x = x; localPlayer.y = y; localPlayer.dead = false; localPlayer.hp = localPlayer.maxHp; }
    document.getElementById('deathOverlay').classList.add('hidden');
    if (respawnTimer) { clearInterval(respawnTimer); respawnTimer = null; }
  });

  socket.on('territory_captured', ({ name, faction, from }) => {
    const color = FACTION_CSS[faction] || '#ffffff';
    const fromStr = from ? ` from ${from.charAt(0).toUpperCase() + from.slice(1)}` : '';
    showNotification(`${faction.charAt(0).toUpperCase() + faction.slice(1)} captured ${name}${fromStr}!`, color, 4000);
  });
}

function updateRespawnText() {
  document.getElementById('respawnText').textContent =
    respawnCountdown > 0 ? `Respawning in ${respawnCountdown}...` : 'Respawning...';
}

// ── HUD helpers ───────────────────────────────────────────────────────────────
function updateFactionScores() {
  const scores = { order: 0, chaos: 0, nature: 0 };
  for (const t of gameState.territories) {
    if (t.owner && scores[t.owner] !== undefined) scores[t.owner]++;
  }
  document.getElementById('orderScore').textContent  = scores.order;
  document.getElementById('chaosScore').textContent  = scores.chaos;
  document.getElementById('natureScore').textContent = scores.nature;
}

function updatePlayerInfoHUD() {
  if (!localPlayer) return;
  const icon = CLASS_ICON[localPlayer.class] || '';
  document.getElementById('piIcon').textContent    = icon;
  document.getElementById('piName').textContent    = localPlayer.name;
  const pct = Math.max(0, Math.min(1, localPlayer.hp / localPlayer.maxHp));
  document.getElementById('piHpFill').style.width  = (pct * 100) + '%';
  document.getElementById('piHpText').textContent  = `${Math.max(0,localPlayer.hp)}/${localPlayer.maxHp}`;
  const fEl = document.getElementById('piFaction');
  fEl.textContent = localPlayer.faction ? localPlayer.faction.toUpperCase() : '';
  fEl.style.color = FACTION_CSS[localPlayer.faction] || '#ffffff';
}

function updateTerritoryInfoHUD() {
  if (!localPlayer || localPlayer.dead) {
    document.getElementById('territoryInfo').innerHTML = '';
    return;
  }
  // Find nearest territory
  let nearest = null, nearestDist = Infinity;
  for (const t of gameState.territories) {
    const dx = localPlayer.x - t.x, dy = localPlayer.y - t.y;
    const d = Math.sqrt(dx*dx + dy*dy);
    if (d < nearestDist) { nearestDist = d; nearest = t; }
  }
  if (!nearest) return;
  const onPoint = nearestDist <= 100;
  let html = `<div style="color:#ddccbb;font-weight:bold">${nearest.name}</div>`;
  const ownerColor = nearest.owner ? (FACTION_CSS[nearest.owner] || '#aaa') : '#888';
  html += `<div style="color:${ownerColor}">${nearest.owner ? nearest.owner.toUpperCase() : 'Unclaimed'}</div>`;
  if (onPoint && !nearest.isHQ) {
    if (nearest.contestedBy && nearest.contestedBy.length > 1) {
      html += `<div style="color:#ff8844">CONTESTED</div>`;
    } else if (nearest.capturingFaction) {
      const capColor = FACTION_CSS[nearest.capturingFaction] || '#fff';
      const pct = Math.round((nearest.captureProgress || 0) * 100);
      html += `<div style="color:${capColor}">Capturing... ${pct}%</div>`;
      html += `<div style="background:#333;height:4px;border-radius:2px;margin-top:3px">` +
              `<div style="background:${capColor};width:${pct}%;height:100%;border-radius:2px"></div></div>`;
    } else {
      html += `<div style="color:#aaffaa">Stand to capture</div>`;
    }
  }
  document.getElementById('territoryInfo').innerHTML = html;
}

// ── Minimap canvas ─────────────────────────────────────────────────────────────
const MINIMAP_W = 160, MINIMAP_H = 120;
const MAP_W = 4000, MAP_H = 3000;

const TERR_FILL_COLORS = {
  order_hq:       '#2244aa',
  chaos_hq:       '#aa2222',
  nature_hq:      '#226622',
  west_plains:    '#446622',
  east_valley:    '#6e3a1a',
  north_ruins:    '#555555',
  center_dungeon: '#111128',
  sw_forest:      '#1e4a1e',
  se_canyon:      '#5a2a0a',
};

function updateMinimapCanvas() {
  const canvas = document.getElementById('minimap');
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, MINIMAP_W, MINIMAP_H);

  function mx(x) { return x / MAP_W * MINIMAP_W; }
  function my(y) { return y / MAP_H * MINIMAP_H; }

  // Background
  ctx.fillStyle = '#080810';
  ctx.fillRect(0, 0, MINIMAP_W, MINIMAP_H);

  // Territory zones
  for (const td of TERRITORY_DEFS) {
    const fill = TERR_FILL_COLORS[td.id] || '#333333';
    ctx.fillStyle = fill;
    ctx.fillRect(mx(td.x - td.w/2), my(td.y - td.h/2), mx(td.w), my(td.h));
  }

  // Territory ownership overlay
  for (const t of gameState.territories) {
    const td = TERR_BY_ID[t.id];
    if (!td || !t.owner) continue;
    const color = t.owner === 'order' ? 'rgba(34,85,204,0.35)' :
                  t.owner === 'chaos' ? 'rgba(204,34,34,0.35)' :
                  'rgba(34,170,68,0.35)';
    ctx.fillStyle = color;
    ctx.fillRect(mx(td.x - td.w/2), my(td.y - td.h/2), mx(td.w), my(td.h));

    // Flag square
    const flagColor = t.owner === 'order' ? '#4466ff' :
                      t.owner === 'chaos' ? '#ff4444' : '#44cc66';
    ctx.fillStyle = flagColor;
    ctx.fillRect(mx(td.x) - 3, my(td.y) - 3, 6, 6);
  }

  // Player dots
  for (const p of gameState.players) {
    if (p.dead) continue;
    ctx.fillStyle = p.id === myId ? '#ffffff' : (FACTION_CSS[p.faction] || '#888888');
    const r = p.id === myId ? 3 : 2;
    ctx.beginPath();
    ctx.arc(mx(p.x), my(p.y), r, 0, Math.PI * 2);
    ctx.fill();
  }

  // Local player blink
  if (localPlayer && !localPlayer.dead) {
    const blink = Math.floor(Date.now() / 400) % 2 === 0;
    if (blink) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(mx(localPlayer.x), my(localPlayer.y), 4, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // Border
  ctx.strokeStyle = '#443355';
  ctx.lineWidth = 1;
  ctx.strokeRect(0, 0, MINIMAP_W, MINIMAP_H);
}

// ── Notifications ─────────────────────────────────────────────────────────────
function showNotification(text, color, duration) {
  const container = document.getElementById('notifications');
  const el = document.createElement('div');
  el.className = 'notification';
  el.textContent = text;
  el.style.color = color || '#ffffff';
  el.style.opacity = '1';
  container.appendChild(el);

  setTimeout(() => {
    el.style.opacity = '0';
    setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 350);
  }, duration - 350);
}

// ══════════════════════════════════════════════════════════════════════════════
// PHASER GAME
// ══════════════════════════════════════════════════════════════════════════════

class MainScene extends Phaser.Scene {
  constructor() {
    super({ key: 'MainScene' });
    this.worldGfx       = null;
    this.playerFollowTarget = null;
    this.keys           = {};
    this.attackCooldown = 0;
    this.lastSentX      = 0;
    this.lastSentY      = 0;
    this.lastMoveTime   = 0;
    this.nameTexts      = {};   // id → Phaser text (cleared each frame, using worldGfx for labels)
    this.vignetteGfx    = null;
  }

  preload() {}

  create() {
    const scene = this;

    // ── Draw static world texture ─────────────────────────────────────────────
    const worldDraw = this.add.graphics();
    this._drawWorld(worldDraw);
    worldDraw.generateTexture('world', MAP_W, MAP_H);
    worldDraw.destroy();

    this.add.image(MAP_W / 2, MAP_H / 2, 'world');

    // ── Dynamic graphics layer (entities) ────────────────────────────────────
    this.worldGfx = this.add.graphics();

    // ── Vignette (screen-space) ───────────────────────────────────────────────
    this.vignetteGfx = this.add.graphics();
    this.vignetteGfx.setScrollFactor(0);
    this.vignetteGfx.setDepth(10);

    // ── Camera ────────────────────────────────────────────────────────────────
    this.cameras.main.setBounds(0, 0, MAP_W, MAP_H);
    this.playerFollowTarget = this.add.rectangle(2000, 1500, 2, 2, 0x000000, 0);
    this.cameras.main.startFollow(this.playerFollowTarget, false, 0.08, 0.08);

    // ── Input ─────────────────────────────────────────────────────────────────
    this.keys = this.input.keyboard.addKeys({
      up:    Phaser.Input.Keyboard.KeyCodes.W,
      down:  Phaser.Input.Keyboard.KeyCodes.S,
      left:  Phaser.Input.Keyboard.KeyCodes.A,
      right: Phaser.Input.Keyboard.KeyCodes.D,
      upArr: Phaser.Input.Keyboard.KeyCodes.UP,
      downArr: Phaser.Input.Keyboard.KeyCodes.DOWN,
      leftArr: Phaser.Input.Keyboard.KeyCodes.LEFT,
      rightArr: Phaser.Input.Keyboard.KeyCodes.RIGHT,
    });

    this.input.on('pointerdown', (pointer) => {
      if (!myId || !localPlayer || localPlayer.dead) return;
      if (document.getElementById('lobby').classList.contains('hidden') === false) return;
      const wx = pointer.worldX;
      const wy = pointer.worldY;
      localPlayer.facing = Math.atan2(wy - localPlayer.y, wx - localPlayer.x);
      socket.emit('player_attack', { targetX: wx, targetY: wy });
    });

    // ── Vignette draw ─────────────────────────────────────────────────────────
    this._drawVignette();
  }

  _drawWorld(g) {
    const W = MAP_W, H = MAP_H;

    // Base ground
    g.fillStyle(0x1a2a1a);
    g.fillRect(0, 0, W, H);

    // Territory zones (background fill)
    const zones = [
      { id: 'order_hq',       x: 400,  y: 1500, w: 700,  h: 600,  fill: 0xb8987a },
      { id: 'chaos_hq',       x: 3600, y: 1500, w: 700,  h: 600,  fill: 0x2a1010 },
      { id: 'nature_hq',      x: 2000, y: 400,  w: 700,  h: 500,  fill: 0x2d6e2d },
      { id: 'west_plains',    x: 1100, y: 1500, w: 600,  h: 500,  fill: 0x5a8a3a },
      { id: 'east_valley',    x: 2900, y: 1500, w: 600,  h: 500,  fill: 0x6e3a1a },
      { id: 'north_ruins',    x: 2000, y: 1050, w: 600,  h: 500,  fill: 0x5a5a5a },
      { id: 'center_dungeon', x: 2000, y: 1500, w: 700,  h: 700,  fill: 0x1a1a2e },
      { id: 'sw_forest',      x: 1100, y: 2200, w: 600,  h: 500,  fill: 0x1e4a1e },
      { id: 'se_canyon',      x: 2900, y: 2200, w: 600,  h: 500,  fill: 0x5a2a0a },
    ];

    // Roads first (beneath zones)
    g.fillStyle(0x2a2318);
    const roadW = 80;
    for (const [aId, bId] of ROADS) {
      const a = TERR_BY_ID[aId], b = TERR_BY_ID[bId];
      if (!a || !b) continue;
      const dx = b.x - a.x, dy = b.y - a.y;
      const len = Math.sqrt(dx*dx + dy*dy);
      const nx = -dy/len * roadW/2, ny = dx/len * roadW/2;
      g.fillPoints([
        { x: a.x + nx, y: a.y + ny },
        { x: b.x + nx, y: b.y + ny },
        { x: b.x - nx, y: b.y - ny },
        { x: a.x - nx, y: a.y - ny },
      ], true);
    }

    // Zone fills
    for (const z of zones) {
      g.fillStyle(z.fill);
      g.fillRect(z.x - z.w/2, z.y - z.h/2, z.w, z.h);
    }

    // Zone borders with faction default color hints
    const borderColors = {
      order_hq:       0x2255cc,
      chaos_hq:       0xcc2222,
      nature_hq:      0x22aa44,
      west_plains:    0x4477cc,
      east_valley:    0xcc4422,
      north_ruins:    0x44aa66,
      center_dungeon: 0x553377,
      sw_forest:      0x336633,
      se_canyon:      0x885522,
    };

    for (const z of zones) {
      const bc = borderColors[z.id] || 0x555555;
      g.lineStyle(3, bc, 0.7);
      g.strokeRect(z.x - z.w/2, z.y - z.h/2, z.w, z.h);
    }

    // Territory name labels
    const labelColors = {
      order_hq:       '#c8d8ff',
      chaos_hq:       '#ffcccc',
      nature_hq:      '#ccffdd',
      west_plains:    '#ddffcc',
      east_valley:    '#ffddcc',
      north_ruins:    '#dddddd',
      center_dungeon: '#bbaaff',
      sw_forest:      '#aaffcc',
      se_canyon:      '#ffccaa',
    };
    // Note: text is drawn with Phaser text objects in the update loop
  }

  _drawVignette() {
    const W = this.scale.width, H = this.scale.height;
    this.vignetteGfx.clear();
    // Radial fade from edges
    for (let i = 0; i < 16; i++) {
      const alpha = (i / 16) * 0.35;
      const inset = i * 14;
      this.vignetteGfx.fillStyle(0x000000, alpha * (1 - i/16));
      this.vignetteGfx.fillRect(0, 0, inset, H);
      this.vignetteGfx.fillRect(W - inset, 0, inset, H);
      this.vignetteGfx.fillRect(inset, 0, W - inset*2, inset);
      this.vignetteGfx.fillRect(inset, H - inset, W - inset*2, inset);
    }
  }

  update(time, delta) {
    const dt = delta / 1000;

    // ── Input / movement ──────────────────────────────────────────────────────
    if (myId && localPlayer && !localPlayer.dead) {
      const speed = this._getLocalSpeed();
      let dx = 0, dy = 0;

      if (this.keys.left.isDown  || this.keys.leftArr.isDown)  dx -= 1;
      if (this.keys.right.isDown || this.keys.rightArr.isDown) dx += 1;
      if (this.keys.up.isDown    || this.keys.upArr.isDown)    dy -= 1;
      if (this.keys.down.isDown  || this.keys.downArr.isDown)  dy += 1;

      if (dx !== 0 || dy !== 0) {
        const mag = Math.sqrt(dx*dx + dy*dy);
        localPlayer.x = Math.max(0, Math.min(MAP_W, localPlayer.x + (dx/mag) * speed * dt));
        localPlayer.y = Math.max(0, Math.min(MAP_H, localPlayer.y + (dy/mag) * speed * dt));
        localPlayer.facing = Math.atan2(dy, dx);
      }

      // Send position to server at ~20 TPS max
      const now = Date.now();
      if (now - this.lastMoveTime > 50 &&
          (Math.abs(localPlayer.x - this.lastSentX) > 1 || Math.abs(localPlayer.y - this.lastSentY) > 1)) {
        socket.emit('player_move', { x: localPlayer.x, y: localPlayer.y, facing: localPlayer.facing });
        this.lastSentX = localPlayer.x;
        this.lastSentY = localPlayer.y;
        this.lastMoveTime = now;
      }

      // Update camera follow target
      this.playerFollowTarget.x = localPlayer.x;
      this.playerFollowTarget.y = localPlayer.y;
    }

    // ── Render all entities ───────────────────────────────────────────────────
    const g = this.worldGfx;
    g.clear();

    this._renderTerritories(g);
    this._renderMonsters(g);
    this._renderProjectiles(g);
    this._renderPlayers(g);
    this._renderDamageNumbers(g, dt);
  }

  _getLocalSpeed() {
    if (!localPlayer) return 160;
    const cls = localPlayer.class;
    return cls === 'warrior' ? 160 : cls === 'mage' ? 190 : 210;
  }

  // ── Territory rendering ────────────────────────────────────────────────────
  _renderTerritories(g) {
    const now = Date.now();

    for (const t of gameState.territories) {
      const td = TERR_BY_ID[t.id];
      if (!td) continue;

      const ownerColor = t.owner ? FACTION_COLOR[t.owner] : 0x666666;

      // Dashed capture circle
      const segments = 24;
      const R = 100;
      g.lineStyle(2, ownerColor, 0.6);
      for (let i = 0; i < segments; i++) {
        if (i % 2 === 0) {
          const a1 = (i / segments) * Math.PI * 2;
          const a2 = ((i + 0.8) / segments) * Math.PI * 2;
          g.beginPath();
          g.arc(t.x, t.y, R, a1, a2);
          g.strokePath();
        }
      }

      // Capture progress arc
      if (t.capturingFaction && t.captureProgress > 0) {
        const capColor = FACTION_COLOR[t.capturingFaction] || 0xffffff;
        g.lineStyle(5, capColor, 0.8);
        g.beginPath();
        g.arc(t.x, t.y, R - 6, -Math.PI / 2, -Math.PI / 2 + t.captureProgress * Math.PI * 2);
        g.strokePath();
      }

      // Contested: flashing red/white ring
      if (t.contestedBy && t.contestedBy.length > 1) {
        const flash = Math.floor(now / 300) % 2 === 0;
        g.lineStyle(3, flash ? 0xff3333 : 0xffffff, 0.9);
        g.beginPath();
        g.arc(t.x, t.y, R + 4, 0, Math.PI * 2);
        g.strokePath();
      }

      // Flag/banner at center
      const flagColor = t.owner ? FACTION_COLOR[t.owner] : 0x666666;
      g.fillStyle(flagColor, 0.85);
      g.fillRect(t.x - 3, t.y - 6, 6, 12);
      // Pole
      g.fillStyle(0x888888, 0.9);
      g.fillRect(t.x - 1, t.y - 10, 2, 20);
    }
  }

  // ── Monster rendering ──────────────────────────────────────────────────────
  _renderMonsters(g) {
    for (const mon of gameState.monsters) {
      const alpha = mon.aggro ? 1.0 : 0.85;

      if (mon.type === 'goblin') {
        // Green diamond
        g.fillStyle(mon.aggro ? 0xff4422 : 0x44bb44, alpha);
        g.beginPath();
        g.moveTo(mon.x, mon.y - 12);
        g.lineTo(mon.x + 10, mon.y);
        g.lineTo(mon.x, mon.y + 12);
        g.lineTo(mon.x - 10, mon.y);
        g.closePath();
        g.fillPath();
        g.lineStyle(1, 0x227722, 0.8);
        g.strokePath();
      } else if (mon.type === 'orc') {
        // Orange rectangle
        g.fillStyle(mon.aggro ? 0xff3311 : 0xcc6622, alpha);
        g.fillRect(mon.x - 10, mon.y - 11, 20, 22);
        g.lineStyle(1, 0x884411, 0.8);
        g.strokeRect(mon.x - 10, mon.y - 11, 20, 22);
      } else if (mon.type === 'skeleton') {
        // White X
        const sc = 14;
        g.lineStyle(3, mon.aggro ? 0xff8888 : 0xeeeeee, alpha);
        g.beginPath();
        g.moveTo(mon.x - sc/2, mon.y - sc/2);
        g.lineTo(mon.x + sc/2, mon.y + sc/2);
        g.strokePath();
        g.beginPath();
        g.moveTo(mon.x + sc/2, mon.y - sc/2);
        g.lineTo(mon.x - sc/2, mon.y + sc/2);
        g.strokePath();
      }

      // HP bar
      const barW = 28, barH = 4;
      const hpPct = Math.max(0, mon.hp / mon.maxHp);
      g.fillStyle(0x330000, 0.9);
      g.fillRect(mon.x - barW/2, mon.y - 22, barW, barH);
      g.fillStyle(0xdd3333, 0.9);
      g.fillRect(mon.x - barW/2, mon.y - 22, barW * hpPct, barH);
    }
  }

  // ── Projectile rendering ───────────────────────────────────────────────────
  _renderProjectiles(g) {
    for (const proj of gameState.projectiles) {
      if (proj.type === 'magic') {
        // Glowing purple circle
        g.fillStyle(0xcc44ff, 0.35);
        g.beginPath();
        g.arc(proj.x, proj.y, 14, 0, Math.PI * 2);
        g.fillPath();
        g.fillStyle(0xdd66ff, 0.9);
        g.beginPath();
        g.arc(proj.x, proj.y, 7, 0, Math.PI * 2);
        g.fillPath();
        g.fillStyle(0xffffff, 0.95);
        g.beginPath();
        g.arc(proj.x, proj.y, 3, 0, Math.PI * 2);
        g.fillPath();
      } else if (proj.type === 'arrow') {
        // Arrow line
        const spd = Math.sqrt((proj.vx||1)**2 + (proj.vy||0)**2) || 1;
        const nx = (proj.vx||1) / spd;
        const ny = (proj.vy||0) / spd;
        const len = 14;
        g.lineStyle(2, 0xaa7733, 1.0);
        g.beginPath();
        g.moveTo(proj.x - nx * len/2, proj.y - ny * len/2);
        g.lineTo(proj.x + nx * len/2, proj.y + ny * len/2);
        g.strokePath();
        // Arrow head
        g.fillStyle(0x886622, 1.0);
        g.fillTriangle(
          proj.x + nx * len/2,              proj.y + ny * len/2,
          proj.x + nx * (len/2 - 5) - ny*3, proj.y + ny * (len/2 - 5) + nx*3,
          proj.x + nx * (len/2 - 5) + ny*3, proj.y + ny * (len/2 - 5) - nx*3
        );
      }
    }
  }

  // ── Player rendering ───────────────────────────────────────────────────────
  _renderPlayers(g) {
    // Merge server state with local prediction
    const allPlayers = gameState.players.map(p => {
      if (p.id === myId && localPlayer && !localPlayer.dead) {
        return { ...p, x: localPlayer.x, y: localPlayer.y, hp: localPlayer.hp, dead: localPlayer.dead };
      }
      return p;
    });

    for (const p of allPlayers) {
      const isLocal = (p.id === myId);
      const alpha   = p.dead ? 0.3 : 1.0;
      const fcolor  = p.dead ? 0xdddddd : (FACTION_COLOR[p.faction] || 0x888888);
      const R       = 18;

      // Glow for mage
      if (p.class === 'mage' && !p.dead) {
        g.fillStyle(fcolor, 0.18);
        g.beginPath();
        g.arc(p.x, p.y, R + 10, 0, Math.PI * 2);
        g.fillPath();
      }

      // White outline
      g.fillStyle(0xffffff, p.dead ? 0.15 : 0.5);
      g.beginPath();
      g.arc(p.x, p.y, R + 1.5, 0, Math.PI * 2);
      g.fillPath();

      // Body circle
      g.fillStyle(fcolor, alpha);
      g.beginPath();
      g.arc(p.x, p.y, R, 0, Math.PI * 2);
      g.fillPath();

      // Local player yellow ring
      if (isLocal) {
        const blink = Math.floor(Date.now() / 600) % 2 === 0;
        g.lineStyle(2.5, blink ? 0xffee00 : 0xffcc00, 0.9);
        g.beginPath();
        g.arc(p.x, p.y, R + 5, 0, Math.PI * 2);
        g.strokePath();
      }

      // Class-specific detail
      if (!p.dead) {
        const f = p.facing || 0;
        const cos = Math.cos(f), sin = Math.sin(f);
        this._drawClassDetail(g, p, cos, sin, fcolor);
      }

      // HP bar
      const barW = 30, barH = 4;
      const hpPct = Math.max(0, Math.min(1, p.hp / p.maxHp));
      g.fillStyle(0x440000, 0.9);
      g.fillRect(p.x - barW/2, p.y - R - 14, barW, barH);
      g.fillStyle(hpPct > 0.5 ? 0x33cc33 : hpPct > 0.25 ? 0xccaa00 : 0xcc3300, 0.95);
      g.fillRect(p.x - barW/2, p.y - R - 14, barW * hpPct, barH);
    }
  }

  _drawClassDetail(g, p, cos, sin, fcolor) {
    const darkerColor = this._darkenColor(fcolor, 0.5);
    if (p.class === 'warrior') {
      // Sword (rectangle + triangle tip)
      g.fillStyle(0xccccdd, 1.0);
      // Blade: rotated rect
      const blen = 20, bwid = 4;
      const bx = p.x + cos * 10, by = p.y + sin * 10;
      g.fillPoints([
        { x: bx + cos*blen/2 - sin*bwid/2, y: by + sin*blen/2 + cos*bwid/2 },
        { x: bx + cos*blen/2 + sin*bwid/2, y: by + sin*blen/2 - cos*bwid/2 },
        { x: bx - cos*blen/2 + sin*bwid/2, y: by - sin*blen/2 - cos*bwid/2 },
        { x: bx - cos*blen/2 - sin*bwid/2, y: by - sin*blen/2 + cos*bwid/2 },
      ], true);
      // Guard
      g.fillStyle(0x887744, 1.0);
      const gx = p.x + cos * 6, gy = p.y + sin * 6;
      g.fillRect(gx - sin*7 - cos*2, gy + cos*7 - sin*2, 4, 14);

    } else if (p.class === 'mage') {
      // 4-pointed star
      g.fillStyle(0xeeccff, 1.0);
      const pts = [];
      for (let i = 0; i < 8; i++) {
        const angle = p.facing + (i * Math.PI / 4) - Math.PI/8;
        const r = i % 2 === 0 ? 14 : 5;
        pts.push({ x: p.x + Math.cos(angle) * r, y: p.y + Math.sin(angle) * r });
      }
      g.fillPoints(pts, true);
      // Center crystal
      g.fillStyle(0xffffff, 0.9);
      g.beginPath();
      g.arc(p.x, p.y, 4, 0, Math.PI * 2);
      g.fillPath();

    } else if (p.class === 'ranger') {
      // Bow arc
      g.lineStyle(2.5, 0x886633, 1.0);
      const bowR = 11, span = Math.PI * 0.7;
      const bAngle = p.facing;
      g.beginPath();
      g.arc(p.x + cos*4, p.y + sin*4, bowR, bAngle - span/2 + Math.PI, bAngle + span/2 + Math.PI);
      g.strokePath();
      // Arrow on bow
      g.lineStyle(1.5, 0xaa8855, 1.0);
      g.beginPath();
      g.moveTo(p.x - cos*6, p.y - sin*6);
      g.lineTo(p.x + cos*14, p.y + sin*14);
      g.strokePath();
    }

    // Attack flash
    if (p.attacking) {
      g.fillStyle(0xffffff, 0.45);
      g.beginPath();
      g.arc(p.x + cos * 20, p.y + sin * 20, 14, 0, Math.PI * 2);
      g.fillPath();
    }
  }

  _darkenColor(hex, factor) {
    const r = ((hex >> 16) & 0xff) * factor;
    const g = ((hex >> 8)  & 0xff) * factor;
    const b = (hex & 0xff) * factor;
    return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b);
  }

  // ── Damage numbers ─────────────────────────────────────────────────────────
  _renderDamageNumbers(g, dt) {
    const seen = new Set();
    damageNumbers = damageNumbers.filter(dn => {
      if (seen.has(dn.id)) return false;
      seen.add(dn.id);
      dn.y  += dn.vy * dt;
      dn.alpha -= dt / 1.5;
      return dn.alpha > 0;
    });

    // Use Phaser text for damage numbers is expensive; use Graphics + bitmap approach
    // Actually draw them as simple stroked rects... better: use the camera to render text
    // We'll use a separate text approach via a pooled set
    this._renderDamageTexts(dt);
  }

  _renderDamageTexts(dt) {
    // We handle text rendering by updating cached Phaser Text objects
    // Clean up old ones
    for (const [id, obj] of Object.entries(this._dmgTextPool || {})) {
      if (!damageNumbers.find(dn => dn.id === id)) {
        obj.destroy();
        delete this._dmgTextPool[id];
      }
    }
    if (!this._dmgTextPool) this._dmgTextPool = {};

    for (const dn of damageNumbers) {
      if (!this._dmgTextPool[dn.id]) {
        this._dmgTextPool[dn.id] = this.add.text(dn.x, dn.y, String(dn.amount), {
          fontSize: '14px',
          fontFamily: 'Georgia, serif',
          color: '#ffee44',
          stroke: '#000000',
          strokeThickness: 3,
          fontStyle: 'bold',
        }).setDepth(8);
      } else {
        const t = this._dmgTextPool[dn.id];
        t.x = dn.x;
        t.y = dn.y;
        t.setAlpha(Math.max(0, dn.alpha));
      }
    }
  }
}

// ── Territory name labels (drawn as Phaser text objects on world) ─────────────
// These are created once after scene is ready
function addTerritoryLabels(scene) {
  const labelStyle = {
    fontSize: '13px',
    fontFamily: 'Georgia, serif',
    color: '#ffffff',
    stroke: '#000000',
    strokeThickness: 3,
    alpha: 0.7,
  };
  for (const td of TERRITORY_DEFS) {
    scene.add.text(td.x, td.y + 20, td.name, labelStyle)
      .setOrigin(0.5, 0.5)
      .setDepth(2);
  }
}

// ── Phaser config + boot ──────────────────────────────────────────────────────
const phaserConfig = {
  type: Phaser.AUTO,
  width: window.innerWidth,
  height: window.innerHeight,
  backgroundColor: '#0d0d14',
  parent: 'game-container',
  scene: MainScene,
  scale: {
    mode: Phaser.Scale.RESIZE,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  callbacks: {
    postBoot(game) {
      const scene = game.scene.getScene('MainScene');
      // Wait for scene ready
      scene.events.once('create', () => {
        addTerritoryLabels(scene);
        scene._dmgTextPool = {};
      });
    }
  }
};

// ── Kickoff ──────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  initSocket();
  const game = new Phaser.Game(phaserConfig);

  window.addEventListener('resize', () => {
    game.scale.resize(window.innerWidth, window.innerHeight);
    const scene = game.scene.getScene('MainScene');
    if (scene && scene.vignetteGfx) scene._drawVignette();
  });

  // Minimap animation loop (outside Phaser)
  setInterval(updateMinimapCanvas, 200);
});
