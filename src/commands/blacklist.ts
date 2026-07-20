import { Context, Logger } from 'koishi'
import { Config } from '../config'
import { errorMessage } from '../utils'

const logger = new Logger('memes-blacklist')

export async function apply(ctx: Context, config: Config) {
  // ============================================================
  // 辅助：校验输入并查找对应的表情信息
  // ============================================================

  /**
   * 校验输入是否匹配某表情的 key 或关键词。
   * - 命中 key：返回 { key, matchedAs: 'key' }
   * - 命中 keyword：返回 { key, matchedAs: 'keyword', matchedKeyword }
   * - 都不命中：返回 null
   */
  const resolveMemeByInput = (input: string): {
    key: string
    matchedAs: 'key' | 'keyword'
    matchedKeyword?: string
  } | null => {
    const trimmed = input.trim()
    if (!trimmed) return null

    // 1. 直接匹配 key
    if (ctx.$.infos[trimmed]) {
      return { key: trimmed, matchedAs: 'key' }
    }

    // 2. 匹配关键词（findMemeKeyByKeyword 已封装此逻辑）
    const key = ctx.$.findMemeKeyByKeyword(trimmed)
    if (key) {
      return { key, matchedAs: 'keyword', matchedKeyword: trimmed }
    }

    return null
  }

  /** 重新注册命令 + 刷新快捷指令 + 失效缓存（add/unblacklist 共用） */
  const applyBlacklistChanges = async () => {
    ctx.$.invalidateAllCaches()
    try {
      await ctx.$.reRegisterGenerateCommands()
      await ctx.$.refreshShortcuts?.()
    } catch (e) {
      logger.warn(e)
    }
  }

  // ============================================================
  // 1. meme.blacklist <keyword> —— 拉黑单个触发词
  //    仅该关键词失效，表情的其他关键词仍可触发
  // ============================================================
  const blacklistCmd = ctx.$.cmd.subcommand('.blacklist <keyword:string>', '拉黑单个触发词（其他关键词仍可用）', { checkArgCount: true, authority: 4 })
  if (config.enableShortcut) {
    blacklistCmd.alias('拉黑表情')
    blacklistCmd.alias('全局禁用')
  }

  blacklistCmd.action(async ({ session }, keyword) => {
    if (!session) return
    const input = (keyword ?? '').trim()
    if (!input) return '❌ 请输入关键词！'

    // 输入校验：必须匹配某表情的关键词
    const match = resolveMemeByInput(input)
    if (!match) {
      return `❌ 没有找到关键词 "${input}"，请输入某表情的关键词。使用 \`meme.list\` 查看可用表情。`
    }

    // 如果输入命中的是 key（而非关键词），引导用户使用 blacklist-meme
    if (match.matchedAs === 'key') {
      return `ℹ️ "${input}" 是表情的 key（标识符），拉黑单个触发词请输入关键词。\n如需拉黑整个表情，请使用 \`meme.blacklist-meme ${input}\`。`
    }

    const memeInfo = ctx.$.infos[match.key]
    const displayName = memeInfo?.keywords[0] || match.key

    try {
      const success = await ctx.$.addBlacklistedKeyword(input)
      if (!success) {
        return `⚠️ 触发词 "${input}" 已经在黑名单里了`
      }
      await applyBlacklistChanges()
      return `✅ 触发词 "${input}" 已拉黑（表情 "${displayName}" 的其他关键词仍可使用）`
    } catch (error) {
      logger.warn('拉黑触发词失败', error)
      return `❌ 拉黑失败: ${errorMessage(error)}`
    }
  })

  // ============================================================
  // 2. meme.blacklist-meme <key_or_keyword> —— 拉黑整个表情
  //    所有关键词都无法触发
  // ============================================================
  const blacklistMemeCmd = ctx.$.cmd.subcommand('.blacklist-meme <input:string>', '拉黑整个表情（所有关键词都失效）', { checkArgCount: true, authority: 4 })
  if (config.enableShortcut) {
    blacklistMemeCmd.alias('拉黑整个表情')
    blacklistMemeCmd.alias('禁用表情')
  }

  blacklistMemeCmd.action(async ({ session }, input) => {
    if (!session) return
    const trimmed = (input ?? '').trim()
    if (!trimmed) return '❌ 请输入表情的 key 或关键词！'

    // 校验：必须匹配某表情
    const match = resolveMemeByInput(trimmed)
    if (!match) {
      return `❌ 没有找到表情 "${trimmed}"，请输入表情的 key 或关键词。使用 \`meme.list\` 查看可用表情。`
    }

    const memeKey = match.key
    const memeInfo = ctx.$.infos[memeKey]
    const displayName = memeInfo?.keywords[0] || memeKey

    try {
      // 拉黑整个表情：以 key 入库（type='meme'）
      const success = await ctx.$.addBlacklistedMeme(memeKey)
      if (!success) {
        return `⚠️ 表情 "${displayName}" (${memeKey}) 已经在黑名单里了`
      }
      await applyBlacklistChanges()
      return `✅ 表情 "${displayName}" (${memeKey}) 已整体拉黑，所有关键词都无法触发`
    } catch (error) {
      logger.warn('拉黑整个表情失败', error)
      return `❌ 拉黑失败: ${errorMessage(error)}`
    }
  })

  // ============================================================
  // 3. meme.unblacklist <keyword> [--type meme|keyword] —— 解除拉黑
  //    默认移除所有类型；指定 --type 仅移除该类型
  // ============================================================
  const unblacklistCmd = ctx.$.cmd.subcommand('.unblacklist <keyword:string>', '将关键词/表情从黑名单中移除', { checkArgCount: true, authority: 4 })
  if (config.enableShortcut) {
    unblacklistCmd.alias('取消拉黑')
    unblacklistCmd.alias('解除屏蔽')
  }
  unblacklistCmd.option('type', '[type:string]', { aliases: ['t'] })

  unblacklistCmd.action(async ({ session, options }, keyword) => {
    if (!session) return
    const input = (keyword ?? '').trim()
    if (!input) return '❌ 请提供要取消拉黑的关键词！'

    // 解析 --type 选项
    let typeFilter: 'meme' | 'keyword' | undefined
    if (options?.type) {
      const t = String(options.type).toLowerCase()
      if (t === 'meme' || t === 'keyword') {
        typeFilter = t
      } else {
        return `❌ 无效的 --type 值 "${options.type}"，应为 "meme" 或 "keyword"`
      }
    }

    try {
      const success = await ctx.$.removeBlacklistedEntry(input, typeFilter)
      if (!success) {
        const typeHint = typeFilter ? `（类型: ${typeFilter}）` : ''
        return `⚠️ 关键词 "${input}"${typeHint} 不在黑名单中！`
      }
      await applyBlacklistChanges()
      const typeHint = typeFilter ? `（仅类型: ${typeFilter}）` : '（所有类型）'
      return `✅ 已将 "${input}" 从黑名单移除${typeHint}，相关触发词已重新启用`
    } catch (error) {
      logger.warn('取消拉黑失败', error)
      return `❌ 取消失败: ${errorMessage(error)}`
    }
  })

  // ============================================================
  // 4. meme.blacklist-list —— 查看黑名单
  // ============================================================
  const listBlacklistCmd = ctx.$.cmd.subcommand('.blacklist-list', '查看黑名单中的所有条目', { checkArgCount: false, authority: 4 })
  if (config.enableShortcut) {
    listBlacklistCmd.alias('黑名单列表')
    listBlacklistCmd.alias('查看黑名单')
    listBlacklistCmd.alias('屏蔽列表')
  }

  listBlacklistCmd.action(async ({ session }) => {
    if (!session) return

    try {
      const entries = await ctx.$.getBlacklistEntries()
      if (entries.length === 0) {
        return '📋 黑名单为空，没有被屏蔽的条目。'
      }

      // 按 type 分组显示
      const memes = entries.filter(e => e.type === 'meme')
      const keywords = entries.filter(e => e.type === 'keyword')

      const lines: string[] = [`📋 当前黑名单 (${entries.length} 个条目):`]

      if (memes.length > 0) {
        lines.push('')
        lines.push(`🚫 整体禁用的表情 (${memes.length} 个):`)
        memes.forEach((e, i) => {
          const info = ctx.$.infos[e.keyword]
          const display = info ? `${e.keyword}（${info.keywords[0] || ''}）` : e.keyword
          lines.push(`  ${i + 1}. ${display}`)
        })
      }

      if (keywords.length > 0) {
        lines.push('')
        lines.push(`⛔ 禁用的触发词 (${keywords.length} 个，对应表情的其他关键词仍可用):`)
        keywords.forEach((e, i) => {
          // 找出该 keyword 属于哪个表情
          const memeKey = ctx.$.findMemeKeyByKeyword(e.keyword)
          const suffix = memeKey ? ` → ${memeKey}` : ''
          lines.push(`  ${i + 1}. ${e.keyword}${suffix}`)
        })
      }

      return lines.join('\n')
    } catch (error) {
      logger.warn('获取黑名单失败', error)
      return `❌ 获取黑名单失败: ${errorMessage(error)}`
    }
  })
}
