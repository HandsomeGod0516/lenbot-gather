import {
  Room,
  RoomEvent,
  Track,
  type RemoteTrack,
  type RemoteTrackPublication,
  type RemoteParticipant,
  type Participant,
} from 'livekit-client'

/**
 * gather 語音（LiveKit）。
 * - identity = userId（token 端點發的），靠它對應角色位置算距離音量
 * - 遠端音軌 attach 成 <audio data-voice-uid>，掛在 body 上；音量由 updateVolumes 控制
 * - 全房間同一個 LiveKit room（main），「近距離才聽得到」是前端音量曲線做的
 */

export interface VoiceCallbacks {
  onStateChange: (s: 'connected' | 'disconnected') => void
  onSpeakers: (userIds: number[]) => void
  onParticipants: (userIds: number[]) => void
  onError: (msg: string) => void
}

/** 距離（格）→ 音量：≤2 格全音量，9 格以外聽不到 */
export function volumeForDistance(d: number): number {
  if (d <= 2) return 1
  if (d >= 9) return 0
  return 1 - (d - 2) / 7
}

export class GatherVoice {
  private room: Room | null = null
  private audioEls = new Map<string, HTMLAudioElement>() // identity → <audio>
  private cb: VoiceCallbacks

  constructor(cb: VoiceCallbacks) {
    this.cb = cb
  }

  async connect(url: string, token: string) {
    const room = new Room()

    room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, _pub: RemoteTrackPublication, participant: RemoteParticipant) => {
      if (track.kind !== Track.Kind.Audio) return
      const el = track.attach() as HTMLAudioElement
      el.dataset.voiceUid = participant.identity
      el.volume = 0 // 先靜音，等距離計算把音量帶起來
      document.body.appendChild(el)
      this.audioEls.set(participant.identity, el)
    })
    room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack, _pub: RemoteTrackPublication, participant: RemoteParticipant) => {
      track.detach().forEach(el => el.remove())
      this.removeAudioOf(participant.identity)
    })
    room.on(RoomEvent.ParticipantConnected, () => this.emitParticipants())
    room.on(RoomEvent.ParticipantDisconnected, (p: RemoteParticipant) => {
      this.removeAudioOf(p.identity)
      this.emitParticipants()
    })
    room.on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => {
      this.cb.onSpeakers(speakers.map(s => Number(s.identity)).filter(Number.isFinite))
    })
    room.on(RoomEvent.Disconnected, () => {
      this.cleanup()
      this.cb.onStateChange('disconnected')
    })

    try {
      await room.connect(url, token)
    } catch (e) {
      throw new Error(`語音伺服器連線失敗：${e instanceof Error ? e.message : e}`)
    }
    this.room = room

    try {
      await room.localParticipant.setMicrophoneEnabled(true)
    } catch {
      // 沒麥克風權限也讓人留在語音房「只聽不講」
      this.cb.onError('無法取得麥克風權限 — 你聽得到別人，但別人聽不到你')
    }

    this.cb.onStateChange('connected')
    this.emitParticipants()
  }

  setMuted(muted: boolean) {
    this.room?.localParticipant.setMicrophoneEnabled(!muted).catch(() => {})
  }

  /** 每隔一陣子由 App 餵最新位置進來，依距離調每個人的音量 */
  updateVolumes(myPos: { x: number; y: number } | null, positions: Map<number, { x: number; y: number }>) {
    if (!myPos) return
    for (const [identity, el] of this.audioEls) {
      const pos = positions.get(Number(identity))
      // 找不到位置（剛加入、不同房）就先靜音，下一輪自然修正
      el.volume = pos ? volumeForDistance(Math.hypot(pos.x - myPos.x, pos.y - myPos.y)) : 0
    }
  }

  participantIds(): number[] {
    if (!this.room) return []
    const ids = [...this.room.remoteParticipants.values()].map(p => Number(p.identity))
    ids.push(Number(this.room.localParticipant.identity))
    return ids.filter(Number.isFinite)
  }

  private emitParticipants() {
    this.cb.onParticipants(this.participantIds())
  }

  /** 連 DOM 一起掃，不依賴事件順序/元素實例對得上 */
  private removeAudioOf(identity: string) {
    this.audioEls.get(identity)?.remove()
    this.audioEls.delete(identity)
    document.querySelectorAll(`audio[data-voice-uid="${CSS.escape(identity)}"]`).forEach(el => el.remove())
  }

  private cleanup() {
    for (const el of this.audioEls.values()) el.remove()
    this.audioEls.clear()
  }

  async disconnect() {
    const r = this.room
    this.room = null
    this.cleanup()
    if (r) await r.disconnect()
  }
}
