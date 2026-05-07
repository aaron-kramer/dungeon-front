/* ═══════════════════════════════════════════════════════════════════════════
   DUNGEON FRONT — Three.js FPS client
   Three.js r134 (global THREE) + Socket.io
   ═══════════════════════════════════════════════════════════════════════════ */
'use strict';

// ── Global state ─────────────────────────────────────────────────────────────
let socket;
let myId = null;
let localPlayer = null;
let gameStarted = false;

let gameState = {
  players: [],
  monsters: [],
  territories: [],
  projectiles: [],
};

// ── Faction colours ───────────────────────────────────────────────────────────
const FACTION_HEX = {
  order:  0x2255cc,
  chaos:  0xcc2222,
  nature: 0x22aa44,
};
const FACTION_CSS = {
  order:  '#6688ff',
  chaos:  '#ff6666',
  nature: '#66dd88',
};
const CLASS_ICON = { warrior: '⚔️', mage: '🔮', ranger: '🏹' };

// ── Territory definitions (must match server) ────────────────────────────────
const TERRITORY_DEFS = [
  { id: 'order_hq',       name: 'Order Keep',       x: -800, z:  0,    isHQ: true  },
  { id: 'chaos_hq',       name: 'Chaos Fortress',   x:  800, z:  0,    isHQ: true  },
  { id: 'nature_hq',      name: 'Nature Grove',     x:    0, z: -850,  isHQ: true  },
  { id: 'west_plains',    name: 'Western Plains',   x: -500, z:  0,    isHQ: false },
  { id: 'east_valley',    name: 'Eastern Valley',   x:  500, z:  0,    isHQ: false },
  { id: 'north_ruins',    name: 'Northern Ruins',   x:    0, z: -350,  isHQ: false },
  { id: 'center_dungeon', name: 'Dark Dungeon',     x:    0, z:  0,    isHQ: false },
  { id: 'sw_forest',      name: 'Shadow Forest',    x: -500, z:  350,  isHQ: false },
  { id: 'se_canyon',      name: 'Fire Canyon',      x:  500, z:  350,  isHQ: false },
];
const TERR_BY_ID = {};
for (const t of TERRITORY_DEFS) TERR_BY_ID[t.id] = t;

// ── Minimap constants ──────────────────────────────────────────────────────────
const MM_SIZE = 180;
const WORLD_HALF = 1000;

// ── Movement state ─────────────────────────────────────────────────────────────
let yaw = 0;
let pitch = 0;
let moveForward = false, moveBack = false, moveLeft = false, moveRight = false;
let isPointerLocked = false;
let mouseSensitivity = 1.0;

// ── Three.js objects ───────────────────────────────────────────────────────────
let renderer, scene, camera, pivot;
let weaponScene, weaponCamera, weaponMesh, weaponBob = 0;
let weaponLurchTime = 0;

// Maps for remote entities
const playerMeshes  = {};  // id → THREE.Group
const monsterMeshes = {};  // id → THREE.Group
const projMeshes    = {};  // id → THREE.Mesh/Group
const terrPillars   = {};  // id → { pillar, light }

// Damage number DOM elements pool
const dmgElPool = [];
const activeDmgEls = [];

// Move send throttle
let lastMoveSent = 0;

// Respawn state
let respawnCountdown = 0;
let respawnTimer = null;

// ── Lobby UI ──────────────────────────────────────────────────────────────────
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
  document.getElementById('enterBattle').disabled = !(selectedFaction && selectedClass && name.length > 0);
}
document.getElementById('playerName').addEventListener('input', updateEnterButton);

document.getElementById('sensitivitySlider').addEventListener('input', e => {
  mouseSensitivity = parseFloat(e.target.value);
  document.getElementById('sensValue').textContent = mouseSensitivity.toFixed(1);
});

document.getElementById('enterBattle').addEventListener('click', () => {
  const name = document.getElementById('playerName').value.trim() || 'Hero';
  if (!selectedFaction || !selectedClass) return;
  socket.emit('join_game', { name, faction: selectedFaction, class: selectedClass });
});

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
  document.getElementById('piIcon').textContent   = CLASS_ICON[localPlayer.class] || '';
  document.getElementById('piName').textContent   = localPlayer.name;
  const pct = Math.max(0, Math.min(1, localPlayer.hp / localPlayer.maxHp));
  document.getElementById('piHpFill').style.width = (pct * 100) + '%';
  document.getElementById('piHpText').textContent = `${Math.max(0, localPlayer.hp)}/${localPlayer.maxHp}`;
  const fEl = document.getElementById('piFaction');
  fEl.textContent = localPlayer.faction ? localPlayer.faction.toUpperCase() : '';
  fEl.style.color = FACTION_CSS[localPlayer.faction] || '#ffffff';
}

function updateTerritoryInfoHUD() {
  if (!localPlayer || localPlayer.dead) {
    document.getElementById('territoryInfo').innerHTML = '';
    return;
  }
  let nearest = null, nearestDist = Infinity;
  for (const t of gameState.territories) {
    const dx = localPlayer.x - t.x, dz = localPlayer.z - t.y;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d < nearestDist) { nearestDist = d; nearest = t; }
  }
  if (!nearest) return;
  const onPoint = nearestDist <= 120;
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

// ── Minimap ────────────────────────────────────────────────────────────────────
function drawMinimap() {
  const canvas = document.getElementById('minimap');
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, MM_SIZE, MM_SIZE);

  // Convert world coord to minimap pixel
  function mx(wx) { return (wx + WORLD_HALF) / (WORLD_HALF * 2) * MM_SIZE; }
  function mz(wz) { return (wz + WORLD_HALF) / (WORLD_HALF * 2) * MM_SIZE; }

  ctx.fillStyle = '#0a0a12';
  ctx.fillRect(0, 0, MM_SIZE, MM_SIZE);

  // Territory zone colors
  const zoneColors = {
    order_hq:       '#1a2e88', chaos_hq:       '#882222', nature_hq:      '#1a5a1a',
    west_plains:    '#2a4a18', east_valley:    '#4a2810', north_ruins:    '#3a3a3a',
    center_dungeon: '#080820', sw_forest:      '#143214', se_canyon:      '#3a1808',
  };
  const zoneSize = 180; // world units

  for (const td of TERRITORY_DEFS) {
    const col = zoneColors[td.id] || '#222';
    ctx.fillStyle = col;
    const half = zoneSize / 2;
    ctx.fillRect(mx(td.x - half), mz(td.z - half), mx(td.x + half) - mx(td.x - half), mz(td.z + half) - mz(td.z - half));
  }

  // Territory ownership overlay + pillar dot
  for (const t of gameState.territories) {
    const td = TERR_BY_ID[t.id];
    if (!td) continue;
    if (t.owner) {
      const r = t.owner === 'order' ? 34 : t.owner === 'chaos' ? 204 : 34;
      const g2 = t.owner === 'order' ? 85 : t.owner === 'chaos' ? 34 : 170;
      const b = t.owner === 'order' ? 204 : t.owner === 'chaos' ? 34 : 68;
      ctx.fillStyle = `rgba(${r},${g2},${b},0.3)`;
      const half = zoneSize / 2;
      ctx.fillRect(mx(td.x - half), mz(td.z - half), mx(td.x + half) - mx(td.x - half), mz(td.z + half) - mz(td.z - half));
    }
    // Pillar square
    const pColor = t.owner ? (FACTION_CSS[t.owner] || '#888') : '#666';
    ctx.fillStyle = pColor;
    ctx.fillRect(mx(td.x) - 3, mz(td.z) - 3, 6, 6);
  }

  // Other players
  for (const p of gameState.players) {
    if (p.dead || p.id === myId) continue;
    ctx.fillStyle = FACTION_CSS[p.faction] || '#888';
    ctx.beginPath();
    ctx.arc(mx(p.x), mz(p.y), 2.5, 0, Math.PI * 2);
    ctx.fill();
  }

  // Local player
  if (localPlayer && !localPlayer.dead) {
    const lx = mx(localPlayer.x), lz = mz(localPlayer.z);
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(lx, lz, 4, 0, Math.PI * 2);
    ctx.fill();
    // Direction indicator
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(lx, lz);
    ctx.lineTo(lx + Math.sin(yaw) * 8, lz - Math.cos(yaw) * 8);
    ctx.stroke();
    // Blink ring
    if (Math.floor(Date.now() / 400) % 2 === 0) {
      ctx.strokeStyle = '#ffff88';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(lx, lz, 6, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  ctx.strokeStyle = '#443355';
  ctx.lineWidth = 1;
  ctx.strokeRect(0, 0, MM_SIZE, MM_SIZE);
}

// ── Canvas-texture label helper ───────────────────────────────────────────────
function makeNameLabel(name, faction) {
  const canvas = document.createElement('canvas');
  canvas.width = 256; canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, 256, 64);
  ctx.font = 'bold 22px Georgia, serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(4, 14, 248, 36);
  ctx.fillStyle = FACTION_CSS[faction] || '#ffffff';
  ctx.fillText(name.slice(0, 16), 128, 32);
  const tex = new THREE.CanvasTexture(canvas);
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 0.55), mat);
  mesh.renderOrder = 999;
  return mesh;
}

// ── HP bar plane ───────────────────────────────────────────────────────────────
function makeHpBarMesh() {
  const geo = new THREE.PlaneGeometry(1.4, 0.18);
  const mat = new THREE.MeshBasicMaterial({ color: 0x33cc33, depthTest: false });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 998;
  return mesh;
}

// ── Player group ───────────────────────────────────────────────────────────────
function buildPlayerGroup(p) {
  const group = new THREE.Group();
  const fcolor = FACTION_HEX[p.faction] || 0x888888;

  const body = new THREE.Mesh(
    new THREE.BoxGeometry(1.0, 1.5, 0.6),
    new THREE.MeshLambertMaterial({ color: fcolor })
  );
  body.position.set(0, 0.75, 0);
  group.add(body);

  const head = new THREE.Mesh(
    new THREE.BoxGeometry(0.7, 0.7, 0.7),
    new THREE.MeshLambertMaterial({ color: fcolor })
  );
  head.position.set(0, 1.85, 0);
  group.add(head);

  // Weapon
  let wpn;
  if (p.class === 'warrior') {
    wpn = new THREE.Mesh(
      new THREE.BoxGeometry(0.15, 1.2, 0.15),
      new THREE.MeshLambertMaterial({ color: 0xaaaacc })
    );
    wpn.rotation.z = Math.PI / 4;
    wpn.position.set(0.6, 1.0, 0.1);
  } else if (p.class === 'mage') {
    wpn = new THREE.Mesh(
      new THREE.CylinderGeometry(0.05, 0.05, 1.4, 6),
      new THREE.MeshLambertMaterial({ color: 0x9933ff })
    );
    wpn.position.set(0.6, 1.0, 0.1);
  } else {
    wpn = new THREE.Mesh(
      new THREE.BoxGeometry(0.08, 1.0, 0.08),
      new THREE.MeshLambertMaterial({ color: 0x886633 })
    );
    wpn.position.set(0.6, 1.0, 0.1);
  }
  group.add(wpn);

  // Name label
  const label = makeNameLabel(p.name, p.faction);
  label.position.set(0, 2.9, 0);
  group.add(label);

  // HP bar
  const hpBar = makeHpBarMesh();
  hpBar.position.set(0, 2.45, 0);
  group.add(hpBar);
  group.userData.hpBar = hpBar;
  group.userData.hpBarBg = null;

  const hpBarBg = new THREE.Mesh(
    new THREE.PlaneGeometry(1.4, 0.18),
    new THREE.MeshBasicMaterial({ color: 0x440000, depthTest: false })
  );
  hpBarBg.position.set(0, 2.45, -0.01);
  hpBarBg.renderOrder = 997;
  group.add(hpBarBg);
  group.userData.hpBarBg = hpBarBg;

  return group;
}

// ── Monster group ──────────────────────────────────────────────────────────────
function buildMonsterGroup(m) {
  const group = new THREE.Group();

  if (m.type === 'goblin') {
    const body = new THREE.Mesh(
      new THREE.SphereGeometry(0.55, 8, 6),
      new THREE.MeshLambertMaterial({ color: 0x22aa22 })
    );
    body.position.y = 0.6;
    group.add(body);
    const head = new THREE.Mesh(
      new THREE.BoxGeometry(0.5, 0.4, 0.4),
      new THREE.MeshLambertMaterial({ color: 0x33bb33 })
    );
    head.position.y = 1.25;
    group.add(head);
  } else if (m.type === 'orc') {
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(1.2, 2.0, 0.8),
      new THREE.MeshLambertMaterial({ color: 0xcc6622 })
    );
    body.position.y = 1.0;
    group.add(body);
    const helm = new THREE.Mesh(
      new THREE.BoxGeometry(0.9, 0.5, 0.9),
      new THREE.MeshLambertMaterial({ color: 0x884411 })
    );
    helm.position.y = 2.25;
    group.add(helm);
    // Shoulder guards
    const sg = new THREE.Mesh(
      new THREE.BoxGeometry(1.8, 0.3, 0.9),
      new THREE.MeshLambertMaterial({ color: 0x663300 })
    );
    sg.position.y = 1.8;
    group.add(sg);
  } else if (m.type === 'skeleton') {
    const torso = new THREE.Mesh(
      new THREE.BoxGeometry(0.5, 0.9, 0.2),
      new THREE.MeshLambertMaterial({ color: 0xddddcc })
    );
    torso.position.y = 0.9;
    group.add(torso);
    const skull = new THREE.Mesh(
      new THREE.BoxGeometry(0.4, 0.4, 0.35),
      new THREE.MeshLambertMaterial({ color: 0xeeeeee })
    );
    skull.position.y = 1.7;
    group.add(skull);
    // Arms
    for (const side of [-1, 1]) {
      const arm = new THREE.Mesh(
        new THREE.BoxGeometry(0.12, 0.7, 0.12),
        new THREE.MeshLambertMaterial({ color: 0xddddcc })
      );
      arm.position.set(side * 0.35, 0.85, 0);
      group.add(arm);
      // Leg
      const leg = new THREE.Mesh(
        new THREE.BoxGeometry(0.14, 0.8, 0.14),
        new THREE.MeshLambertMaterial({ color: 0xddddcc })
      );
      leg.position.set(side * 0.15, 0.35, 0);
      group.add(leg);
    }
  }

  // HP bar
  const hpBg = new THREE.Mesh(
    new THREE.PlaneGeometry(1.4, 0.18),
    new THREE.MeshBasicMaterial({ color: 0x440000, depthTest: false })
  );
  hpBg.renderOrder = 997;
  const hpFg = new THREE.Mesh(
    new THREE.PlaneGeometry(1.4, 0.18),
    new THREE.MeshBasicMaterial({ color: 0xdd3333, depthTest: false })
  );
  hpFg.renderOrder = 998;
  hpFg.position.z = 0.01;
  const hpGroup = new THREE.Group();
  hpGroup.add(hpBg);
  hpGroup.add(hpFg);
  hpGroup.position.y = m.type === 'orc' ? 2.8 : m.type === 'goblin' ? 1.8 : 2.2;
  group.add(hpGroup);
  group.userData.hpFg = hpFg;
  group.userData.hpGroup = hpGroup;

  return group;
}

// ── Weapon (first-person) models ───────────────────────────────────────────────
function buildWeaponMesh(cls) {
  if (cls === 'warrior') {
    const g = new THREE.Group();
    const blade = new THREE.Mesh(
      new THREE.BoxGeometry(0.1, 0.9, 0.08),
      new THREE.MeshLambertMaterial({ color: 0xccccdd })
    );
    blade.position.y = 0.25;
    g.add(blade);
    const guard = new THREE.Mesh(
      new THREE.BoxGeometry(0.45, 0.07, 0.12),
      new THREE.MeshLambertMaterial({ color: 0x887744 })
    );
    guard.position.y = -0.15;
    g.add(guard);
    const grip = new THREE.Mesh(
      new THREE.BoxGeometry(0.09, 0.35, 0.09),
      new THREE.MeshLambertMaterial({ color: 0x553311 })
    );
    grip.position.y = -0.38;
    g.add(grip);
    return g;
  } else if (cls === 'mage') {
    const g = new THREE.Group();
    const staff = new THREE.Mesh(
      new THREE.CylinderGeometry(0.04, 0.055, 1.1, 8),
      new THREE.MeshLambertMaterial({ color: 0x6633aa })
    );
    staff.position.y = 0.05;
    g.add(staff);
    const orb = new THREE.Mesh(
      new THREE.SphereGeometry(0.13, 10, 8),
      new THREE.MeshBasicMaterial({ color: 0xcc66ff })
    );
    orb.position.y = 0.65;
    g.add(orb);
    return g;
  } else {
    // ranger bow
    const g = new THREE.Group();
    const handle = new THREE.Mesh(
      new THREE.BoxGeometry(0.06, 0.75, 0.06),
      new THREE.MeshLambertMaterial({ color: 0x774422 })
    );
    g.add(handle);
    // Bow limbs (two angled boxes)
    for (const side of [-1, 1]) {
      const limb = new THREE.Mesh(
        new THREE.BoxGeometry(0.05, 0.45, 0.05),
        new THREE.MeshLambertMaterial({ color: 0x885533 })
      );
      limb.position.y = side * 0.48;
      limb.rotation.z = side * 0.28;
      g.add(limb);
    }
    // Bowstring
    const strGeo = new THREE.BufferGeometry();
    const strPts = new Float32Array([0, 0.45, -0.18, 0, 0, -0.22, 0, -0.45, -0.18]);
    strGeo.setAttribute('position', new THREE.BufferAttribute(strPts, 3));
    const strLine = new THREE.Line(strGeo, new THREE.LineBasicMaterial({ color: 0xddccaa }));
    g.add(strLine);
    return g;
  }
}

// ── Territory pillar ───────────────────────────────────────────────────────────
function buildTerritoryPillar(td, owner) {
  const color = owner ? (FACTION_HEX[owner] || 0x666666) : 0x666666;
  const pillar = new THREE.Mesh(
    new THREE.CylinderGeometry(1.8, 2.2, 20, 8),
    new THREE.MeshBasicMaterial({ color })
  );
  pillar.position.set(td.x, 10, td.z);

  const light = new THREE.PointLight(color, 1.2, 120);
  light.position.set(td.x, 22, td.z);

  return { pillar, light };
}

// ── HQ building ────────────────────────────────────────────────────────────────
function buildHQCastle(x, z, factionColor) {
  const group = new THREE.Group();
  const mat = new THREE.MeshLambertMaterial({ color: factionColor });
  const stoneMat = new THREE.MeshLambertMaterial({ color: 0x554444 });

  // Main keep
  const keep = new THREE.Mesh(new THREE.BoxGeometry(60, 40, 60), mat);
  keep.position.set(0, 20, 0);
  group.add(keep);

  // 4 corner towers
  const towerOffsets = [[-40, -40], [40, -40], [-40, 40], [40, 40]];
  for (const [ox, oz] of towerOffsets) {
    const tower = new THREE.Mesh(new THREE.BoxGeometry(15, 60, 15), stoneMat);
    tower.position.set(ox, 30, oz);
    group.add(tower);
  }

  // Walls (North, East, West — leave south open for gate)
  const wallMat = new THREE.MeshLambertMaterial({ color: 0x443333 });
  const wallN = new THREE.Mesh(new THREE.BoxGeometry(80, 20, 10), wallMat);
  wallN.position.set(0, 10, -40);
  group.add(wallN);
  const wallE = new THREE.Mesh(new THREE.BoxGeometry(10, 20, 60), wallMat);
  wallE.position.set(40, 10, 0);
  group.add(wallE);
  const wallW = new THREE.Mesh(new THREE.BoxGeometry(10, 20, 60), wallMat);
  wallW.position.set(-40, 10, 0);
  group.add(wallW);
  // South wall split (gate gap)
  const wallS1 = new THREE.Mesh(new THREE.BoxGeometry(25, 20, 10), wallMat);
  wallS1.position.set(-27, 10, 40);
  group.add(wallS1);
  const wallS2 = new THREE.Mesh(new THREE.BoxGeometry(25, 20, 10), wallMat);
  wallS2.position.set(27, 10, 40);
  group.add(wallS2);

  group.position.set(x, 0, z);
  return group;
}

// ── World creation ─────────────────────────────────────────────────────────────
function buildWorld() {
  // Ground
  const groundGeo = new THREE.PlaneGeometry(2000, 2000);
  const groundMat = new THREE.MeshLambertMaterial({ color: 0x2a4a1a });
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = 0;
  scene.add(ground);

  // Territory zone ground overlays
  const zoneData = [
    { id: 'order_hq',       x: -800, z:   0, w: 350, d: 350, color: 0xc8a050 },
    { id: 'chaos_hq',       x:  800, z:   0, w: 350, d: 350, color: 0x3a1010 },
    { id: 'nature_hq',      x:    0, z: -850, w: 350, d: 350, color: 0x2d8a2d },
    { id: 'center_dungeon', x:    0, z:   0, w: 400, d: 400, color: 0x0a0a1a },
    { id: 'west_plains',    x: -500, z:   0, w: 300, d: 300, color: 0x5a7a30 },
    { id: 'east_valley',    x:  500, z:   0, w: 300, d: 300, color: 0x7a3010 },
    { id: 'north_ruins',    x:    0, z: -350, w: 300, d: 300, color: 0x4a4a40 },
    { id: 'sw_forest',      x: -500, z: 350, w: 300, d: 300, color: 0x1a5a1a },
    { id: 'se_canyon',      x:  500, z: 350, w: 300, d: 300, color: 0x6a2808 },
  ];

  for (const z of zoneData) {
    const zonePlane = new THREE.Mesh(
      new THREE.PlaneGeometry(z.w, z.d),
      new THREE.MeshLambertMaterial({ color: z.color })
    );
    zonePlane.rotation.x = -Math.PI / 2;
    zonePlane.position.set(z.x, 0.01, z.z);
    scene.add(zonePlane);
  }

  // HQ buildings
  scene.add(buildHQCastle(-800, 0, 0x2244aa));
  scene.add(buildHQCastle( 800, 0, 0x992222));
  scene.add(buildHQCastle(   0, -850, 0x228833));

  // Territory capture pillars (non-HQ)
  for (const td of TERRITORY_DEFS) {
    if (td.isHQ) continue;
    const { pillar, light } = buildTerritoryPillar(td, null);
    scene.add(pillar);
    scene.add(light);
    terrPillars[td.id] = { pillar, light };
  }

  // Boundary walls
  const boundMat = new THREE.MeshLambertMaterial({ color: 0x1a1a22 });
  const walls = [
    { pos: [0, 15, -1005], size: [2010, 30, 10] },
    { pos: [0, 15,  1005], size: [2010, 30, 10] },
    { pos: [-1005, 15, 0], size: [10, 30, 2010] },
    { pos: [ 1005, 15, 0], size: [10, 30, 2010] },
  ];
  for (const w of walls) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(...w.size), boundMat);
    m.position.set(...w.pos);
    scene.add(m);
  }

  buildCoverObjects();
}

// ── Cover/obstacle objects ─────────────────────────────────────────────────────
function buildCoverObjects() {
  const stoneMat = new THREE.MeshLambertMaterial({ color: 0x5a5a6a });
  const darkStoneMat = new THREE.MeshLambertMaterial({ color: 0x3a3a4a });
  const brownMat = new THREE.MeshLambertMaterial({ color: 0x5a3a1a });
  const greenMat = new THREE.MeshLambertMaterial({ color: 0x1a5a1a });
  const foliageMat = new THREE.MeshLambertMaterial({ color: 0x2a6a2a });

  // Wall cluster helper
  function addWall(x, y, z, w, h, d, mat) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y + h / 2, z);
    scene.add(m);
  }

  // Tree helper
  function addTree(x, z) {
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.6, 6, 6), brownMat);
    trunk.position.set(x, 3, z);
    scene.add(trunk);
    const foliage = new THREE.Mesh(new THREE.BoxGeometry(5, 6, 5), foliageMat);
    foliage.position.set(x, 8, z);
    scene.add(foliage);
  }

  // Rock formation helper
  function addRock(x, z, scale) {
    const s = scale || 1;
    const r1 = new THREE.Mesh(new THREE.BoxGeometry(3 * s, 2.5 * s, 3 * s), stoneMat);
    r1.position.set(x, 1.25 * s, z);
    r1.rotation.y = Math.random() * Math.PI;
    scene.add(r1);
    const r2 = new THREE.Mesh(new THREE.BoxGeometry(2 * s, 3 * s, 2 * s), stoneMat);
    r2.position.set(x + 1.5 * s, 1.5 * s, z - 1 * s);
    r2.rotation.y = Math.random() * Math.PI;
    scene.add(r2);
  }

  // -- West plains stone wall clusters
  addWall(-580, 0,  30, 20, 4, 2, stoneMat);
  addWall(-540, 0, -20, 2, 4, 20, stoneMat);
  addWall(-460, 0,  50, 20, 5, 2, stoneMat);
  addWall(-430, 0, -40, 2, 5, 16, stoneMat);
  addWall(-520, 0,  80, 14, 3, 2, stoneMat);

  // -- East valley rock clusters
  addRock( 560,  40, 1.2);
  addRock( 480, -30, 0.9);
  addRock( 430,  60, 1.1);
  addWall( 550, 0, -50, 20, 4, 2, darkStoneMat);
  addWall( 470, 0,  80, 2, 4, 18, darkStoneMat);

  // -- North ruins broken walls
  addWall(  30, 0, -380, 22, 5, 2, darkStoneMat);
  addWall( -40, 0, -310, 2, 4, 18, darkStoneMat);
  addWall(  60, 0, -320, 16, 3, 2, darkStoneMat);
  addWall( -70, 0, -380, 2, 6, 12, darkStoneMat);
  addRock(-20, -400, 0.8);
  addRock( 80, -340, 0.7);

  // -- Center dungeon walls
  addWall(  60, 0,  30, 2, 6, 30, darkStoneMat);
  addWall( -60, 0, -30, 2, 6, 30, darkStoneMat);
  addWall(  30, 0,  60, 30, 6, 2, darkStoneMat);
  addWall( -30, 0, -60, 30, 6, 2, darkStoneMat);
  addWall(  80, 0, -50, 2, 5, 20, darkStoneMat);
  addWall( -80, 0,  50, 2, 5, 20, darkStoneMat);

  // -- SW forest trees
  for (let i = 0; i < 14; i++) {
    const angle = (i / 14) * Math.PI * 2;
    const r = 60 + Math.random() * 80;
    addTree(-500 + Math.cos(angle) * r, 350 + Math.sin(angle) * r);
  }
  addWall(-470, 0, 280, 18, 4, 2, brownMat);
  addWall(-530, 0, 400, 2, 4, 18, brownMat);

  // -- SE canyon walls/rocks
  addWall( 470, 0, 280, 18, 5, 2, darkStoneMat);
  addWall( 530, 0, 400, 2, 5, 18, darkStoneMat);
  addRock( 450,  300, 1.3);
  addRock( 540,  380, 1.0);
  addRock( 480,  420, 0.9);

  // -- Scattered midfield cover
  addWall(-200, 0, -150, 20, 4, 2, stoneMat);
  addWall( 200, 0,  150, 20, 4, 2, stoneMat);
  addWall(-250, 0,  200, 2, 4, 18, stoneMat);
  addWall( 250, 0, -200, 2, 4, 18, stoneMat);
  addRock(-150,  100, 1.0);
  addRock( 150, -100, 1.0);
  addRock(  50,  200, 0.8);
  addRock( -50, -200, 0.8);

  // -- Mid-route rock clusters
  addRock(-300,   0, 1.0);
  addRock( 300,   0, 1.0);
  addRock(   0, -200, 0.9);
  addRock(   0,  200, 0.9);
  addWall(-350, 0,  80, 2, 5, 22, stoneMat);
  addWall( 350, 0, -80, 2, 5, 22, stoneMat);
}

// ── Three.js init ─────────────────────────────────────────────────────────────
function initThree() {
  // Renderer
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.autoClear = true;
  document.getElementById('game-container').appendChild(renderer.domElement);

  // Main scene + fog + background
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0a2a);
  scene.fog = new THREE.Fog(0x0a0a2a, 200, 800);

  // Lighting
  const ambient = new THREE.AmbientLight(0x334466, 0.8);
  scene.add(ambient);
  const dirLight = new THREE.DirectionalLight(0xffeedd, 0.6);
  dirLight.position.set(100, 200, 100);
  scene.add(dirLight);

  // Camera rig
  pivot = new THREE.Object3D();
  scene.add(pivot);
  camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
  camera.position.y = 1.8;
  pivot.add(camera);

  // Weapon scene (rendered on top, no fog)
  weaponScene = new THREE.Scene();
  weaponCamera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.05, 10);
  const wLight = new THREE.AmbientLight(0xffffff, 1.2);
  weaponScene.add(wLight);

  // Build world geometry
  buildWorld();

  // Input
  setupInput();

  // Pointer lock
  renderer.domElement.addEventListener('click', () => {
    if (!gameStarted) return;
    renderer.domElement.requestPointerLock();
  });
  document.addEventListener('pointerlockchange', () => {
    isPointerLocked = document.pointerLockElement === renderer.domElement;
    const prompt = document.getElementById('lockPrompt');
    if (isPointerLocked) {
      prompt.classList.add('hidden');
    } else {
      prompt.classList.remove('hidden');
    }
  });

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    weaponCamera.aspect = window.innerWidth / window.innerHeight;
    weaponCamera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
}

// ── Input setup ───────────────────────────────────────────────────────────────
function setupInput() {
  document.addEventListener('mousemove', e => {
    if (!isPointerLocked) return;
    yaw   -= e.movementX * 0.002 * mouseSensitivity;
    pitch -= e.movementY * 0.002 * mouseSensitivity;
    pitch  = Math.max(-1.4, Math.min(1.4, pitch));
    pivot.rotation.y = yaw;
    camera.rotation.x = pitch;
  });

  document.addEventListener('keydown', e => {
    if (!gameStarted) return;
    switch (e.code) {
      case 'KeyW': case 'ArrowUp':    moveForward = true; break;
      case 'KeyS': case 'ArrowDown':  moveBack    = true; break;
      case 'KeyA': case 'ArrowLeft':  moveLeft    = true; break;
      case 'KeyD': case 'ArrowRight': moveRight   = true; break;
    }
  });

  document.addEventListener('keyup', e => {
    switch (e.code) {
      case 'KeyW': case 'ArrowUp':    moveForward = false; break;
      case 'KeyS': case 'ArrowDown':  moveBack    = false; break;
      case 'KeyA': case 'ArrowLeft':  moveLeft    = false; break;
      case 'KeyD': case 'ArrowRight': moveRight   = false; break;
    }
  });

  document.addEventListener('mousedown', e => {
    if (e.button !== 0 || !isPointerLocked || !gameStarted) return;
    if (!localPlayer || localPlayer.dead) return;
    const tx = localPlayer.x + Math.sin(yaw) * 100;
    const ty = localPlayer.z - Math.cos(yaw) * 100;
    socket.emit('player_attack', { targetX: tx, targetY: ty });
    playAttackAnimation();
  });
}

// ── Attack animation ───────────────────────────────────────────────────────────
function playAttackAnimation() {
  weaponLurchTime = 0.3;
}

// ── Movement update ────────────────────────────────────────────────────────────
const _moveDir = new THREE.Vector3();
const _yawAxis = new THREE.Vector3(0, 1, 0);

function updateMovement(dt) {
  if (!localPlayer || localPlayer.dead) return;
  const speed = localPlayer.speed || 8;

  _moveDir.set(0, 0, 0);
  if (moveForward) _moveDir.z -= 1;
  if (moveBack)    _moveDir.z += 1;
  if (moveLeft)    _moveDir.x -= 1;
  if (moveRight)   _moveDir.x += 1;

  if (_moveDir.length() > 0) {
    _moveDir.normalize();
    _moveDir.applyAxisAngle(_yawAxis, yaw);
    localPlayer.x += _moveDir.x * speed * dt;
    localPlayer.z += _moveDir.z * speed * dt;
    localPlayer.x  = Math.max(-990, Math.min(990, localPlayer.x));
    localPlayer.z  = Math.max(-990, Math.min(990, localPlayer.z));
  }

  pivot.position.set(localPlayer.x, 0, localPlayer.z);

  const now = Date.now();
  if (now - lastMoveSent > 50) {
    socket.emit('player_move', { x: localPlayer.x, y: localPlayer.z, facing: yaw });
    lastMoveSent = now;
  }
}

// ── Weapon bob + lurch ─────────────────────────────────────────────────────────
function updateWeapon(dt, time) {
  if (!weaponMesh) return;

  const isMoving = moveForward || moveBack || moveLeft || moveRight;
  weaponBob += dt;

  const bobY = isMoving ? Math.sin(weaponBob * 8) * 0.022 : Math.sin(weaponBob * 1.5) * 0.006;
  const bobX = isMoving ? Math.sin(weaponBob * 4) * 0.01 : 0;

  let lurchZ = 0;
  if (weaponLurchTime > 0) {
    weaponLurchTime -= dt;
    const t = 1 - (weaponLurchTime / 0.3);
    lurchZ = t < 0.5 ? -t * 0.18 : -(1 - t) * 0.18;
  }

  weaponMesh.position.set(0.28 + bobX, -0.32 + bobY, -0.45 + lurchZ);
}

// ── Update remote players ─────────────────────────────────────────────────────
function updatePlayerMeshes() {
  const seen = new Set();

  for (const p of gameState.players) {
    if (p.id === myId) continue;
    seen.add(p.id);

    if (!playerMeshes[p.id]) {
      const g = buildPlayerGroup(p);
      scene.add(g);
      playerMeshes[p.id] = g;
    }

    const g = playerMeshes[p.id];
    g.position.set(p.x, 0, p.y);
    g.rotation.y = -(p.facing || 0);
    g.visible = !p.dead;

    // Update HP bar scale
    const hpBar = g.userData.hpBar;
    if (hpBar) {
      const pct = Math.max(0, Math.min(1, p.hp / p.maxHp));
      hpBar.scale.x = pct;
      hpBar.position.x = -(1 - pct) * 0.7;
      hpBar.material.color.setHex(pct > 0.5 ? 0x33cc33 : pct > 0.25 ? 0xccaa00 : 0xcc3300);
    }

    // Billboard labels toward camera
    const label = g.children.find(c => c.geometry && c.geometry.type === 'PlaneGeometry' && c.renderOrder === 999);
    if (label) {
      const wp = new THREE.Vector3();
      g.getWorldPosition(wp);
      label.lookAt(pivot.position.x, wp.y + 2.9, pivot.position.z);
    }
    const hpBg = g.userData.hpBarBg;
    if (hpBg) {
      const wp2 = new THREE.Vector3();
      g.getWorldPosition(wp2);
      const dir = new THREE.Vector3(pivot.position.x - wp2.x, 0, pivot.position.z - wp2.z).normalize();
      const angle = Math.atan2(dir.x, dir.z);
      const hpG = g.children.find(c => c === hpBar || c === hpBg);
      g.children.forEach(c => {
        if (c.renderOrder >= 997) c.rotation.y = angle - g.rotation.y;
      });
    }
  }

  // Remove disconnected players
  for (const id of Object.keys(playerMeshes)) {
    if (!seen.has(id)) {
      scene.remove(playerMeshes[id]);
      delete playerMeshes[id];
    }
  }
}

// ── Update monster meshes ──────────────────────────────────────────────────────
function updateMonsterMeshes() {
  const seen = new Set();

  for (const m of gameState.monsters) {
    seen.add(m.id);

    if (!monsterMeshes[m.id]) {
      const g = buildMonsterGroup(m);
      scene.add(g);
      monsterMeshes[m.id] = g;
    }

    const g = monsterMeshes[m.id];
    g.position.set(m.x, 0, m.y);

    // Update HP bar
    const hpFg = g.userData.hpFg;
    if (hpFg) {
      const pct = Math.max(0, Math.min(1, m.hp / m.maxHp));
      hpFg.scale.x = pct;
      hpFg.position.x = -(1 - pct) * 0.7;
    }

    // Billboard HP group toward camera
    const hpGroup = g.userData.hpGroup;
    if (hpGroup) {
      const dir = new THREE.Vector3(pivot.position.x - g.position.x, 0, pivot.position.z - g.position.z);
      if (dir.length() > 0.01) {
        dir.normalize();
        hpGroup.rotation.y = Math.atan2(dir.x, dir.z);
      }
    }
  }

  for (const id of Object.keys(monsterMeshes)) {
    if (!seen.has(id)) {
      scene.remove(monsterMeshes[id]);
      delete monsterMeshes[id];
    }
  }
}

// ── Update projectile meshes ───────────────────────────────────────────────────
function updateProjectileMeshes() {
  const seen = new Set();

  for (const proj of gameState.projectiles) {
    seen.add(proj.id);

    if (!projMeshes[proj.id]) {
      let mesh;
      if (proj.type === 'magic') {
        mesh = new THREE.Mesh(
          new THREE.SphereGeometry(0.35, 8, 6),
          new THREE.MeshBasicMaterial({ color: 0x9933ff })
        );
        const pLight = new THREE.PointLight(0x9933ff, 1.5, 20);
        pLight.position.copy(mesh.position);
        mesh.add(pLight);
      } else {
        mesh = new THREE.Mesh(
          new THREE.BoxGeometry(0.08, 0.08, 0.6),
          new THREE.MeshLambertMaterial({ color: 0x886633 })
        );
      }
      scene.add(mesh);
      projMeshes[proj.id] = mesh;
    }

    const mesh = projMeshes[proj.id];
    mesh.position.set(proj.x, 1.6, proj.y);

    // Orient arrow to velocity
    if (proj.type === 'arrow') {
      const angle = Math.atan2(proj.vx, proj.vy);
      mesh.rotation.y = angle;
    }
  }

  for (const id of Object.keys(projMeshes)) {
    if (!seen.has(id)) {
      scene.remove(projMeshes[id]);
      delete projMeshes[id];
    }
  }
}

// ── Update territory pillars ───────────────────────────────────────────────────
function updateTerritoryPillars() {
  for (const t of gameState.territories) {
    if (t.isHQ || !terrPillars[t.id]) continue;
    const { pillar, light } = terrPillars[t.id];
    const color = t.owner ? (FACTION_HEX[t.owner] || 0x666666) : 0x666666;
    pillar.material.color.setHex(color);
    light.color.setHex(color);

    // Capture glow intensity
    if (t.capturingFaction && t.captureProgress > 0) {
      light.intensity = 1.2 + Math.sin(Date.now() * 0.005) * 0.6;
    } else {
      light.intensity = 1.2;
    }
  }
}

// ── Damage numbers ─────────────────────────────────────────────────────────────
function spawnDamageNumber(worldX, worldY, amount) {
  const el = document.createElement('div');
  el.className = 'dmg-number';
  el.textContent = String(amount);
  el.style.color = amount >= 30 ? '#ff6644' : '#ffee44';
  document.body.appendChild(el);

  activeDmgEls.push({
    el,
    worldX,
    worldZ: worldY,
    screenY: 0,
    vy: -80,
    life: 1.5,
    maxLife: 1.5,
  });
}

const _projVec = new THREE.Vector3();
const _projVec2 = new THREE.Vector2();

function updateDamageNumbers(dt) {
  for (let i = activeDmgEls.length - 1; i >= 0; i--) {
    const d = activeDmgEls[i];
    d.life -= dt;
    if (d.life <= 0) {
      if (d.el.parentNode) d.el.parentNode.removeChild(d.el);
      activeDmgEls.splice(i, 1);
      continue;
    }

    // Project world position to screen
    _projVec.set(d.worldX, 2.5, d.worldZ);
    _projVec.project(camera);

    if (_projVec.z > 1) {
      d.el.style.display = 'none';
      continue;
    }

    const screenX = (_projVec.x  * 0.5 + 0.5) * window.innerWidth;
    const screenY = (-_projVec.y * 0.5 + 0.5) * window.innerHeight;
    d.screenYOffset = (d.screenYOffset || 0) + d.vy * dt;

    const alpha = Math.max(0, d.life / d.maxLife);
    d.el.style.display = 'block';
    d.el.style.left = screenX + 'px';
    d.el.style.top  = (screenY + d.screenYOffset) + 'px';
    d.el.style.opacity = alpha;
    d.el.style.fontSize = (16 + (1 - alpha) * 8) + 'px';
  }
}

// ── Socket init ───────────────────────────────────────────────────────────────
function initSocket() {
  socket = io();

  socket.on('connect', () => {
    showNotification('Connected to Dungeon Front', '#aaaaff', 3000);
  });

  socket.on('disconnect', () => {
    showNotification('Disconnected from server', '#ff6666', 5000);
  });

  socket.on('joined', ({ id, player }) => {
    myId = id;
    localPlayer = { ...player, z: player.y };
    localPlayer.x = player.x;
    localPlayer.z = player.y;

    pivot.position.set(localPlayer.x, 0, localPlayer.z);

    document.getElementById('lobby').classList.add('hidden');
    document.getElementById('hud').classList.remove('hidden');
    document.getElementById('playerInfo').classList.remove('hidden');
    gameStarted = true;

    // Build weapon
    if (weaponMesh) { weaponScene.remove(weaponMesh); }
    weaponMesh = buildWeaponMesh(localPlayer.class);
    weaponMesh.position.set(0.28, -0.32, -0.45);
    weaponScene.add(weaponMesh);

    updatePlayerInfoHUD();
    showNotification('Welcome to Dungeon Front!', '#ffdd88', 4000);
  });

  socket.on('game_state', state => {
    gameState = state;

    if (myId) {
      const serverMe = state.players.find(p => p.id === myId);
      if (serverMe) {
        if (!localPlayer) localPlayer = { ...serverMe, z: serverMe.y };
        localPlayer.hp    = serverMe.hp;
        localPlayer.maxHp = serverMe.maxHp;
        localPlayer.dead  = serverMe.dead;
        if (serverMe.dead) {
          localPlayer.x = serverMe.x;
          localPlayer.z = serverMe.y;
        }
      }
    }

    if (state.damageNumbers && state.damageNumbers.length) {
      for (const dn of state.damageNumbers) {
        spawnDamageNumber(dn.x, dn.y, dn.amount);
      }
    }

    updateFactionScores();
    updatePlayerInfoHUD();
    updateTerritoryInfoHUD();
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
    if (localPlayer) {
      localPlayer.x = x;
      localPlayer.z = y;
      localPlayer.dead = false;
      localPlayer.hp = localPlayer.maxHp;
      pivot.position.set(x, 0, y);
    }
    document.getElementById('deathOverlay').classList.add('hidden');
    if (respawnTimer) { clearInterval(respawnTimer); respawnTimer = null; }
  });

  socket.on('territory_captured', ({ name, faction, from }) => {
    const color = FACTION_CSS[faction] || '#ffffff';
    const fromStr = from ? ` from ${from.charAt(0).toUpperCase() + from.slice(1)}` : '';
    showNotification(`${faction.charAt(0).toUpperCase() + faction.slice(1)} captured ${name}${fromStr}!`, color, 4000);
    // Update pillar color immediately
    for (const t of gameState.territories) {
      if (!t.isHQ && terrPillars[t.id]) {
        const { pillar, light } = terrPillars[t.id];
        const c = t.owner ? (FACTION_HEX[t.owner] || 0x666666) : 0x666666;
        pillar.material.color.setHex(c);
        light.color.setHex(c);
      }
    }
  });
}

function updateRespawnText() {
  document.getElementById('respawnText').textContent =
    respawnCountdown > 0 ? `Respawning in ${respawnCountdown}...` : 'Respawning...';
}

// ── Main render loop ───────────────────────────────────────────────────────────
let prevTime = performance.now();

function animate() {
  requestAnimationFrame(animate);
  const now = performance.now();
  const dt  = Math.min((now - prevTime) / 1000, 0.1);
  prevTime  = now;
  const time = now / 1000;

  if (gameStarted) {
    updateMovement(dt);
    updateWeapon(dt, time);
    updatePlayerMeshes();
    updateMonsterMeshes();
    updateProjectileMeshes();
    updateTerritoryPillars();
    updateDamageNumbers(dt);
    drawMinimap();
  }

  // Main scene render
  renderer.autoClear = true;
  renderer.render(scene, camera);

  // Weapon overlay (no depth clear overlap)
  if (gameStarted && weaponMesh) {
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(weaponScene, weaponCamera);
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  initThree();
  initSocket();
  animate();
});
