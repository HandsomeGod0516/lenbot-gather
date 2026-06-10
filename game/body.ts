import type * as Phaser from 'phaser'
import type { Dir } from './types'

/**
 * 程式產生的像素小人「身體」sprite sheet（頭部留空，由照片圓頭疊上去）。
 * 邏輯像素 13×16，放大 2 倍 → 每格 26×32。
 * 3 影格（0=站立, 1=左腳前, 2=右腳前）× 4 方向（down/left/right/up）。
 */

const SCALE = 2
const GRID_W = 13
const GRID_H = 16
export const BODY_W = GRID_W * SCALE
export const BODY_H = GRID_H * SCALE

const DIRS: Dir[] = ['down', 'left', 'right', 'up']

export const SHIRT_PALETTE = [
  '#4f8df7', '#e0563f', '#3fae6a', '#c9a23f',
  '#9a6cf0', '#e06fae', '#3fb6c9', '#7d9a4e',
]

const PANTS = '#2a2d3a'
const SHOES = '#15161d'
const SKIN = '#e8b890'

export function shirtColorFor(userId: number): string {
  return SHIRT_PALETTE[Math.abs(userId) % SHIRT_PALETTE.length]
}

function drawFrame(
  ctx: CanvasRenderingContext2D,
  ox: number, oy: number,
  dir: Dir, frame: number, shirt: string,
) {
  const rect = (x: number, y: number, w: number, h: number, c: string) => {
    ctx.fillStyle = c
    ctx.fillRect((ox + x) * SCALE, (oy + y) * SCALE, w * SCALE, h * SCALE)
  }
  // 手臂擺動量：走路時前後交錯
  const a = frame === 1 ? 1 : frame === 2 ? -1 : 0

  if (dir === 'down' || dir === 'up') {
    rect(4, 0, 5, 1, shirt)                 // 領口
    rect(3, 1, 7, 7, shirt)                 // 軀幹
    rect(2, 2 + a, 1, 4, shirt)             // 左臂
    rect(2, 6 + a, 1, 1, SKIN)              // 左手
    rect(10, 2 - a, 1, 4, shirt)            // 右臂
    rect(10, 6 - a, 1, 1, SKIN)             // 右手
  } else {
    rect(5, 0, 3, 1, shirt)                 // 領口（側面較窄）
    rect(4, 1, 5, 7, shirt)                 // 軀幹
    const armX = dir === 'left' ? 3 : 9     // 只畫面向側的手臂
    rect(armX, 2 + a, 1, 4, shirt)
    rect(armX, 6 + a, 1, 1, SKIN)
  }

  rect(3, 8, 7, 1, PANTS)                   // 臀部
  if (frame === 0) {
    rect(4, 9, 2, 5, PANTS); rect(7, 9, 2, 5, PANTS)     // 雙腿
    rect(4, 14, 2, 2, SHOES); rect(7, 14, 2, 2, SHOES)   // 鞋
  } else {
    const fwd = frame === 1 ? 4 : 7         // 前腳 x
    const back = frame === 1 ? 7 : 4        // 後腳 x
    rect(fwd, 9, 2, 5, PANTS); rect(fwd, 14, 2, 2, SHOES)
    rect(back, 9, 2, 4, PANTS); rect(back, 13, 2, 2, SHOES) // 後腳抬起 1px
  }
}

/** 建立（或重用）某件襯衫顏色的身體 sheet + 四方向走路動畫 */
export function ensureBodySheet(scene: Phaser.Scene, key: string, shirt: string) {
  if (scene.textures.exists(key)) return

  const canvas = document.createElement('canvas')
  canvas.width = BODY_W * 3
  canvas.height = BODY_H * 4
  const ctx = canvas.getContext('2d')!
  DIRS.forEach((dir, row) => {
    for (let f = 0; f < 3; f++) drawFrame(ctx, f * GRID_W, row * GRID_H, dir, f, shirt)
  })

  const tex = scene.textures.addCanvas(key, canvas)
  if (!tex) return
  DIRS.forEach((dir, row) => {
    for (let f = 0; f < 3; f++) tex.add(`${dir}-${f}`, 0, f * BODY_W, row * BODY_H, BODY_W, BODY_H)
  })
  DIRS.forEach((dir) => {
    scene.anims.create({
      key: `${key}-walk-${dir}`,
      frames: [
        { key, frame: `${dir}-1` },
        { key, frame: `${dir}-0` },
        { key, frame: `${dir}-2` },
        { key, frame: `${dir}-0` },
      ],
      frameRate: 10,
      repeat: -1,
    })
  })
}
