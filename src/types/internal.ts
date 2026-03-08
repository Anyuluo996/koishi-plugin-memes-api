// 内部类型定义 - 用于替代 any 类型

import type { Session } from 'koishi'
import type { MemeInfoResponse } from 'meme-generator-api'

// ============ 数据库记录类型 ============

export interface MemeBlacklistRecord {
  id: number
  keyword: string
}

export interface MemeUsageRecord {
  id: number
  meme_key: string
  guild_id: string
  user_id: string
  platform: string
  usage_count: number
  last_used: Date
}

export interface GuildSettingRecord {
  id: number
  guild_id: string
  platform: string
  meme_key: string
  enabled: boolean
}

export interface UserBlockRecord {
  id: number
  guild_id: string
  platform: string
  user_id: string
  meme_key: string
  blocked: boolean
}

// ============ HTTP 配置类型 ============

export interface HttpConfig {
  baseURL: string
  timeout?: number
  keepAlive?: boolean
  headers?: Record<string, string>
}

// ============ 命令相关类型 ============

export interface CommandSession {
  session: Session
  options?: Record<string, unknown>
}

// ============ 工具类型 ============

export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P]
}

export interface DatabaseQueryResult<T> {
  matched: number
  removed: number
  created?: number
}

// ============ 重新导出 ============

export * from './constants'
export * from './session'
