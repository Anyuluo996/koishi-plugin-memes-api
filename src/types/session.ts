// Session 工具函数

import type { Session } from 'koishi'

export interface SessionInfo {
  guildId: string
  userId: string
  platform: string
  isPrivate: boolean
}

/**
 * 从 session 中提取常用信息
 */
export function extractSessionInfo(session: Session): SessionInfo {
  return {
    guildId: session.guildId || 'private',
    userId: session.userId,
    platform: session.platform,
    isPrivate: !session.guildId,
  }
}

/**
 * 获取带默认值的 guildId
 */
export function getGuildId(session: Session, fallback = 'private'): string {
  return session.guildId || fallback
}

/**
 * 判断是否为群组会话
 */
export function isGuildSession(session: { guildId?: string | null }): boolean {
  return !!session.guildId
}

/**
 * 获取群组或私聊的显示名称
 */
export function getGuildDisplay(session: { guildId?: string | null }): string {
  return session.guildId ? '群组' : '私聊'
}
