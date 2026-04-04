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

    // 第二步：异步检查黑名单和群组禁用
    const suitableMemes: typeof rangeFiltered = []
    for (const info of rangeFiltered) {
      if (await ctx.$.isMemeBlacklisted(info.key, info.keywords)) continue
      if (guildId !== 'private') {
        if (!await ctx.$.isMemeGuildEnabled(guildId, platform, info.key)) continue
      }
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

      let img: Blob
      try {
        img = await ctx.$.api.renderMeme(info.key, {
          texts: autoUse ? info.params_type.default_texts : texts,
          images,
          args: { user_infos: userInfos },
        })
      } catch (e) {
        ctx.logger.warn(e)
        continue
      }

      const elems = [h.image(await img.arrayBuffer(), img.type)]
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
