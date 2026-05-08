// Co-op zombie FPS server. Serves index.html + a WebSocket game loop.
// Players are friendlies (no PvP). Server spawns waves of zombies that chase
// nearest alive player and melee-attack on contact. Two hits kill a player.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const TICK_HZ = 20;
const TICK_DT = 1 / TICK_HZ;

const RESPAWN_MS = 3000;
const MAX_HP = 100;

// Player gun
const SHOOT_RANGE = 80;
const SHOOT_DAMAGE = 35;

// Zombies
const ZOMBIE_HP = 70;            // ~2 shots at 35dmg
const ZOMBIE_SPEED_BASE = 2.6;   // m/s
const ZOMBIE_RADIUS = 0.45;
const ZOMBIE_HEIGHT = 1.8;
const ZOMBIE_ATTACK_RANGE = 1.6;
const ZOMBIE_ATTACK_COOLDOWN_MS = 1000;
const ZOMBIE_DAMAGE = 50;        // 2 hits = dead

const ARENA_HALF = 30;
const WAVE_COOLDOWN_MS = 5000;

const SPAWN_POINTS = [
  { x: -25, y: 1.6, z: -25 }, { x:  25, y: 1.6, z: -25 },
  { x: -25, y: 1.6, z:  25 }, { x:  25, y: 1.6, z:  25 },
  { x:   0, y: 1.6, z: -22 }, { x:   0, y: 1.6, z:  22 },
];

// Zombies spawn around the arena edge, away from interior.
const ZOMBIE_SPAWN_POINTS = [
  { x: -28, z: -28 }, { x: 28, z: -28 }, { x: -28, z: 28 }, { x: 28, z: 28 },
  { x:   0, z: -28 }, { x:  0, z:  28 }, { x: -28, z:  0 }, { x: 28, z:  0 },
];

const MAP = [
  // Outer walls (60x60 arena)
  { x:  0, y: 2, z: -30, w: 60, h: 4, d: 1 },
  { x:  0, y: 2, z:  30, w: 60, h: 4, d: 1 },
  { x: -30, y: 2, z:  0, w:  1, h: 4, d: 60 },
  { x:  30, y: 2, z:  0, w:  1, h: 4, d: 60 },
  // Cover crates and pillars
  { x: -10, y: 1,    z: -5,  w: 4, h: 2,   d: 4 },
  { x:  10, y: 1,    z:  5,  w: 4, h: 2,   d: 4 },
  { x:   0, y: 1.5,  z:  0,  w: 6, h: 3,   d: 2 },
  { x: -15, y: 1,    z:  15, w: 3, h: 2,   d: 3 },
  { x:  15, y: 1,    z: -15, w: 3, h: 2,   d: 3 },
  { x:   8, y: 2,    z: -12, w: 2, h: 4,   d: 2 },
  { x:  -8, y: 2,    z:  12, w: 2, h: 4,   d: 2 },
  { x: -20, y: 0.75, z: -10, w: 2, h: 1.5, d: 6 },
  { x:  20, y: 0.75, z:  10, w: 2, h: 1.5, d: 6 },
];

const COLORS = ['#ef4444','#3b82f6','#10b981','#f59e0b','#a855f7','#ec4899','#06b6d4','#84cc16'];

const players = new Map();
const zombies = new Map();
let nextPlayerId = 1;
let nextZombieId = 1;
let wave = 0;
let waveStartScheduled = false;

function pickPlayerSpawn() {
  return SPAWN_POINTS[Math.floor(Math.random() * SPAWN_POINTS.length)];
}
function pickZombieSpawn() {
  const sp = ZOMBIE_SPAWN_POINTS[Math.floor(Math.random() * ZOMBIE_SPAWN_POINTS.length)];
  return { x: sp.x + (Math.random() - 0.5) * 2, z: sp.z + (Math.random() - 0.5) * 2 };
}
function pickColor() {
  const used = new Set([...players.values()].map(p => p.color));
  for (const c of COLORS) if (!used.has(c)) return c;
  return COLORS[Math.floor(Math.random() * COLORS.length)];
}
function publicPlayer(p) {
  return {
    id: p.id, name: p.name, color: p.color,
    x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch,
    hp: p.hp, score: p.score, deaths: p.deaths, alive: p.alive,
  };
}
function publicZombie(z) {
  return { id: z.id, x: +z.x.toFixed(2), y: +z.y.toFixed(2), z: +z.z.toFixed(2),
           yaw: +z.yaw.toFixed(3), hp: z.hp, attacking: !!z.attacking };
}
function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}
function broadcast(obj, exceptWs) {
  const s = JSON.stringify(obj);
  for (const p of players.values()) {
    if (p.ws !== exceptWs && p.ws.readyState === 1) p.ws.send(s);
  }
}

// Static file server.
const server = http.createServer((req, res) => {
  let url = req.url.split('?')[0];
  if (url === '/') url = '/index.html';
  const file = path.normalize(path.join(__dirname, url));
  if (!file.startsWith(__dirname)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    const ext = path.extname(file).toLowerCase();
    const types = { '.html':'text/html; charset=utf-8', '.js':'application/javascript', '.css':'text/css' };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  const id = String(nextPlayerId++);
  const sp = pickPlayerSpawn();
  const player = {
    ws, id,
    name: `Player${id}`,
    color: pickColor(),
    x: sp.x, y: sp.y, z: sp.z,
    yaw: 0, pitch: 0,
    hp: MAX_HP, score: 0, deaths: 0,
    alive: true, respawnAt: 0,
    lastShotAt: 0,
  };
  players.set(id, player);

  send(ws, {
    type: 'welcome',
    id,
    you: publicPlayer(player),
    map: MAP,
    arena: ARENA_HALF,
    config: { maxHp: MAX_HP, range: SHOOT_RANGE, damage: SHOOT_DAMAGE,
              zombieAttackRange: ZOMBIE_ATTACK_RANGE, zombieDamage: ZOMBIE_DAMAGE },
    players: [...players.values()].map(publicPlayer),
    zombies: [...zombies.values()].filter(z => z.alive).map(publicZombie),
    wave,
  });
  broadcast({ type: 'join', player: publicPlayer(player) }, ws);

  // First connection seeds wave 1.
  if (wave === 0 && zombies.size === 0 && !waveStartScheduled) {
    waveStartScheduled = true;
    setTimeout(spawnNextWave, 2500);
  }

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    const p = players.get(id);
    if (!p) return;

    switch (m.type) {
      case 'name': {
        if (typeof m.name === 'string') {
          const cleaned = m.name.slice(0, 16).replace(/[^\w \-]/g, '').trim();
          if (cleaned) {
            p.name = cleaned;
            broadcast({ type: 'rename', id: p.id, name: p.name });
          }
        }
        break;
      }

      case 'state': {
        if (!p.alive) return;
        if (![m.x, m.y, m.z, m.yaw, m.pitch].every(Number.isFinite)) return;
        p.x = Math.max(-ARENA_HALF + 0.5, Math.min(ARENA_HALF - 0.5, m.x));
        p.y = Math.max(0, Math.min(50, m.y));
        p.z = Math.max(-ARENA_HALF + 0.5, Math.min(ARENA_HALF - 0.5, m.z));
        p.yaw = m.yaw;
        p.pitch = m.pitch;
        break;
      }

      case 'shoot': {
        if (!p.alive) return;
        const now = Date.now();
        if (now - p.lastShotAt < 90) return;
        p.lastShotAt = now;

        const from = Array.isArray(m.from) ? m.from : [p.x, p.y, p.z];
        const to   = Array.isArray(m.to)   ? m.to   : [p.x, p.y, p.z];
        const targetType = m.targetType;
        const tid = m.target ? String(m.target) : null;

        let hitOk = false, hitTarget = null;
        if (targetType === 'zombie' && tid) {
          const z = zombies.get(tid);
          if (z && z.alive) {
            const dx = z.x - p.x, dy = (z.y + 1.0) - p.y, dz = z.z - p.z;
            const dist2 = dx*dx + dy*dy + dz*dz;
            if (dist2 <= SHOOT_RANGE * SHOOT_RANGE) {
              hitOk = true;
              hitTarget = tid;
              z.hp -= SHOOT_DAMAGE;
              if (z.hp <= 0) {
                z.alive = false;
                z.deathTime = now;
                p.score += 1;
                broadcast({ type: 'zkill', zombie: z.id, killer: p.id,
                            killerScore: p.score, killerName: p.name });
              } else {
                broadcast({ type: 'zhit', zombie: z.id, hp: z.hp, by: p.id });
              }
            }
          }
        }
        broadcast({ type: 'shot', shooter: p.id, hit: hitOk,
                    target: hitTarget, targetType: hitOk ? 'zombie' : null,
                    from, to });
        break;
      }

      case 'chat': {
        if (typeof m.text !== 'string') return;
        const text = m.text.slice(0, 140).trim();
        if (!text) return;
        broadcast({ type: 'chat', from: p.id, name: p.name, text });
        break;
      }
    }
  });

  ws.on('close', () => {
    players.delete(id);
    broadcast({ type: 'leave', id });
    // Stop spawning waves if everyone left
    if (players.size === 0) {
      zombies.clear();
      wave = 0;
      waveStartScheduled = false;
    }
  });
});

// ---------- Zombie AI / wave logic ----------

function spawnNextWave() {
  waveStartScheduled = false;
  if (players.size === 0) return;
  wave += 1;
  const count = 2 + wave * 2;
  const speedMul = 1 + (wave - 1) * 0.06;
  const newOnes = [];
  for (let i = 0; i < count; i++) {
    const sp = pickZombieSpawn();
    const z = {
      id: 'z' + (nextZombieId++),
      x: sp.x, y: 0, z: sp.z,
      yaw: 0,
      hp: ZOMBIE_HP,
      maxHp: ZOMBIE_HP,
      alive: true,
      attacking: false,
      speed: ZOMBIE_SPEED_BASE * speedMul,
      lastAttackAt: 0,
      deathTime: 0,
    };
    zombies.set(z.id, z);
    newOnes.push(publicZombie(z));
  }
  broadcast({ type: 'wave', wave, zombies: newOnes });
}

function aabbBlocksZombie(b, x, z) {
  // Treat zombie as a vertical column from y=0 to y=ZOMBIE_HEIGHT.
  const minX = b.x - b.w / 2, maxX = b.x + b.w / 2;
  const minY = b.y - b.h / 2, maxY = b.y + b.h / 2;
  const minZ = b.z - b.d / 2, maxZ = b.z + b.d / 2;
  if (maxY < 0 || minY > ZOMBIE_HEIGHT) return null;
  if (x + ZOMBIE_RADIUS > minX && x - ZOMBIE_RADIUS < maxX &&
      z + ZOMBIE_RADIUS > minZ && z - ZOMBIE_RADIUS < maxZ) {
    return { minX, maxX, minZ, maxZ };
  }
  return null;
}

function moveZombieXZ(z, dx, dz) {
  const oldX = z.x, oldZ = z.z;
  z.x += dx;
  for (const b of MAP) {
    const r = aabbBlocksZombie(b, z.x, z.z);
    if (!r) continue;
    if (oldX <= r.minX) z.x = r.minX - ZOMBIE_RADIUS - 0.001;
    else if (oldX >= r.maxX) z.x = r.maxX + ZOMBIE_RADIUS + 0.001;
  }
  z.z += dz;
  for (const b of MAP) {
    const r = aabbBlocksZombie(b, z.x, z.z);
    if (!r) continue;
    if (oldZ <= r.minZ) z.z = r.minZ - ZOMBIE_RADIUS - 0.001;
    else if (oldZ >= r.maxZ) z.z = r.maxZ + ZOMBIE_RADIUS + 0.001;
  }
  // Clamp arena
  const lim = ARENA_HALF - 0.5;
  if (z.x < -lim) z.x = -lim; else if (z.x > lim) z.x = lim;
  if (z.z < -lim) z.z = -lim; else if (z.z > lim) z.z = lim;
}

function tickAI(dt) {
  const alivePlayers = [...players.values()].filter(p => p.alive);

  for (const z of zombies.values()) {
    if (!z.alive) continue;

    // Pick nearest alive player
    let target = null, bd2 = Infinity;
    for (const p of alivePlayers) {
      const dx = p.x - z.x, dz = p.z - z.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bd2) { bd2 = d2; target = p; }
    }
    if (!target) { z.attacking = false; continue; }

    const dx = target.x - z.x, dz = target.z - z.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    // In Three.js, rotation.y rotates -Z (forward) so it points at the target.
    z.yaw = Math.atan2(-dx, -dz);

    if (dist > ZOMBIE_ATTACK_RANGE) {
      z.attacking = false;
      const inv = dist > 0 ? 1 / dist : 0;
      const vx = dx * inv * z.speed;
      const vz = dz * inv * z.speed;
      moveZombieXZ(z, vx * dt, vz * dt);
    } else {
      // In range: attack on cooldown
      z.attacking = true;
      const now = Date.now();
      if (now - z.lastAttackAt >= ZOMBIE_ATTACK_COOLDOWN_MS) {
        z.lastAttackAt = now;
        target.hp -= ZOMBIE_DAMAGE;
        if (target.hp <= 0) {
          target.hp = 0;
          target.alive = false;
          target.deaths += 1;
          target.respawnAt = now + RESPAWN_MS;
          broadcast({ type: 'death', victim: target.id, by: 'zombie',
                      victimName: target.name, deaths: target.deaths });
        } else {
          broadcast({ type: 'attack', zombie: z.id, target: target.id,
                      damage: ZOMBIE_DAMAGE, hp: target.hp });
        }
      }
    }
  }

  // Remove zombies that have been dead a while (so the death animation can play client-side).
  const now = Date.now();
  for (const [id, z] of zombies) {
    if (!z.alive && now - z.deathTime > 1500) zombies.delete(id);
  }

  // Schedule next wave if all dead.
  const remaining = [...zombies.values()].filter(z => z.alive).length;
  if (remaining === 0 && !waveStartScheduled && players.size > 0) {
    waveStartScheduled = true;
    setTimeout(spawnNextWave, WAVE_COOLDOWN_MS);
  }
}

// ---------- Main tick ----------

setInterval(() => {
  tickAI(TICK_DT);

  const now = Date.now();
  for (const p of players.values()) {
    if (!p.alive && now >= p.respawnAt) {
      const sp = pickPlayerSpawn();
      p.x = sp.x; p.y = sp.y; p.z = sp.z;
      p.hp = MAX_HP;
      p.alive = true;
      broadcast({ type: 'respawn', id: p.id, x: p.x, y: p.y, z: p.z, hp: p.hp });
    }
  }

  const snap = {
    type: 'snap',
    t: now,
    wave,
    zombiesLeft: [...zombies.values()].filter(z => z.alive).length,
    players: [...players.values()].map(p => ({
      id: p.id,
      x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2),
      yaw: +p.yaw.toFixed(3), pitch: +p.pitch.toFixed(3),
      hp: p.hp, score: p.score, deaths: p.deaths, alive: p.alive,
    })),
    zombies: [...zombies.values()].filter(z => z.alive).map(publicZombie),
  };
  broadcast(snap);
}, 1000 / TICK_HZ);

server.listen(PORT, () => {
  console.log(`Co-op zombie FPS server on http://localhost:${PORT}`);
});
