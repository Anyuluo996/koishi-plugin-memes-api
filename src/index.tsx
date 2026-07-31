import { Context, Logger, h, Session } from 'koishi'
import { MemeAPI, MemeInfoResponse } from 'meme-generator-api'
import * as fs from 'fs'
import * as path from 'path'
import pLimit from 'p-limit'

import * as Commands from './commands'
import { Config } from './config'
import { RenderCache } from './cache'
import zhCNLocale from './locales/zh-CN'
import type { HttpConfig, MemeUsageRecord, GuildSettingRecord, UserBlockRecord } from './types/internal'
import { getGuildId } from './types/internal'
import { errorMessage } from './utils'
import type { ImageFetchInfo } from './cache'
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
  renderCache: RenderCache
  cmd?: any
  updateInfos: (
    progressCallback?: (now: number, total: number) => void,
  ) => Promise<void>
  findMeme(query: string): MemeInfoResponse | undefined

  // 黑名单
  /** 获取被拉黑的表情 key 列表（小写归一化，type='meme'） */
  getBlacklistedMemes(): Promise<string[]>
  /** 获取被拉黑的关键词列表（小写归一化，type='keyword'） */
  getBlacklistedKeywords(): Promise<string[]>
  /** 获取全部黑名单条目（原始大小写 + type，用于显示） */
  getBlacklistEntries(): Promise<Array<{ keyword: string; type: string }>>
  /** 拉黑整个表情（type='meme'）。返回 false 表示已存在 */
  addBlacklistedMeme(keyword: string): Promise<boolean>
  /** 拉黑单个触发词（type='keyword'）。返回 false 表示已存在 */
  addBlacklistedKeyword(keyword: string): Promise<boolean>
  /**
   * 移除黑名单条目（大小写不敏感）。
   * - type 提供：仅移除该类型
   * - type 省略：移除该 keyword 的所有类型条目
   * 返回是否实际移除了记录
   */
  removeBlacklistedEntry(keyword: string, type?: 'meme' | 'keyword'): Promise<boolean>
  /**
   * 运行时拦截判断：整个表情是否被禁用。
   * - 表情 key 在 meme 黑名单 → true
   * - 表情所有 keywords 都在 keyword 黑名单（无可用触发词）→ true
   */
  isMemeBlacklisted(memeKey: string, keywords: string[]): Promise<boolean>

  recordMemeUsage(session: Session, memeKey: string): Promise<void>
  getMemeUsageStats(memeKey: string, guildId?: string | null, limit?: number): Promise<any[]>
  getTopMemes(guildId?: string | null, limit?: number): Promise<any[]>
  findMemeKeyByKeyword(keyword: string): string | null

  /**
   * 统一的可用性检查接口（S1：消除 generate/random 中分散的三类检查）。
   * 顺序：黑名单 > 群组禁用 > 用户屏蔽。
   * 返回 'ok' | 'blacklisted' | 'guild-disabled' | 'user-blocked'。
   */
  checkMemeAvailability(
    session: Session,
    info: MemeInfoResponse,
    imageInfos: ImageFetchInfo[],
  ): Promise<'ok' | 'blacklisted' | 'guild-disabled' | 'user-blocked'>

  // 群组管理
  setMemeGuildEnabled(guildId: string, platform: string, memeKey: string, enabled: boolean): Promise<void>
  /** 删除群组某表情的设置记录（= 恢复默认启用）。返回 matched 数 */
  removeMemeGuildSetting(guildId: string, platform: string, memeKey: string): Promise<number>
  isMemeGuildEnabled(guildId: string, platform: string, memeKey: string): Promise<boolean>
  getGuildMemeSettings(guildId: string, platform: string): Promise<any[]>

  // 用户屏蔽
  setUserMemeBlocked(guildId: string, platform: string, userId: string, memeKey: string, blocked: boolean): Promise<void>
  /** 解除用户屏蔽（删除记录）。返回 matched 数 */
  removeUserMemeBlock(guildId: string, platform: string, userId: string, memeKey: string): Promise<number>
  isUserMemeBlocked(guildId: string, platform: string, userId: string, memeKey: string): Promise<boolean>
  getUserMemeBlocks(guildId: string, platform: string, userId?: string): Promise<any[]>

  reRegisterGenerateCommands(): Promise<void>
  refreshShortcuts(): Promise<void>
  /** 刷新表情列表图片。成功返回 true，全部重试失败返回 false（保留旧图） */
  refreshListImage(): Promise<boolean>
  getListImagePath(): string | undefined
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
      // 拉黑类型：'meme' = 整个表情禁用；'keyword' = 仅该触发词的别名/快捷指令禁用
      // 旧数据无 type 字段时，读取层自动视为 'meme'（保留旧行为）
      type: 'string',
    }, {
      primary: 'id', autoInc: true,
      // 复合 unique：(keyword, type) 组合唯一。允许同 keyword 同时存在 meme 和 keyword 两条记录
      indexes: [{ keys: { keyword: 'asc', type: 'asc' }, unique: true }],
    })

    ; (ctx as any).model.extend('memes_usage_stats', {
      id: 'unsigned',
      meme_key: 'string',
      guild_id: 'string',
      user_id: 'string',
      platform: 'string',
      usage_count: 'unsigned',
      last_used: 'timestamp',
    }, {
      primary: 'id', autoInc: true,
      // unique 约束防止并发"查→改/插"模式产生重复记录
      // 注意：minato 对 unique 复合索引要求 keys 为对象形式 { field: 'asc' }
      // （数组形式仅用于非 unique 复合索引）
      indexes: [{
        keys: {
          meme_key: 'asc',
          guild_id: 'asc',
          user_id: 'asc',
          platform: 'asc',
        },
        unique: true,
      }],
    })

    ; (ctx as any).model.extend('memes_guild_settings', {
      id: 'unsigned',
      guild_id: 'string',
      platform: 'string',
      meme_key: 'string',
      enabled: 'boolean',
    }, {
      primary: 'id', autoInc: true,
      // unique 复合索引：防止并发"查→改/插"产生重复记录（与 memes_usage_stats 同范式）
      indexes: [{ keys: { guild_id: 'asc', platform: 'asc', meme_key: 'asc' }, unique: true }],
    })

    ; (ctx as any).model.extend('memes_user_blocks', {
      id: 'unsigned',
      guild_id: 'string',
      platform: 'string',
      user_id: 'string',
      meme_key: 'string',
      blocked: 'boolean',
    }, {
      primary: 'id', autoInc: true,
      // unique 复合索引：同上
      indexes: [{ keys: { guild_id: 'asc', platform: 'asc', user_id: 'asc', meme_key: 'asc' }, unique: true }],
    })

  // === API 初始化 ===
  let httpConfig: HttpConfig
  if (config.requestConfig && typeof config.requestConfig === 'object') {
    const { endpoint, ...rest } = config.requestConfig
    // 用户配置优先，超时过短时（< 60s）自动提升，防止 933 个表情请求超时
    const userTimeout = (config.requestConfig as any)?.timeout
    const timeout = userTimeout && userTimeout >= 60_000 ? userTimeout : 120_000
    httpConfig = { baseURL: endpoint, timeout, ...rest }
  } else {
    httpConfig = { baseURL: 'http://127.0.0.1:2233', timeout: 120_000 }
  }
  ctx.$.api = new MemeAPI((ctx as any).http.extend(httpConfig))
  ctx.$.infos = {}

  // === 渲染缓存初始化 ===
  ctx.$.renderCache = new RenderCache(
    {
      enabled: config.renderCacheEnabled,
      ttl: config.renderCacheTtl,
      maxEntries: config.renderCacheMaxEntries,
      maxSize: config.renderCacheMaxSize,
      persist: config.renderCachePersist,
    },
    config.cacheDir,
  )
  // keepCache=false 时启动清空旧渲染缓存文件
  // 注意：条件不依赖 enabled —— 用户把 enabled 从 true 改为 false 后，
  // 旧持久化文件也应被清理，避免磁盘累积无用数据
  if (config.renderCachePersist && !config.keepCache) {
    ctx.$.renderCache.clearDisk()
  }

  // findMeme 查询缓存（必须在 updateInfos 之前声明，避免 TDZ 风险）
  let findMemeCache: Map<string, MemeInfoResponse> | null = null

  ctx.$.updateInfos = async (progressCallback) => {
    const keys = await ctx.$.api.getKeys()
    const len = keys.length
    progressCallback?.(0, len)

    let ok = 0
    const limit = pLimit(config.getInfoConcurrency)
    // 使用 allSettled：单个表情 getInfo 失败不阻塞整体，保留已成功的部分
    const settled = await Promise.allSettled(
      keys.map((key) => {
        return limit(async () => {
          const v = await ctx.$.api.getInfo(key)
          ok += 1
          progressCallback?.(ok, len)
          return [key, v] as const
        })
      }),
    )
    const newEntries: Array<readonly [string, MemeInfoResponse]> = []
    let failed = 0
    for (const r of settled) {
      if (r.status === 'fulfilled') {
        newEntries.push(r.value)
      } else {
        failed++
      }
    }
    if (failed > 0) {
      logger.warn(`updateInfos: ${failed}/${len} memes failed to load, continuing with ${newEntries.length} successes`)
    }
    // 全部失败时抛错（让上层 refresh/init 的 catch 处理）
    if (newEntries.length === 0 && len > 0) {
      const firstReason = settled.find(r => r.status === 'rejected') as PromiseRejectedResult | undefined
      throw firstReason?.reason ?? new Error('All meme info fetches failed')
    }

    ctx.$.infos = Object.fromEntries(newEntries)
    // 更新后清除 findMeme 查询缓存
    findMemeCache = null
  }

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

  // 表情列表图片路径
  const LIST_IMAGE_NAME = 'meme-list.png'
  // 刷新表情列表图片的有限重试参数（对抗后端瞬时不可用）
  const LIST_IMAGE_MAX_RETRIES = 3
  const LIST_IMAGE_RETRY_DELAY_MS = 2000

  // 表情列表图片：下载并保存到缓存目录
  // 设计要点：
  //   1. 原子替换：先写 .tmp，全部重试成功后再删旧图 + rename，避免失败时丢图
  //   2. 有限重试：对网络步骤（getKeys + renderList）重试 LIST_IMAGE_MAX_RETRIES 次
  //   3. 并发合并：inflight 防止 N 个并发调用击穿后端（对齐 blacklistInflight / RenderCache.dedup 范式）
  //   4. 不吞错：返回布尔，让上层（list 命令、初始化）可感知成败
  let listImageInflight: Promise<boolean> | null = null

  // 实际执行刷新（不含并发合并）；返回 true=成功，false=全部重试失败（保留旧图）
  const doRefreshListImage = async (): Promise<boolean> => {
    const cacheDir = path.resolve(config.cacheDir)
    fs.mkdirSync(cacheDir, { recursive: true })
    const imgPath = path.join(cacheDir, LIST_IMAGE_NAME)
    const tmpPath = `${imgPath}.tmp`
    let lastErr: unknown
    for (let attempt = 1; attempt <= LIST_IMAGE_MAX_RETRIES; attempt++) {
      try {
        // 向后端请求表情列表图片
        const keys = await ctx.$.api.getKeys()
        const blob = await ctx.$.api.renderList({
          meme_list: keys.map(k => ({ meme_key: k })),
          text_template: config.listTextTemplate,
          add_category_icon: config.listAddCategoryIcon,
        })
        // 先写临时文件，确认成功后再替换旧图
        fs.writeFileSync(tmpPath, Buffer.from(await blob.arrayBuffer()))
        // 原子替换：tmp 与目标同目录（同卷）→ renameSync 原子；
        // 极端情况下 cacheDir 跨卷（符号链接/junction）→ EXDEV，回退为 copy+unlink
        try {
          if (fs.existsSync(imgPath)) fs.unlinkSync(imgPath)
          fs.renameSync(tmpPath, imgPath)
        } catch (renameErr: any) {
          if (renameErr?.code === 'EXDEV') {
            fs.copyFileSync(tmpPath, imgPath)
            fs.unlinkSync(tmpPath)
          } else {
            throw renameErr
          }
        }
        logger.info(`表情列表图片已更新: ${imgPath}`)
        return true
      } catch (e) {
        lastErr = e
        if (attempt < LIST_IMAGE_MAX_RETRIES) {
          logger.warn(`刷新表情列表图片失败(第${attempt}次)，${LIST_IMAGE_RETRY_DELAY_MS}ms后重试:`, e)
          // 用 koishi timer 绑定插件生命周期（卸载时自动取消），避免裸 setTimeout 泄露
          await new Promise<void>(r => (ctx as any).timer.setTimeout(r, LIST_IMAGE_RETRY_DELAY_MS))
        }
      }
    }
    // 全部失败：清理 tmp，保留旧图（若有）
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath)
    } catch {
      // tmp 清理失败不致命
    }
    logger.warn(`刷新表情列表图片失败，已重试${LIST_IMAGE_MAX_RETRIES}次:`, lastErr)
    return false
  }

  ctx.$.refreshListImage = async (): Promise<boolean> => {
    // 并发合并：已在进行中的刷新直接复用其 Promise，避免并发击穿后端
    if (listImageInflight) return listImageInflight
    listImageInflight = doRefreshListImage()
    try {
      return await listImageInflight
    } finally {
      listImageInflight = null
    }
  }

  // 获取表情列表图片路径（未生成时返回 undefined）
  ctx.$.getListImagePath = () => {
    const imgPath = path.resolve(config.cacheDir, LIST_IMAGE_NAME)
    return fs.existsSync(imgPath) ? imgPath : undefined
  }

  // 缓存失效函数，供其他模块调用
  ctx.$.invalidateFindMemeCache = () => {
    findMemeCache = null
  }

  ctx.$.invalidateAllCaches = () => {
    findMemeCache = null
    invalidateBlacklistCache()
    // 删除旧的表情列表图片
    try {
      const imgPath = path.resolve(config.cacheDir, LIST_IMAGE_NAME)
      if (fs.existsSync(imgPath)) fs.unlinkSync(imgPath)
    } catch (_) { }
  }

  // === 数据库操作函数 ===
  // 黑名单缓存：分两个 Set 存储，均【小写归一化】
  // - memesSet: type='meme' 的条目（整个表情禁用）
  // - keywordsSet: type='keyword' 的条目（仅该触发词禁用）
  // 旧数据无 type 字段时，读取层视为 'meme'（保留旧行为）
  type BlacklistCache = { memes: Set<string>; keywords: Set<string>; raw: Array<{ keyword: string; type: string }> }
  let blacklistCache: BlacklistCache | null = null
  // inflight 防止冷启动并发击穿（对齐 RenderCache.dedup 范式）
  let blacklistInflight: Promise<BlacklistCache> | null = null

  const buildBlacklistCache = async (): Promise<BlacklistCache> => {
    const records = await (ctx as any).database.get('memes_blacklist', {})
    const memes = new Set<string>()
    const keywords = new Set<string>()
    const raw: Array<{ keyword: string; type: string }> = []
    for (const record of records) {
      // 旧数据无 type → 视为 'meme'（保留旧行为：拉黑 = 整个禁用）
      const type = record.type === 'keyword' ? 'keyword' : 'meme'
      const lower = String(record.keyword).toLowerCase()
      raw.push({ keyword: record.keyword, type })
      if (type === 'meme') memes.add(lower)
      else keywords.add(lower)
    }
    return { memes, keywords, raw }
  }

  const ensureBlacklistCache = async (): Promise<BlacklistCache> => {
    if (blacklistCache) return blacklistCache
    if (blacklistInflight) return blacklistInflight
    blacklistInflight = (async () => {
      const result = await buildBlacklistCache()
      blacklistCache = result
      blacklistInflight = null
      return result
    })()
    return blacklistInflight
  }

  const invalidateBlacklistCache = () => {
    blacklistCache = null
    blacklistInflight = null
  }

  ctx.$.getBlacklistedMemes = async () => {
    const cache = await ensureBlacklistCache()
    return Array.from(cache.memes)
  }

  ctx.$.getBlacklistedKeywords = async () => {
    const cache = await ensureBlacklistCache()
    return Array.from(cache.keywords)
  }

  ctx.$.getBlacklistEntries = async () => {
    const cache = await ensureBlacklistCache()
    return cache.raw
  }

  /** 添加黑名单条目的通用实现，按 type 区分；unique 冲突视为幂等成功 */
  const addBlacklistEntry = async (keyword: string, type: 'meme' | 'keyword'): Promise<boolean> => {
    try {
      await (ctx as any).database.create('memes_blacklist', { keyword, type })
      invalidateBlacklistCache()
      return true
    } catch (e: any) {
      // unique 冲突（同 keyword+type 已存在）→ 幂等返回 false
      // 不同 driver 报错信息不一致，宽松判断
      const msg = errorMessage(e).toLowerCase()
      if (msg.includes('unique') || msg.includes('duplicate') || msg.includes('constraint')) {
        return false
      }
      throw e
    }
  }

  ctx.$.addBlacklistedMeme = (keyword: string) => addBlacklistEntry(keyword, 'meme')
  ctx.$.addBlacklistedKeyword = (keyword: string) => addBlacklistEntry(keyword, 'keyword')

  ctx.$.removeBlacklistedEntry = async (keyword: string, type?: 'meme' | 'keyword') => {
    // 大小写不敏感删除：先查出所有记录过滤，再按 id 删
    // （minato 默认字符串相等是大小写敏感的，直接 remove({keyword}) 会漏掉大小写不同的条目）
    const records = await (ctx as any).database.get('memes_blacklist', {})
    const lower = keyword.toLowerCase()
    const toDelete = records.filter((r: any) => {
      if (String(r.keyword).toLowerCase() !== lower) return false
      if (type) {
        const rType = r.type === 'keyword' ? 'keyword' : 'meme'
        return rType === type
      }
      return true
    })
    if (toDelete.length === 0) return false
    await (ctx as any).database.remove('memes_blacklist', { id: toDelete.map((r: any) => r.id) })
    invalidateBlacklistCache()
    return true
  }

  ctx.$.isMemeBlacklisted = async (memeKey: string, keywords: string[]) => {
    const cache = await ensureBlacklistCache()
    const keyLower = memeKey.toLowerCase()

    if (config.debug) {
      logger.info(`[DEBUG] Checking blacklist for key: ${memeKey}, keywords: ${keywords.join(', ')}`)
      logger.info(`[DEBUG] Blacklisted memes: ${Array.from(cache.memes).join(', ')}`)
      logger.info(`[DEBUG] Blacklisted keywords: ${Array.from(cache.keywords).join(', ')}`)
    }

    // 1. 表情 key 在 meme 黑名单 → 整个禁用
    if (cache.memes.has(keyLower)) return true

    // 2. 若 keywords 为空（仅有 key），仅按 key 判断
    if (keywords.length === 0) return false

    // 3. 所有触发词都在 keyword 黑名单（无可用触发词）→ 整个禁用
    //    部分被拉黑时，剩余触发词仍可使用（符合用户预期）
    const allKeywordsBlacklisted = keywords.every(kw => cache.keywords.has(kw.toLowerCase()))
    if (allKeywordsBlacklisted) return true

    return false
  }

  ctx.$.recordMemeUsage = async (session: Session, memeKey: string) => {
    try {
      const guildId = session.guildId || 'private'
      const userId = session.userId
      const platform = session.platform

      // 读-改-写 + 重试：兼容所有 driver（SQLite 不支持 upsert 的函数值表达式）
      // 配合 memes_usage_stats 上的 unique 索引，并发场景下最多重试 2 次
      for (let attempt = 0; attempt < 3; attempt++) {
        const existing = await (ctx as any).database.get('memes_usage_stats', {
          meme_key: memeKey, guild_id: guildId, user_id: userId, platform,
        })
        if (existing.length > 0) {
          await (ctx as any).database.set('memes_usage_stats', existing[0].id, {
            usage_count: (existing[0].usage_count || 0) + 1,
            last_used: new Date(),
          })
          return
        }
        try {
          await (ctx as any).database.create('memes_usage_stats', {
            meme_key: memeKey, guild_id: guildId, user_id: userId,
            platform, usage_count: 1, last_used: new Date(),
          })
          return
        } catch (createErr) {
          // 并发场景：另一个请求已创建 → 下一轮循环走 set 分支
          const msg = errorMessage(createErr).toLowerCase()
          if (msg.includes('unique') || msg.includes('duplicate') || msg.includes('constraint')) {
            continue
          }
          throw createErr
        }
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
      // 注意：minato 的 groupBy/eval 聚合在部分 driver（memory/mongo）上行为不一致，
      // 故仍用内存聚合，但只取必要字段（meme_key + usage_count）减小内存压力。
      // 长期方案：迁移到支持窗口函数的 driver 或定时物化。
      const allRecords = await (ctx as any).database.get('memes_usage_stats', query, [
        'meme_key', 'usage_count',
      ])
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

  // ============================================================
  // 群组设置：内存缓存（低频变更、高频读取）
  // 设计统一为「删除即启用」：
  // - 禁用：写入 enabled=false 记录
  // - 启用：删除记录（恢复默认 = 启用）
  // - 不再有 enabled=true 的记录（避免僵尸数据）
  // ============================================================
  // 缓存结构：`${guildId}\0${platform}` → Map<memeKey(lowercase), boolean(enabled)>
  type GuildSettingsCache = Map<string, Map<string, boolean>>
  let guildSettingsCache: GuildSettingsCache | null = null
  let guildSettingsInflight: Promise<GuildSettingsCache> | null = null

  const buildGuildSettingsCache = async (): Promise<GuildSettingsCache> => {
    const records = await (ctx as any).database.get('memes_guild_settings', {})
    const cache: GuildSettingsCache = new Map()
    for (const r of records) {
      const scopeKey = `${r.guild_id}\0${r.platform}`
      let inner = cache.get(scopeKey)
      if (!inner) { inner = new Map(); cache.set(scopeKey, inner) }
      inner.set(String(r.meme_key).toLowerCase(), !!r.enabled)
    }
    return cache
  }

  const ensureGuildSettingsCache = async (): Promise<GuildSettingsCache> => {
    if (guildSettingsCache) return guildSettingsCache
    if (guildSettingsInflight) return guildSettingsInflight
    guildSettingsInflight = (async () => {
      const result = await buildGuildSettingsCache()
      guildSettingsCache = result
      guildSettingsInflight = null
      return result
    })()
    return guildSettingsInflight
  }

  const invalidateGuildSettingsCache = () => {
    guildSettingsCache = null
    guildSettingsInflight = null
  }

  // 设置群组表情启用状态（写 DB + 更新缓存，原子 upsert）
  ctx.$.setMemeGuildEnabled = async (guildId: string, platform: string, memeKey: string, enabled: boolean) => {
    await (ctx as any).database.upsert('memes_guild_settings', [{
      guild_id: guildId, platform, meme_key: memeKey, enabled,
    }])
    // 更新缓存（避免重新查 DB）
    const cache = await ensureGuildSettingsCache()
    const scopeKey = `${guildId}\0${platform}`
    let inner = cache.get(scopeKey)
    if (!inner) { inner = new Map(); cache.set(scopeKey, inner) }
    inner.set(memeKey.toLowerCase(), enabled)
  }

  // 删除群组某表情的设置记录（= 恢复默认启用）
  ctx.$.removeMemeGuildSetting = async (guildId: string, platform: string, memeKey: string) => {
    const result = await (ctx as any).database.remove('memes_guild_settings', {
      guild_id: guildId, platform, meme_key: memeKey,
    })
    // 从缓存中移除
    const cache = await ensureGuildSettingsCache()
    const scopeKey = `${guildId}\0${platform}`
    cache.get(scopeKey)?.delete(memeKey.toLowerCase())
    return result?.matched ?? 0
  }

  ctx.$.isMemeGuildEnabled = async (guildId: string, platform: string, memeKey: string) => {
    const cache = await ensureGuildSettingsCache()
    const inner = cache.get(`${guildId}\0${platform}`)
    if (!inner) return true  // 该群无任何设置 = 全部默认启用
    const v = inner.get(memeKey.toLowerCase())
    return v === undefined ? true : v  // 无记录 = 启用
  }

  ctx.$.getGuildMemeSettings = async (guildId: string, platform: string) => {
    // 直接读 DB（list 命令需要原始字段，缓存是归一化后的）
    return await (ctx as any).database.get('memes_guild_settings', {
      guild_id: guildId, platform: platform
    })
  }

  // ============================================================
  // 用户屏蔽：内存缓存（同上范式）
  // 设计统一为「删除即未屏蔽」：
  // - 屏蔽：写入 blocked=true 记录
  // - 解除：删除记录（恢复默认 = 未屏蔽）
  // - 不再有 blocked=false 的僵尸数据（U10/S3 修复）
  // ============================================================
  // 缓存结构：`${guildId}\0${platform}` → Map<userId(lowercase), Set<memeKey(lowercase)>>
  type UserBlocksCache = Map<string, Map<string, Set<string>>>
  let userBlocksCache: UserBlocksCache | null = null
  let userBlocksInflight: Promise<UserBlocksCache> | null = null

  const buildUserBlocksCache = async (): Promise<UserBlocksCache> => {
    const records = await (ctx as any).database.get('memes_user_blocks', {})
    const cache: UserBlocksCache = new Map()
    for (const r of records) {
      // 旧数据可能存在 blocked=false 的僵尸记录，构建缓存时忽略它们
      // （下一次 unblock 改为删除后，僵尸记录会自然消失）
      if (!r.blocked) continue
      const scopeKey = `${r.guild_id}\0${r.platform}`
      let byUser = cache.get(scopeKey)
      if (!byUser) { byUser = new Map(); cache.set(scopeKey, byUser) }
      let memes = byUser.get(String(r.user_id).toLowerCase())
      if (!memes) { memes = new Set(); byUser.set(String(r.user_id).toLowerCase(), memes) }
      memes.add(String(r.meme_key).toLowerCase())
    }
    return cache
  }

  const ensureUserBlocksCache = async (): Promise<UserBlocksCache> => {
    if (userBlocksCache) return userBlocksCache
    if (userBlocksInflight) return userBlocksInflight
    userBlocksInflight = (async () => {
      const result = await buildUserBlocksCache()
      userBlocksCache = result
      userBlocksInflight = null
      return result
    })()
    return userBlocksInflight
  }

  const invalidateUserBlocksCache = () => {
    userBlocksCache = null
    userBlocksInflight = null
  }

  // 屏蔽用户（type='block'，原子 upsert）
  ctx.$.setUserMemeBlocked = async (guildId: string, platform: string, userId: string, memeKey: string, _blocked: boolean) => {
    // _blocked 参数保留以兼容旧签名；新设计统一为「屏蔽=写入true，解除=删除」
    // 若传入 false，视为解除屏蔽（删除记录）
    if (!_blocked) {
      await ctx.$.removeUserMemeBlock(guildId, platform, userId, memeKey)
      return
    }
    await (ctx as any).database.upsert('memes_user_blocks', [{
      guild_id: guildId, platform, user_id: userId, meme_key: memeKey, blocked: true,
    }])
    // 更新缓存
    const cache = await ensureUserBlocksCache()
    const scopeKey = `${guildId}\0${platform}`
    let byUser = cache.get(scopeKey)
    if (!byUser) { byUser = new Map(); cache.set(scopeKey, byUser) }
    let memes = byUser.get(userId.toLowerCase())
    if (!memes) { memes = new Set(); byUser.set(userId.toLowerCase(), memes) }
    memes.add(memeKey.toLowerCase())
  }

  // 解除屏蔽（删除记录）
  ctx.$.removeUserMemeBlock = async (guildId: string, platform: string, userId: string, memeKey: string) => {
    const result = await (ctx as any).database.remove('memes_user_blocks', {
      guild_id: guildId, platform, user_id: userId, meme_key: memeKey,
    })
    // 从缓存中移除
    const cache = await ensureUserBlocksCache()
    cache.get(`${guildId}\0${platform}`)?.get(userId.toLowerCase())?.delete(memeKey.toLowerCase())
    return result?.matched ?? 0
  }

  ctx.$.isUserMemeBlocked = async (guildId: string, platform: string, userId: string, memeKey: string) => {
    const cache = await ensureUserBlocksCache()
    const byUser = cache.get(`${guildId}\0${platform}`)
    if (!byUser) return false
    return byUser.get(userId.toLowerCase())?.has(memeKey.toLowerCase()) ?? false
  }

  ctx.$.getUserMemeBlocks = async (guildId: string, platform: string, userId?: string) => {
    // list 命令用，直接读 DB 拿原始字段
    const query: any = { guild_id: guildId, platform: platform }
    if (userId) query.user_id = userId
    return await (ctx as any).database.get('memes_user_blocks', query)
  }

  // ============================================================
  // S1：统一的可用性检查接口（generate/random 共用）
  // 顺序：黑名单 > 群组禁用 > 用户屏蔽
  // 注：本接口适合 generate 单表情检查；random 的批量过滤仍各自优化（避免 N 次 await）
  // ============================================================
  ctx.$.checkMemeAvailability = async (session, info, imageInfos: ImageFetchInfo[]) => {
    const guildId = getGuildId(session)
    const platform = session.platform

    // 1. 黑名单（按表情粒度兜底）
    if (await ctx.$.isMemeBlacklisted(info.key, info.keywords)) return 'blacklisted'

    // 2. 群组禁用（仅群聊场景）
    if (guildId !== 'private') {
      if (!(await ctx.$.isMemeGuildEnabled(guildId, platform, info.key))) return 'guild-disabled'
    }

    // 3. 用户屏蔽（仅群聊场景；跳过发送者自己，避免用户屏蔽自己后无法使用表情）
    if (guildId !== 'private') {
      for (const item of imageInfos) {
        if (!('userId' in item) || !item.userId) continue
        if (item.userId === session.userId) continue  // 故意跳过自己（U8：避免自我屏蔽死锁）
        if (await ctx.$.isUserMemeBlocked(guildId, platform, item.userId, info.key)) {
          return 'user-blocked'
        }
      }
    }

    return 'ok'
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
    // 同时拉取两类黑名单：meme（整个表情禁用）和 keyword（仅该触发词禁用）
    const blacklistedMemes = new Set(await ctx.$.getBlacklistedMemes())
    const blacklistedKeywords = new Set(await ctx.$.getBlacklistedKeywords())

    for (const info of Object.values(ctx.$.infos)) {
      // 表情整体被拉黑 → 跳过所有快捷指令
      if (blacklistedMemes.has(info.key.toLowerCase())) continue

      // 关键词快捷方式（转成正则表达式）
      for (const keyword of info.keywords) {
        // 单个关键词被拉黑 → 该关键词不注册快捷指令（其他关键词仍生效）
        if (blacklistedKeywords.has(keyword.toLowerCase())) continue
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

      // 辅助函数：提取最后一个纯文本片段（排除图片、@等元素）
      const extractLastTextSegment = (content: string): string => {
        let elems: any[]
        try {
          elems = h.parse(content)
        } catch {
          return content
        }
        const texts: string[] = []
        const visit = (e: any) => {
          if (e.children?.length) e.children.forEach(visit)
          if (e.type === 'text' && e.attrs?.content) texts.push(e.attrs.content)
        }
        elems.forEach(visit)
        const combined = texts.join('')
        // 取最后一个以非空白字符结尾的文本片段（最后一个"词"之前的内容）
        const trimmed = combined.trimEnd()
        const lastNonSpace = trimmed.search(/\s+\S*$/)
        return lastNonSpace === -1 ? trimmed : trimmed.slice(lastNonSpace + 1)
      }

      // 辅助函数：在 content 中尝试开头匹配
      const tryMatchAtStart = (fullContent: string, prefixRe: string, pattern: string, flags: string, args: string[]) => {
        const re = new RegExp(`^${prefixRe}${pattern}`, flags)
        const res = re.exec(fullContent)
        if (!res) return undefined
        const argTxt = `${shortcutEscapeArgs(resolveArgs(args, res))} ${fullContent.slice(res.index + res[0].length)}`
        return argTxt
      }

      // 辅助函数：在 content 末尾（最后一个文本段末尾）尝试匹配
      const tryMatchAtEnd = (fullContent: string, prefixRe: string, pattern: string, flags: string, args: string[]) => {
        const lastSegment = extractLastTextSegment(fullContent)
        if (!lastSegment) return undefined
        // 在 lastSegment 末尾匹配（关键词必须在段末尾）
        const re = new RegExp(`${prefixRe}${pattern}$`, flags)
        const res = re.exec(lastSegment)
        if (!res) return undefined
        // 从 lastSegment 提取前缀内容作为参数（关键词前的内容）
        const beforeKw = lastSegment.slice(0, res.index)
        // 原始 content 中关键词之前的所有内容（含图片、@等）拼接上前缀文本
        // 找到 lastSegment 在 fullContent 中的位置
        const segStart = fullContent.lastIndexOf(lastSegment)
        const beforeSeg = fullContent.slice(0, segStart)
        const combinedBefore = `${beforeSeg}${beforeKw}`.trim()
        const argTxt = `${shortcutEscapeArgs(resolveArgs(args, res))} ${combinedBefore}`
        return argTxt
      }

      for (const { name, pattern, flags, args } of shortcuts) {
        try {
          let argTxt: string | undefined

          if (config.shortcutMatchMode !== 'end') {
            argTxt = tryMatchAtStart(content, cmdPrefixRegex, pattern, flags, args)
          }

          if (!argTxt && config.shortcutMatchMode !== 'start') {
            argTxt = tryMatchAtEnd(content, cmdPrefixRegex, pattern, flags, args)
          }

          if (!argTxt) continue

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
    args.map(arg => String(arg)).join(' ')

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
    logger.warn('Failed to fetch meme list, continuing without memes:', e)
    const errorMsg = e.message || '未知错误'
      ; (ctx as any).timer.setTimeout(() => {
        ctx.$.notifier?.update({
          type: 'warning',
          content: (
            <p>
              <strong>⚠️ 表情包信息获取失败</strong>
              <br />
              错误: {errorMsg}
              <br />
              表情列表功能暂时不可用，请检查后端连接。
            </p>
          ),
        })
      }, afterInitDelay)
    // 不 return，插件继续初始化，表情列表图片在启动后重试
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

  // 后台生成表情列表图片（内部含有限重试，失败不影响启动）。
  // 不再以 memeCount > 0 为前置条件：即便 updateInfos 全部失败，
  // 也尝试刷新列表图片，避免用户陷入"永远没有列表图"的状态。
  ctx.$.refreshListImage().catch(() => {})
}