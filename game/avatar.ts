import type * as Phaser from 'phaser'

/**
 * 照片圓頭：抓 /api/gather/assets/<filename>（同源帶 cookie），
 * 中央正方裁切 → 圓形 clip → 畫進 canvas → 註冊成 Phaser texture。
 */
export async function loadCircleAvatar(
  scene: Phaser.Scene, key: string, filename: string, size = 56,
): Promise<boolean> {
  if (scene.textures.exists(key)) return true
  try {
    const res = await fetch(`/api/gather/assets/${encodeURIComponent(filename)}`, {
      credentials: 'same-origin',
    })
    if (!res.ok) return false
    const bmp = await createImageBitmap(await res.blob())

    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d')!
    ctx.beginPath()
    ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2)
    ctx.clip()
    const s = Math.min(bmp.width, bmp.height)
    ctx.drawImage(bmp, (bmp.width - s) / 2, (bmp.height - s) / 2, s, s, 0, 0, size, size)
    bmp.close()

    // scene 可能在 fetch 期間被銷毀
    if (!scene.textures) return false
    scene.textures.addCanvas(key, canvas)
    return true
  } catch {
    return false
  }
}

/** 沒照片 / 載入失敗時的替代頭：色塊圓 + 名字首字 */
export function ensureFallbackHead(
  scene: Phaser.Scene, key: string, name: string, bg: string, size = 56,
) {
  if (scene.textures.exists(key)) return
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!
  ctx.beginPath()
  ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2)
  ctx.fillStyle = bg
  ctx.fill()
  ctx.fillStyle = 'rgba(255,255,255,.92)'
  ctx.font = `bold ${Math.round(size * 0.5)}px Inter, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText((name || '?').slice(0, 1).toUpperCase(), size / 2, size / 2 + 1)
  scene.textures.addCanvas(key, canvas)
}
