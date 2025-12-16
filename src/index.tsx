import { Context, Logger, h } from 'koishi'
import { MemeAPI, MemeInfoResponse } from 'meme-generator-api'
import pLimit from 'p-limit'

import * as Commands from './commands'
import { Config } from './config'
import zhCNLocale from './locales/zh-CN'
import * as UserInfo from './user-info'

import type {} from '@koishijs/plugin-help'
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
  isMemeBlacklisted(memeKey: string, keywords: string[]): Promise<boolean> // 新增便捷检测函数

  recordMemeUsage(session: any, memeKey: string): Promise<void>
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
  ;(ctx as any).i18n.define('zh-CN', zhCNLocale)
  ;(ctx as any).i18n.define('zh', zhCNLocale)

  // isolate new context for plugin internal use
  ctx = ctx.isolate('$')
  ctx.set('$', {})

  ctx.inject(['notifier'], () => {
    ctx.$.notifier = ctx.notifier.create()
  })

  // 定义数据库模型
  ;(ctx as any).model.extend('memes_blacklist', {
    id: 'unsigned',
    keyword: 'string',
  }, {
    primary: 'id',
    autoInc: true,
  })

  // 表情包使用统计表
  ;(ctx as any).model.extend('memes_usage_stats', {
    id: 'unsigned',
    meme_key: 'string',
    guild_id: 'string',
    user_id: 'string',
    platform: 'string',
    usage_count: 'unsigned',
    last_used: 'timestamp',
  }, {
    primary: 'id',
    autoInc: true,
  })

  // 表情包群组设置表
  ;(ctx as any).model.extend('memes_guild_settings', {
    id: 'unsigned',
    guild_id: 'string',
    platform: 'string',
    meme_key: 'string',
    enabled: 'boolean',
  }, {
    primary: 'id',
    autoInc: true,
  })

  // 用户表情包屏蔽设置表
  ;(ctx as any).model.extend('memes_user_blocks', {
    id: 'unsigned',
    guild_id: 'string',
    platform: 'string',
    user_id: 'string',
    meme_key: 'string',
    blocked: 'boolean',
  }, {
    primary: 'id',
    autoInc: true,
  })

  // 处理 requestConfig，现在只支持对象类型（WebUI 完美展示）
  let httpConfig: any
  if (config.requestConfig && typeof config.requestConfig === 'object') {
    // 因为 Config 里现在叫 endpoint，但 ctx.http 需要 baseURL
    // 我们解构出 endpoint 并重命名为 baseURL，其他的保持不变
    const { endpoint, ...rest } = config.requestConfig
    httpConfig = {
      baseURL: endpoint,
      ...rest
    }
  } else {
    // 默认配置
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
    for (const k in ctx.$.infos) delete ctx.$.infos[k]
    Object.assign(ctx.$.infos, Object.fromEntries(newEntries))
  }

  ctx.$.findMeme = (query) => {
    query = query.trim()
    if (query in ctx.$.infos) return ctx.$.infos[query]

    query = query.toLowerCase()
    for (const info of Object.values(ctx.$.infos)) {
      for (const keyword of info.keywords) {
        if (keyword.toLowerCase() === query) return info
      }
      for (const tag of info.tags) {
        if (tag.toLowerCase() === query) return info
      }
      for (const { key, humanized } of info.shortcuts) {
        const ok = humanized
          ? humanized.toLowerCase() === query
          : key.toLowerCase() === query
        if (ok) return info
      }
    }
  }

  // 黑名单数据库操作函数
  ctx.$.getBlacklistedKeywords = async () => {
    const records = await (ctx as any).database.get('memes_blacklist', {})
    return records.map((record: any) => record.keyword)
  }

  ctx.$.addBlacklistedKeyword = async (keyword: string) => {
    const existing = await (ctx as any).database.get('memes_blacklist', { keyword })
    if (existing.length > 0) {
      return false
    }
    await (ctx as any).database.create('memes_blacklist', { keyword })
    return true
  }

  ctx.$.removeBlacklistedKeyword = async (keyword: string) => {
    const result = await (ctx as any).database.remove('memes_blacklist', { keyword })
    return result.matched > 0
  }

  // 新增：判断某个表情是否包含被屏蔽的关键词
  ctx.$.isMemeBlacklisted = async (memeKey: string, keywords: string[]) => {
    const blacklist = await ctx.$.getBlacklistedKeywords()
    // 检查 Key
    if (blacklist.includes(memeKey)) return true
    // 检查 Keywords (任意一个关键词在黑名单，该表情即被判定为黑名单表情)
    for (const kw of keywords) {
      if (blacklist.includes(kw)) return true
    }
    return false
  }

  // 表情包使用统计数据库操作函数
  ctx.$.recordMemeUsage = async (session: any, memeKey: string) => {
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
  }

  ctx.$.getMemeUsageStats = async (memeKey: string, guildId: string | null = null, limit: number = 10) => {
    try {
      const query: any = { meme_key: memeKey }
      if (guildId) {
        query.guild_id = guildId
      }

      const records = await (ctx as any).database.get('memes_usage_stats', query)

      return records
        .sort((a: any, b: any) => b.usage_count - a.usage_count)
        .slice(0, limit)

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

  // 通过关键词查找表情包标识符
  ctx.$.findMemeKeyByKeyword = (keyword: string) => {
    if (ctx.$.infos[keyword]) {
      return keyword
    }

    for (const [key, info] of Object.entries(ctx.$.infos)) {
      if (info.keywords && info.keywords.includes(keyword)) {
        return key
      }
    }

    return null
  }

  // 表情包群组设置数据库操作函数
  ctx.$.setMemeGuildEnabled = async (guildId: string, platform: string, memeKey: string, enabled: boolean) => {
    const existing = await (ctx as any).database.get('memes_guild_settings', {
      guild_id: guildId,
      platform: platform,
      meme_key: memeKey
    })

    if (existing.length > 0) {
      await (ctx as any).database.set('memes_guild_settings', existing[0].id, {
        enabled: enabled
      })
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

    if (records.length === 0) {
      return true
    }

    return records[0].enabled
  }

  ctx.$.getGuildMemeSettings = async (guildId: string, platform: string) => {
    const records = await (ctx as any).database.get('memes_guild_settings', {
      guild_id: guildId,
      platform: platform
    })

    return records
  }

  // 用户表情包屏蔽数据库操作函数
  ctx.$.setUserMemeBlocked = async (guildId: string, platform: string, userId: string, memeKey: string, blocked: boolean) => {
    const existing = await (ctx as any).database.get('memes_user_blocks', {
      guild_id: guildId,
      platform: platform,
      user_id: userId,
      meme_key: memeKey
    })

    if (existing.length > 0) {
      await (ctx as any).database.set('memes_user_blocks', existing[0].id, {
        blocked: blocked
      })
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

    if (records.length === 0) {
      return false
    }

    return records[0].blocked
  }

  ctx.$.getUserMemeBlocks = async (guildId: string, platform: string, userId?: string) => {
    const query: any = {
      guild_id: guildId,
      platform: platform
    }

    if (userId) {
      query.user_id = userId
    }

    const records = await (ctx as any).database.get('memes_user_blocks', query)

    return records
  }

  // 重新注册生成命令（包含关键词冲突处理）
  ctx.$.reRegisterGenerateCommands = async () => {
    // 定义一个 Set 用来记录这次启动已经注册过的名字，防止同一个循环里重复
    const registeredNames = new Set<string>()

    // 第一步：收集所有关键词
    const keywordMap = new Map()
    for (const info of Object.values(ctx.$.infos)) {
      for (const keyword of info.keywords) {
        if (!keywordMap.has(keyword)) {
          keywordMap.set(keyword, [])
        }
        keywordMap.get(keyword).push(info)
      }
    }

    // 第二步：为冲突关键词添加数字后缀
    const resolvedKeywords = new Map()
    logger.info('关键词冲突检测开始...')

    for (const info of Object.values(ctx.$.infos)) {
      const resolvedKws = []
      for (const keyword of info.keywords) {
        const conflictingInfos = keywordMap.get(keyword)
        if (conflictingInfos.length === 1) {
          resolvedKws.push(keyword)
        } else {
          const index = conflictingInfos.indexOf(info)
          const resolvedKeyword = `${keyword}${index + 1}`
          resolvedKws.push(resolvedKeyword)
          logger.info(`关键词冲突: "${keyword}" 被以下表情使用: ${conflictingInfos.map((i: any) => i.key).join(', ')}, 已自动添加数字后缀`)
        }
      }
      resolvedKeywords.set(info.key, resolvedKws)
    }

    // 清理现有命令逻辑（更健壮的版本）
    try {
      // 务必使用副本进行遍历，因为 dispose 会修改数组长度
      const commandsToRemove = ctx.$.cmd?.children?.filter(cmd =>
        cmd.name.startsWith('meme.generate.')
      ) || []

      for (const cmd of commandsToRemove) {
        cmd.dispose()
      }
    } catch (e) {
      logger.warn('清理旧命令时出错 (非致命错误)', e)
    }

    // 注册新命令
    const generateSubCommands = []
    for (const info of Object.values(ctx.$.infos)) {
      const subCmd = ctx.$.cmd.subcommand(
        `.generate ${info.key} <target:user>`,
        (info as any).description || `生成${info.key}表情包`
      )

      // --- 修改开始：更安全的别名注册逻辑 ---

      const resolvedKws = resolvedKeywords.get(info.key) || info.keywords

      // 获取黑名单
      const blacklist = new Set(await ctx.$.getBlacklistedKeywords())

      // 过滤掉：1.黑名单中的词 2.本次已经注册过的词
      const validKeywords = resolvedKws.filter((kw: string) => {
        if (blacklist.has(kw)) return false // 被黑名单屏蔽
        if (registeredNames.has(kw)) return false // 已经被前面的表情占用了
        return true
      })

      // 记录这些关键词已被占用
      validKeywords.forEach(kw => registeredNames.add(kw))

      const blockedKeywords = resolvedKws.filter((kw: string) => blacklist.has(kw))
      if (blockedKeywords.length > 0) {
        logger.info(`表情 "${info.key}" 的以下关键词已被黑名单过滤: ${blockedKeywords.join(', ')}`)
      }

      // 检查是否有被去重的关键词
      const duplicateKeywords = resolvedKws.filter((kw: string) => registeredNames.has(kw) && !blacklist.has(kw))
      if (duplicateKeywords.length > 0 && duplicateKeywords.length !== resolvedKws.length) {
        logger.info(`表情 "${info.key}" 的以下关键词因重复被自动去重: ${duplicateKeywords.join(', ')}`)
      }

      for (const kw of validKeywords) {
        try {
          // 给注册过程穿上"防弹衣"，防止 Koishi 抛出错误导致崩溃
          subCmd.alias(`.${kw}`)
        } catch (error: any) {
          // 只是警告，不要抛出异常，这样循环可以继续，插件能正常启动
          // Error: duplicate command names 说明和系统其他插件冲突了
          ctx.logger.warn(`无法注册关键词别名: "${kw}" (属于表情: ${info.key}) - 原因: 名字冲突/已存在`)
        }
      }

      // --- 修改结束 ---

      subCmd.action(async ({ session }, target) => {
        if (!session) return

        try {
          const guildId = (session as any).guildId || 'private'
          const platform = (session as any).platform

          // 检查群组启用状态
          const isEnabled = await ctx.$.isMemeGuildEnabled(guildId, platform, info.key)
          if (!isEnabled) {
            await session.send(`❌ 表情包 "${info.key}" 在当前群组已被禁用！`)
            return
          }

          // 检查用户屏蔽设置（仅在群组中）
          if (guildId !== 'private') {
            // 解析被@的用户ID
            const content = session.content || ''
            const mentionedUserIds = new Set<string>()

            // OneBot 格式: [CQ:at,qq=123456]
            const onebotAtRegex = /\[CQ:at,qq=(\d+)\]/g
            let match
            while ((match = onebotAtRegex.exec(content)) !== null) {
              mentionedUserIds.add(match[1])
            }

            // 如果没有解析到@的用户，但 target 参数存在，则使用 target
            const userIdToCheck = target?.userId || target
            if (userIdToCheck) {
              mentionedUserIds.add(String(userIdToCheck))
            }

            // 检查每个被@的用户是否被屏蔽
            for (const userId of mentionedUserIds) {
              const isBlocked = await ctx.$.isUserMemeBlocked(guildId, platform, userId, info.key)
              if (isBlocked) {
                // 静默跳过，不生成表情包也不提示
                return
              }
            }
          }

          const userInfo = await ctx.$.getInfoFromID?.(session, target?.userId || target)
          if (!userInfo) {
            await session.send('❌ 无法获取用户信息')
            return
          }

          const url = await (ctx.$.api as any).generate(info.key, userInfo.url, userInfo.userInfo)
          await session.send(<img src={url} />)

          // 记录使用统计
          try {
            await ctx.$.recordMemeUsage(session, info.key)
          } catch (error) {
            logger.warn('记录使用统计失败', error)
          }
        } catch (error: any) {
          logger.warn(`生成表情包失败: ${info.key}`, error)
          await session.send(`❌ 生成表情包失败: ${error.message}`)
        }
      })

      generateSubCommands.push(subCmd)
    }

    logger.info(`已注册 ${generateSubCommands.length} 个表情生成命令`)
  }

  // 刷新快捷指令
  ctx.$.refreshShortcuts = async () => {
    if (!config.enableShortcut) return

    const shortcuts = []
    for (const info of Object.values(ctx.$.infos)) {
      for (const { key, args } of info.shortcuts) {
        shortcuts.push({
          name: info.key,
          key: key,
          args: args ?? []
        })
      }
    }

    ;(ctx as any).middleware(async (session: any, next: any) => {
      const { content } = session
      if (!content) return next()

      const cmdPrefixRegex = (() => {
        if (config.shortcutUsePrefix) {
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

      for (const { name, key, args } of shortcuts) {
        const transformResult = transformRegex(key.replace(/^\^/, "").replace(/\$$/, ""))
        const regexData = typeof transformResult === 'object' && transformResult.pattern
          ? transformResult
          : { pattern: transformResult, flags: '' }

        const regexFlags = regexData.flags || ''
        const res = new RegExp(`^${cmdPrefixRegex}${regexData.pattern}`, regexFlags).exec(content)
        if (!res) continue

        const argTxt = `${escapeArgs(resolveArgs(args, res))} ${content.slice(res.index + res[0].length)}`
        session.inShortcut = true
        return session.execute(`meme.generate.${name} ${argTxt}`)
      }
      return next()
    })
  }

  // 正则表达式转换函数
  const transformRegex = (pythonRegex: string) => {
    let result = pythonRegex.replace(/\(\?P<(?<n>\w+?)>/g, "(?<$<n>>")

    const flags: string[] = []
    result = result.replace(/\(\?([ims]+)\)/g, (match, flagStr) => {
      for (const flag of flagStr) {
        if (!flags.includes(flag)) {
          flags.push(flag)
        }
      }
      return ''
    })

    if (flags.includes('i')) {
      return { pattern: result, flags: flags.join('') }
    }

    return result
  }

  const escapeRegExp = (string: string) => {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }

  const escapeArgs = (args: any[]) => {
    return args.map(arg => String(arg).replace(/\s+/g, '\\s+')).join(' ')
  }

  const resolveArgs = (args: any[], res: any) => {
    return args.map(arg => {
      if (typeof arg === 'string' && arg.startsWith('$')) {
        const index = parseInt(arg.slice(1)) - 1
        return res[index] || ''
      }
      return arg
    })
  }

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
    ;(ctx as any).timer.setTimeout(() => {
      ctx.$.notifier?.update({
        type: 'danger',
        content: (
          <p>
            <strong>⚠️ 插件初始化失败</strong>
            <br />
            错误信息: {errorMsg}
            <br /><br />
            <strong>解决方案:</strong>
            <br />
            1. 确保 meme-generator-api 服务正在运行
            <br />
            2. 在插件设置中配置正确的 API 地址
            <br />
            3. 默认地址: http://127.0.0.1:2233
            <br /><br />
            详细配置指南请查看插件文档
          </p>
        ),
      })
    }, afterInitDelay)
    return
  }

  try {
    // 🔴 关键修复：初始化 ctx.$.cmd 为根命令 "meme"
    ctx.$.cmd = ctx.command('meme', '制作各种沙雕表情')

    await Commands.apply(ctx, config)
    await ctx.$.reRegisterGenerateCommands()
    await ctx.$.refreshShortcuts?.()
  } catch (e: any) {
    try {
      ctx.$.cmd?.dispose()
    } catch (_) {}
    logger.warn('Failed to initialize commands, plugin will not work')
    logger.warn(e)
    ;(ctx as any).timer.setTimeout(() => {
      ctx.$.notifier?.update({
        type: 'danger',
        content: (
          <p>
            注册插件指令时出错，插件将不会工作！
            <br />
            更多信息请查看日志。
          </p>
        ),
      })
    }, afterInitDelay)
    return
  }

  // public apis
  const $public: MemePublic = {
    api: ctx.$.api,
    infos: ctx.$.infos,
  }
  ctx.set('memesApi', $public)

  const memeCount = Object.keys(ctx.$.infos).length
  ;(ctx as any).timer.setTimeout(() => {
    ctx.$.notifier?.update({
      type: 'success',
      content: <p>插件初始化完毕，共载入 {memeCount} 个表情。</p>,
    })
  }, afterInitDelay)
  logger.info(`Plugin initialized successfully, loaded ${memeCount} memes`)
}
