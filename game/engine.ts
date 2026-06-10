import Phaser from 'phaser'
import { io, type Socket } from 'socket.io-client'
import { GatherScene } from './scene'
import type { ChatEntry, Dir, Me, PlayerWire, RoomData } from './types'

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
  })

  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent: opts.parent,
    width: opts.room.width * opts.room.tile,
    height: opts.room.height * opts.room.tile,
    backgroundColor: '#0d0f14',
    roundPixels: true,
    scale: {
      mode: Phaser.Scale.FIT,
      autoCenter: Phaser.Scale.CENTER_BOTH,
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

  return {
    game,
    scene,
    socket,
    sendChat: (text: string) => socket?.emit('chat', text),
    notifyRoomUpdated: () => socket?.emit('room-updated'),
    destroy: () => {
      socket?.disconnect()
      game.destroy(true)
    },
  }
}
