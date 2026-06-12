// phaser.esm.js 只有 named exports（無 default）— Rollup build 會炸，必須用 namespace import
import * as Phaser from 'phaser'
import { io, type Socket } from 'socket.io-client'
import { GatherScene } from './scene'
import type { ChatEntry, Dir, Me, PlayerWire, RoomData, Weapon } from './types'

export interface EngineOpts {
  parent: HTMLElement
  me: Me
  avatar: string | null
  room: RoomData
  spawn: { x: number; y: number }
  onChat: (entry: ChatEntry) => void
  onPlayers: (list: PlayerWire[]) => void
  onRoomUpdated: () => void
  onConnectionChange: (ok: boolean) => void
}

export interface GatherHandle {
  game: Phaser.Game
  scene: GatherScene
  socket: Socket
  sendChat: (text: string) => void
  notifyRoomUpdated: () => void
  /** 換頭像：本地立即換 + 廣播給其他人 */
  changeAvatar: (filename: string) => void
  /** 給語音算距離音量用：自己 + 其他人的最新格子座標 */
  getPositions: () => { me: { x: number; y: number } | null; others: Array<{ userId: number; x: number; y: number }> }
  destroy: () => void
}

/**
 * WS 位址規則：
 *  - 經 nginx 的正式站（無 port）→ 同源，path /gather-ws
 *  - 本機開發（localhost:3000 / 5184 等）→ 直連 :3101，path /gather-ws
 */
function connectSocket(): Socket {
  const opts = { path: '/gather-ws', withCredentials: true }
  if (!window.location.port || window.location.port === '80' || window.location.port === '443') {
    return io(opts)
  }
  return io(`${window.location.protocol}//${window.location.hostname}:3101`, opts)
}

export async function createGather(opts: EngineOpts): Promise<GatherHandle> {
  const meWire: PlayerWire = {
    sid: 'me',
    userId: opts.me.id,
    name: opts.me.display_name || opts.me.username,
    avatar: opts.avatar,
    x: opts.spawn.x,
    y: opts.spawn.y,
    dir: 'down',
  }

  let socket: Socket | null = null
  // scene.events 要等 SceneManager boot 後才存在，不能在 new 完就 once()；
  // 用 opts.onReady（scene create() 結尾呼叫）當就緒訊號
  let sceneReady!: () => void
  const readyPromise = new Promise<void>((resolve) => { sceneReady = resolve })
  const scene = new GatherScene({
    room: opts.room,
    me: meWire,
    onReady: () => sceneReady(),
    onMoveStep: (x: number, y: number, dir: Dir) => socket?.emit('move', { x, y, dir }),
    onAttack: () => socket?.emit('attack'),
  })

  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: opts.parent,
    // RESIZE：canvas 跟著容器大小走，地圖用攝影機（跟隨+縮放）瀏覽
    width: opts.parent.clientWidth || 800,
    height: opts.parent.clientHeight || 600,
    backgroundColor: '#0d0f14',
    roundPixels: true,
    scale: {
      mode: Phaser.Scale.RESIZE,
      autoCenter: Phaser.Scale.NO_CENTER,
    },
    scene,
  })

  await readyPromise

  socket = connectSocket()
  const others = new Map<string, PlayerWire>()
  let mySid = 'me'
  const emitPlayers = () =>
    opts.onPlayers([{ ...meWire, sid: mySid }, ...others.values()])

  socket.on('connect', () => opts.onConnectionChange(true))
  socket.on('disconnect', () => opts.onConnectionChange(false))
  socket.on('connect_error', () => opts.onConnectionChange(false))

  socket.on('init', (data: { sid: string; players: PlayerWire[] }) => {
    mySid = data.sid
    scene.setMySid(data.sid)
    scene.removeAllRemote()
    others.clear()
    for (const p of data.players) {
      if (p.sid === data.sid) continue
      others.set(p.sid, p)
      scene.addRemotePlayer(p)
    }
    emitPlayers()
  })

  socket.on('player-joined', (p: PlayerWire) => {
    others.set(p.sid, p)
    scene.addRemotePlayer(p)
    emitPlayers()
  })

  socket.on('player-moved', (m: { sid: string; x: number; y: number; dir: Dir }) => {
    const p = others.get(m.sid)
    if (p) { p.x = m.x; p.y = m.y; p.dir = m.dir }
    scene.applyRemoteMove(m.sid, m.x, m.y, m.dir)
  })

  socket.on('player-left', ({ sid }: { sid: string }) => {
    others.delete(sid)
    scene.removePlayer(sid)
    emitPlayers()
  })

  socket.on('chat', (c: { sid: string; userId: number; name: string; text: string }) => {
    scene.showBubble(c.sid, c.text)
    opts.onChat({ ...c, at: Date.now() })
  })

  socket.on('room-updated', () => opts.onRoomUpdated())

  socket.on('avatar-updated', (a: { sid: string; avatar: string }) => {
    const p = others.get(a.sid)
    if (p) p.avatar = a.avatar
    scene.updateAvatar(a.sid, a.avatar)
  })

  // ---------- 打架 ----------
  socket.on('attacked', (a: { sid: string; weapon: Weapon }) => {
    scene.playAttack(a.sid, a.weapon)
  })
  socket.on('hp', (h: { sid: string; hp: number; dmg?: number }) => {
    scene.setHp(h.sid, h.hp, h.dmg)
  })
  socket.on('died', (d: { sid: string; name: string; by: string; x: number; y: number; ms: number }) => {
    const p = others.get(d.sid)
    if (p) { p.x = d.x; p.y = d.y }
    scene.applyDeath(d.sid, d.x, d.y, d.ms)
    opts.onChat({ sid: 'sys', userId: 0, name: '💀', text: `${d.name} 被 ${d.by} 打昏了，左上角罰站 5 秒`, at: Date.now() })
  })
  socket.on('revived', (r: { sid: string; hp: number }) => {
    scene.applyRevive(r.sid, r.hp)
  })

  return {
    game,
    scene,
    socket,
    sendChat: (text: string) => socket?.emit('chat', text),
    notifyRoomUpdated: () => socket?.emit('room-updated'),
    changeAvatar: (filename: string) => {
      meWire.avatar = filename
      scene.updateAvatar(mySid, filename)
      socket?.emit('avatar-changed', filename)
    },
    getPositions: () => ({
      me: scene.getMyPosition(),
      others: [...others.values()].map(o => ({ userId: o.userId, x: o.x, y: o.y })),
    }),
    destroy: () => {
      socket?.disconnect()
      game.destroy(true)
    },
  }
}
