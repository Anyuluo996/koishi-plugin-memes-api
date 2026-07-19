import { Context, Logger } from 'koishi'
import { Config } from '../config'
import { errorMessage } from '../utils'
import { getGuildId } from '../types/internal'

const logger = new Logger('memes-guild')

export async function apply(ctx: Context, config: Config) {
  // ============================
  // 1. 启用群组表情包命令
  // ============================
  const enableGuildCmd = ctx.$.cmd.subcommand('.enable-guild <meme_input:string> [guild_id:string]', '在指定群组启用（恢复）表情包', { checkArgCount: true, authority: 4 })
  if (config.enableShortcut) {
    enableGuildCmd.alias('群组启用表情')
    enableGuildCmd.alias('群组开启表情')
    enableGuildCmd.alias('群表情启用')
  }

  enableGuildCmd.action(async ({ session }, memeInput, guildId) => {
    if (!session) return

    // 显式传入 guild_id 时优先使用，允许管理其他群组；在私聊中无参数时才用 session.guildId
    const targetGuildId = guildId !== undefined && guildId !== '' ? guildId : session.guildId
    if (!targetGuildId) {
      await session.send('❌ 请在群组中使用此命令或指定群组ID！')
      return
    }

    const platform = session.platform
    const inputTrimmed = memeInput.trim()

    // 通过关键词查找表情包标识符
    const memeKey = ctx.$.findMemeKeyByKeyword(inputTrimmed)
    if (!memeKey) {
      await session.send(`❌ 未找到表情包 "${inputTrimmed}"！请检查表情包名称或关键词是否正确。`)
      return
    }

    const memeInfo = ctx.$.infos[memeKey]
    const displayName = memeInfo.keywords[0] || memeKey

    try {
      // 🚨 修改点：不再设置为 true，而是直接删除记录
      // 逻辑：默认是开启的，如果有"禁用"记录存在，我们把它删了就等于开启了（恢复默认）。
      // 这样 guild-list 就不会显示这个表情了。
      const db = (ctx as any).database
      const removed = await db.remove('memes_guild_settings', {
        guild_id: targetGuildId,
        platform: platform,
        meme_key: memeKey
      })

      const guildDisplay = guildId ? `群组 ${targetGuildId}` : '当前群组'

      if (removed.matched && removed.matched > 0) {
        await session.send(`✅ 已在${guildDisplay}启用（恢复默认）表情包 "${displayName}" (${memeKey})！`)
      } else {
        await session.send(`ℹ️ 表情包 "${displayName}" 在${guildDisplay}本身就是启用状态。`)
      }

    } catch (error) {
      logger.warn('启用群组表情包失败', error)
      await session.send(`❌ 启用群组表情包失败: ${errorMessage(error)}`)
    }
  })

  // ============================
  // 2. 禁用群组表情包命令
  // ============================
  const disableGuildCmd = ctx.$.cmd.subcommand('.disable-guild <meme_input:string> [guild_id:string]', '在指定群组禁用表情包', { checkArgCount: true, authority: 4 })
  if (config.enableShortcut) {
    disableGuildCmd.alias('群组禁用表情')
    disableGuildCmd.alias('群组关闭表情')
    disableGuildCmd.alias('群表情禁用')
  }

  disableGuildCmd.action(async ({ session }, memeInput, guildId) => {
    if (!session) return

    // 显式传入 guild_id 时优先使用，允许管理其他群组；在私聊中无参数时才用 session.guildId
    const targetGuildId = guildId !== undefined && guildId !== '' ? guildId : session.guildId
    if (!targetGuildId) {
      await session.send('❌ 请在群组中使用此命令或指定群组ID！')
      return
    }

    const platform = session.platform
    const inputTrimmed = memeInput.trim()

    const memeKey = ctx.$.findMemeKeyByKeyword(inputTrimmed)
    if (!memeKey) {
      await session.send(`❌ 未找到表情包 "${inputTrimmed}"！`)
      return
    }

    const memeInfo = ctx.$.infos[memeKey]
    const displayName = memeInfo.keywords[0] || memeKey

    try {
      // 禁用逻辑保持不变：设置为 false
      await ctx.$.setMemeGuildEnabled(targetGuildId, platform, memeKey, false)
      const guildDisplay = guildId ? `群组 ${targetGuildId}` : '当前群组'
      await session.send(`✅ 已在${guildDisplay}禁用表情包 "${displayName}" (${memeKey})！`)
    } catch (error) {
      logger.warn('禁用群组表情包失败', error)
      await session.send(`❌ 禁用群组表情包失败: ${errorMessage(error)}`)
    }
  })

  // ============================
  // 3. 查看群组设置命令
  // ============================
  const guildListCmd = ctx.$.cmd.subcommand('.guild-list [guild_id:string]', '查看群组的表情包设置', { checkArgCount: false, authority: 4 })
  if (config.enableShortcut) {
    guildListCmd.alias('群组设置')
    guildListCmd.alias('表情设置')
    guildListCmd.alias('设置列表')
  }

  guildListCmd.action(async ({ session }, guildId) => {
    if (!session) return

    // 显式传入 guild_id 时优先使用，允许管理其他群组；在私聊中无参数时才用 session.guildId
    const targetGuildId = guildId !== undefined && guildId !== '' ? guildId : session.guildId
    if (!targetGuildId) {
      await session.send('❌ 请在群组中使用此命令或指定群组ID！')
      return
    }

    try {
      const settings = await ctx.$.getGuildMemeSettings(targetGuildId, session.platform)

      if (settings.length === 0) {
        const guildDisplay = guildId ? `群组 ${targetGuildId}` : '当前群组'
        await session.send(`📋 ${guildDisplay}没有特殊的表情包设置（所有表情包默认均为启用状态）。`)
        return
      }

      // 现在这里过滤出的主要是被显式禁用的表情
      const disabledMemes = settings.filter(s => !s.enabled)

      // 只有当我们使用了 "先删库后加库" 的 enabled 逻辑，数据库里才会留下 enabled=true 的记录
      // 如果按上面的"删除即启用"逻辑，enabledMemes 这里应该是空的（或者遗留数据）
      const enabledMemes = settings.filter(s => s.enabled)

      const guildDisplay = guildId ? `群组 ${targetGuildId}` : '当前群组'
      let message = `📋 ${guildDisplay}的表情包设置:\n\n`

      if (disabledMemes.length > 0) {
        message += `❌ 已禁用 (${disabledMemes.length} 个):\n`
        message += disabledMemes.map(s => `• ${s.meme_key}`).join('\n')
        message += '\n'
      }

      // 如果数据库里还有遗留的 enabled=true 记录，顺便显示出来，或者你可以不显示
      if (enabledMemes.length > 0) {
        message += `\n⚠️ 特殊启用记录 (建议通过"启用表情"指令清理):\n`
        message += enabledMemes.map(s => `• ${s.meme_key}`).join('\n')
      }

      if (disabledMemes.length === 0 && enabledMemes.length === 0) {
         message = `📋 ${guildDisplay}没有特殊的表情包设置（所有表情包默认均为启用状态）。`
      }

      await session.send(message.trim())
    } catch (error) {
      logger.warn('获取群组设置失败', error)
      await session.send(`❌ 获取群组设置失败: ${errorMessage(error)}`)
    }
  })
}
