const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

// ─── Constants ────────────────────────────────────────────────────────────────
const TICK_RATE    = 20;
const TICK_MS      = 1000 / TICK_RATE;
const MAP_WIDTH    = 2000;
const MAP_HEIGHT   = 2000;
const CAPTURE_RADIUS = 60;
const CAPTURE_TIME   = 10;  // seconds
const RESPAWN_TIME   = 5;   // seconds

// ─── Class definitions ────────────────────────────────────────────────────────
const CLASS_DEFS = {
  warrior: { hp: 150, speed: 8,  damage: 30, range: 70,  atkRate: 1.2, ranged: false },
  mage:    { hp: 80,  speed: 9,  damage: 50, range: 250, atkRate: 1.0, ranged: true,  projType: 'magic' },
  ranger:  { hp: 100, speed: 10, damage: 40, range: 200, atkRate: 1.5, ranged: true,  projType: 'arrow' },
};

// ─── Faction spawn points (FPS world coords, centered at 0,0) ─────────────────
const FACTION_SPAWNS = {
  order:  { x: -800, y: 0   },
  chaos:  { x:  800, y: 0   },
  nature: { x:  0,   y: -850 },
};

// ─── Territory definitions ────────────────────────────────────────────────────
const TERRITORY_DEFS = [
  { id: 'order_hq',       name: 'Order Keep',       x: -800, y: 0,    defaultOwner: 'order',  isHQ: true  },
  { id: 'chaos_hq',       name: 'Chaos Fortress',   x:  800, y: 0,    defaultOwner: 'chaos',  isHQ: true  },
  { id: 'nature_hq',      name: 'Nature Grove',     x:  0,   y: -850, defaultOwner: 'nature', isHQ: true  },
  { id: 'west_plains',    name: 'Western Plains',   x: -500, y: 0,    defaultOwner: 'order',  isHQ: false },
  { id: 'east_valley',    name: 'Eastern Valley',   x:  500, y: 0,    defaultOwner: 'chaos',  isHQ: false },
  { id: 'north_ruins',    name: 'Northern Ruins',   x:  0,   y: -350, defaultOwner: 'nature', isHQ: false },
  { id: 'center_dungeon', name: 'Dark Dungeon',     x:  0,   y: 0,    defaultOwner: null,     isHQ: false },
  { id: 'sw_forest',      name: 'Shadow Forest',    x: -500, y: 350,  defaultOwner: null,     isHQ: false },
  { id: 'se_canyon',      name: 'Fire Canyon',      x:  500, y: 350,  defaultOwner: null,     isHQ: false },
];

// ─── Monster types ────────────────────────────────────────────────────────────
const MONSTER_TYPES = {
  goblin:   { hp: 40, damage: 10, speed: 4,  aggroRange: 150, atkRange: 15, atkRate: 1.0 },
  orc:      { hp: 80, damage: 15, speed: 3,  aggroRange: 150, atkRange: 20, atkRate: 0.8 },
  skeleton: { hp: 50, damage: 12, speed: 5,  aggroRange: 150, atkRange: 18, atkRate: 1.2 },
};

// ─── Monster spawn locations ───────────────────────────────────────────────────
const MONSTER_SPAWNS = [
  // center_dungeon
  { x:  -50, y: -60,  type: 'goblin'   },
  { x:   50, y: -30,  type: 'goblin'   },
  { x:    0, y:  60,  type: 'orc'      },
  { x:  -80, y:  30,  type: 'skeleton' },
  { x:   80, y: -80,  type: 'skeleton' },
  { x:   30, y:  90,  type: 'goblin'   },
  { x:  -30, y: -10,  type: 'orc'      },
  { x:  100, y:  30,  type: 'goblin'   },
  // sw_forest
  { x: -530, y: 310,  type: 'goblin'   },
  { x: -470, y: 390,  type: 'goblin'   },
  { x: -510, y: 420,  type: 'orc'      },
  { x: -450, y: 330,  type: 'skeleton' },
  // se_canyon
  { x:  470, y: 310,  type: 'orc'      },
  { x:  530, y: 390,  type: 'goblin'   },
  { x:  500, y: 420,  type: 'skeleton' },
  { x:  550, y: 330,  type: 'goblin'   },
  // north_ruins
  { x:  -30, y: -390, type: 'skeleton' },
  { x:   30, y: -320, type: 'skeleton' },
  { x:   60, y: -380, type: 'orc'      },
];

// ─── Game state ───────────────────────────────────────────────────────────────
let players     = {};
let monsters    = {};
let territories = {};
let projectiles = {};
let pendingDamageNumbers = [];
let nextMonsterId    = 1;
let nextProjectileId = 1;

// ─── Initialise territories ───────────────────────────────────────────────────
function initTerritories() {
  for (const def of TERRITORY_DEFS) {
    territories[def.id] = {
      id:              def.id,
      name:            def.name,
      x:               def.x,
      y:               def.y,
      owner:           def.defaultOwner,
      isHQ:            def.isHQ,
      captureProgress: 0,
      capturingFaction: null,
      contestedBy:     [],
    };
  }
}

// ─── Initialise monsters ──────────────────────────────────────────────────────
function spawnMonster(spawnDef) {
  const id = 'mon_' + (nextMonsterId++);
  const def = MONSTER_TYPES[spawnDef.type];
  monsters[id] = {
    id,
    type:        spawnDef.type,
    x:           spawnDef.x + (Math.random() - 0.5) * 20,
    y:           spawnDef.y + (Math.random() - 0.5) * 20,
    spawnX:      spawnDef.x,
    spawnY:      spawnDef.y,
    hp:          def.hp,
    maxHp:       def.hp,
    speed:       def.speed,
    damage:      def.damage,
    aggroRange:  def.aggroRange,
    atkRange:    def.atkRange,
    atkRate:     def.atkRate,
    atkCooldown: 0,
    target:      null,
    aggro:       false,
    spawnDef,
  };
  return id;
}

function initMonsters() {
  for (const spawnDef of MONSTER_SPAWNS) {
    spawnMonster(spawnDef);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function dist(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

function randomHex(len) {
  let s = '';
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

// ─── Server game loop ─────────────────────────────────────────────────────────
let lastTick = Date.now();

function gameTick() {
  const now = Date.now();
  const dt  = (now - lastTick) / 1000;
  lastTick  = now;

  const alivePlayers = Object.values(players).filter(p => !p.dead);

  // ── Monster AI ──────────────────────────────────────────────────────────────
  for (const mon of Object.values(monsters)) {
    let nearest = null, nearestDist = Infinity;
    for (const p of alivePlayers) {
      const d = dist(mon, p);
      if (d < nearestDist) { nearestDist = d; nearest = p; }
    }

    if (nearest && nearestDist <= mon.aggroRange) {
      mon.aggro  = true;
      mon.target = nearest.id;

      const dx = nearest.x - mon.x;
      const dy = nearest.y - mon.y;
      const d  = Math.sqrt(dx * dx + dy * dy);
      if (d > mon.atkRange) {
        mon.x += (dx / d) * mon.speed * dt;
        mon.y += (dy / d) * mon.speed * dt;
      }

      mon.atkCooldown -= dt;
      if (mon.atkCooldown <= 0 && nearestDist <= mon.atkRange + 5) {
        mon.atkCooldown = 1 / mon.atkRate;
        nearest.hp -= mon.damage;
        pendingDamageNumbers.push({ x: nearest.x, y: nearest.y, amount: mon.damage, id: randomHex(8) });
        if (nearest.hp <= 0) {
          killPlayer(nearest);
        }
      }
    } else {
      mon.aggro  = false;
      mon.target = null;
      const dx = mon.spawnX - mon.x;
      const dy = mon.spawnY - mon.y;
      const d  = Math.sqrt(dx * dx + dy * dy);
      if (d > 5) {
        mon.x += (dx / d) * mon.speed * 0.3 * dt;
        mon.y += (dy / d) * mon.speed * 0.3 * dt;
      }
    }
  }

  // ── Projectile physics ───────────────────────────────────────────────────────
  for (const [pid, proj] of Object.entries(projectiles)) {
    proj.x += proj.vx * dt;
    proj.y += proj.vy * dt;
    proj.distTraveled += Math.sqrt(proj.vx * proj.vx + proj.vy * proj.vy) * dt;

    let hit = false;

    if (proj.owner === 'player') {
      for (const mon of Object.values(monsters)) {
        const hitRadius = proj.type === 'magic' ? 3 : 2;
        if (dist(proj, mon) < hitRadius) {
          mon.hp -= proj.damage;
          pendingDamageNumbers.push({ x: mon.x, y: mon.y, amount: proj.damage, id: randomHex(8) });
          if (mon.hp <= 0) {
            const sd = mon.spawnDef;
            delete monsters[mon.id];
            setTimeout(() => spawnMonster(sd), 15000);
          }
          hit = true;
          break;
        }
      }
      if (!hit) {
        for (const p of alivePlayers) {
          if (p.id === proj.ownerId) continue;
          if (p.faction === proj.ownerFaction) continue;
          if (dist(proj, p) < 2) {
            p.hp -= proj.damage;
            pendingDamageNumbers.push({ x: p.x, y: p.y, amount: proj.damage, id: randomHex(8) });
            if (p.hp <= 0) killPlayer(p);
            hit = true;
            break;
          }
        }
      }
    }

    if (hit || proj.distTraveled > proj.maxDist ||
        proj.x < -MAP_WIDTH/2 || proj.x > MAP_WIDTH/2 ||
        proj.y < -MAP_HEIGHT/2 || proj.y > MAP_HEIGHT/2) {
      delete projectiles[pid];
    }
  }

  // ── Territory capture ─────────────────────────────────────────────────────────
  for (const terr of Object.values(territories)) {
    if (terr.isHQ) continue;

    const factionsOnPoint = {};
    for (const p of alivePlayers) {
      if (dist(p, terr) <= CAPTURE_RADIUS) {
        factionsOnPoint[p.faction] = (factionsOnPoint[p.faction] || 0) + 1;
      }
    }

    const factionList = Object.keys(factionsOnPoint);

    if (factionList.length === 0) {
      if (terr.captureProgress > 0 && terr.capturingFaction !== terr.owner) {
        terr.captureProgress = Math.max(0, terr.captureProgress - dt / CAPTURE_TIME * 0.5);
      }
      terr.contestedBy = [];
    } else if (factionList.length > 1) {
      terr.contestedBy = factionList;
    } else {
      const attackingFaction = factionList[0];
      terr.contestedBy = [];

      if (attackingFaction === terr.owner) {
        if (terr.capturingFaction && terr.capturingFaction !== terr.owner) {
          terr.captureProgress = Math.max(0, terr.captureProgress - dt / CAPTURE_TIME);
          if (terr.captureProgress <= 0) terr.capturingFaction = null;
        }
      } else {
        if (terr.capturingFaction && terr.capturingFaction !== attackingFaction) {
          terr.captureProgress = 0;
        }
        terr.capturingFaction = attackingFaction;
        terr.captureProgress += dt / CAPTURE_TIME;

        if (terr.captureProgress >= 1) {
          terr.captureProgress = 1;
          const oldOwner = terr.owner;
          terr.owner = attackingFaction;
          terr.capturingFaction = null;
          terr.captureProgress = 0;
          io.emit('territory_captured', { id: terr.id, name: terr.name, faction: attackingFaction, from: oldOwner });
        }
      }
    }
  }

  // ── Broadcast state ───────────────────────────────────────────────────────────
  const statePayload = {
    players:    Object.values(players).map(p => ({
      id:       p.id,
      name:     p.name,
      x:        p.x,
      y:        p.y,
      hp:       p.hp,
      maxHp:    p.maxHp,
      faction:  p.faction,
      class:    p.class,
      dead:     p.dead,
      facing:   p.facing,
      attacking: p.attacking,
    })),
    monsters:   Object.values(monsters).map(m => ({
      id:    m.id,
      x:     m.x,
      y:     m.y,
      type:  m.type,
      hp:    m.hp,
      maxHp: m.maxHp,
      aggro: m.aggro,
    })),
    territories: Object.values(territories).map(t => ({
      id:              t.id,
      name:            t.name,
      x:               t.x,
      y:               t.y,
      owner:           t.owner,
      captureProgress: t.captureProgress,
      capturingFaction: t.capturingFaction,
      contestedBy:     t.contestedBy,
      isHQ:            t.isHQ,
    })),
    projectiles: Object.values(projectiles).map(p => ({
      id:   p.id,
      x:    p.x,
      y:    p.y,
      type: p.type,
      vx:   p.vx,
      vy:   p.vy,
    })),
    damageNumbers: pendingDamageNumbers.splice(0),
  };

  io.emit('game_state', statePayload);
}

// ─── Player death ─────────────────────────────────────────────────────────────
function killPlayer(player) {
  if (player.dead) return;
  player.dead = true;
  player.hp   = 0;

  const sock = io.sockets.sockets.get(player.id);
  if (sock) sock.emit('you_died', { respawnIn: RESPAWN_TIME });

  setTimeout(() => {
    if (!players[player.id]) return;
    const spawn = FACTION_SPAWNS[player.faction];
    player.x    = spawn.x + (Math.random() - 0.5) * 60;
    player.y    = spawn.y + (Math.random() - 0.5) * 60;
    player.hp   = player.maxHp;
    player.dead = false;
    const s = io.sockets.sockets.get(player.id);
    if (s) s.emit('respawned', { x: player.x, y: player.y });
  }, RESPAWN_TIME * 1000);
}

// ─── Socket handlers ──────────────────────────────────────────────────────────
io.on('connection', socket => {
  console.log('connect:', socket.id);

  socket.on('join_game', ({ name, faction, class: cls }) => {
    if (!FACTION_SPAWNS[faction] || !CLASS_DEFS[cls]) {
      socket.emit('join_error', { msg: 'Invalid faction or class' });
      return;
    }
    const def   = CLASS_DEFS[cls];
    const spawn = FACTION_SPAWNS[faction];
    players[socket.id] = {
      id:          socket.id,
      name:        (name || 'Hero').slice(0, 20),
      x:           spawn.x + (Math.random() - 0.5) * 60,
      y:           spawn.y + (Math.random() - 0.5) * 60,
      hp:          def.hp,
      maxHp:       def.hp,
      faction,
      class:       cls,
      speed:       def.speed,
      damage:      def.damage,
      range:       def.range,
      atkRate:     def.atkRate,
      ranged:      def.ranged,
      projType:    def.projType || null,
      atkCooldown: 0,
      dead:        false,
      facing:      0,
      attacking:   false,
    };
    socket.emit('joined', {
      id:        socket.id,
      player:    players[socket.id],
      mapWidth:  MAP_WIDTH,
      mapHeight: MAP_HEIGHT,
    });
    console.log(`${name} joined as ${faction} ${cls}`);
  });

  socket.on('player_move', ({ x, y, facing }) => {
    const p = players[socket.id];
    if (!p || p.dead) return;
    p.x      = clamp(x, -MAP_WIDTH/2, MAP_WIDTH/2);
    p.y      = clamp(y, -MAP_HEIGHT/2, MAP_HEIGHT/2);
    p.facing = facing || 0;
  });

  socket.on('player_attack', ({ targetX, targetY }) => {
    const p = players[socket.id];
    if (!p || p.dead) return;

    const now = Date.now() / 1000;
    if (p.atkCooldownUntil && now < p.atkCooldownUntil) return;
    p.atkCooldownUntil = now + 1 / p.atkRate;
    p.attacking = true;
    setTimeout(() => { if (players[socket.id]) players[socket.id].attacking = false; }, 200);

    if (p.ranged) {
      const dx  = targetX - p.x;
      const dy  = targetY - p.y;
      const mag = Math.sqrt(dx * dx + dy * dy) || 1;
      const spd = 60;
      const id  = 'proj_' + (nextProjectileId++);
      const maxDist = p.projType === 'magic' ? 250 : 200;
      projectiles[id] = {
        id,
        x:            p.x,
        y:            p.y,
        vx:           (dx / mag) * spd,
        vy:           (dy / mag) * spd,
        type:         p.projType,
        damage:       p.damage,
        owner:        'player',
        ownerId:      p.id,
        ownerFaction: p.faction,
        maxDist,
        distTraveled: 0,
      };
    } else {
      for (const mon of Object.values(monsters)) {
        if (dist(p, mon) <= p.range) {
          mon.hp -= p.damage;
          pendingDamageNumbers.push({ x: mon.x, y: mon.y, amount: p.damage, id: randomHex(8) });
          if (mon.hp <= 0) {
            const sd = mon.spawnDef;
            delete monsters[mon.id];
            setTimeout(() => spawnMonster(sd), 15000);
          }
        }
      }
      for (const enemy of Object.values(players)) {
        if (enemy.id === p.id || enemy.faction === p.faction || enemy.dead) continue;
        if (dist(p, enemy) <= p.range) {
          enemy.hp -= p.damage;
          pendingDamageNumbers.push({ x: enemy.x, y: enemy.y, amount: p.damage, id: randomHex(8) });
          if (enemy.hp <= 0) killPlayer(enemy);
        }
      }
    }
  });

  socket.on('disconnect', () => {
    console.log('disconnect:', socket.id);
    delete players[socket.id];
  });
});

// ─── Boot ─────────────────────────────────────────────────────────────────────
initTerritories();
initMonsters();
setInterval(gameTick, TICK_MS);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Dungeon Front running on http://localhost:${PORT}`));
