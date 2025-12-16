import { Context, escapeRegExp, h, Session } from 'koishi'
import { Config } from '../config'
import { escapeArgs } from '../utils'

// 为了兼容性暂时保留 any，如果你环境能正常导入 Element，建议改为 import { Element } from 'koishi'
type Element = any

interface ShortcutInfo {
  name: string
  // 修改结构：存储正则模式字符串和修饰符(flags)
  regex: { pattern: string; flags: string }
  args: string[]
}

interface KeywordInfo {
  name: string
  keyword: string
}

export async function apply(ctx: Context, config: Config) {
  // 定义扩展属性（解决TS报错，如果不适用可以删掉这段声明）
  ctx.$.refreshShortcuts = async () => {
    if (!config.enableShortcut) return

    const shortcuts: ShortcutInfo[] = []
    const tmpKeywords: KeywordInfo[] = []
    const tmpRegExps: ShortcutInfo[] = []

    // 1. 遍历所有表情信息，收集关键词和快捷指令正则
    for (const name in ctx.$.infos) {
      const info = ctx.$.infos[name]

      // 收集普通关键词
      info.keywords.forEach((keyword) => {
        tmpKeywords.push({ name, keyword })
      })

      // 收集 Python 风格的快捷指令正则
      info.shortcuts.forEach(({ key, args }) => {
        try {
          const cleanKey = key.replace(/^\^/, '').replace(/\$/, '')
          tmpRegExps.push({
            name,
            // 关键点：调用转换函数，解析 Python 正则
            regex: transformRegex(cleanKey),
            args: args ?? [],
          })
        } catch (e) {
          ctx.logger.warn(`Failed to parse shortcut regex "${key}" for meme "${name}":`, e)
        }
      })
    }

    // 2. 整合数据
    const tmpShortcuts: ShortcutInfo[] = [
      // 优先处理长关键词，避免短词干扰（如"吃"匹配到了"吃惊"）
      ...tmpKeywords
        .sort((a, b) => b.keyword.length - a.keyword.length)
        .map(({ name, keyword }) => {
          return {
            name,
            regex: { pattern: escapeRegExp(keyword), flags: '' },
            args: []
          }
        }),
      ...tmpRegExps,
    ]

    shortcuts.length = 0
    shortcuts.push(...tmpShortcuts)

    // 将 shortcuts 挂载到 ctx 或者局部变量闭包中使用
    // 这里由于是在 apply 内部定义的 middleware，闭包引用 shortcuts 即可

    // 更新中间件逻辑
    ctx.middleware(async (session, next) => {
      const { content } = session
      if (!content) return next()

      // 计算指令前缀
      const cmdPrefixRegex = (() => {
        if (config.shortcutUsePrefix) {
          const prefixConfig = (ctx.root.config as any).prefix
          const cmdPfxCfg = session.resolve(prefixConfig)
          const cmdPfx = Array.isArray(cmdPfxCfg) ? cmdPfxCfg : [cmdPfxCfg ?? '']

          const hasEmptyPfx = cmdPfx.includes('')
          const cmdPfxNotEmpty = cmdPfx.filter(Boolean)

          if (cmdPfxNotEmpty.length) {
            // 生成类似于 (?:/|.|!)? 的正则前缀
            return `(?:${cmdPfxNotEmpty.map(escapeRegExp).join('|')})${hasEmptyPfx ? '?' : ''}`
          }
        }
        return ''
      })()

      // 遍历匹配
      for (const { name, regex, args } of shortcuts) {
        try {
          // 构造 JS 正则：^ + 前缀 + pattern
          // 关键修复：正确传递 flags (例如 'i')
          const finalRegex = new RegExp(`^${cmdPrefixRegex}${regex.pattern}`, regex.flags)

          const res = finalRegex.exec(content)
          if (!res) continue

          const argTxt =
            `${escapeArgs(resolveArgs(args, res))}` +
            ` ${content.slice(res.index + res[0].length)}`

          session.inShortcut = true
          return session.execute(`meme.generate.${name} ${argTxt}`)
        } catch (error) {
          // 捕获正则执行错误，防止crash
          continue
        }
      }

      return next()
    })
  }

  // ================= 辅助函数区域 =================

  // 提取文本内容
  const extractContentPlaintext = (content: string) => {
    let elems: Element[]
    try {
      elems = h.parse(content) as Element[]
    } catch (e) {
      return content
    }

    const textBuffer: string[] = []
    const visit = (e: Element) => {
      if (e.children && e.children.length) {
        for (const child of e.children) visit(child)
      }
      if (e.type === 'text') {
        const t = e.attrs.content
        if (t) textBuffer.push(t)
      }
    }
    for (const child of elems) visit(child)
    return textBuffer.join('')
  }

  // 解析参数并填充
  const resolveArgs = (args: string[], res: RegExpExecArray) => {
    return args.map((v) => {
      // 处理 Python 风格的双括号转义和参数替换 {1} {mygroup}
      return v.replace(/(?<l>[^\{])?\{(?<v>.+?)\}(?<r>[^\}])?/g, (...args) => {
        type Groups = Record<'l' | 'r', string | undefined> & Record<'v', string>
        const { l, v, r } = args[args.length - 1] as Groups
        const index = parseInt(v)
        let resolved: string
        if (!isNaN(index)) {
          // 这里 index 需要 +1 还是不加取决于你的 args 定义习惯
          // Python 正则通常 $1 是第一个组。如果是数组索引则是0。
          // 假设这里 v 是 1,2,3... 对应 res[1], res[2]
          resolved = res[index] ?? v
        } else if (res.groups && v in res.groups) {
          resolved = res.groups[v]
        } else {
          resolved = v
        }
        return `${l ?? ''}${extractContentPlaintext(resolved)}${r ?? ''}`
      })
    })
  }

  /**
   * 将 Python 风格正则转换为 JS 风格
   * 1. (?P<name>...) -> (?<name>...)
   * 2. 剥离 (?i) 等内联修饰符到 flags
   */
  const transformRegex = (pythonRegex: string): { pattern: string; flags: string } => {
    // 1. 处理命名组
    let result = pythonRegex.replace(/\(\?P<(?<n>\w+?)>/g, '(?<$<n>>')

    const flags: string[] = []

    // 2. 处理内联 Flag: (?i), (?s), (?m), (?im) 等
    result = result.replace(/\(\?([aiLmsux]+)\)/g, (match, flagStr) => {
      for (const flag of flagStr) {
        // JS RegExp 构造函数支持的 flags
        if (['i', 'm', 's', 'u'].includes(flag)) {
          if (!flags.includes(flag)) {
            flags.push(flag)
          }
        }
        // a, L, x 等 flag 在 JS 中无对应或不常用，直接忽略
      }
      return '' // 从原串中移除
    })

    return { pattern: result, flags: flags.join('') }
  }
}
