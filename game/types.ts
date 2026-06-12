export type Dir = 'down' | 'left' | 'right' | 'up'

export interface Furniture {
  id: number
  name: string
  image_filename: string
  tile_w: number
  tile_h: number
  is_solid: number
}

/** id 為 DB id；前端新擺、尚未存檔的項目用負數暫時 id */
export interface RoomItem {
  id: number
  furniture_id: number
  x: number
  y: number
}

export interface RoomData {
  width: number
  height: number
  tile: number
  furniture: Furniture[]
  items: RoomItem[]
}

export interface PlayerWire {
  sid: string
  userId: number
  name: string
  avatar: string | null
  x: number
  y: number
  dir: Dir
  hp?: number
  /** 剩餘昏倒毫秒（>0 = 正在 KO） */
  ko?: number
}

export type Weapon = 'bat' | 'fist'

export interface ChatEntry {
  sid: string
  userId: number
  name: string
  text: string
  at: number
}

export interface Me {
  id: number
  username: string
  display_name: string | null
  role: string
}
