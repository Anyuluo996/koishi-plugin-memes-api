import { Context, h, Random } from 'koishi'

import { Config } from '../config'
import { checkInRange, formatKeywords } from '../utils'
import { ImagesAndInfos, ResolvedArgs } from './generate'
import { getGuildId } from '../types/internal'

export async function apply(ctx: Context, config: Config) {
  const subCmd = ctx.$.cmd.subcommand('.random [args:el]')

  if (config.enableShortcut) {
    subCmd.alias('随机表情')
  }

  subCmd.action(async ({ session }, args) => {
    if (!session) return

    if (config.randomCommandCountToGenerate) {
      const msg = await ctx.$.checkAndCountToGenerate(session)
      if (msg) return msg
    }

    let resolvedArgs: ResolvedArgs
    try {
      resolvedArgs = await ctx.$.resolveArgs(session, args ?? [])
    } catch (e) {
      return ctx.$.handleResolveArgsError(session, e)
    }
    const { imageInfos, texts } = resolvedArgs

    // enable auto use sender avatar and default texts when no image and text provided
    const autoUse = !imageInfos.length && !texts.length
    if (autoUse) imageInfos.push({ userId: session.userId })

    const guildId = getGuildId(session)
    const platform = session.platform

    // 第一步：按图片/文字数量过滤（同步）
    const rangeFiltered = Object.values(ctx.$.infos).filter((info) => {
      const { min_images, max_images, min_texts, max_texts } = info.params_type
      if (!checkInRange(imageInfos.length, min_images, max_images)) return false
      if (!autoUse && !checkInRange(texts.length, min_texts, max_texts)) return false
      return true
    })

    // 第二步：批量拉取群组禁用清单 + 黑名单（各一次查询），在内存中过滤
    // 避免 N 个候选 × N 次 DB 往返导致随机命令阻塞数秒
    let disabledMemeKeys: Set<string> | null = null
    if (guildId !== 'private') {
      const settings = await ctx.$.getGuildMemeSettings(guildId, platform)
      disabledMemeKeys = new Set(
        settings.filter((s: any) => !s.enabled).map((s: any) => s.meme_key.toLowerCase()),
      )
    }
    // 黑名单已有内存缓存（首次后 0 往返）
    const blacklistedSet = new Set(await ctx.$.getBlacklistedKeywords())

    const suitableMemes: typeof rangeFiltered = []
    for (const info of rangeFiltered) {
      // 黑名单检查：检查 key 及所有 keywords
      if (blacklistedSet.has(info.key.toLowerCase())) continue
      if (info.keywords.some((kw: string) => blacklistedSet.has(kw.toLowerCase()))) continue
      // 群组禁用检查
      if (disabledMemeKeys && disabledMemeKeys.has(info.key.toLowerCase())) continue
      suitableMemes.push(info)
    }

    if (!suitableMemes.length) {
      return session.text('memes-api.random.no-suitable-meme')
    }

    let imagesAndInfos: ImagesAndInfos
    try {
      imagesAndInfos = await ctx.$.resolveImagesAndInfos(session, imageInfos)
    } catch (e) {
      return ctx.$.handleResolveImagesAndInfosError(session, e)
    }
    const { images, userInfos, imageInfos: resolvedImageInfos } = imagesAndInfos

    while (suitableMemes.length) {
      const index = Random.int(0, suitableMemes.length)
      const info = suitableMemes[index]
      suitableMemes.splice(index, 1)

      // 用户屏蔽检查（使用原始 imageInfos 获取 userId）
      if (guildId !== 'private') {
        let blocked = false
        for (let i = 0; i < resolvedImageInfos.length; i++) {
          const item = resolvedImageInfos[i]
          if (!('userId' in item) || item.userId === session.userId) continue
          if (await ctx.$.isUserMemeBlocked(guildId, platform, item.userId, info.key)) {
            blocked = true
            break
          }
        }
        if (blocked) continue
      }

      // 渲染结果缓存：与 generate 共用，对重复随机的相同组合有益
      // texts 归一化：autoUse（用户未传文字）时用固定标记，避免 default_texts 漂移导致 miss
      const randomTexts = autoUse ? info.params_type.default_texts : texts
      const cacheTexts = autoUse ? ['__auto_default__'] : randomTexts
      const cacheKey = ctx.$.renderCache.computeKey(info.key, imageInfos, cacheTexts, undefined)
      let entry
      try {
        entry = await ctx.$.renderCache.dedup(cacheKey, async () => {
          const img = await ctx.$.api.renderMeme(info.key, {
            texts: randomTexts,
            images,
            args: { user_infos: userInfos },
          })
          return { buffer: Buffer.from(await img.arrayBuffer()), mime: img.type }
        })
      } catch (e) {
        ctx.logger.warn(e)
        continue
      }

      const elems = [h.image(entry.buffer, entry.mime)]
      if (config.randomMemeShowInfo) {
        elems.unshift(
          ...session.i18n('memes-api.random.info', [formatKeywords(info.keywords)]),
        )
      }
      return elems
    }

    return session.text('memes-api.random.no-suitable-meme')
  })
}
