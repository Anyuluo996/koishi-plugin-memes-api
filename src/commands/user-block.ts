import { Context, Logger, h } from 'koishi'
import { Config } from '../config'

const logger = new Logger('memes-user-block')

// 🔴 核心修复：更强大的ID提取器
function parseUserId(input: string): string {
  if (!input) return ''
  // 1. Koishi Segment 格式 <at id="123"/>
  const segment = h.parse(input).find(e => e.type === 'at')
  if (segment && segment.attrs.id) return segment.attrs.id

  // 2. OneBot 格式 [CQ:at,qq=123]
  const matchCQ = input.match(/qq=(\d+)/)
  if (matchCQ) return matchCQ[1]

  // 3. 纯文本，只取前面的数字 (以防有空格或其他)
  // 如果输入的是 @123，正则 \d+ 也能取到 123
  const matchNum = input.match(/(\d+)/)
  if (matchNum) return matchNum[1]

  return input.trim()
}

export async function apply(ctx: Context, config: Config) {
  // 屏蔽
  const blockUserCmd = ctx.$.cmd.subcommand('.user-block.block <meme_input:string> <user:text>', '屏蔽用户成为表情包素材', { checkArgCount: true, authority: 4 })
  if (config.enableShortcut) {
    blockUserCmd.alias('屏蔽用户表情')
    blockUserCmd.alias('用户屏蔽表情')
  }

  blockUserCmd.action(async ({ session }, memeInput, userTarget) => {
    if (!session || !session.guildId) return session?.send('❌ 此命令只能在群组中使用！')

    // 🔴 存入前进行清洗
    const userId = parseUserId(userTarget)
    if (!userId) return session.send('❌ 无效的用户，请@该用户或输入纯数字ID。')

    const inputTrimmed = memeInput.trim()
    const memeKey = ctx.$.findMemeKeyByKeyword(inputTrimmed)
    if (!memeKey) {
      return session.send(`❌ 未找到表情包 "${inputTrimmed}"！`)
    }

    const memeInfo = ctx.$.infos[memeKey]
    const displayName = memeInfo.keywords[0] || memeKey

    try {
      await ctx.$.setUserMemeBlocked(session.guildId, session.platform, userId, memeKey, true)
      await session.send(`✅ 已屏蔽用户 ${userId} 出演表情包 "${displayName}" (${memeKey})！`)
    } catch (error: any) {
      logger.warn('屏蔽用户表情包失败', error)
      await session.send(`❌ 屏蔽失败: ${error.message}`)
    }
  })

  // 解除屏蔽
  const unblockUserCmd = ctx.$.cmd.subcommand('.user-block.unblock <meme_input:string> <user:text>', '解除用户的表情包素材屏蔽', { checkArgCount: true, authority: 4 })
  if (config.enableShortcut) {
    unblockUserCmd.alias('恢复用户表情')
    unblockUserCmd.alias('取消屏蔽')
  }

  unblockUserCmd.action(async ({ session }, memeInput, userTarget) => {
    if (!session || !session.guildId) return session?.send('❌ 此命令只能在群组中使用！')

    const userId = parseUserId(userTarget)
    if (!userId) return session.send('❌ 无效的用户 ID。')

    const inputTrimmed = memeInput.trim()
    const memeKey = ctx.$.findMemeKeyByKeyword(inputTrimmed)
    if (!memeKey) {
      return session.send(`❌ 未找到表情包 "${inputTrimmed}"！`)
    }

    const memeInfo = ctx.$.infos[memeKey]
    const displayName = memeInfo.keywords[0] || memeKey

    try {
      await ctx.$.setUserMemeBlocked(session.guildId, session.platform, userId, memeKey, false)
      await session.send(`✅ 已恢复用户 ${userId} 出演表情包 "${displayName}" (${memeKey})！`)
    } catch (error: any) {
      logger.warn('取消屏蔽用户表情包失败', error)
      await session.send(`❌ 取消失败: ${error.message}`)
    }
  })

  // 列表 (优化显示 + 数据清洗)
  const listUserBlocksCmd = ctx.$.cmd.subcommand('.user-block.list [user:text]', '查看用户屏蔽设置', { checkArgCount: false, authority: 4 })
  if (config.enableShortcut) {
    listUserBlocksCmd.alias('用户屏蔽列表')
    listUserBlocksCmd.alias('用户设置')
    listUserBlocksCmd.alias('屏蔽设置')
  }

  listUserBlocksCmd.action(async ({ session }, userTarget) => {
    if (!session || !session.guildId) return session?.send('❌ 此命令只能在群组中使用！')

    const targetUserId = userTarget ? parseUserId(userTarget) : undefined

    try {
      // 从数据库取出所有原始数据
      const blocks = await ctx.$.getUserMemeBlocks(session.guildId, session.platform)

      if (blocks.length === 0) {
        return session.send('📋 当前范围内没有用户屏蔽记录。')
      }

      // 获取昵称的辅助函数
      const getName = async (uid: string) => {
        try {
          const member = await session.bot.getGuildMember(session.guildId!, uid)
          return member.nick || member.user?.nick || member.user?.name || uid
        } catch {
          return uid
        }
      }

      // 按【清洗后的ID】分组
      // 注意：这里只是显示时合并，物理数据库的脏数据需要手动解除或重设一次才能清理
      const blocksByUser = new Map<string, { blocked: string[], unblocked: string[] }>()
      
      for (const block of blocks) {
        // 在读取时，尝试把脏数据 (@安雨落) 转回 CleanID
        const cleanUid = parseUserId(block.user_id) || block.user_id

        if (!blocksByUser.has(cleanUid)) {
          blocksByUser.set(cleanUid, { blocked: [], unblocked: [] })
        }
        const userRec = blocksByUser.get(cleanUid)!
        const memeName = ctx.$.infos[block.meme_key]?.keywords[0] || block.meme_key
        const displayText = `${memeName}`
        
        // 防止同一个表情重复显示（因为脏数据可能造成两条记录）
        if (block.blocked && !userRec.blocked.includes(displayText)) {
            userRec.blocked.push(displayText)
        } else if (!block.blocked && !userRec.unblocked.includes(displayText)) {
            userRec.unblocked.push(displayText)
        }
      }

      const outputLines = ['📋 屏蔽设置列表 (仅素材对象)']
      
      for (const [uid, data] of blocksByUser) {
        // 如果用户指定了查询对象，进行过滤
        if (targetUserId && uid !== targetUserId) continue
        
        // 空记录跳过
        if (data.blocked.length === 0 && data.unblocked.length === 0) continue

        const userName = await getName(uid)
        outputLines.push('━━━━━━━━━━━━━━')
        outputLines.push(`👤 ${userName} (${uid})`)
        
        if (data.blocked.length > 0) {
          outputLines.push(`  🚫 已屏蔽: ${data.blocked.join(', ')}`)
        }
        
        if (data.unblocked.length > 0) {
          outputLines.push(`  ✅ 显式允许: ${data.unblocked.join(', ')}`)
        }
      }

      if (outputLines.length <= 1) {
          if (targetUserId) return session.send(`📋 用户 ${targetUserId} 没有相关设置。`)
          return session.send('📋 列表为空。')
      }
      
      await session.send(outputLines.join('\n'))

    } catch (error: any) {
      logger.warn('获取设置失败', error)
      await session.send(`❌ 获取设置失败: ${error.message}`)
    }
  })
}

