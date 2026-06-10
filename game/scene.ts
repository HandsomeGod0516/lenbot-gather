// phaser.esm.js 只有 named exports（無 default）— Rollup build 會炸，必須用 namespace import
import * as Phaser from 'phaser'
import type { Dir, Furniture, PlayerWire, RoomData, RoomItem } from './types'
import { BODY_H, ensureBodySheet, shirtColorFor } from './body'
import { ensureFallbackHead, loadCircleAvatar } from './avatar'

const STEP_MS = 170
const HEAD = 30                    // 照片頭顯示直徑 px
const HEAD_Y = -25                 // 頭中心相對 container 的 y
const DX: Record<Dir, number> = { down: 0, up: 0, left: -1, right: 1 }
const DY: Record<Dir, number> = { down: 1, up: -1, left: 0, right: 0 }

interface PlayerSprite {
  wire: PlayerWire
  container: Phaser.GameObjects.Container
  body: Phaser.GameObjects.Sprite
  head: Phaser.GameObjects.Image
  bubble: Phaser.GameObjects.Container | null
  bubbleTimer: Phaser.Time.TimerEvent | null
  idleTimer: Phaser.Time.TimerEvent | null
  bodyKey: string
}

interface ItemSprite {
  item: RoomItem
  img: Phaser.GameObjects.Image
}

export interface SceneOpts {
  room: RoomData
  me: PlayerWire
  onReady: (scene: GatherScene) => void
  onMoveStep: (x: number, y: number, dir: Dir) => void
}

/**
 * 房間場景。Vue 透過公開方法溝通；scene → Vue 用 this.events：
 *   'editor' { hasSelection, dirty, placing }   編輯狀態變動
 */
export class GatherScene extends Phaser.Scene {
  private opts: SceneOpts
  private room: RoomData
  private T: number

  private mePlayer: PlayerSprite | null = null
  private mySid = 'me'
  private players = new Map<string, PlayerSprite>()
  private blocked: boolean[][] = []
  private furnitureById = new Map<number, Furniture>()
  private itemSprites: ItemSprite[] = []

  private meMoving = false
  private typing = false
  private lastSent = ''
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys
  private wasd!: Record<'W' | 'A' | 'S' | 'D', Phaser.Input.Keyboard.Key>

  // 編輯模式
  private editMode = false
  private dirty = false
  private placingId: number | null = null
  private ghost: Phaser.GameObjects.Image | null = null
  private selected: ItemSprite | null = null
  private nextTempId = -1

  constructor(opts: SceneOpts) {
    super({ key: 'gather' })
    this.opts = opts
    this.room = opts.room
    this.T = opts.room.tile
  }

  // ---------- lifecycle ----------

  preload() {
    for (const f of this.room.furniture) {
      this.load.image(this.furKey(f), `/api/gather/assets/${f.image_filename}`)
    }
  }

  create() {
    this.furnitureById = new Map(this.room.furniture.map(f => [f.id, f]))
    this.drawFloor()
    this.redrawItems()

    this.mePlayer = this.buildPlayer(this.opts.me, true)

    const kb = this.input.keyboard!
    this.cursors = kb.createCursorKeys()
    this.wasd = kb.addKeys('W,A,S,D') as GatherScene['wasd']
    this.input.mouse?.disableContextMenu()

    this.input.on('pointermove', (p: Phaser.Input.Pointer) => this.onPointerMove(p))
    this.input.on('pointerdown', (p: Phaser.Input.Pointer, over: unknown[]) => this.onPointerDown(p, over))
    this.input.on('drag', (_p: Phaser.Input.Pointer, obj: Phaser.GameObjects.GameObject, dragX: number, dragY: number) => {
      if (!this.editMode) return
      const rec = this.itemSprites.find(r => r.img === obj)
      if (!rec) return
      const fur = this.furnitureById.get(rec.item.furniture_id)
      if (!fur) return
      rec.img.setPosition(
        this.clamp(Math.round(dragX / this.T), 0, this.room.width - fur.tile_w) * this.T,
        this.clamp(Math.round(dragY / this.T), 0, this.room.height - fur.tile_h) * this.T,
      )
    })
    this.input.on('dragend', (_p: Phaser.Input.Pointer, obj: Phaser.GameObjects.GameObject) => {
      if (!this.editMode) return
      const rec = this.itemSprites.find(r => r.img === obj)
      if (!rec) return
      const nx = Math.round(rec.img.x / this.T)
      const ny = Math.round(rec.img.y / this.T)
      if (nx !== rec.item.x || ny !== rec.item.y) {
        rec.item.x = nx
        rec.item.y = ny
        this.setItemDepth(rec)
        this.rebuildBlocked()
        this.markDirty()
      }
    })

    this.opts.onReady(this)
  }

  update() {
    if (!this.mePlayer || this.editMode || this.typing || this.meMoving) return
    const dir = this.heldDir()
    if (dir) this.tryStep(dir)
  }

  // ---------- 地圖 ----------

  private furKey(f: Furniture | string) {
    return `fur-${typeof f === 'string' ? f : f.image_filename}`
  }

  private drawFloor() {
    const { width: w, height: h } = this.room
    const T = this.T
    const g = this.add.graphics().setDepth(-10000)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        g.fillStyle((x + y) % 2 ? 0x222633 : 0x1e2230, 1)
        g.fillRect(x * T, y * T, T, T)
      }
    }
    g.lineStyle(1, 0xffffff, 0.03)
    for (let x = 1; x < w; x++) g.lineBetween(x * T, 0, x * T, h * T)
    for (let y = 1; y < h; y++) g.lineBetween(0, y * T, w * T, y * T)
    g.lineStyle(2, 0x3a4150, 1).strokeRect(1, 1, w * T - 2, h * T - 2)
  }

  private rebuildBlocked() {
    const { width: w, height: h } = this.room
    this.blocked = Array.from({ length: h }, () => Array(w).fill(false))
    for (const { item } of this.itemSprites) {
      const fur = this.furnitureById.get(item.furniture_id)
      if (!fur || !fur.is_solid) continue
      for (let dy = 0; dy < fur.tile_h; dy++) {
        for (let dx = 0; dx < fur.tile_w; dx++) {
          const yy = item.y + dy, xx = item.x + dx
          if (this.blocked[yy] && xx >= 0 && xx < w) this.blocked[yy][xx] = true
        }
      }
    }
  }

  private setItemDepth(rec: ItemSprite) {
    const fur = this.furnitureById.get(rec.item.furniture_id)
    rec.img.setDepth((rec.item.y + (fur?.tile_h ?? 1)) * this.T - 8)
  }

  private createItemSprite(item: RoomItem): ItemSprite | null {
    const fur = this.furnitureById.get(item.furniture_id)
    if (!fur || !this.textures.exists(this.furKey(fur))) return null
    const img = this.add.image(item.x * this.T, item.y * this.T, this.furKey(fur))
      .setOrigin(0)
      .setDisplaySize(fur.tile_w * this.T, fur.tile_h * this.T)
    const rec: ItemSprite = { item: { ...item }, img }
    this.setItemDepth(rec)
    if (this.editMode) this.makeItemInteractive(rec)
    this.itemSprites.push(rec)
    return rec
  }

  private redrawItems() {
    for (const r of this.itemSprites) r.img.destroy()
    this.itemSprites = []
    this.selected = null
    for (const item of this.room.items) this.createItemSprite(item)
    this.rebuildBlocked()
  }

  /** 家具庫或佈置有變（上傳新家具、別的 admin 儲存）→ 換新 room 資料重畫 */
  refreshRoom(room: RoomData) {
    this.room = room
    this.furnitureById = new Map(room.furniture.map(f => [f.id, f]))
    const missing = room.furniture.filter(f => !this.textures.exists(this.furKey(f)))
    if (missing.length) {
      for (const f of missing) this.load.image(this.furKey(f), `/api/gather/assets/${f.image_filename}`)
      this.load.once(Phaser.Loader.Events.COMPLETE, () => this.redrawItems())
      this.load.start()
    } else {
      this.redrawItems()
    }
  }

  // ---------- 玩家 ----------

  private buildPlayer(wire: PlayerWire, isMe: boolean): PlayerSprite {
    const T = this.T
    const bodyKey = `body-${Math.abs(wire.userId) % 8}`
    ensureBodySheet(this, bodyKey, shirtColorFor(wire.userId))

    const shadow = this.add.ellipse(0, 15, 26, 9, 0x000000, 0.35)
    const body = this.add.sprite(0, 16, bodyKey, `${wire.dir}-0`).setOrigin(0.5, 1)
    const fbKey = `head-fb-${wire.userId}`
    ensureFallbackHead(this, fbKey, wire.name, shirtColorFor(wire.userId))
    const head = this.add.image(0, HEAD_Y, fbKey).setDisplaySize(HEAD, HEAD)
    const nameText = this.add.text(0, 18, wire.name, {
      fontSize: '10px', fontFamily: 'Inter, sans-serif', color: isMe ? '#9ee6b8' : '#cdd3e0',
    }).setOrigin(0.5, 0).setShadow(0, 1, '#000000', 2)

    const cx = wire.x * T + T / 2
    const cy = wire.y * T + T / 2
    const container = this.add.container(cx, cy, [shadow, body, head, nameText]).setDepth(cy)

    const ps: PlayerSprite = {
      wire: { ...wire }, container, body, head,
      bubble: null, bubbleTimer: null, idleTimer: null, bodyKey,
    }
    if (wire.avatar) {
      const avKey = `head-${wire.avatar}`
      loadCircleAvatar(this, avKey, wire.avatar).then((ok) => {
        if (ok && ps.head.active) ps.head.setTexture(avKey).setDisplaySize(HEAD, HEAD)
      })
    }
    return ps
  }

  private destroyPlayer(ps: PlayerSprite) {
    ps.bubbleTimer?.remove()
    ps.idleTimer?.remove()
    this.tweens.killTweensOf(ps.container)
    ps.container.destroy()
  }

  private setFacing(ps: PlayerSprite, dir: Dir, moving: boolean) {
    if (moving) {
      ps.body.anims.play(`${ps.bodyKey}-walk-${dir}`, true)
    } else {
      ps.body.anims.stop()
      ps.body.setFrame(`${dir}-0`)
    }
  }

  setMySid(sid: string) { this.mySid = sid }

  addRemotePlayer(wire: PlayerWire) {
    this.removePlayer(wire.sid)
    this.players.set(wire.sid, this.buildPlayer(wire, false))
  }

  removePlayer(sid: string) {
    const ps = this.players.get(sid)
    if (ps) { this.destroyPlayer(ps); this.players.delete(sid) }
  }

  removeAllRemote() {
    for (const ps of this.players.values()) this.destroyPlayer(ps)
    this.players.clear()
  }

  applyRemoteMove(sid: string, x: number, y: number, dir: Dir) {
    const ps = this.players.get(sid)
    if (!ps) return
    ps.wire.x = x; ps.wire.y = y; ps.wire.dir = dir
    const tx = x * this.T + this.T / 2
    const ty = y * this.T + this.T / 2
    this.tweens.killTweensOf(ps.container)
    if (ps.container.x === tx && ps.container.y === ty) {
      this.setFacing(ps, dir, false)
      return
    }
    this.setFacing(ps, dir, true)
    this.tweens.add({
      targets: ps.container, x: tx, y: ty, duration: STEP_MS,
      onUpdate: () => ps.container.setDepth(ps.container.y),
    })
    ps.idleTimer?.remove()
    ps.idleTimer = this.time.delayedCall(STEP_MS + 90, () => this.setFacing(ps, ps.wire.dir, false))
  }

  // ---------- 自己移動 ----------

  private heldDir(): Dir | null {
    const c = this.cursors, k = this.wasd
    if (c.left.isDown || k.A.isDown) return 'left'
    if (c.right.isDown || k.D.isDown) return 'right'
    if (c.up.isDown || k.W.isDown) return 'up'
    if (c.down.isDown || k.S.isDown) return 'down'

    const p = this.input.activePointer
    if (p.isDown && this.mePlayer) {
      const dx = p.worldX - this.mePlayer.container.x
      const dy = p.worldY - this.mePlayer.container.y
      if (Math.abs(dx) < 14 && Math.abs(dy) < 14) return null
      if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? 'right' : 'left'
      return dy > 0 ? 'down' : 'up'
    }
    return null
  }

  private tryStep(dir: Dir) {
    const me = this.mePlayer!
    const w = me.wire
    const tx = w.x + DX[dir]
    const ty = w.y + DY[dir]
    const passable = tx >= 0 && ty >= 0 && tx < this.room.width && ty < this.room.height
      && !this.blocked[ty]?.[tx]

    if (!passable) {
      w.dir = dir
      this.setFacing(me, dir, false)
      this.sendMove(w.x, w.y, dir)
      return
    }

    w.x = tx; w.y = ty; w.dir = dir
    this.meMoving = true
    this.setFacing(me, dir, true)
    this.sendMove(tx, ty, dir)
    this.tweens.add({
      targets: me.container,
      x: tx * this.T + this.T / 2,
      y: ty * this.T + this.T / 2,
      duration: STEP_MS,
      onUpdate: () => me.container.setDepth(me.container.y),
      onComplete: () => {
        this.meMoving = false
        if (!this.heldDir()) this.setFacing(me, w.dir, false)
      },
    })
  }

  private sendMove(x: number, y: number, dir: Dir) {
    const key = `${x},${y},${dir}`
    if (key === this.lastSent) return
    this.lastSent = key
    this.opts.onMoveStep(x, y, dir)
  }

  /** 聊天輸入框 focus 時停掉遊戲鍵盤，避免邊打字邊走路 */
  setTyping(t: boolean) {
    this.typing = t
    const kb = this.input.keyboard
    if (!kb) return
    if (t) kb.disableGlobalCapture()
    else kb.enableGlobalCapture()
  }

  getMyPosition() {
    const w = this.mePlayer?.wire
    return w ? { x: w.x, y: w.y } : null
  }

  // ---------- 聊天泡泡 ----------

  showBubble(sid: string, text: string) {
    const ps = sid === this.mySid ? this.mePlayer : this.players.get(sid)
    if (!ps) return
    ps.bubble?.destroy()
    ps.bubbleTimer?.remove()

    const t = this.add.text(0, 0, text, {
      fontSize: '11px', fontFamily: 'Inter, sans-serif', color: '#181a20',
      wordWrap: { width: 150 }, align: 'center',
    }).setOrigin(0.5)
    const bw = t.width + 16
    const bh = t.height + 10
    const g = this.add.graphics()
    g.fillStyle(0xffffff, 0.95)
    g.fillRoundedRect(-bw / 2, -bh / 2, bw, bh, 7)
    g.fillTriangle(-4, bh / 2 - 1, 4, bh / 2 - 1, 0, bh / 2 + 5)

    const bub = this.add.container(0, HEAD_Y - HEAD / 2 - bh / 2 - 8, [g, t])
    ps.container.add(bub)
    ps.bubble = bub
    ps.bubbleTimer = this.time.delayedCall(4500, () => {
      this.tweens.add({ targets: bub, alpha: 0, duration: 350, onComplete: () => bub.destroy() })
      ps.bubble = null
    })
  }

  // ---------- 編輯模式（admin） ----------

  setEditMode(on: boolean) {
    this.editMode = on
    this.dirty = false
    this.setPlacing(null)
    this.clearSelection()
    for (const rec of this.itemSprites) {
      if (on) this.makeItemInteractive(rec)
      else { rec.img.disableInteractive(); rec.img.clearTint() }
    }
    if (this.mePlayer) this.setFacing(this.mePlayer, this.mePlayer.wire.dir, false)
    this.emitEditor()
  }

  private makeItemInteractive(rec: ItemSprite) {
    rec.img.setInteractive({ draggable: true, useHandCursor: true })
    rec.img.off('pointerdown')
    rec.img.on('pointerdown', () => {
      if (this.placingId !== null) return // 放置模式下點擊交給場景處理
      this.clearSelection()
      this.selected = rec
      rec.img.setTint(0x66ff99)
      this.emitEditor()
    })
  }

  private clearSelection() {
    this.selected?.img.clearTint()
    this.selected = null
  }

  setPlacing(furnitureId: number | null) {
    this.placingId = furnitureId
    this.ghost?.destroy()
    this.ghost = null
    if (furnitureId !== null) {
      const fur = this.furnitureById.get(furnitureId)
      if (fur && this.textures.exists(this.furKey(fur))) {
        this.ghost = this.add.image(0, 0, this.furKey(fur))
          .setOrigin(0).setAlpha(0.55).setDepth(999999)
          .setDisplaySize(fur.tile_w * this.T, fur.tile_h * this.T)
          .setVisible(false)
        this.clearSelection()
      } else {
        this.placingId = null
      }
    }
    this.emitEditor()
  }

  private onPointerMove(p: Phaser.Input.Pointer) {
    if (!this.editMode || this.placingId === null || !this.ghost) return
    const fur = this.furnitureById.get(this.placingId)
    if (!fur) return
    const tx = this.clamp(Math.floor(p.worldX / this.T), 0, this.room.width - fur.tile_w)
    const ty = this.clamp(Math.floor(p.worldY / this.T), 0, this.room.height - fur.tile_h)
    this.ghost.setPosition(tx * this.T, ty * this.T).setVisible(true)
  }

  private onPointerDown(p: Phaser.Input.Pointer, over: unknown[]) {
    if (!this.editMode) return
    if (p.rightButtonDown()) { this.setPlacing(null); return }
    if (this.placingId === null) {
      if (over.length === 0) { this.clearSelection(); this.emitEditor() }
      return
    }
    const fur = this.furnitureById.get(this.placingId)
    if (!fur) return
    const tx = this.clamp(Math.floor(p.worldX / this.T), 0, this.room.width - fur.tile_w)
    const ty = this.clamp(Math.floor(p.worldY / this.T), 0, this.room.height - fur.tile_h)
    const rec = this.createItemSprite({ id: this.nextTempId--, furniture_id: fur.id, x: tx, y: ty })
    if (rec) {
      this.rebuildBlocked()
      this.markDirty()
    }
  }

  deleteSelectedItem() {
    if (!this.selected) return
    this.itemSprites = this.itemSprites.filter(r => r !== this.selected)
    this.selected.img.destroy()
    this.selected = null
    this.rebuildBlocked()
    this.markDirty()
  }

  getItems(): RoomItem[] {
    return this.itemSprites.map(r => ({ ...r.item }))
  }

  clearDirty() {
    this.dirty = false
    this.emitEditor()
  }

  private markDirty() {
    this.dirty = true
    this.emitEditor()
  }

  private emitEditor() {
    this.events.emit('editor', {
      hasSelection: !!this.selected,
      dirty: this.dirty,
      placing: this.placingId,
    })
  }

  private clamp(v: number, min: number, max: number) {
    return Math.max(min, Math.min(max, v))
  }
}
