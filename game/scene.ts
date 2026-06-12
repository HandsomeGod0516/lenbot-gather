// phaser.esm.js 只有 named exports（無 default）— Rollup build 會炸，必須用 namespace import
import * as Phaser from 'phaser'
import type { Dir, Furniture, PlayerWire, RoomData, RoomItem, Weapon } from './types'
import { ensureFallbackHead, loadCircleAvatar, shirtColorFor } from './avatar'

const STEP_MS = 170
const HEAD = 40                    // 照片頭顯示直徑 px（角色就是照片本人，不加像素身體）
const HEAD_Y = -8                  // 頭中心相對 container 的 y
const DX: Record<Dir, number> = { down: 0, up: 0, left: -1, right: 1 }
const DY: Record<Dir, number> = { down: 1, up: -1, left: 0, right: 0 }

interface PlayerSprite {
  wire: PlayerWire
  container: Phaser.GameObjects.Container
  head: Phaser.GameObjects.Image
  ring: Phaser.GameObjects.Arc        // 說話中的綠圈
  hpBar: Phaser.GameObjects.Graphics  // 頭上血條
  hp: number
  ko: boolean
  bubble: Phaser.GameObjects.Container | null
  bubbleTimer: Phaser.Time.TimerEvent | null
}

const MAX_HP = 100
const HP_BAR_W = 28
const HP_BAR_Y = -37                 // 血條相對 container 的 y（頭頂上方）

interface ItemSprite {
  item: RoomItem
  img: Phaser.GameObjects.Image
}

export interface SceneOpts {
  room: RoomData
  me: PlayerWire
  onReady: (scene: GatherScene) => void
  onMoveStep: (x: number, y: number, dir: Dir) => void
  onAttack: () => void
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
  private stunnedUntil = 0      // 被打死後的昏倒鎖定
  private lastAttackAt = 0
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

    // Enter 聚焦聊天框（打字中由 input 自己處理、不重複觸發）
    kb.on('keydown-ENTER', () => {
      if (!this.typing && !this.editMode) this.events.emit('chat-focus')
    })

    // Z 揮擊（命中由伺服器判定；本地只做節流）
    kb.on('keydown-Z', () => {
      const now = Date.now()
      if (this.typing || this.editMode || now < this.stunnedUntil) return
      if (now - this.lastAttackAt < 350) return
      this.lastAttackAt = now
      this.opts.onAttack()
    })

    // 攝影機：跟著自己、限制在地圖範圍內、可縮放
    const cam = this.cameras.main
    cam.setBounds(0, 0, this.room.width * this.T, this.room.height * this.T)
    cam.startFollow(this.mePlayer.container, true, 0.12, 0.12)
    cam.setZoom(this.clampZoom(1.25))
    this.scale.on(Phaser.Scale.Events.RESIZE, () => {
      cam.setZoom(this.clampZoom(cam.zoom))
    })
    this.input.on('wheel', (_p: Phaser.Input.Pointer, _o: unknown[], _dx: number, dy: number) => {
      this.adjustZoom(dy > 0 ? -0.12 : 0.12)
    })

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
    if (Date.now() < this.stunnedUntil) return // 昏倒中
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
    // 家具永遠墊在所有玩家底下（玩家 depth = container.y ≥ 0），
    // 家具彼此間仍照下緣排序
    const fur = this.furnitureById.get(rec.item.furniture_id)
    rec.img.setDepth(-5000 + (rec.item.y + (fur?.tile_h ?? 1)))
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

  /**
   * 家具庫或佈置有變（上傳新家具、別的 admin 儲存）→ 換新 room 資料重畫。
   * keepItems：編輯中上傳新家具時，畫布上的未儲存擺放是唯一真相，
   * 不能被 DB 內容清掉 — 只更新家具庫與 texture。
   */
  refreshRoom(room: RoomData, keepItems = false) {
    this.room = room
    this.furnitureById = new Map(room.furniture.map(f => [f.id, f]))
    const after = () => { if (keepItems) this.rebuildBlocked(); else this.redrawItems() }
    const missing = room.furniture.filter(f => !this.textures.exists(this.furKey(f)))
    if (missing.length) {
      for (const f of missing) this.load.image(this.furKey(f), `/api/gather/assets/${f.image_filename}`)
      this.load.once(Phaser.Loader.Events.COMPLETE, after)
      this.load.start()
    } else {
      after()
    }
  }

  // ---------- 玩家 ----------

  private buildPlayer(wire: PlayerWire, isMe: boolean): PlayerSprite {
    const T = this.T

    const shadow = this.add.ellipse(0, 14, 30, 10, 0x000000, 0.35)
    const ring = this.add.circle(0, HEAD_Y, HEAD / 2 + 3)
      .setStrokeStyle(2.5, 0x00d18a).setFillStyle(0, 0).setVisible(false)
    const fbKey = `head-fb-${wire.userId}`
    ensureFallbackHead(this, fbKey, wire.name, shirtColorFor(wire.userId))
    const head = this.add.image(0, HEAD_Y, fbKey).setDisplaySize(HEAD, HEAD)
    const nameText = this.add.text(0, 16, wire.name, {
      fontSize: '10px', fontFamily: 'Inter, sans-serif', color: isMe ? '#9ee6b8' : '#cdd3e0',
    }).setOrigin(0.5, 0).setShadow(0, 1, '#000000', 2)
    const hpBar = this.add.graphics()

    const cx = wire.x * T + T / 2
    const cy = wire.y * T + T / 2
    const container = this.add.container(cx, cy, [shadow, ring, head, nameText, hpBar]).setDepth(cy)

    const ps: PlayerSprite = {
      wire: { ...wire }, container, head, ring, hpBar,
      hp: wire.hp ?? MAX_HP, ko: false,
      bubble: null, bubbleTimer: null,
    }
    this.drawHp(ps)
    if ((wire.ko ?? 0) > 0) this.setKo(ps, true)
    if (wire.avatar) {
      const avKey = `head-${wire.avatar}`
      loadCircleAvatar(this, avKey, wire.avatar).then((ok) => {
        if (ok && ps.head.active) ps.head.setTexture(avKey).setDisplaySize(HEAD, HEAD)
      })
    }
    return ps
  }

  // ---------- 打架 ----------

  private drawHp(ps: PlayerSprite) {
    const g = ps.hpBar
    const ratio = Math.max(0, Math.min(1, ps.hp / MAX_HP))
    const color = ratio > 0.5 ? 0x36d399 : ratio > 0.25 ? 0xf5b942 : 0xff4d4f
    g.clear()
    g.fillStyle(0x000000, 0.55)
    g.fillRoundedRect(-HP_BAR_W / 2 - 1, HP_BAR_Y - 1, HP_BAR_W + 2, 6, 3)
    if (ratio > 0) {
      g.fillStyle(color, 1)
      g.fillRoundedRect(-HP_BAR_W / 2, HP_BAR_Y, HP_BAR_W * ratio, 4, 2)
    }
  }

  private getPs(sid: string): PlayerSprite | undefined {
    return sid === this.mySid ? (this.mePlayer ?? undefined) : this.players.get(sid)
  }

  private ensureWeaponTextures() {
    if (!this.textures.exists('wpn-bat')) {
      const g = this.make.graphics({ x: 0, y: 0 }, false)
      g.fillStyle(0x8a5a2b, 1).fillRoundedRect(1, 0, 7, 26, 3)   // 棒身
      g.fillStyle(0xb07c42, 1).fillRoundedRect(2, 0, 5, 9, 2)    // 棒頭
      g.fillStyle(0x5d3d1e, 1).fillRoundedRect(2, 22, 5, 4, 2)   // 握把
      g.generateTexture('wpn-bat', 9, 26)
      g.destroy()
    }
    if (!this.textures.exists('wpn-fist')) {
      const g = this.make.graphics({ x: 0, y: 0 }, false)
      g.fillStyle(0xe8b890, 1).fillCircle(6, 6, 6)
      g.fillStyle(0xd19a6b, 1).fillCircle(6, 4, 2)
      g.generateTexture('wpn-fist', 12, 12)
      g.destroy()
    }
  }

  /** 揮擊動畫：武器繞角色掃一個弧 */
  playAttack(sid: string, weapon: Weapon) {
    const ps = this.getPs(sid)
    if (!ps) return
    this.ensureWeaponTextures()
    const flip = ps.wire.dir === 'left' ? -1 : 1
    const wpn = this.add.image(6 * flip, 0, weapon === 'bat' ? 'wpn-bat' : 'wpn-fist')
      .setOrigin(0.5, 1)
      .setAngle(-70 * flip)
    ps.container.add(wpn)
    this.tweens.add({
      targets: wpn,
      angle: 80 * flip,
      duration: 150,
      ease: 'Cubic.easeIn',
      onComplete: () => {
        this.tweens.add({ targets: wpn, alpha: 0, duration: 90, onComplete: () => wpn.destroy() })
      },
    })
  }

  /** 被打：更新血條 + 紅閃 + 傷害浮字 */
  setHp(sid: string, hp: number, dmg?: number) {
    const ps = this.getPs(sid)
    if (!ps) return
    const dropped = hp < ps.hp
    ps.hp = hp
    this.drawHp(ps)
    if (!dropped) return
    ps.head.setTint(0xff6666)
    this.time.delayedCall(160, () => { if (ps.head.active) ps.head.clearTint() })
    if (dmg) {
      const t = this.add.text(ps.container.x, ps.container.y - 44, `-${dmg}`, {
        fontSize: '13px', fontFamily: 'Inter, sans-serif', color: '#ff5b5b', fontStyle: 'bold',
      }).setOrigin(0.5).setDepth(99999).setShadow(0, 1, '#000', 2)
      this.tweens.add({ targets: t, y: t.y - 22, alpha: 0, duration: 700, onComplete: () => t.destroy() })
    }
  }

  private setKo(ps: PlayerSprite, ko: boolean) {
    ps.ko = ko
    ps.head.setAngle(ko ? 90 : 0)
    ps.head.setAlpha(ko ? 0.6 : 1)
    if (ko) ps.head.setTint(0x9aa0ad)
    else ps.head.clearTint()
  }

  /** 被打死：丟到指定位置（左上角）+ KO 視覺；自己則鎖操作 */
  applyDeath(sid: string, x: number, y: number, ms: number) {
    const ps = this.getPs(sid)
    if (!ps) return
    this.tweens.killTweensOf(ps.container)
    ps.wire.x = x; ps.wire.y = y
    ps.container.setPosition(x * this.T + this.T / 2, y * this.T + this.T / 2)
    ps.container.setDepth(ps.container.y)
    ps.hp = 0
    this.drawHp(ps)
    this.setKo(ps, true)
    if (sid === this.mySid) {
      this.stunnedUntil = Date.now() + ms
      this.meMoving = false
    }
    const skull = this.add.text(ps.container.x, ps.container.y - 50, '💀', { fontSize: '18px' })
      .setOrigin(0.5).setDepth(99999)
    this.tweens.add({ targets: skull, y: skull.y - 26, alpha: 0, duration: 1100, onComplete: () => skull.destroy() })
  }

  applyRevive(sid: string, hp: number) {
    const ps = this.getPs(sid)
    if (!ps) return
    ps.hp = hp
    this.drawHp(ps)
    this.setKo(ps, false)
    if (sid === this.mySid) this.stunnedUntil = 0
  }

  private destroyPlayer(ps: PlayerSprite) {
    ps.bubbleTimer?.remove()
    this.tweens.killTweensOf(ps.container)
    this.tweens.killTweensOf(ps.head)
    ps.container.destroy()
  }

  /** 走一步時頭微微跳一下，沒有身體動畫也有「在走」的感覺 */
  private stepBob(ps: PlayerSprite) {
    this.tweens.killTweensOf(ps.head)
    ps.head.y = HEAD_Y
    this.tweens.add({
      targets: ps.head, y: HEAD_Y - 4,
      duration: STEP_MS / 2, yoyo: true, ease: 'Sine.easeOut',
    })
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
    if (ps.container.x === tx && ps.container.y === ty) return
    this.stepBob(ps)
    this.tweens.add({
      targets: ps.container, x: tx, y: ty, duration: STEP_MS,
      onUpdate: () => ps.container.setDepth(ps.container.y),
    })
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
      this.sendMove(w.x, w.y, dir)
      return
    }

    w.x = tx; w.y = ty; w.dir = dir
    this.meMoving = true
    this.stepBob(me)
    this.sendMove(tx, ty, dir)
    this.tweens.add({
      targets: me.container,
      x: tx * this.T + this.T / 2,
      y: ty * this.T + this.T / 2,
      duration: STEP_MS,
      onUpdate: () => me.container.setDepth(me.container.y),
      onComplete: () => { this.meMoving = false },
    })
  }

  private sendMove(x: number, y: number, dir: Dir) {
    const key = `${x},${y},${dir}`
    if (key === this.lastSent) return
    this.lastSent = key
    this.opts.onMoveStep(x, y, dir)
  }

  // ---------- 縮放 ----------

  /** 最小縮放 = 地圖恰好蓋滿視窗（不露出地圖外的黑邊） */
  private clampZoom(z: number) {
    const minZoom = Math.max(
      this.scale.width / (this.room.width * this.T),
      this.scale.height / (this.room.height * this.T),
    )
    return Math.min(2.5, Math.max(minZoom, z))
  }

  adjustZoom(delta: number) {
    const cam = this.cameras.main
    cam.setZoom(this.clampZoom(cam.zoom + delta))
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

  /** 換頭像：載入新圓頭 texture 換上（KO 灰階等狀態由 tint 保留） */
  updateAvatar(sid: string, filename: string) {
    const ps = this.getPs(sid)
    if (!ps) return
    ps.wire.avatar = filename
    const key = `head-${filename}`
    loadCircleAvatar(this, key, filename).then((ok) => {
      if (ok && ps.head.active) ps.head.setTexture(key).setDisplaySize(HEAD, HEAD)
    })
  }

  /** 語音「說話中」綠圈（userIds 來自 LiveKit ActiveSpeakers，identity = userId） */
  setSpeaking(userIds: number[]) {
    const speaking = new Set(userIds)
    if (this.mePlayer) this.mePlayer.ring.setVisible(speaking.has(this.mePlayer.wire.userId))
    for (const ps of this.players.values()) {
      ps.ring.setVisible(speaking.has(ps.wire.userId))
    }
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

    const bub = this.add.container(0, HP_BAR_Y - bh / 2 - 8, [g, t])
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
      if (!fur) {
        this.placingId = null
      } else if (this.textures.exists(this.furKey(fur))) {
        this.makeGhost(fur)
      } else {
        // 圖還沒進 texture（剛上傳/載入失敗過）：現載，載完 ghost 才出現
        this.load.image(this.furKey(fur), `/api/gather/assets/${fur.image_filename}`)
        this.load.once(Phaser.Loader.Events.COMPLETE, () => {
          if (this.placingId !== furnitureId) return
          if (this.textures.exists(this.furKey(fur))) {
            this.makeGhost(fur)
          } else {
            this.placingId = null
            this.events.emit('editor-error', `「${fur.name}」圖片載入失敗，請重新整理或重傳`)
            this.emitEditor()
          }
        })
        this.load.start()
      }
    }
    this.emitEditor()
  }

  private makeGhost(fur: Furniture) {
    this.ghost = this.add.image(0, 0, this.furKey(fur))
      .setOrigin(0).setAlpha(0.55).setDepth(999999)
      .setDisplaySize(fur.tile_w * this.T, fur.tile_h * this.T)
      .setVisible(false)
    this.clearSelection()
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
    } else {
      // texture 缺失等原因放不上去 → 不能無聲失敗
      this.events.emit('editor-error', `「${fur.name}」圖片尚未載入完成，請稍候再點一次`)
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
