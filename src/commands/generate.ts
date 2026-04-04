import { Command, Context, h, paramCase, Session, Logger } from 'koishi'

// 适配 Element 类型
type Element = any
import pLimit from 'p-limit'

import {
  ActType,
  MemeArgsResponse,
  MemeError,
  MemeInfoResponse,
  ParserOption,
  UserInfo,
} from 'meme-generator-api'

import { Config } from '../config'
import { GetAvatarFailedError } from '../user-info'
import { getGuildId } from '../types/internal'
import {
  ArgSyntaxError,
  checkInRange,
  constructBlobFromFileResp,
  formatRange,
  splitArgString,
} from '../utils'

declare module 'koishi' {
  interface Session {
    inGenerateSubCommand?: boolean
    inShortcut?: boolean
  }
}

export interface OptionInfo {
  names: string[]
  argName: string
  type: string
  description: string
}

export type ImageFetchInfo = { src: string } | { userId: string }
export interface ResolvedArgs {
  imageInfos: ImageFetchInfo[]
  texts: string[]
}
export interface ImagesAndInfos {
  images: Blob[]
  userInfos: UserInfo[]
  imageInfos: any[]
}

declare module '../index' {
  interface MemeInternal {
    argTypeMap: Record<string, string>
    transformToKoishiOptions: (args: MemeArgsResponse) => OptionInfo[]
    applyOptionEffects: (
      session: Session,
      options: Record<string, any>,
      info: MemeInfoResponse,
    ) => Promise<Record<string, any>>
    resolveArgs(session: Session, args: Element[]): Promise<ResolvedArgs>
    reRegisterGenerateCommands: () => Promise<void>
    resolveImagesAndInfos: (
      session: Session,
      imageInfos: ImageFetchInfo[],
    ) => Promise<ImagesAndInfos>
    handleResolveArgsError: (session: Session, e: any) => Element[] | undefined
    handleResolveImagesAndInfosError: (
      session: Session,
      e: any,
    ) => Element[] | undefined
    handleRenderError: (session: Session, e: any) => Element[] | undefined
    checkAndCountToGenerate(session: Session): Promise<Element[] | undefined>

    isMemeGuildEnabled: (guildId: string, platform: string, memeKey: string) => Promise<boolean>
    isUserMemeBlocked: (guildId: string, platform: string, userId: string, memeKey: string) => Promise<boolean>
  }
}

const logger = new Logger('memes-generate')

export async function apply(ctx: Context, config: Config) {
  // 确保 cmd 已在 index.tsx 中初始化
  const cmdGenerate = (ctx.$.cmd as any).subcommand('.generate').action(async ({ session }) => {
    if (session?.inGenerateSubCommand) return
    return session?.execute('help meme.generate')
  })

  // 使用数组追踪已注册的子命令，方便注销
  const generateSubCommands: Command[] = []

  ctx.$.argTypeMap = {
    str: 'string',
    int: 'integer',
    float: 'number',
    bool: 'boolean',
  }

  // --- Transform Logic ---
  ctx.$.transformToKoishiOptions = (args: MemeArgsResponse) => {
    const options: OptionInfo[] = []
    for (const arg of args.parser_options) {
      const trimmedNames = arg.names.map((v) => v.replace(/^-+/, ''))
      const name =
        trimmedNames.filter((v) => v in args.args_model.properties)[0] ??
        trimmedNames.filter((v) => /^[a-zA-Z0-9-_]+$/.test(v)).sort((v) => -v.length)[0]
      const aliases = trimmedNames.filter((v) => v !== name)
      if (!arg.args) {
        options.push({ names: [name, ...aliases], argName: name, type: 'boolean', description: arg.help_text ?? '' })
        continue
      }
      const transformArgType = (value: string): string => value in ctx.$.argTypeMap ? ctx.$.argTypeMap[value] : 'string'
      const withSuffix = arg.args && arg.args.length > 1
      const aliasesSuffixed = withSuffix ? aliases.map((v) => `${v}-${name}`) : aliases
      for (const argInfo of arg.args) {
        const argName = argInfo?.name ?? name
        const argType = argInfo ? transformArgType(argInfo.value) : 'boolean'
        const nameSuffixed = withSuffix ? `${name}-${paramCase(argName)}` : name
        options.push({ names: [nameSuffixed, ...aliasesSuffixed], argName, type: argType, description: arg.help_text ?? '' })
      }
    }
    return options
  }

  ctx.$.applyOptionEffects = async (session, options, info) => {
    const parserOptions = info.params_type.args_type?.parser_options
    if (!parserOptions) return options
    options = { ...options }
    for (const opt of parserOptions) {
      const optName = opt.names.map((v) => v.replace(/^-+/, '')).filter((v) => v in options)[0]
      if (!optName || options[optName] !== true) continue
      if (opt.action && opt.dest) {
        const { type, value } = opt.action
        if (type === ActType.STORE) options[opt.dest] = value
        else if (type === ActType.APPEND) options[opt.dest] = (options[opt.dest] ?? []).concat(value)
        else if (type === ActType.COUNT) options[opt.dest] = (options[opt.dest] ?? 0) + 1
        delete options[optName]
      }
    }
    return options
  }

  ctx.$.resolveArgs = async (session, args) => {
    const imageInfos: ImageFetchInfo[] = []
    const texts: string[] = []
    if (session.quote?.elements) {
      const visit = (e: Element) => {
        if (e.children?.length) for (const child of e.children) visit(child)
        if (e.type === 'img' && e.attrs.src) imageInfos.push({ src: e.attrs.src })
      }
      for (const child of session.quote.elements) visit(child)
    }
    const textBuffer: string[] = []
    const resolveBuffer = () => {
      if (!textBuffer.length) return
      texts.push(...splitArgString(textBuffer.join('')).filter(v => {
        if (v === '自己' || v === '@自己') { imageInfos.push({ userId: session.userId }); return false }
        if (v.startsWith('@')) { imageInfos.push({ userId: v.slice(1) }); return false }
        return true
      }))
      textBuffer.length = 0
    }
    const visit = (e: Element) => {
      if (e.children?.length) for (const child of e.children) visit(child)
      if (e.type === 'text' && e.attrs.content) return textBuffer.push(e.attrs.content)
      resolveBuffer()
      if (e.type === 'img' && e.attrs.src) imageInfos.push({ src: e.attrs.src })
      if (e.type === 'at' && e.attrs.id) imageInfos.push({ userId: e.attrs.id })
    }
    for (const child of args) visit(child)
    resolveBuffer()
    return { imageInfos, texts }
  }

  ctx.$.resolveImagesAndInfos = async (session, imageInfos) => {
    // 使用 Map 去重，避免重复的 JSON 序列化和 indexOf 查找
    const imageInfoMap = new Map<string, ImageFetchInfo>()
    for (const info of imageInfos) {
      const key = JSON.stringify(info)
      if (!imageInfoMap.has(key)) imageInfoMap.set(key, info)
    }

    const imageMap: Record<string, Blob> = {}
    const userInfoMap: Record<string, UserInfo> = {}
    const limit = pLimit(3) // 限制并发下载数量
    const tasks = Array.from(imageInfoMap.entries()).map(([key, info]) =>
      limit(async () => {
        let url: string
        let userInfo: UserInfo
        if ('src' in info) { url = info.src; userInfo = {} }
        else if ('userId' in info) { ({ url, userInfo } = await ctx.$.getInfoFromID(session, info.userId)) }
        else throw new Error('Invalid image info')
        imageMap[key] = constructBlobFromFileResp(await ctx.http.file(url))
        userInfoMap[key] = userInfo
      })
    )
    await Promise.all(tasks)
    // 保持原顺序返回
    const resultImages: Blob[] = []
    const resultUserInfos: UserInfo[] = []
    for (const info of imageInfos) {
      const key = JSON.stringify(info)
      resultImages.push(imageMap[key])
      resultUserInfos.push(userInfoMap[key])
    }
    return { images: resultImages, userInfos: resultUserInfos, imageInfos }
  }

  // Error Handlers
  ctx.$.handleResolveArgsError = (session, e) => {
    if (e instanceof ArgSyntaxError) {
      logger.warn(e.message)
      return config.silentShortcut && session.inShortcut ? undefined : session.text(ArgSyntaxError.getI18NKey(e), e)
    }
    return undefined
  }

  ctx.$.handleResolveImagesAndInfosError = (session, e) => {
    if (e instanceof GetAvatarFailedError) return config.silentShortcut && session.inShortcut && config.moreSilent ? undefined : session.text('memes-api.errors.can-not-get-avatar', e)
    logger.warn(e)
    return config.silentShortcut && session.inShortcut && config.moreSilent ? undefined : session.text('memes-api.errors.download-image-failed')
  }

  ctx.$.handleRenderError = (session, e) => {
    if (e instanceof MemeError && e.type) {
      logger.warn(e)
      return config.silentShortcut && session.inShortcut && (config.moreSilent || (e.response.status <= 540 && e.response.status > 560)) ? undefined : [e.memeMessage] as any
    }
    return undefined
  }

  ctx.$.checkAndCountToGenerate = async (session) => {
    session.inGenerateSubCommand = true
    const fatherRet = await session.execute('meme.generate', true)
    return fatherRet.length ? fatherRet : undefined
  }

  const registerGenerateOptions = (cmd: Command, info: MemeInfoResponse) => {
    const { params_type: { args_type: args } } = info
    if (!args) return cmd
    for (const opt of ctx.$.transformToKoishiOptions(args)) {
      const { names, argName, type, description } = opt
      const [name, ...aliases] = names
        ; (cmd as any).option(name, `[${argName}:${type}] ${description}`, { aliases })
    }
    return cmd
  }

  // ========================================================================
  // 核心修复：重新注册命令的完整逻辑 (从 index.tsx 迁移并整合)
  // ========================================================================
  ctx.$.reRegisterGenerateCommands = async () => {
    // 1. 清理现有命令
    for (const cmd of generateSubCommands) { try { (cmd as any).dispose() } catch (_) { } }
    generateSubCommands.length = 0

    const registeredNames = new Set<string>()
    const blacklistRaw = await ctx.$.getBlacklistedKeywords()
    const blacklist = new Set(blacklistRaw.map(k => k.toLowerCase()))
    logger.info(`Starting to register ${Object.keys(ctx.$.infos).length} memes...`)

    // 2. 预处理：解决关键词冲突 (index.tsx 中的高级逻辑)
    const keywordMap = new Map()
    for (const info of Object.values(ctx.$.infos)) {
      for (const keyword of info.keywords) {
        if (!keywordMap.has(keyword)) keywordMap.set(keyword, [])
        keywordMap.get(keyword).push(info)
      }
    }

    const resolvedKeywordsMap = new Map()
    for (const info of Object.values(ctx.$.infos)) {
      const resolvedKws = []
      for (const keyword of info.keywords) {
        const conflictingInfos = keywordMap.get(keyword)
        if (conflictingInfos.length === 1) {
          resolvedKws.push(keyword)
        } else {
          const index = conflictingInfos.indexOf(info)
          const resolvedKeyword = `${keyword}${index + 1}`
          resolvedKws.push(resolvedKeyword)
          logger.info(`关键词冲突: "${keyword}" 被以下表情使用: ${conflictingInfos.map((i: MemeInfoResponse) => i.key).join(', ')}, 已自动添加数字后缀`)
        }
      }
      resolvedKeywordsMap.set(info.key, resolvedKws)
    }

    // 3. 注册命令
    for (const info of Object.values(ctx.$.infos)) {
      // 检查 key 是否在黑名单中 (全局禁用该表情)
      if (blacklist.has(info.key.toLowerCase())) {
        logger.info(`Skip registering blacklisted meme: ${info.key}`)
        continue
      }

      // 如果 key 已经被注册（异常情况），跳过
      if (registeredNames.has(info.key)) {
        logger.warn(`Skip registering duplicate meme key: ${info.key}`)
        continue
      }

      // 注册子命令
      const subCmd = (cmdGenerate as any).subcommand(`.${info.key} [args:el]`, (info as any).description || `生成${info.key}表情包`, { strictOptions: true, hidden: true })
      registeredNames.add(info.key)

      // 获取处理过冲突的关键词列表
      const resolvedKws = resolvedKeywordsMap.get(info.key) || info.keywords

      // 过滤掉：1.黑名单中的词 2.本次已经注册过的词
      const validKeywords = resolvedKws.filter((kw: string) => {
        if (blacklist.has(kw.toLowerCase())) return false
        if (registeredNames.has(kw)) return false
        return true
      })

      // 记录这些关键词已被占用
      validKeywords.forEach((kw: string) => registeredNames.add(kw))

      const blockedKeywords = resolvedKws.filter((kw: string) => blacklist.has(kw.toLowerCase()))
      if (blockedKeywords.length > 0) {
        logger.info(`表情 "${info.key}" 的以下关键词已被黑名单过滤: ${blockedKeywords.join(', ')}`)
      }

      // 别名注册逻辑
      for (const kw of validKeywords) {
        try {
          (subCmd as any).alias(`.${kw}`)
        } catch (e) {
          logger.warn(`Alias conflict: ${kw}`)
        }
      }

      registerGenerateOptions(subCmd, info)

      // 动作定义
      subCmd.action(async ({ session, options }: { session: Session, options?: Record<string, unknown> }, args: unknown[]) => {
        if (!session) return

        try {
          const guildId = getGuildId(session)
          const platform = session.platform

          if (config.debug) {
            logger.info('[DEBUG] Triggered meme: %s, user: %s, guild: %s', info.key, session.userId, guildId)
          }

          // 1. 黑名单检查 (最高优先级)
          // 注意：这里我们使用 info.key，确保即使是别名触发也能正确检查到主键
          // 同时也传入 info.keywords，确保如果表情包含的关键词在黑名单中，也能被拦截
          const isBlacklisted = await ctx.$.isMemeBlacklisted(info.key, info.keywords)
          if (isBlacklisted) {
            logger.info(`Blocked blacklisted meme execution: ${info.key}`)
            return
          }
          if (config.debug) logger.info('[DEBUG] Blacklist check passed')

          // 2. 检查群组启用状态
          const isGuildEnabled = await ctx.$.isMemeGuildEnabled(guildId, platform, info.key)
          if (!isGuildEnabled) {
            if (config.debug) logger.info('[DEBUG] Guild disabled for meme: %s', info.key)
            return
          }
          if (config.debug) logger.info('[DEBUG] Guild enabled check passed')

          if (config.generateSubCommandCountToFather) {
            const msg = await ctx.$.checkAndCountToGenerate(session)
            if (msg) return msg
          }

          if (options) {
            options = await ctx.$.applyOptionEffects(session, options, info)
          }

          let resolvedArgs: ResolvedArgs
          try {
            resolvedArgs = await ctx.$.resolveArgs(session, args ?? [])
          } catch (e) {
            return ctx.$.handleResolveArgsError(session, e)
          }
          const { imageInfos, texts } = resolvedArgs
          if (config.debug) {
            logger.info('[DEBUG] Resolved args: texts=%o, imageInfos=%d', texts, imageInfos.length)
          }

          // 处理参数补全
          const { min_images, max_images, min_texts, max_texts, default_texts } = info.params_type
          const autoUseAvatar = !!(
            (config.autoUseSenderAvatarWhenOnlyOne && !imageInfos.length && min_images === 1) ||
            (config.autoUseSenderAvatarWhenOneLeft && imageInfos.length && imageInfos.length + 1 === min_images)
          )
          if (autoUseAvatar) imageInfos.unshift({ userId: session.userId })
          if (!texts.length && config.autoUseDefaultTexts) texts.push(...default_texts)

          // 用户屏蔽检查
          if (guildId !== 'private') {
            for (const item of imageInfos) {
              if ('userId' in item && item.userId) {
                if (item.userId === session.userId) continue
                const isBlocked = await ctx.$.isUserMemeBlocked(guildId, platform, item.userId, info.key)
                if (isBlocked) {
                  if (config.debug) logger.info('[DEBUG] User %s is blocked for meme: %s', item.userId, info.key)
                  return
                }
              }
            }
          }
          if (config.debug) logger.info('[DEBUG] User block check passed')

          if (!checkInRange(imageInfos.length, min_images, max_images)) {
            return config.silentShortcut && session.inShortcut
              ? undefined
              : session.text('memes-api.errors.image-number-mismatch', [
                formatRange(min_images, max_images),
                imageInfos.length,
              ])
          }
          if (!checkInRange(texts.length, min_texts, max_texts)) {
            return config.silentShortcut && session.inShortcut
              ? undefined
              : session.text('memes-api.errors.text-number-mismatch', [
                formatRange(min_texts, max_texts),
                texts.length,
              ])
          }

          let imagesAndInfos: ImagesAndInfos
          try {
            imagesAndInfos = await ctx.$.resolveImagesAndInfos(session, imageInfos)
          } catch (e) {
            return ctx.$.handleResolveImagesAndInfosError(session, e)
          }
          const { images, userInfos } = imagesAndInfos

          if (config.debug) logger.info('[DEBUG] Starting render...')

          let img: Blob
          try {
            img = await ctx.$.api.renderMeme(info.key, {
              images,
              texts,
              args: { ...(options ?? {}), user_infos: userInfos },
            })
          } catch (e) {
            return ctx.$.handleRenderError(session, e)
          }

          ctx.$.recordMemeUsage(session, info.key).catch(() => { })
          return h.image(await img.arrayBuffer(), img.type)

        } catch (error: unknown) {
          logger.warn(`Action error: ${error instanceof Error ? error.message : String(error)}`)
        }
      })

      // 保存引用以便清理
      generateSubCommands.push(subCmd)
    }
    logger.info(`Successfully registered ${generateSubCommands.length} commands.`)
  }
}
