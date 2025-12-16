import { Command, Context, h, paramCase, Session, Logger } from 'koishi'

// 适配不同版本的 Element 类型
type Element = any

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

  const generateSubCommands: Command[] = []

  ctx.$.argTypeMap = {
    str: 'string',
    int: 'integer',
    float: 'number',
    bool: 'boolean',
  }

  // --- 省略中间未变动的辅助函数 transformToKoishiOptions, applyOptionEffects, resolveArgs 等 ---
  // --- 为了完整性，你可以保留原文件里这一部分，直接看最下面的 registerGenerateCmd 即可 ---
  // 但为了复制方便，这里还是提供完整文件

  ctx.$.transformToKoishiOptions = (args: MemeArgsResponse) => {
    const options: OptionInfo[] = []
    for (const arg of args.parser_options) {
      const trimmedNames = arg.names.map((v) => v.replace(/^-+/, ''))
      const name =
        trimmedNames.filter((v) => v in args.args_model.properties)[0] ??
        trimmedNames.filter((v) => /^[a-zA-Z0-9-_]+$/.test(v)).sort((v) => -v.length)[0]
      const aliases = trimmedNames.filter((v) => v !== name)
      if (!arg.args) {
        options.push({
          names: [name, ...aliases],
          argName: name,
          type: 'boolean',
          description: arg.help_text ?? '',
        })
        continue
      }
      const transformArgType = (value: string): string => {
        if (value in ctx.$.argTypeMap) return ctx.$.argTypeMap[value]
        logger.warn(`Unsupported arg type ${value} in arg ${name}`)
        return 'string'
      }
      const withSuffix = arg.args && arg.args.length > 1
      const aliasesSuffixed = withSuffix ? aliases.map((v) => `${v}-${name}`) : aliases
      for (const argInfo of arg.args) {
        const argName = argInfo?.name ?? name
        const argType = argInfo ? transformArgType(argInfo.value) : 'boolean'
        const nameSuffixed = withSuffix ? `${name}-${paramCase(argName)}` : name
        options.push({
          names: [nameSuffixed, ...aliasesSuffixed],
          argName,
          type: argType,
          description: arg.help_text ?? '',
        })
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
    const imageInfoKeys = imageInfos.map((v) => JSON.stringify(v))
    const imageMap: Record<string, Blob> = {}
    const userInfoMap: Record<string, UserInfo> = {}
    const tasks = [...new Set(imageInfoKeys)].map(async (key) => {
      const index = imageInfoKeys.indexOf(key)
      const info = imageInfos[index]
      let url: string
      let userInfo: UserInfo
      if ('src' in info) { url = info.src; userInfo = {} }
      else if ('userId' in info) { ({ url, userInfo } = await ctx.$.getInfoFromID(session, info.userId)) }
      else throw new Error('Invalid image info')
      imageMap[key] = constructBlobFromFileResp(await ctx.http.file(url))
      userInfoMap[key] = userInfo
    })
    await Promise.all(tasks)
    return { images: imageInfoKeys.map(k => imageMap[k]), userInfos: imageInfoKeys.map(k => userInfoMap[k]) }
  }

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
      ;(cmd as any).option(name, `[${argName}:${type}] ${description}`, { aliases })
    }
    return cmd
  }

  const registerGenerateCmd = (info: MemeInfoResponse, registeredNames: Set<string>) => {
    const { key, keywords } = info
    if (registeredNames.has(key)) {
      logger.warn(`Skip registering duplicate meme key: ${key}`)
      return null
    }

    const subCmd: Command =
      (cmdGenerate as any).subcommand(`.${key} [args:el]`, { strictOptions: true, hidden: true })
    registeredNames.add(key)

    for (const kw of keywords) {
      if (registeredNames.has(kw)) continue
      try {
        (subCmd as any).alias(`.${kw}`)
        registeredNames.add(kw)
      } catch (error) {
        logger.warn(`Failed to register alias ".${kw}" for "${key}": ${error.message}`)
      }
    }

    registerGenerateOptions(subCmd, info)

    return (subCmd as any).action(async ({ session, options }, args) => {
      if (!session) return

      try {
        const guildId = (session as any).guildId || 'private'
        const platform = (session as any).platform
        const userId = session.userId

        // ============================================
        // 🚨 1. 最高优先级：全局黑名单检查 🚨
        // ============================================
        // 检查表情的 KEY 和所有关联的 KEYWORD 是否在黑名单中
        const isGlobalBanned = await ctx.$.isMemeBlacklisted(info.key, info.keywords)
        if (isGlobalBanned) {
          // 如果被全局拉黑，即使群组开启了，也不许用
          logger.debug(`Meme "${info.key}" is global blacklisted. blocked.`)
          // 选择性提示：session.send("❌ 该表情已被管理员全局禁用。")
          return
        }

        // ============================================
        // 2. 第二优先级：群组开启/禁用检查
        // ============================================
        const isGuildEnabled = await ctx.$.isMemeGuildEnabled(guildId, platform, info.key)
        if (!isGuildEnabled) {
          // 被群组禁用
          return
        }

        // (之前删掉了最开始的 userId check)
        // ----------------------------------------

        if (config.generateSubCommandCountToFather) {
          const msg = await ctx.$.checkAndCountToGenerate(session)
          if (msg) return msg
        }

        if (options) {
          options = await ctx.$.applyOptionEffects(session, options, info)
        }

        // 2. 解析参数：解析完才知道谁是目标用户 (resolveArgs)
        let resolvedArgs: ResolvedArgs
        try {
          resolvedArgs = await ctx.$.resolveArgs(session, args ?? [])
        } catch (e) {
          return ctx.$.handleResolveArgsError(session, e)
        }
        const { imageInfos, texts } = resolvedArgs

        // 处理自动补充参数
        const { min_images, max_images, min_texts, max_texts, default_texts } = info.params_type
        const autoUseAvatar = !!(
          (config.autoUseSenderAvatarWhenOnlyOne && !imageInfos.length && min_images === 1) ||
          (config.autoUseSenderAvatarWhenOneLeft && imageInfos.length && imageInfos.length + 1 === min_images)
        )
        if (autoUseAvatar) {
          // 这里会自动把 session.userId 加到开头
          imageInfos.unshift({ userId: session.userId })
        }
        if (!texts.length && config.autoUseDefaultTexts) {
          texts.push(...default_texts)
        }

        // ============================================
        //  关键逻辑修改：检测 target 是否被屏蔽 (包含@的人 和 自动补全的人)
        // ============================================
        if (guildId !== 'private') {
          // imageInfos 里的每个带 userId 的都是我们的目标对象
          // 如果某个人屏蔽了这个表情，我们就阻止生成
          for (const item of imageInfos) {
            if ('userId' in item && item.userId) {
              const isBlocked = await ctx.$.isUserMemeBlocked(guildId, platform, item.userId, info.key)
              if (isBlocked) {
                // 如果发现某个素材用户已屏蔽，终止生成并提示
                await session.send(`🚫 用户 ${item.userId} 拒绝以此表情 (${info.key}) 出演。`)
                return
              }
            }
          }
        }
        // ============================================

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

        let img: Blob
        try {
          img = await ctx.$.api.renderMeme(key, {
            images,
            texts,
            args: { ...(options ?? {}), user_infos: userInfos },
          })
        } catch (e) {
          return ctx.$.handleRenderError(session, e)
        }

        // 成功后记录 (可选: 仅记录发起人)
        try {
          await ctx.$.recordMemeUsage(session, info.key)
        } catch (e) { /* ignore */ }

        return h.image(await img.arrayBuffer(), img.type)

      } catch (error: any) {
        logger.warn(`Action error: ${error.message}`)
      }
    })
  }

  ctx.$.reRegisterGenerateCommands = async () => {
    for (const cmd of generateSubCommands) {
        try { (cmd as any).dispose() } catch (e) {}
    }
    generateSubCommands.length = 0
    const registeredNames = new Set<string>()
    logger.info(`Starting to register ${Object.keys(ctx.$.infos).length} memes...`)

    for (const info of Object.values(ctx.$.infos)) {
        const cmd = registerGenerateCmd(info, registeredNames)
        if (cmd) generateSubCommands.push(cmd)
    }
    logger.info(`Successfully registered ${generateSubCommands.length} commands.`)
  }
}
