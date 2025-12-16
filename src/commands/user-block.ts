import { Context, Logger } from 'koishi'
import { Config } from '../config'

const logger = new Logger('memes-user-block')

export async function apply(ctx: Context, config: Config) {
  // 屏蔽用户表情包命令
  const blockUserCmd = ctx.$.cmd.subcommand('.user-block.block <meme_input:string> <user_id:string>', '屏蔽特定用户触发特定表情包', { checkArgCount: true, authority: 4 })
  if (config.enableShortcut) {
    blockUserCmd.alias('屏蔽用户表情')
    blockUserCmd.alias('用户屏蔽表情')
  }

  blockUserCmd.action(async ({ session }, memeInput, userId) => {
    if (!session) return

    const guildId = (session as any).guildId
    if (!guildId) {
      await session.send('❌ 此命令只能在群组中使用！')
      return
    }

    const platform = (session as any).platform
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
      await ctx.$.setUserMemeBlocked(guildId, platform, userId, memeKey, true)
      await session.send(`✅ 已屏蔽用户 ${userId} 触发表情包 "${displayName}" (${memeKey})！`)
    } catch (error) {
      logger.warn('屏蔽用户表情包失败', error)
      await session.send(`❌ 屏蔽用户表情包失败: ${error.message}`)
    }
  })

  // 取消屏蔽用户表情包命令
  const unblockUserCmd = ctx.$.cmd.subcommand('.user-block.unblock <meme_input:string> <user_id:string>', '取消屏蔽特定用户触发特定表情包', { checkArgCount: true, authority: 4 })
  if (config.enableShortcut) {
    unblockUserCmd.alias('恢复用户表情')
    unblockUserCmd.alias('取消屏蔽')
  }

  unblockUserCmd.action(async ({ session }, memeInput, userId) => {
    if (!session) return

    const guildId = (session as any).guildId
    if (!guildId) {
      await session.send('❌ 此命令只能在群组中使用！')
      return
    }

    const platform = (session as any).platform
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
      await ctx.$.setUserMemeBlocked(guildId, platform, userId, memeKey, false)
      await session.send(`✅ 已取消屏蔽用户 ${userId} 触发表情包 "${displayName}" (${memeKey})！`)
    } catch (error) {
      logger.warn('取消屏蔽用户表情包失败', error)
      await session.send(`❌ 取消屏蔽用户表情包失败: ${error.message}`)
    }
  })

  // 查看用户屏蔽设置命令
  const listUserBlocksCmd = ctx.$.cmd.subcommand('.user-block.list [user_id:string]', '查看用户的表情包屏蔽设置', { checkArgCount: false, authority: 4 })
  if (config.enableShortcut) {
    listUserBlocksCmd.alias('用户屏蔽列表')
    listUserBlocksCmd.alias('用户设置')
    listUserBlocksCmd.alias('屏蔽设置')
  }

  listUserBlocksCmd.action(async ({ session }, userId) => {
    if (!session) return

    const guildId = (session as any).guildId
    if (!guildId) {
      await session.send('❌ 此命令只能在群组中使用！')
      return
    }

    const platform = (session as any).platform

    try {
      const blocks = await ctx.$.getUserMemeBlocks(guildId, platform, userId)

      if (blocks.length === 0) {
        if (userId) {
          await session.send(`📋 用户 ${userId} 没有被屏蔽的表情包。`)
        } else {
          await session.send('📋 当前群组没有用户屏蔽设置。')
        }
        return
      }

      // 按用户ID分组
      const blocksByUser = new Map<string, any[]>()
      for (const block of blocks) {
        if (!blocksByUser.has(block.user_id)) {
          blocksByUser.set(block.user_id, [])
        }
        blocksByUser.get(block.user_id)!.push(block)
      }

      let message = ''
      if (userId) {
        message = `📋 用户 ${userId} 的表情包屏蔽设置:\n\n`
      } else {
        message = `📋 当前群组的用户表情包屏蔽设置:\n\n`
      }

      for (const [uid, userBlocks] of blocksByUser) {
        const blockedMemes = userBlocks.filter(b => b.blocked)
        const unblockedMemes = userBlocks.filter(b => !b.blocked)

        if (userId || blockedMemes.length > 0) {
          message += `👤 用户 ${uid}:\n`

          if (blockedMemes.length > 0) {
            message += `  🚫 已屏蔽 (${blockedMemes.length} 个):\n`
            message += blockedMemes.map(b => `    • ${b.meme_key}`).join('\n') + '\n'
          }

          if (unblockedMemes.length > 0) {
            message += `  ✅ 已取消屏蔽 (${unblockedMemes.length} 个):\n`
            message += unblockedMemes.map(b => `    • ${b.meme_key}`).join('\n') + '\n'
          }

          message += '\n'
        }
      }

      await session.send(message.trim())
    } catch (error) {
      logger.warn('获取用户屏蔽设置失败', error)
      await session.send(`❌ 获取用户屏蔽设置失败: ${error.message}`)
    }
  })
}
