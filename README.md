# gather — 虛擬辦公室

類 Gather 的 2D 虛擬辦公室，lenbot 子專案。Vue 3 + Phaser 3，
即時同步走獨立的 Node.js + Socket.io 伺服器（`server/`）。

## 結構

```
App.vue          Vue 進入點（portal-main 自動掛載到 /projects/gather）
game/
  engine.ts      Phaser game 建立 + Socket.io 接線（只能在瀏覽器動態 import）
  scene.ts       房間場景：地圖、移動、碰撞、聊天泡泡、編輯模式
  body.ts        程式產生的像素身體 sprite sheet（照片頭疊在上面）
  avatar.ts      照片 → 圓形頭 texture
  types.ts       共用型別
server/
  index.js       Socket.io 同步伺服器（位置 / 聊天 / 佈置更新通知）
  Dockerfile     infra-docker 的 gather-ws 服務用
```

## 角色

使用者上傳照片 → portal API 裁成正方 webp → 前端再裁圓，
疊在程式畫的像素小身體上（四方向走路動畫，襯衫顏色依 userId 固定）。

## 即時同步

- 連線時帶 `lenbot_session` cookie，server 轉呼叫 portal `/api/auth/me` 驗身分
- 事件：`init` / `player-joined` / `player-moved` / `player-left` / `chat` / `room-updated`
- 斷線時用使用者自己的 cookie 回寫最後位置到 portal

WS 位址規則（`game/engine.ts`）：正式站（無 port，經 nginx `/gather-ws/`）同源連線；
本機開發直連 `localhost:3101`。

## 開發

```bash
# 透過 portal-main（建議）：infra-docker 起 MySQL 後
cd ../portal-main && npm run dev        # http://localhost:3000/projects/gather
node server/index.js                    # WS 伺服器（或 cd server && npm start）

# API（家具 / avatar / room）在 portal-main/server/api/gather/
```

家具編輯（上傳、擺放、刪除）僅 admin 可用；資料表見 portal-main `db/init.sql`
的 gather 區塊。
