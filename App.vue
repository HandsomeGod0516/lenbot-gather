<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import type { ChatEntry, Furniture, Me, PlayerWire, RoomData } from './game/types'
import type { GatherHandle } from './game/engine'
import type { GatherScene } from './game/scene'

/**
 * 注意：Phaser / socket.io-client / engine 一律在 onMounted 內動態 import。
 * portal-main 是 Nuxt SSR — 任何頂層的靜態 game import 都會在 server 端爆掉。
 */

const loading = ref(true)
const fatal = ref('')
const me = ref<Me | null>(null)
const room = ref<RoomData | null>(null)
const avatarFilename = ref<string | null>(null)
const spawn = ref({ x: 3, y: 3 })

const canvasHost = ref<HTMLElement | null>(null)
let handle: GatherHandle | null = null
const scene = ref<GatherScene | null>(null)

const connected = ref(false)
const players = ref<PlayerWire[]>([])
const chatLog = ref<ChatEntry[]>([])
const chatInput = ref('')
const inRoom = ref(false)

// avatar 上傳
const needAvatar = ref(false)
const avatarFile = ref<File | null>(null)
const avatarPreview = ref('')
const uploadingAvatar = ref(false)
const avatarError = ref('')

// 編輯模式（admin）
const isAdmin = computed(() => me.value?.role === 'admin')
const editMode = ref(false)
const placing = ref<number | null>(null)
const hasSelection = ref(false)
const dirty = ref(false)
const savingLayout = ref(false)
const editorMsg = ref('')
const newFur = ref({ name: '', tile_w: 1, tile_h: 1, is_solid: true, file: null as File | null })
const furFileInput = ref<HTMLInputElement | null>(null)
const uploadingFur = ref(false)

// 語音（LiveKit）— 進房自動加入（像 Meet），拒絕麥克風也能聽
type Voice = InstanceType<typeof import('./game/voice').GatherVoice>
let voice: Voice | null = null
let volumeTimer: ReturnType<typeof setInterval> | null = null
let voiceMsgTimer: ReturnType<typeof setTimeout> | null = null
const voiceState = ref<'off' | 'connecting' | 'on'>('off')
const voiceMuted = ref(false)
const micOk = ref(true)
const audioBlocked = ref(false)
const voiceUserIds = ref<number[]>([])
const voiceMsg = ref('')

function setVoiceMsg(msg: string, ms = 7000) {
  voiceMsg.value = msg
  if (voiceMsgTimer) clearTimeout(voiceMsgTimer)
  if (msg) voiceMsgTimer = setTimeout(() => { voiceMsg.value = '' }, ms)
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: 'same-origin', ...init })
  if (!res.ok) {
    const body = await res.json().catch(() => null) as { statusMessage?: string; message?: string } | null
    throw new Error(body?.statusMessage || body?.message || `${res.status} ${res.statusText}`)
  }
  return res.json() as Promise<T>
}

onMounted(async () => {
  try {
    const meRes = await api<{ user: Me | null }>('/api/auth/me')
    if (!meRes.user) { fatal.value = '請先登入 portal'; return }
    me.value = meRes.user

    const [prof, roomData] = await Promise.all([
      api<{ profile: { avatar_filename: string | null; last_x: number; last_y: number } }>('/api/gather/profile'),
      api<RoomData>('/api/gather/room'),
    ])
    room.value = roomData
    avatarFilename.value = prof.profile.avatar_filename
    spawn.value = {
      x: Math.min(Math.max(prof.profile.last_x, 0), roomData.width - 1),
      y: Math.min(Math.max(prof.profile.last_y, 0), roomData.height - 1),
    }

    // 先收掉 loading 讓 .stage（canvasHost）渲染出來，才能掛 Phaser
    loading.value = false
    if (!avatarFilename.value) {
      needAvatar.value = true
      return
    }
    await nextTick()
    await enterRoom()
  } catch (e) {
    fatal.value = e instanceof Error ? e.message : String(e)
    loading.value = false
  }
})

onBeforeUnmount(() => {
  leaveVoice()
  handle?.destroy()
  handle = null
  if (avatarPreview.value) URL.revokeObjectURL(avatarPreview.value)
})

// ---------- 語音 ----------

async function joinVoice() {
  if (!handle || voiceState.value !== 'off') return
  voiceState.value = 'connecting'
  setVoiceMsg('')
  try {
    const { token, url } = await api<{ token: string; url: string }>('/api/gather/voice-token')
    const { GatherVoice } = await import('./game/voice')
    voice = new GatherVoice({
      onStateChange: (s) => {
        if (s === 'disconnected' && voiceState.value !== 'off') {
          stopVoiceLocal()
          setVoiceMsg('語音已斷線')
        }
      },
      onSpeakers: (ids) => scene.value?.setSpeaking(ids),
      onParticipants: (ids) => { voiceUserIds.value = ids },
      onError: (msg) => setVoiceMsg(msg),
      onAudioBlocked: (blocked) => { audioBlocked.value = blocked },
    })
    const res = await voice.connect(url, token)
    micOk.value = res.micOk
    voiceMuted.value = false
    voiceState.value = 'on'
    if (!res.micOk) {
      setVoiceMsg('未開啟麥克風 — 你聽得到別人，別人聽不到你（網址列可重新允許）', 9000)
    }
    // 依距離調音量：≤2 格全音量，9 格外靜音
    volumeTimer = setInterval(() => {
      if (!voice || !handle) return
      const pos = handle.getPositions()
      voice.updateVolumes(pos.me, new Map(pos.others.map(o => [o.userId, { x: o.x, y: o.y }])))
    }, 400)
  } catch (e) {
    stopVoiceLocal()
    setVoiceMsg(e instanceof Error ? e.message : String(e))
  }
}

/** 瀏覽器擋自動播放時，使用者點一下解鎖聲音 */
async function enableSound() {
  await voice?.startAudio()
}

function toggleMute() {
  if (!voice) return
  voiceMuted.value = !voiceMuted.value
  voice.setMuted(voiceMuted.value)
}

/** 清掉本地語音狀態（不含 room.disconnect，給斷線 callback 用） */
function stopVoiceLocal() {
  if (volumeTimer) { clearInterval(volumeTimer); volumeTimer = null }
  voiceState.value = 'off'
  voiceMuted.value = false
  micOk.value = true
  audioBlocked.value = false
  voiceUserIds.value = []
  scene.value?.setSpeaking([])
}

function leaveVoice() {
  const v = voice
  voice = null
  stopVoiceLocal()
  v?.disconnect()
}

async function enterRoom() {
  if (!me.value || !room.value) return
  if (!canvasHost.value) {
    fatal.value = '畫布容器尚未就緒（canvasHost null）— 請回報這個 bug'
    return
  }
  const { createGather } = await import('./game/engine')
  handle = await createGather({
    parent: canvasHost.value,
    me: me.value,
    avatar: avatarFilename.value,
    room: room.value,
    spawn: spawn.value,
    onChat: (entry) => {
      chatLog.value = [...chatLog.value.slice(-30), entry]
    },
    onPlayers: (list) => { players.value = list },
    onRoomUpdated: async () => {
      // 別的 admin 改了佈置；自己正在編輯時不要蓋掉手上的修改
      if (editMode.value && dirty.value) return
      await reloadRoom()
    },
    onConnectionChange: (ok) => { connected.value = ok },
  })
  scene.value = handle.scene
  handle.scene.events.on('editor', (s: { hasSelection: boolean; dirty: boolean; placing: number | null }) => {
    hasSelection.value = s.hasSelection
    dirty.value = s.dirty
    placing.value = s.placing
  })
  handle.scene.events.on('editor-error', (msg: string) => { editorMsg.value = msg })
  inRoom.value = true
  // 像 Meet：一進房就詢問麥克風並加入語音（拒絕也能聽）
  joinVoice()
}

/** keepItems：編輯中重抓家具庫時，保住畫布上未儲存的擺放 */
async function reloadRoom(keepItems = false) {
  const fresh = await api<RoomData>('/api/gather/room')
  room.value = fresh
  scene.value?.refreshRoom(fresh, keepItems)
}

// ---------- avatar ----------

function pickAvatar(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0] ?? null
  avatarFile.value = f
  avatarError.value = ''
  if (avatarPreview.value) URL.revokeObjectURL(avatarPreview.value)
  avatarPreview.value = f ? URL.createObjectURL(f) : ''
}

async function uploadAvatar() {
  if (!avatarFile.value) return
  uploadingAvatar.value = true
  avatarError.value = ''
  try {
    const fd = new FormData()
    fd.append('image', avatarFile.value)
    const res = await api<{ filename: string }>('/api/gather/avatar', { method: 'POST', body: fd })
    avatarFilename.value = res.filename
    needAvatar.value = false
    await enterRoom()
  } catch (e) {
    avatarError.value = e instanceof Error ? e.message : String(e)
  } finally {
    uploadingAvatar.value = false
  }
}

// ---------- chat ----------

function sendChat(e?: Event) {
  const text = chatInput.value.trim()
  if (!text || !handle) return
  handle.sendChat(text)
  chatInput.value = ''
  // 送出後把焦點還給遊戲，方向鍵才能繼續走路（blur 會觸發 setTyping(false)）
  ;(e?.target as HTMLElement | undefined)?.blur?.()
}

function chatFocus(t: boolean) {
  scene.value?.setTyping(t)
}

// ---------- 編輯模式 ----------

async function toggleEdit() {
  if (!scene.value) return
  if (editMode.value && dirty.value && !confirm('有未儲存的佈置變更，放棄嗎？')) return
  const turningOff = editMode.value
  editMode.value = !editMode.value
  scene.value.setEditMode(editMode.value)
  editorMsg.value = ''
  if (turningOff) await reloadRoom() // 還原成 DB 現狀
}

function startPlacing(f: Furniture) {
  if (!scene.value) return
  scene.value.setPlacing(placing.value === f.id ? null : f.id)
}

function deleteSelected() {
  scene.value?.deleteSelectedItem()
}

async function saveLayout() {
  if (!scene.value) return
  savingLayout.value = true
  editorMsg.value = ''
  try {
    const items = scene.value.getItems().map(({ furniture_id, x, y }) => ({ furniture_id, x, y }))
    await api('/api/gather/room-items', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items }),
    })
    await reloadRoom()
    scene.value.clearDirty()
    handle?.notifyRoomUpdated()
    editorMsg.value = '已儲存 ✓'
  } catch (e) {
    editorMsg.value = `儲存失敗：${e instanceof Error ? e.message : e}`
  } finally {
    savingLayout.value = false
  }
}

function pickFurImage(e: Event) {
  newFur.value.file = (e.target as HTMLInputElement).files?.[0] ?? null
}

async function uploadFurniture() {
  const f = newFur.value
  if (!f.file || !f.name.trim()) { editorMsg.value = '家具需要名稱和圖片'; return }
  const w = Math.round(Number(f.tile_w)), h = Math.round(Number(f.tile_h))
  if (!(w >= 1 && w <= 8 && h >= 1 && h <= 8)) {
    editorMsg.value = '寬高單位是「格」（1 格 = 32 像素），請填 1–8。'
    return
  }
  f.tile_w = w; f.tile_h = h
  uploadingFur.value = true
  editorMsg.value = ''
  try {
    const fd = new FormData()
    fd.append('name', f.name.trim())
    fd.append('tile_w', String(f.tile_w))
    fd.append('tile_h', String(f.tile_h))
    fd.append('is_solid', f.is_solid ? '1' : '0')
    fd.append('image', f.file)
    await api('/api/gather/furniture', { method: 'POST', body: fd })
    newFur.value = { name: '', tile_w: 1, tile_h: 1, is_solid: true, file: null }
    // DOM 的檔案選擇也要清，否則畫面看似還掛著檔案、model 卻是空的，
    // 連續選同一檔案時 change 也不會再觸發
    if (furFileInput.value) furFileInput.value.value = ''
    await reloadRoom(true) // 保住畫布上尚未儲存的擺放
    editorMsg.value = '家具已新增 ✓'
  } catch (e) {
    editorMsg.value = `上傳失敗：${e instanceof Error ? e.message : e}`
  } finally {
    uploadingFur.value = false
  }
}

async function removeFurniture(f: Furniture) {
  if (!confirm(`刪除家具「${f.name}」？已擺放的會一併移除。`)) return
  try {
    await api(`/api/gather/furniture/${f.id}`, { method: 'DELETE' })
    await reloadRoom()
  } catch (e) {
    editorMsg.value = `刪除失敗：${e instanceof Error ? e.message : e}`
  }
}
</script>

<template>
  <div class="gather">
    <p v-if="loading" class="state">載入中…</p>
    <p v-else-if="fatal" class="state error">{{ fatal }}</p>

    <template v-else>
      <div class="stage-wrap">
        <div class="stage-box">
          <div ref="canvasHost" class="stage" :class="{ editing: editMode }" />

          <!-- HUD：左上 — 連線狀態與在線名單 -->
          <div class="hud hud-tl" :title="players.map(p => p.name).join('、')">
            <span class="dot" :class="{ on: connected }" />
            <span>{{ players.length }} 人在線</span>
            <span class="hud-names">{{ players.map(p => p.name).join('、') }}</span>
          </div>

          <!-- HUD：右上 — 語音與編輯控制 -->
          <div v-if="inRoom" class="hud hud-tr">
            <button v-if="voiceState === 'off'" class="btn" @click="joinVoice">🎤 加入語音</button>
            <span v-else-if="voiceState === 'connecting'" class="hud-chip">語音連線中…</span>
            <template v-else>
              <span class="voice-count" :title="`${voiceUserIds.length} 人在語音中`">🔊 {{ voiceUserIds.length }}</span>
              <span v-if="!micOk" class="hud-chip" title="瀏覽器未允許麥克風，你聽得到別人，別人聽不到你">僅收聽</span>
              <button v-else class="btn" :class="{ danger: voiceMuted }" @click="toggleMute">
                {{ voiceMuted ? '取消靜音' : '靜音' }}
              </button>
              <button class="btn" @click="leaveVoice">離開語音</button>
            </template>
            <button v-if="isAdmin" class="btn" :class="{ active: editMode }" @click="toggleEdit">
              {{ editMode ? '結束編輯' : '編輯佈置' }}
            </button>
          </div>

          <!-- 上中 toast：離線 / 語音訊息 / 點擊開聲音 -->
          <div class="hud-toasts">
            <p v-if="inRoom && !connected" class="toast warn">
              ⚠️ 即時同步未連線 — 看不到其他人、訊息送不出去
            </p>
            <p v-if="voiceMsg" class="toast warn">🎤 {{ voiceMsg }}</p>
            <button v-if="audioBlocked" class="toast action" @click="enableSound">
              🔊 點一下開啟聲音
            </button>
          </div>

          <div v-if="chatLog.length && !editMode" class="chat-log">
            <p v-for="c in chatLog.slice(-6)" :key="c.at + c.sid">
              <b>{{ c.name }}</b>：{{ c.text }}
            </p>
          </div>

          <!-- 底部聊天列（畫布內） -->
          <div v-if="inRoom" class="chat-dock">
            <input
              v-model="chatInput"
              placeholder="說點什麼…（Enter 送出）"
              maxlength="200"
              @focus="chatFocus(true)"
              @blur="chatFocus(false)"
              @keydown.enter="sendChat"
            >
            <button class="btn" @click="sendChat">送出</button>
          </div>

          <aside v-if="editMode" class="editor">
          <h3>家具庫</h3>
          <div class="fur-grid">
            <div
              v-for="f in room?.furniture" :key="f.id"
              class="fur" :class="{ placing: placing === f.id }"
              @click="startPlacing(f)"
            >
              <img :src="`/api/gather/assets/${f.image_filename}`" :alt="f.name">
              <span class="fur-name">{{ f.name }}</span>
              <span class="fur-meta">{{ f.tile_w }}×{{ f.tile_h }}{{ f.is_solid ? '・阻擋' : '' }}</span>
              <button class="fur-del" title="刪除家具" @click.stop="removeFurniture(f)">×</button>
            </div>
            <p v-if="!room?.furniture.length" class="hint">還沒有家具，先在下面上傳一個。</p>
          </div>
          <p class="hint">點家具後在地圖點擊放置（右鍵取消）；拖曳已擺放的家具可移動。</p>

          <div class="editor-actions">
            <button class="btn danger" :disabled="!hasSelection" @click="deleteSelected">刪除選取</button>
            <button class="btn primary" :disabled="!dirty || savingLayout" @click="saveLayout">
              {{ savingLayout ? '儲存中…' : '儲存佈置' }}
            </button>
          </div>

          <h3>新增家具</h3>
          <div class="fur-form">
            <input v-model="newFur.name" placeholder="名稱（如：會議桌）" maxlength="50">
            <div class="row">
              <label>寬 <input v-model.number="newFur.tile_w" type="number" min="1" max="8"> 格</label>
              <label>高 <input v-model.number="newFur.tile_h" type="number" min="1" max="8"> 格</label>
              <label class="solid"><input v-model="newFur.is_solid" type="checkbox"> 阻擋</label>
            </div>
            <p class="hint">尺寸單位是「格」（1 格 = 32 像素），1–8 格。例：桌子 2×1、沙發 2×2。</p>
            <input ref="furFileInput" type="file" accept="image/*" @change="pickFurImage">
            <button class="btn primary" :disabled="uploadingFur" @click="uploadFurniture">
              {{ uploadingFur ? '上傳中…' : '上傳家具' }}
            </button>
          </div>
          <p v-if="editorMsg" class="hint">{{ editorMsg }}</p>
          </aside>
        </div>
      </div>

      <div v-if="needAvatar" class="modal-mask">
        <div class="modal">
          <h3>上傳你的大頭照</h3>
          <p class="hint">照片會裁成圓形，當作你在辦公室裡的頭。</p>
          <div class="avatar-preview" :style="avatarPreview ? { backgroundImage: `url(${avatarPreview})` } : {}">
            <span v-if="!avatarPreview">?</span>
          </div>
          <input type="file" accept="image/*" @change="pickAvatar">
          <p v-if="avatarError" class="state error">{{ avatarError }}</p>
          <button class="btn primary" :disabled="!avatarFile || uploadingAvatar" @click="uploadAvatar">
            {{ uploadingAvatar ? '上傳中…' : '進入辦公室' }}
          </button>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.gather { display: flex; flex-direction: column; gap: 10px; }
.state { color: var(--tx-3); padding: 40px 0; text-align: center; }
.state.error { color: var(--danger); }

/* HUD：浮在畫布上的控制列 */
.hud {
  position: absolute; z-index: 8; /* 高於編輯器浮窗，結束編輯等按鈕永遠點得到 */
  display: flex; align-items: center; gap: 8px;
  padding: 6px 10px;
  font-size: 12px; color: var(--tx-2);
  background: rgba(10, 12, 16, .72);
  border: 1px solid var(--line-2);
  border-radius: var(--r-sm);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  max-width: calc(100% - 20px);
}
.hud-tl { top: 10px; left: 10px; }
.hud-tr { top: 10px; right: 10px; flex-wrap: wrap; justify-content: flex-end; }
.hud .btn { padding: 4px 10px; }
.hud-chip { color: var(--tx-3); flex: none; }
.hud-names {
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--tx-3); max-width: 24vw;
}
.dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: var(--tx-4); flex: none;
}
.dot.on { background: var(--success); }

.hud-toasts {
  position: absolute; z-index: 6;
  top: 52px; left: 50%; transform: translateX(-50%);
  display: flex; flex-direction: column; align-items: center; gap: 6px;
  width: max-content; max-width: 90%;
  pointer-events: none;
}
.toast {
  margin: 0; padding: 7px 12px;
  font-size: 12px; border-radius: var(--r-sm);
  pointer-events: none; /* 警告類不收事件，免得擋到底下的 HUD/畫布 */
}
.toast.action { pointer-events: auto; }
.toast.warn {
  color: #ffb454;
  background: rgba(30, 22, 8, .85);
  border: 1px solid rgba(255, 180, 84, .3);
}
.toast.action {
  color: var(--success);
  background: rgba(8, 28, 20, .9);
  border: 1px solid var(--success);
  cursor: pointer;
}

.btn {
  border: 1px solid var(--line-3); border-radius: var(--r-sm);
  padding: 6px 14px; font-size: 12px; color: var(--tx-2);
  transition: all .15s;
}
.btn:hover:not(:disabled) { color: var(--tx-1); background: var(--hover-bg); }
.btn:disabled { opacity: .4; cursor: default; }
.btn.active { border-color: var(--success); color: var(--success); }
.btn.primary { border-color: var(--success); color: var(--success); }
.btn.danger { border-color: var(--danger); color: var(--danger); }

.voice-count { color: var(--success); font-size: 12px; flex: none; }

.stage-wrap { display: flex; justify-content: center; }
.stage-box {
  position: relative;
  flex: 1; min-width: 0;
  /* 控制項都在畫布內（HUD），只需扣 portal topbar + padding，
     畫布吃滿剩餘視窗高、寬度照 5:3 反推 */
  max-width: calc((100vh - 150px) * 5 / 3);
  max-width: calc((100dvh - 150px) * 5 / 3);
}
.stage {
  width: 100%;
  border: 1px solid var(--line-2); border-radius: var(--r-md);
  overflow: hidden;
  aspect-ratio: 5 / 3;
  background: #0d0f14;
}
.stage.editing { border-color: var(--success); }
.stage :deep(canvas) { display: block; width: 100% !important; height: 100% !important; }

.chat-log {
  position: absolute; left: 12px; bottom: 60px; z-index: 4;
  max-width: 46%;
  background: rgba(0, 0, 0, .55);
  border-radius: var(--r-sm);
  padding: 8px 10px;
  font-size: 11px; color: var(--tx-2);
  pointer-events: none;
}
.chat-log p { margin: 2px 0; }
.chat-log b { color: var(--tx-1); font-weight: 600; }

.chat-dock {
  position: absolute; z-index: 5;
  left: 50%; bottom: 10px; transform: translateX(-50%);
  width: min(520px, calc(100% - 20px));
  display: flex; gap: 8px;
}
.chat-dock input {
  flex: 1; min-width: 0;
  background: rgba(10, 12, 16, .72);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  border: 1px solid var(--line-2); border-radius: var(--r-sm);
  padding: 8px 12px; color: var(--tx-1); outline: none;
}
.chat-dock input:focus { border-color: var(--focus-ring); }
.chat-dock .btn {
  background: rgba(10, 12, 16, .72);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
}

.editor {
  position: absolute; z-index: 7;
  top: 54px; right: 10px; bottom: 10px; /* 從 HUD 下緣開始，不蓋住右上控制列 */
  width: min(272px, calc(100% - 20px));
  border: 1px solid var(--line-2); border-radius: var(--r-md);
  background: rgba(13, 13, 13, .92);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  padding: 14px;
  display: flex; flex-direction: column; gap: 10px;
  overflow-y: auto;
}
.editor h3 {
  margin: 0; font-size: 11px; letter-spacing: .2em;
  color: var(--tx-3); font-weight: 600;
}
.fur-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.fur {
  position: relative;
  border: 1px solid var(--line-2); border-radius: var(--r-sm);
  padding: 8px; cursor: pointer; text-align: center;
  display: flex; flex-direction: column; gap: 4px; align-items: center;
}
.fur:hover { background: var(--hover-bg); }
.fur.placing { border-color: var(--success); background: rgba(0, 209, 138, .07); }
.fur img { width: 48px; height: 48px; object-fit: contain; }
.fur-name { font-size: 11px; color: var(--tx-1); }
.fur-meta { font-size: 10px; color: var(--tx-3); }
.fur-del {
  position: absolute; top: 2px; right: 2px;
  width: 18px; height: 18px; line-height: 16px;
  border-radius: 50%; font-size: 12px;
  color: var(--tx-3);
}
.fur-del:hover { color: var(--danger); }

.editor-actions { display: flex; gap: 8px; }
.editor-actions .btn { flex: 1; }

.fur-form { display: flex; flex-direction: column; gap: 8px; }
.fur-form input[type="text"], .fur-form > input:first-child {
  background: var(--bg-input);
  border: 1px solid var(--line-2); border-radius: var(--r-sm);
  padding: 7px 10px; color: var(--tx-1); outline: none; width: 100%;
}
.fur-form .row { display: flex; gap: 8px; align-items: center; font-size: 12px; color: var(--tx-2); }
.fur-form .row label { display: flex; gap: 4px; align-items: center; }
.fur-form .row input[type="number"] {
  width: 44px;
  background: var(--bg-input);
  border: 1px solid var(--line-2); border-radius: var(--r-sm);
  padding: 4px 6px; color: var(--tx-1);
}
.fur-form input[type="file"] { font-size: 11px; color: var(--tx-3); }

.hint { font-size: 11px; color: var(--tx-3); margin: 0; }

.modal-mask {
  position: fixed; inset: 0; z-index: 50;
  background: rgba(0, 0, 0, .7);
  display: flex; align-items: center; justify-content: center;
}
.modal {
  background: var(--bg-elev);
  border: 1px solid var(--line-2); border-radius: var(--r-lg);
  padding: 28px; width: min(92vw, 360px);
  display: flex; flex-direction: column; gap: 14px; align-items: center;
  text-align: center;
}
.modal h3 { margin: 0; font-size: 15px; }
.avatar-preview {
  width: 110px; height: 110px; border-radius: 50%;
  background: var(--bg-input) center / cover no-repeat;
  border: 2px solid var(--line-3);
  display: flex; align-items: center; justify-content: center;
  color: var(--tx-4); font-size: 36px;
}
.modal input[type="file"] { font-size: 12px; color: var(--tx-3); }
.modal .btn { width: 100%; padding: 10px; }

@media (max-width: 640px) {
  .hud-names { display: none; }
  .chat-log { max-width: 70%; bottom: 56px; }
}
</style>
