import { Context, Logger, h, Session } from 'koishi'
import { Config } from '../config'
import { errorMessage } from '../utils'

const logger = new Logger('memes-user-block')

// ============================================================
// 辅助：从命令参数中提取 userId（支持 @, CQ 码, 纯数字）
// ============================================================
function parseUserId(input: string): string {
  if (!input) return ''
  // 1. Koishi Segment 格式 <at id="123"/>
  const segment = h.parse(input).find(e => e.type === 'at')
  if (segment && segment.attrs.id) return segment.attrs.id

  // 2. OneBot 格式 [CQ:at,qq=123]
  const matchCQ = input.match(/qq=(\d+)/)
  if (matchCQ) return matchCQ[1]

  // 3. 纯数字 ID
  const matchNum = input.match(/(\d+)/)
  if (matchNum) return matchNum[1]

  return input.trim()
}

/**
 * U7：校验目标用户是否真实存在（避免无效 user_id 入库）。
 * 通过 bot.getGuildMember 探测，失败则返回 null。
 */
async function resolveTargetUser(session: Session, userId: string): Promise<{ id: string; name: string } | null> {
  if (!session.guildId) return null
  try {
    const member = await session.bot.getGuildMember(session.guildId, userId)
    return {
      id: userId,
      name: member.nick || member.user?.nick || member.user?.name || userId,
    }
  } catch {
    return null
  }
}

/**
 * U4：获取用户在当前群的权限等级。失败返回 0。
 */
async function getUserAuthority(session: Session, userId: string): Promise<number> {
  try {
    // 优先用 bot.getGuildMember 拿权限信息（不同 adapter 字段不一）
    const member: any = await session.bot.getGuildMember(session.guildId!, userId)
    // OneBot: member.role → 'owner'|'admin'|'member'；其他 adapter 可能在 permissions
    if (member?.role) {
      if (member.role === 'owner' || member.role === 'admin') return 4
    }
    if (Array.isArray(member?.permissions)) {
      // 检查是否含 authority:4 或更高
      for (const p of member.permissions) {
        const m = /authority:(\d+)/.exec(String(p))
        if (m && parseInt(m[1], 10) >= 4) return parseInt(m[1], 10)
      }
    }
    return 1  // 普通成员默认 authority 1
  } catch {
    return 0  // 查询失败
  }
}

export async function apply(ctx: Context, config: Config) {
  // ============================================================
  // 屏蔽：meme.user-block.block <meme_input> <user>
  // ============================================================
  const blockUserCmd = ctx.$.cmd.subcommand('.user-block.block <meme_input:string> <user:text>', '屏蔽用户成为表情包素材', { checkArgCount: true, authority: 4 })
  if (config.enableShortcut) {
    blockUserCmd.alias('屏蔽用户表情')
    blockUserCmd.alias('用户屏蔽表情')
  }

  blockUserCmd.action(async ({ session }, memeInput, userTarget) => {
    if (!session || !session.guildId) return session?.send('❌ 此命令只能在群组中使用！')

    // 解析目标用户 ID
    const userId = parseUserId(userTarget)
    if (!userId) return session.send('❌ 无效的用户，请@该用户或输入纯数字ID。')

    // U7：校验目标用户是否真实存在
    const target = await resolveTargetUser(session, userId)
    if (!target) {
      return session.send(`❌ 找不到用户 ${userId}，请确认该用户在本群内。`)
    }

    // U4：不可屏蔽同级或更高权限的管理员（避免管理员互相屏蔽）
    const operatorAuth = session.user?.authority ?? session.authority ?? 4
    const targetAuth = await getUserAuthority(session, userId)
    if (targetAuth >= operatorAuth && targetAuth > 0) {
      return session.send(`❌ 无法屏蔽权限等级不低于你的用户（${target.name}）。`)
    }

    // 查找表情
    const inputTrimmed = memeInput.trim()
    const memeKey = ctx.$.findMemeKeyByKeyword(inputTrimmed)
    if (!memeKey) {
      return session.send(`❌ 未找到表情包 "${inputTrimmed}"！`)
    }

    const memeInfo = ctx.$.infos[memeKey]
    const displayName = memeInfo.keywords[0] || memeKey

    try {
      // U10/S3：屏蔽 = 写入 blocked=true 记录
      await ctx.$.setUserMemeBlocked(session.guildId, session.platform, target.id, memeKey, true)
      await session.send(`✅ 已屏蔽用户 ${target.name} (${target.id}) 出演表情包 "${displayName}" (${memeKey})！`)
    } catch (error: unknown) {
      logger.warn('屏蔽用户表情包失败', error)
      await session.send(`❌ 屏蔽失败: ${errorMessage(error)}`)
    }
  })

  // ============================================================
  // 解除屏蔽：meme.user-block.unblock <meme_input> <user>
  // U10/S3：改为删除记录（与 enable-guild 对齐），不再写入 blocked=false
  // ============================================================
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
      // U10/S3：删除记录（而非写入 blocked=false）
      const matched = await ctx.$.removeUserMemeBlock(session.guildId, session.platform, userId, memeKey)
      if (matched > 0) {
        await session.send(`✅ 已恢复用户 ${userId} 出演表情包 "${displayName}" (${memeKey})！`)
      } else {
        await session.send(`ℹ️ 用户 ${userId} 未被屏蔽出演表情包 "${displayName}"。`)
      }
    } catch (error: unknown) {
      logger.warn('取消屏蔽用户表情包失败', error)
      await session.send(`❌ 取消失败: ${errorMessage(error)}`)
    }
  })

  // ============================================================
  // 屏蔽列表：meme.user-block.list [user]
  // U14：U10 修复后不再有 blocked=false 记录，移除"显式允许"分类
  // ============================================================
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
      // U10 修复后，DB 里只有 blocked=true 的记录（无僵尸数据）
      // 但仍过滤一次，兼容旧版残留的 blocked=false 记录
      const blocks = (await ctx.$.getUserMemeBlocks(session.guildId, session.platform))
        .filter((b: any) => b.blocked)

      if (blocks.length === 0) {
        return session.send('📋 当前范围内没有用户屏蔽记录。')
      }

      // U13：获取昵称，失败时记录 debug 日志
      const getName = async (uid: string) => {
        try {
          const member = await session.bot.getGuildMember(session.guildId!, uid)
          return member.nick || member.user?.nick || member.user?.name || uid
        } catch (e) {
          logger.debug(`获取群成员 ${uid} 昵称失败：${errorMessage(e)}`)
          return uid
        }
      }

      // 按用户分组（清洗历史脏数据：parseUserId 归一化）
      const blocksByUser = new Map<string, Set<string>>()

      for (const block of blocks) {
        const cleanUid = parseUserId(block.user_id) || block.user_id
        if (targetUserId && cleanUid !== targetUserId) continue

        if (!blocksByUser.has(cleanUid)) {
          blocksByUser.set(cleanUid, new Set())
        }
        const memeName = ctx.$.infos[block.meme_key]?.keywords[0] || block.meme_key
        blocksByUser.get(cleanUid)!.add(`${memeName} (${block.meme_key})`)
      }

      const outputLines = ['📋 屏蔽设置列表 (仅素材对象)']

      for (const [uid, memes] of blocksByUser) {
        if (memes.size === 0) continue

        const userName = await getName(uid)
        outputLines.push('━━━━━━━━━━━━━━')
        outputLines.push(`👤 ${userName} (${uid})`)
        outputLines.push(`  🚫 已屏蔽: ${Array.from(memes).join(', ')}`)
      }

      if (outputLines.length <= 1) {
          if (targetUserId) return session.send(`📋 用户 ${targetUserId} 没有相关设置。`)
          return session.send('📋 列表为空。')
      }

      await session.send(outputLines.join('\n'))

    } catch (error: unknown) {
      logger.warn('获取设置失败', error)
      await session.send(`❌ 获取设置失败: ${errorMessage(error)}`)
    }
  })
}
