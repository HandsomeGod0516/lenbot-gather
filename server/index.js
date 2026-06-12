import http from 'node:http'
import { Server } from 'socket.io'

/**
 * gather 即時同步伺服器（位置 / 聊天）。
 *
 * 不碰 DB、不存 secret：身分驗證與位置持久化都拿使用者自己的
 * lenbot_session cookie 轉呼叫 portal-main 的 API，portal 永遠是唯一權威。
 *
 * env：
 *   GATHER_WS_PORT  監聽埠（預設 3101）
 *   PORTAL_API      portal-main 位址（預設 http://127.0.0.1:3000）
 *   PUBLIC_ORIGIN   正式站 origin，給 CORS 白名單（預設 https://lenbotai.com）
 */

const PORT = Number(process.env.GATHER_WS_PORT || 3101)
const PORTAL_API = process.env.PORTAL_API || 'http://127.0.0.1:3000'
const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN || 'https://lenbotai.com'
const ROOM = 'main'

const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' })
  res.end('gather-ws ok')
})

const io = new Server(httpServer, {
  path: '/gather-ws',
  cors: {
    origin(origin, cb) {
      if (!origin) return cb(null, true) // 同源請求
      const ok = origin === PUBLIC_ORIGIN
        || origin === 'https://www.lenbotai.com'
        || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
      cb(ok ? null : new Error('origin not allowed'), ok)
    },
    credentials: true,
  },
})

async function portalGet(path, cookie) {
  const res = await fetch(`${PORTAL_API}${path}`, {
    headers: { cookie },
    signal: AbortSignal.timeout(5000),
  })
  if (!res.ok) return null
  return res.json()
}

// 連線即驗證：拿 handshake cookie 問 portal 這是誰
io.use(async (socket, next) => {
  try {
    const cookie = socket.handshake.headers.cookie || ''
    if (!cookie.includes('lenbot_session=')) return next(new Error('unauthorized'))

    const meRes = await portalGet('/api/auth/me', cookie)
    if (!meRes?.user) return next(new Error('unauthorized'))

    const profRes = await portalGet('/api/gather/profile', cookie)
    const prof = profRes?.profile || {}

    socket.data.cookie = cookie
    socket.data.user = meRes.user
    socket.data.spawn = {
      x: Number.isInteger(prof.last_x) ? prof.last_x : 3,
      y: Number.isInteger(prof.last_y) ? prof.last_y : 3,
      avatar: prof.avatar_filename || null,
    }
    next()
  } catch {
    next(new Error('auth failed'))
  }
})

/** sid → { userId, name, avatar, role, x, y, dir } */
const players = new Map()

const wire = (sid, p) => ({
  sid, userId: p.userId, name: p.name, avatar: p.avatar, x: p.x, y: p.y, dir: p.dir,
  hp: p.hp, ko: Math.max(0, p.koUntil - Date.now()),
})

// ---------- 打架（純娛樂）----------
// 命中與血量由伺服器仲裁；admin 拿棒球棍、其他人用拳頭
const WEAPONS = {
  bat: { dmg: 34, cd: 600 },
  fist: { dmg: 15, cd: 450 },
}
const HIT_RANGE = 1.9   // 格
const MAX_HP = 100
const KO_MS = 5000
const KO_POS = { x: 1, y: 1 }  // 被打死丟到左上角

io.on('connection', (socket) => {
  const u = socket.data.user
  const s = socket.data.spawn
  const player = {
    userId: u.id,
    name: u.display_name || u.username,
    avatar: s.avatar,
    role: u.role,
    x: s.x,
    y: s.y,
    dir: 'down',
    hp: MAX_HP,
    koUntil: 0,
    lastAttack: 0,
    weapon: u.role === 'admin' ? 'bat' : 'fist',
  }

  socket.join(ROOM)
  socket.emit('init', {
    sid: socket.id,
    players: [...players.entries()].map(([sid, p]) => wire(sid, p)),
  })
  players.set(socket.id, player)
  socket.to(ROOM).emit('player-joined', wire(socket.id, player))

  socket.on('move', (m) => {
    if (player.koUntil > Date.now()) return // 昏倒中不能動
    const x = Number(m?.x), y = Number(m?.y)
    const dir = ['down', 'left', 'right', 'up'].includes(m?.dir) ? m.dir : 'down'
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x > 199 || y > 199) return
    player.x = x; player.y = y; player.dir = dir
    socket.to(ROOM).emit('player-moved', { sid: socket.id, x, y, dir })
  })

  // Z 揮擊：範圍內所有人掉血；歸零 → 丟到左上角 KO 5 秒後滿血復活
  socket.on('attack', () => {
    const now = Date.now()
    if (player.koUntil > now) return
    const w = WEAPONS[player.weapon]
    if (now - player.lastAttack < w.cd) return
    player.lastAttack = now
    io.to(ROOM).emit('attacked', { sid: socket.id, weapon: player.weapon })

    for (const [sid, p] of players) {
      if (sid === socket.id || p.koUntil > now) continue
      if (Math.hypot(p.x - player.x, p.y - player.y) > HIT_RANGE) continue
      p.hp = Math.max(0, p.hp - w.dmg)
      if (p.hp > 0) {
        io.to(ROOM).emit('hp', { sid, hp: p.hp, dmg: w.dmg })
        continue
      }
      p.koUntil = now + KO_MS
      p.x = KO_POS.x
      p.y = KO_POS.y
      io.to(ROOM).emit('died', {
        sid, name: p.name, by: player.name,
        x: p.x, y: p.y, ms: KO_MS,
      })
      setTimeout(() => {
        if (players.get(sid) !== p) return // 已離線
        p.hp = MAX_HP
        p.koUntil = 0
        io.to(ROOM).emit('revived', { sid, hp: MAX_HP })
      }, KO_MS)
    }
  })

  socket.on('chat', (raw) => {
    const text = String(raw ?? '').trim().slice(0, 200)
    if (!text) return
    io.to(ROOM).emit('chat', { sid: socket.id, userId: player.userId, name: player.name, text })
  })

  // 換頭像：驗證檔名是自己的（gather_av_<uid>_ 前綴）再廣播
  socket.on('avatar-changed', (raw) => {
    const filename = String(raw ?? '')
    if (!filename.startsWith(`gather_av_${player.userId}_`) || !/^gather_av_[0-9]+_[0-9a-fA-F-]+\.webp$/.test(filename)) return
    player.avatar = filename
    socket.to(ROOM).emit('avatar-updated', { sid: socket.id, avatar: filename })
  })

  // admin 存了新佈置 → 通知其他人重抓 room
  socket.on('room-updated', () => {
    if (player.role === 'admin') socket.to(ROOM).emit('room-updated')
  })

  socket.on('disconnect', () => {
    players.delete(socket.id)
    socket.to(ROOM).emit('player-left', { sid: socket.id })
    // 用使用者自己的 cookie 持久化最後位置；失敗就算了
    fetch(`${PORTAL_API}/api/gather/position`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: socket.data.cookie },
      body: JSON.stringify({ x: player.x, y: player.y }),
      signal: AbortSignal.timeout(5000),
    }).catch(() => {})
  })
})

httpServer.listen(PORT, () => {
  console.log(`gather-ws listening on :${PORT} (portal: ${PORTAL_API})`)
})
