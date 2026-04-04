import { Context, Logger, h, Session } from 'koishi'
import { MemeAPI, MemeInfoResponse } from 'meme-generator-api'
import pLimit from 'p-limit'

import * as Commands from './commands'
import { Config } from './config'
import zhCNLocale from './locales/zh-CN'
import type { HttpConfig, MemeUsageRecord, GuildSettingRecord, UserBlockRecord } from './types/internal'
import * as UserInfo from './user-info'

import type { } from '@koishijs/plugin-help'
import type { Notifier } from '@koishijs/plugin-notifier'

export { Config }

export const name = '@anyul/koishi-plugin-memes-api'

export const inject = {
  required: ['http', 'database'],
  optional: ['notifier'],
}

export interface MemeInternal {
  notifier?: Notifier
  api: MemeAPI
  infos: Record<string, MemeInfoResponse>
  cmd?: any
  updateInfos: (
    progressCallback?: (now: number, total: number) => void,
  ) => Promise<void>
  findMeme(query: string): MemeInfoResponse | undefined

  // 黑名单
  getBlacklistedKeywords(): Promise<string[]>
  addBlacklistedKeyword(keyword: string): Promise<boolean>
  removeBlacklistedKeyword(keyword: string): Promise<boolean>
  isMemeBlacklisted(memeKey: string, keywords: string[]): Promise<boolean>

  recordMemeUsage(session: Session, memeKey: string): Promise<void>
  getMemeUsageStats(memeKey: string, guildId?: string | null, limit?: number): Promise<any[]>
  getTopMemes(guildId?: string | null, limit?: number): Promise<any[]>
  findMemeKeyByKeyword(keyword: string): string | null

  // 群组管理
  setMemeGuildEnabled(guildId: string, platform: string, memeKey: string, enabled: boolean): Promise<void>
  isMemeGuildEnabled(guildId: string, platform: string, memeKey: string): Promise<boolean>
  getGuildMemeSettings(guildId: string, platform: string): Promise<any[]>

  // 用户屏蔽
  setUserMemeBlocked(guildId: string, platform: string, userId: string, memeKey: string, blocked: boolean): Promise<void>
  isUserMemeBlocked(guildId: string, platform: string, userId: string, memeKey: string): Promise<boolean>
  getUserMemeBlocks(guildId: string, platform: string, userId?: string): Promise<any[]>

  reRegisterGenerateCommands(): Promise<void>
  refreshShortcuts(): Promise<void>
  invalidateFindMemeCache(): void
  invalidateAllCaches(): void
}
export interface MemePublic {
  api: MemeAPI
  infos: Record<string, MemeInfoResponse>
}
declare module 'koishi' {
  interface Context {
    $: MemeInternal
    memesApi: MemePublic
  }
}

const logger = new Logger('memes-api')

export async function apply(ctx: Context, config: Config) {
  ; (ctx as any).i18n.define('zh', zhCNLocale)

  ctx = ctx.isolate('$')
  ctx.set('$', {})

  ctx.inject(['notifier'], () => {
    ctx.$.notifier = ctx.notifier.create()
  })

    // === 数据库定义 ===
    ; (ctx as any).model.extend('memes_blacklist', {
      id: 'unsigned',
      keyword: 'string',
    }, { primary: 'id', autoInc: true, indexes: [{ keys: { keyword: 'asc' }, unique: true }] })

    ; (ctx as any).model.extend('memes_usage_stats', {
      id: 'unsigned',
      meme_key: 'string',
      guild_id: 'string',
      user_id: 'string',
      platform: 'string',
      usage_count: 'unsigned',
      last_used: 'timestamp',
    }, { primary: 'id', autoInc: true, indexes: [['meme_key', 'guild_id', 'user_id', 'platform']] })

    ; (ctx as any).model.extend('memes_guild_settings', {
      id: 'unsigned',
      guild_id: 'string',
      platform: 'string',
      meme_key: 'string',
      enabled: 'boolean',
    }, { primary: 'id', autoInc: true, indexes: [['guild_id', 'platform', 'meme_key']] })

    ; (ctx as any).model.extend('memes_user_blocks', {
      id: 'unsigned',
      guild_id: 'string',
      platform: 'string',
      user_id: 'string',
      meme_key: 'string',
      blocked: 'boolean',
    }, { primary: 'id', autoInc: true, indexes: [['guild_id', 'platform', 'user_id', 'meme_key']] })

  // === API 初始化 ===
  let httpConfig: HttpConfig
  if (config.requestConfig && typeof config.requestConfig === 'object') {
    const { endpoint, ...rest } = config.requestConfig
    httpConfig = { baseURL: endpoint, ...rest }
  } else {
    httpConfig = { baseURL: 'http://127.0.0.1:2233' }
  }
  ctx.$.api = new MemeAPI((ctx as any).http.extend(httpConfig))
  ctx.$.infos = {}

  ctx.$.updateInfos = async (progressCallback) => {
    const keys = await ctx.$.api.getKeys()
    const len = keys.length
    progressCallback?.(0, len)

    let ok = 0
    const limit = pLimit(config.getInfoConcurrency)
    const newEntries = await Promise.all(
      keys.map((key) => {
        return limit(async () => {
          const v = await ctx.$.api.getInfo(key)
          ok += 1
          progressCallback?.(ok, len)
          return [key, v] as const
        })
      }),
    )
    
    ctx.$.infos = Object.fromEntries(newEntries)
    // 更新后清除 findMeme 查询缓存
    findMemeCache = null
  }

  // findMeme 查询缓存
  let findMemeCache: Map<string, MemeInfoResponse> | null = null

  const buildFindMemeCache = () => {
    const cache = new Map<string, MemeInfoResponse>()
    // 主 key
    for (const [key, info] of Object.entries(ctx.$.infos)) {
      cache.set(key.toLowerCase(), info)
      // 关键词
      for (const keyword of info.keywords) {
        cache.set(keyword.toLowerCase(), info)
      }
      // 标签
      for (const tag of info.tags) {
        cache.set(tag.toLowerCase(), info)
      }
      // 快捷键
      for (const { key, humanized } of info.shortcuts) {
        cache.set(key.toLowerCase(), info)
        if (humanized) cache.set(humanized.toLowerCase(), info)
      }
    }
    return cache
  }

  ctx.$.findMeme = (query) => {
    query = query.trim().toLowerCase()
    // 使用缓存查找
    if (!findMemeCache) findMemeCache = buildFindMemeCache()
    return findMemeCache.get(query)
  }

  // 缓存失效函数，供其他模块调用
  ctx.$.invalidateFindMemeCache = () => {
    findMemeCache = null
  }

  ctx.$.invalidateAllCaches = () => {
    findMemeCache = null
    blacklistCache = null
  }

  // === 数据库操作函数 ===
 // 黑名单缓存
  let blacklistCache: Set<string> | null = null
  ctx.$.getBlacklistedKeywords = async () => {
    if (blacklistCache) return Array.from(blacklistCache)
    const records = await (ctx as any).database.get('memes_blacklist', {})
    const keywords = records.map((record: any) => record.keyword)
    blacklistCache = new Set(keywords.map(k => k.toLowerCase()))
    return keywords
  }

  ctx.$.addBlacklistedKeyword = async (keyword: string) => {
    const existing = await (ctx as any).database.get('memes_blacklist', { keyword })
    if (existing.length > 0) return false
    await (ctx as any).database.create('memes_blacklist', { keyword })
    blacklistCache = null  // 清除缓存
    return true
  }

  ctx.$.removeBlacklistedKeyword = async (keyword: string) => {
    const result = await (ctx as any).database.remove('memes_blacklist', { keyword })
    blacklistCache = null  // 清除缓存（必须在 return 之前）
    return result.matched > 0
  }

  ctx.$.isMemeBlacklisted = async (memeKey: string, keywords: string[]) => {
    // 直接使用已缓存的 blacklistSet，避免每次创建新 Set
    if (!blacklistCache) {
      const blacklistRaw = await ctx.$.getBlacklistedKeywords()
      blacklistCache = new Set(blacklistRaw.map(k => k.toLowerCase()))
    }

    if (config.debug) {
      logger.info(`[DEBUG] Checking blacklist for key: ${memeKey}, keywords: ${keywords.join(', ')}`)
      logger.info(`[DEBUG] Current blacklist: ${Array.from(blacklistCache).join(', ')}`)
    }

    if (blacklistCache.has(memeKey.toLowerCase())) return true
    for (const kw of keywords) {
      if (blacklistCache.has(kw.toLowerCase())) return true
    }
    return false
  }

  ctx.$.recordMemeUsage = async (session: Session, memeKey: string) => {
    try {
      const guildId = session.guildId || 'private'
      const userId = session.userId
      const platform = session.platform
      const existing = await (ctx as any).database.get('memes_usage_stats', {
        meme_key: memeKey,
        guild_id: guildId,
        user_id: userId,
        platform: platform
      })
      if (existing.length > 0) {
        await (ctx as any).database.set('memes_usage_stats', existing[0].id, {
          usage_count: existing[0].usage_count + 1,
          last_used: new Date()
        })
      } else {
        await (ctx as any).database.create('memes_usage_stats', {
          meme_key: memeKey,
          guild_id: guildId,
          user_id: userId,
          platform: platform,
          usage_count: 1,
          last_used: new Date()
        })
      }
    } catch (error) {
      logger.warn('Failed to record meme usage:', error)
    }
  }

  ctx.$.getMemeUsageStats = async (memeKey: string, guildId: string | null = null, limit: number = 10) => {
    try {
      const query: any = { meme_key: memeKey }
      if (guildId) query.guild_id = guildId
      const records = await (ctx as any).database.get('memes_usage_stats', query)
      return records.sort((a: any, b: any) => b.usage_count - a.usage_count).slice(0, limit)
    } catch (error) {
      logger.warn('获取表情包用户统计失败', error)
      return []
    }
  }

  ctx.$.getTopMemes = async (guildId: string | null = null, limit: number = 10) => {
    const query = guildId ? { guild_id: guildId } : {}
    try {
      const allRecords = await (ctx as any).database.get('memes_usage_stats', query)
      const memeStats = new Map()
      for (const record of allRecords) {
        const current = memeStats.get(record.meme_key) || 0
        memeStats.set(record.meme_key, current + record.usage_count)
      }
      return Array.from(memeStats.entries())
        .map(([meme_key, usage_count]) => ({ meme_key, usage_count }))
        .sort((a: any, b: any) => b.usage_count - a.usage_count)
        .slice(0, limit)
    } catch (error) {
      logger.warn('获取表情包统计失败', error)
      return []
    }
  }

  ctx.$.findMemeKeyByKeyword = (keyword: string) => {
    if (ctx.$.infos[keyword]) return keyword
    for (const [key, info] of Object.entries(ctx.$.infos)) {
      if (info.keywords && info.keywords.includes(keyword)) return key
    }
    return null
  }

  ctx.$.setMemeGuildEnabled = async (guildId: string, platform: string, memeKey: string, enabled: boolean) => {
    const existing = await (ctx as any).database.get('memes_guild_settings', {
      guild_id: guildId,
      platform: platform,
      meme_key: memeKey
    })
    if (existing.length > 0) {
      await (ctx as any).database.set('memes_guild_settings', existing[0].id, { enabled: enabled })
    } else {
      await (ctx as any).database.create('memes_guild_settings', {
        guild_id: guildId,
        platform: platform,
        meme_key: memeKey,
        enabled: enabled
      })
    }
  }

  ctx.$.isMemeGuildEnabled = async (guildId: string, platform: string, memeKey: string) => {
    const records = await (ctx as any).database.get('memes_guild_settings', {
      guild_id: guildId,
      platform: platform,
      meme_key: memeKey
    })
    if (records.length === 0) return true
    return records[0].enabled
  }

  ctx.$.getGuildMemeSettings = async (guildId: string, platform: string) => {
    return await (ctx as any).database.get('memes_guild_settings', {
      guild_id: guildId,
      platform: platform
    })
  }

  ctx.$.setUserMemeBlocked = async (guildId: string, platform: string, userId: string, memeKey: string, blocked: boolean) => {
    const existing = await (ctx as any).database.get('memes_user_blocks', {
      guild_id: guildId,
      platform: platform,
      user_id: userId,
      meme_key: memeKey
    })
    if (existing.length > 0) {
      await (ctx as any).database.set('memes_user_blocks', existing[0].id, { blocked: blocked })
    } else {
      await (ctx as any).database.create('memes_user_blocks', {
        guild_id: guildId,
        platform: platform,
        user_id: userId,
        meme_key: memeKey,
        blocked: blocked
      })
    }
  }

  ctx.$.isUserMemeBlocked = async (guildId: string, platform: string, userId: string, memeKey: string) => {
    const records = await (ctx as any).database.get('memes_user_blocks', {
      guild_id: guildId,
      platform: platform,
      user_id: userId,
      meme_key: memeKey
    })
    if (records.length === 0) return false
    return records[0].blocked
  }

  ctx.$.getUserMemeBlocks = async (guildId: string, platform: string, userId?: string) => {
    const query: any = { guild_id: guildId, platform: platform }
    if (userId) query.user_id = userId
    return await (ctx as any).database.get('memes_user_blocks', query)
  }

  // === 🔴 这里删除了 reRegisterGenerateCommands 的定义，因为它在 generate.ts 中定义 ===

  // 刷新快捷指令 (🔴 修复版：防止中间件泄露)
  let shortcutDispose: () => void // 用于存储旧的中间件销毁函数

  ctx.$.refreshShortcuts = async () => {
    if (!config.enableShortcut) return

    // 1. 如果存在旧的中间件，先销毁
    if (shortcutDispose) {
      shortcutDispose()
      shortcutDispose = undefined
    }

    const shortcuts: { name: string; pattern: string; flags: string; args: string[] }[] = []
    const blacklistRaw = await ctx.$.getBlacklistedKeywords()
    const blacklist = new Set(blacklistRaw.map(k => k.toLowerCase()))

    for (const info of Object.values(ctx.$.infos)) {
      if (blacklist.has(info.key.toLowerCase())) continue

      // 关键词快捷方式（转成正则表达式）
      for (const keyword of info.keywords) {
        shortcuts.push({
          name: info.key,
          pattern: escapeRegExp(keyword),
          flags: '',
          args: [],
        })
      }

      // Python 风格正则快捷方式
      for (const { key, args } of info.shortcuts) {
        try {
          const cleanKey = key.replace(/^\^/, '').replace(/\$$/, '')
          const result = transformRegex(cleanKey)
          shortcuts.push({
            name: info.key,
            pattern: result.pattern,
            flags: result.flags,
            args: args ?? [],
          })
        } catch (e) {
          ctx.logger.warn(`Failed to parse shortcut regex "${key}" for meme "${info.key}":`, e)
        }
      }
    }

    // 按 pattern 长度倒序，优先匹配长关键词
    shortcuts.sort((a, b) => b.pattern.length - a.pattern.length)

    // 2. 注册新的中间件，并保存销毁函数
    shortcutDispose = (ctx as any).middleware(async (session: any, next: any) => {
      const { content } = session
      if (!content) return next()

      const cmdPrefixRegex = (() => {
        if (config.shortcutUsePrefix) {
          // 优先使用自定义前缀
          if (config.shortcutPrefix && config.shortcutPrefix.length > 0) {
            const hasEmptyPfx = config.shortcutPrefix.includes('')
            const cmdPfxNotEmpty = config.shortcutPrefix.filter(Boolean)
            if (cmdPfxNotEmpty.length) {
              return `(?:${cmdPfxNotEmpty.map(escapeRegExp).join('|')})${hasEmptyPfx ? '?' : ''}`
            }
          }
          // 回退到全局前缀
          const cmdPfxCfg = session.resolve((ctx as any).root.config.prefix)
          const cmdPfx = cmdPfxCfg instanceof Array ? cmdPfxCfg : [cmdPfxCfg ?? ""]
          const hasEmptyPfx = cmdPfx.includes("")
          const cmdPfxNotEmpty = cmdPfx.filter(Boolean)
          if (cmdPfxNotEmpty.length) {
            return `(?:${cmdPfxNotEmpty.map(escapeRegExp).join("|")})${hasEmptyPfx ? "?" : ""}`
          }
        }
        return ""
      })()

      for (const { name, pattern, flags, args } of shortcuts) {
        try {
          const res = new RegExp(`^${cmdPrefixRegex}${pattern}`, flags).exec(content)
          if (!res) continue
          const argTxt = `${shortcutEscapeArgs(resolveArgs(args, res))} ${content.slice(res.index + res[0].length)}`
          session.inShortcut = true
          return session.execute(`meme.generate.${name} ${argTxt}`)
        } catch (e) {
          ctx.logger.warn(`Shortcut regex match error for "${pattern}":`, e)
          continue
        }
      }
      return next()
    })
  }

  // 正则表达式转换函数
  const transformRegex = (pythonRegex: string) => {
    let result = pythonRegex.replace(/\(\?P<(?<n>\w+?)>/g, '(?<$<n>>')
    const flags: string[] = []
    result = result.replace(/\(\?([aiLmsux]+)\)/g, (match, flagStr) => {
      for (const flag of flagStr) {
        if (['i', 'm', 's', 'u'].includes(flag) && !flags.includes(flag)) {
          flags.push(flag)
        }
      }
      return ''
    })
    if (flags.length) return { pattern: result, flags: flags.join('') }
    return { pattern: result, flags: '' }
  }

  const escapeRegExp = (string: string) => string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

  // 提取 h.parse 后的文本内容
  const extractContentPlaintext = (content: string) => {
    let elems: any[]
    try {
      elems = h.parse(content)
    } catch (e) {
      return content
    }
    const textBuffer: string[] = []
    const visit = (e: any) => {
      if (e.children && e.children.length) {
        for (const child of e.children) visit(child)
      }
      if (e.type === 'text' && e.attrs?.content) {
        textBuffer.push(e.attrs.content)
      }
    }
    for (const child of elems) visit(child)
    return textBuffer.join('')
  }

  // 解析参数并填充（支持 Python 风格 {1} / {group} 占位符）
  const resolveArgs = (args: string[], res: any) => {
    return args.map((v) => {
      return v.replace(/(?<l>[^\{])?\{(?<v>.+?)\}(?<r>[^\}])?/g, (...m) => {
        const groups = m[m.length - 1]
        const { l, v, r } = groups as { l?: string; v: string; r?: string }
        const index = parseInt(v)
        let resolved: string
        if (!isNaN(index)) {
          resolved = res[index] ?? v
        } else if (res.groups && v in res.groups) {
          resolved = res.groups[v]
        } else {
          resolved = v
        }
        return `${l ?? ''}${extractContentPlaintext(resolved)}${r ?? ''}`
      })
    })
  }

  const shortcutEscapeArgs = (args: any[]) =>
    args.map(arg => String(arg).replace(/\s+/g, '\\s+')).join(' ')

  await UserInfo.apply(ctx, config)

  const throttleDelay = 250
  const afterInitDelay = 600

  // init
  const initMemeList = async () => {
    const tip = '获取表情信息中……'
    ctx.$.notifier?.update({ type: 'primary', content: tip })
    await ctx.$.updateInfos(
      (ctx as any).timer.throttle((now: number, total: number) => {
        const p = Math.ceil((now / total) * 100)
        ctx.$.notifier?.update(
          <p>
            {tip}
            <progress {...({ percentage: p, duration: 1 } as any)}>
              {now} / {total} | {p}%
            </progress>
          </p>,
        )
      }, throttleDelay),
    )
  }
  try {
    await initMemeList()
  } catch (e: any) {
    logger.warn('Failed to fetch meme list, plugin will not work')
    logger.warn(e)
    const errorMsg = e.message || '未知错误'
      ; (ctx as any).timer.setTimeout(() => {
        ctx.$.notifier?.update({
          type: 'danger',
          content: (
            <p>
              <strong>⚠️ 插件初始化失败</strong>
              <br />
              错误信息: {errorMsg}
              <br /><br />
              详细配置指南请查看插件文档
            </p>
          ),
        })
      }, afterInitDelay)
    return
  }

  try {
    // 初始化根命令
    ctx.$.cmd = ctx.command('meme', '制作各种沙雕表情')

    // 加载子模块 (Generate, Blacklist 等)
    // 这里的 apply 会覆盖 ctx.$.reRegisterGenerateCommands
    await Commands.apply(ctx, config)

    // 执行注册 (此时使用的是 Generate.ts 里定义的正确逻辑)
    await ctx.$.reRegisterGenerateCommands()
    await ctx.$.refreshShortcuts?.()
  } catch (e: any) {
    try {
      ctx.$.cmd?.dispose()
    } catch (_) { }
    logger.warn('Failed to initialize commands, plugin will not work')
    logger.warn(e)
      ; (ctx as any).timer.setTimeout(() => {
        ctx.$.notifier?.update({ type: 'danger', content: '插件指令注册失败' })
      }, afterInitDelay)
    return
  }

  const $public: MemePublic = { api: ctx.$.api, infos: ctx.$.infos }
  ctx.set('memesApi', $public)

  const memeCount = Object.keys(ctx.$.infos).length
    ; (ctx as any).timer.setTimeout(() => {
      ctx.$.notifier?.update({
        type: 'success',
        content: <p>插件初始化完毕，共载入 {memeCount} 个表情。</p>,
      })
    }, afterInitDelay)
  logger.info(`Plugin initialized successfully, loaded ${memeCount} memes`)
}