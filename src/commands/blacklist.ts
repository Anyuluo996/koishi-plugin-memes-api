import { Context, Logger } from 'koishi'
import { Config } from '../config'

const logger = new Logger('memes-blacklist')

export async function apply(ctx: Context, config: Config) {
  // 黑名单管理命令
  const blacklistCmd = ctx.$.cmd.subcommand('.blacklist <keyword:string>', '添加到全局黑名单', { authority: 4 })
  if (config.enableShortcut) {
    blacklistCmd.alias('拉黑表情')
    blacklistCmd.alias('全局禁用') // 增加中文别名，明确这是全局的
  }

  blacklistCmd.action(async ({ session }, keyword) => {
    if (!keyword) return '❌ 请输入关键词！'
    keyword = keyword.trim()

    // 存库
    const success = await ctx.$.addBlacklistedKeyword(keyword)

    // 刷新逻辑
    try {
      // 1. 重新注册命令（这会处理 .alias 的移除）
      await ctx.$.reRegisterGenerateCommands()
      // 2. 刷新快捷指令（这会移除正则触发）
      await ctx.$.refreshShortcuts?.()
    } catch (e) {
      logger.warn(e)
    }

    return success ? `✅ "${keyword}" 已加入黑名单 (全局生效)` : `⚠️ "${keyword}" 已经在黑名单里了`
  })

  // 取消拉黑命令
  const unblacklistCmd = ctx.$.cmd.subcommand('.unblacklist <keyword:string>', '将表情关键词从全局黑名单中移除', { checkArgCount: true, authority: 4 })
  if (config.enableShortcut) {
    unblacklistCmd.alias('取消拉黑')
    unblacklistCmd.alias('解除屏蔽')
  }

  unblacklistCmd.action(async ({ session }, keyword) => {
    if (!session) return

    if (!keyword || keyword.trim() === '') {
      await session.send('❌ 请提供要取消拉黑的关键词！')
      return
    }

    keyword = keyword.trim()

    // 从数据库黑名单中移除
    const success = await ctx.$.removeBlacklistedKeyword(keyword)
    if (!success) {
      await session.send(`⚠️ 关键词 "${keyword}" 不在黑名单中！`)
      return
    }

    // 重新注册命令以应用更改
    try {
      await ctx.$.reRegisterGenerateCommands()
      await ctx.$.refreshShortcuts?.()

      await session.send(`✅ 已将关键词 "${keyword}" 从黑名单中移除！相关表情触发词已重新启用。`)
    } catch (error) {
      logger.warn('重新注册命令时出错', error)
      await session.send(`⚠️ 关键词已从黑名单移除，但重新注册命令时出错: ${error.message}`)
    }
  })

  // 查看黑名单命令
  const listBlacklistCmd = ctx.$.cmd.subcommand('.blacklist-list', '查看全局黑名单中的所有关键词', { checkArgCount: false, authority: 4 })
  if (config.enableShortcut) {
    listBlacklistCmd.alias('黑名单列表')
    listBlacklistCmd.alias('查看黑名单')
    listBlacklistCmd.alias('屏蔽列表')
  }

  listBlacklistCmd.action(async ({ session }) => {
    if (!session) return

    const blacklistedKeywords = await ctx.$.getBlacklistedKeywords()
    if (blacklistedKeywords.length === 0) {
      await session.send('📋 黑名单为空，没有被屏蔽的关键词。')
      return
    }

    const blacklistText = blacklistedKeywords.map((kw, index) => `${index + 1}. ${kw}`).join('\n')
    await session.send(`📋 当前黑名单关键词 (${blacklistedKeywords.length} 个):\n${blacklistText}`)
  })
}
