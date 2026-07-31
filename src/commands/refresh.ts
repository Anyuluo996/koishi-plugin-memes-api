import { Context, Logger } from 'koishi'
import { Config } from '../config'
import { errorMessage } from '../utils'

const logger = new Logger('memes-refresh')

export async function apply(ctx: Context, config: Config) {
  // 手动刷新命令
  const refreshCmd = ctx.$.cmd.subcommand('.refresh', '手动重新获取表情包信息并更新命令', { checkArgCount: true, authority: 1 })
  if (config.enableShortcut) {
    refreshCmd.alias('获取表情')
    refreshCmd.alias('meme获取表情')
    refreshCmd.alias('更新表情')
    refreshCmd.alias('刷新表情')
  }

  refreshCmd.action(async ({ session }) => {
    if (!session) return

    try {
      // 清除所有缓存
      ctx.$.invalidateAllCaches()

      // 使用现有的 updateInfos 函数重新获取表情信息
      await ctx.$.updateInfos()

      // 重新注册生成命令
      await ctx.$.reRegisterGenerateCommands()

      // 刷新快捷指令
      await ctx.$.refreshShortcuts?.()

      // 刷新表情列表图片（仅需一次，之前由于复制粘贴被调用了两次）
      const listImageOk = await ctx.$.refreshListImage()

      const totalMemes = Object.keys(ctx.$.infos).length
      if (listImageOk) {
        await session.send(`✅ 表情信息更新完成！共获取到 ${totalMemes} 个表情包。`)
      } else {
        // 列表图片刷新失败：表情信息已更新，但图片可能仍是旧的或缺失
        await session.send(`⚠️ 表情信息更新完成！共获取到 ${totalMemes} 个表情包，但列表图片刷新失败（后端可能不可用，可稍后重试）。`)
      }
    } catch (error) {
      logger.warn('手动获取表情信息失败', error)
      await session.send(`❌ 获取表情信息失败: ${errorMessage(error)}`)
    }
  })
}
