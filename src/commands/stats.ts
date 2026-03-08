import { Context, Logger } from 'koishi'
import { Config } from '../config'
import { getGuildId, getGuildDisplay } from '../types/internal'

const logger = new Logger('memes-stats')

export async function apply(ctx: Context, config: Config) {
  // 表情包使用统计命令
  const statsCmd = ctx.$.cmd.subcommand('.stats [meme_key:string]', '查看表情包使用统计信息', { checkArgCount: false })
  if (config.enableShortcut) {
    statsCmd.alias('表情统计')
    statsCmd.alias('使用统计')
    statsCmd.alias('统计信息')
  }

  statsCmd.action(async ({ session }, memeKey) => {
    if (!session) return

    try {
      if (memeKey) {
        // 查看特定表情包的统计
        if (!ctx.$.infos[memeKey]) {
          await session.send(`❌ 表情包 "${memeKey}" 不存在！`)
          return
        }

        const guildId = getGuildId(session)
        const stats = await ctx.$.getMemeUsageStats(memeKey, guildId, 10)

        if (stats.length === 0) {
          await session.send(`📊 表情包 "${memeKey}" 在当前${(session as any).guildId ? '群组' : '私聊'}中还没有使用记录。`)
          return
        }

        const totalUsage = stats.reduce((sum, record) => sum + record.usage_count, 0)
        const statsText = stats.map((record, index) =>
          `${index + 1}. 用户 ${record.user_id}: ${record.usage_count} 次`
        ).join('\n')

        await session.send(`📊 表情包 "${memeKey}" 在当前${(session as any).guildId ? '群组' : '私聊'}的使用统计:\n总使用次数: ${totalUsage}\n\n用户排行:\n${statsText}`)
      } else {
        // 查看热门表情包排行
        const guildId = getGuildId(session)
        const topMemes = await ctx.$.getTopMemes(guildId, 10)

        if (topMemes.length === 0) {
          await session.send(`📊 当前${(session as any).guildId ? '群组' : '私聊'}还没有表情包使用记录。`)
          return
        }

        const statsText = topMemes.map((record, index) => {
          const memeInfo = ctx.$.infos[record.meme_key]
          const memeName = memeInfo ? memeInfo.keywords[0] : record.meme_key
          return `${index + 1}. ${memeName} (${record.meme_key}): ${record.usage_count || 0} 次`
        }).join('\n')

        await session.send(`📊 当前${(session as any).guildId ? '群组' : '私聊'}的热门表情包排行:\n\n${statsText}`)
      }
    } catch (error) {
      logger.warn('获取表情包统计失败', error)
      await session.send(`❌ 获取统计信息失败: ${error.message}`)
    }
  })
}
