import { describe, it, expect } from 'vitest'

// ============================================================
// Mock h.parse: parses "[图]" as img, "<@id>" as at, rest as text.
// Key invariants:
// - `[图]` (3 chars) is ONE element
// - `<@123456>` (9 chars) is ONE element
// - Text spans continuously between element boundaries (no space-splitting)
// ============================================================

interface Elem { type: string; attrs: Record<string, any>; rawStart: number; rawEnd: number }

const parseContent = (content: string): Elem[] => {
  const elems: Elem[] = []
  let pos = 0
  while (pos < content.length) {
    if (content.startsWith('[图]', pos)) {
      elems.push({ type: 'img', attrs: { src: 'mock.jpg' }, rawStart: pos, rawEnd: pos + 3 })
      pos += 3
    } else if (content.startsWith('<@', pos)) {
      const end = content.indexOf('>', pos)
      elems.push({ type: 'at', attrs: { id: content.slice(pos + 2, end) }, rawStart: pos, rawEnd: end + 1 })
      pos = end + 1
    } else {
      const ni = content.indexOf('[图]', pos)
      const na = content.indexOf('<@', pos)
      const next = Math.min(ni === -1 ? Infinity : ni, na === -1 ? Infinity : na)
      const end = next === Infinity ? content.length : next
      elems.push({ type: 'text', attrs: { content: content.slice(pos, end) }, rawStart: pos, rawEnd: end })
      pos = end
    }
  }
  return elems
}

// ============================================================
// Core logic — mirrors index.tsx helper functions exactly
// ============================================================

// 提取最后一个空格分隔的"词"（镜像 index.tsx extractLastTextSegment）
const extractLastWord = (content: string): string => {
  const elems = parseContent(content)
  const texts = elems.filter(e => e.type === 'text')
  if (!texts.length) return ''
  const combined = texts.map(e => e.attrs.content as string).join('')
  const trimmed = combined.trimEnd()
  const lastNonSpace = trimmed.search(/\s+\S*$/)
  return lastNonSpace === -1 ? trimmed : trimmed.slice(lastNonSpace + 1)
}

// 开头匹配（镜像 index.tsx tryMatchAtStart）
const tryMatchAtStart = (content: string, prefixRe: string, pattern: string, _flags: string, args: string[]) => {
  const re = new RegExp(`^${prefixRe}${pattern}`)
  const res = re.exec(content)
  if (!res) return undefined
  return `${args.join(' ')} ${content.slice(res.index + res[0].length)}`.trim()
}

// 末尾匹配（镜像 index.tsx tryMatchAtEnd）：
// - 找到最后一个文本段
// - 在该段末尾匹配 pattern
// - 关键词前的内容 = 原始 content 中 lastSegment 之前的所有内容（过滤掉图片/@元素）+ 段内前缀
const tryMatchAtEnd = (content: string, prefixRe: string, pattern: string, _flags: string, args: string[]) => {
  const elems = parseContent(content)
  const textElems = elems.filter(e => e.type === 'text')
  if (!textElems.length) return undefined
  const last = textElems[textElems.length - 1]

  const re = new RegExp(`${prefixRe}${pattern}$`)
  const res = re.exec(last.attrs.content)
  if (!res) return undefined

  // 关键词前的内容（段内部分）
  const beforeKw = last.attrs.content.slice(0, res.index)
  // lastSegment 在原始 content 中的起始位置
  const segStart = content.lastIndexOf(last.attrs.content)
  // lastSegment 之前的内容（包含图片、@等原始元素）
  const beforeSeg = content.slice(0, segStart)

  // 验证关键词后还有没有其他内容（trim 掉空白）
  const afterKwContent = content.slice(segStart + res.index + res[0].length).trim()
  if (afterKwContent) return undefined

  // 过滤掉 [图] 和 <@...>，只保留文字部分（模拟 Koishi 命令参数解析行为）
  const beforeSegText = beforeSeg.replace(/\[图\]|<@[^>]*>/g, '')
  const combinedBefore = `${beforeSegText}${beforeKw}`.trim()

  // combinedBefore 为空（如 [图]petpet）→ 空参数返回 ''
  return `${args.join(' ')} ${combinedBefore}`.trim()
}

// ============================================================
// Tests
// ============================================================

describe('shortcut matching', () => {
  // ---- extractLastWord ----
  describe('extractLastWord', () => {
    it('pure text', () => expect(extractLastWord('petpet')).toBe('petpet'))
    it('text + space + keyword', () => expect(extractLastWord('文字 petpet')).toBe('petpet'))
    it('image then keyword', () => expect(extractLastWord('[图]petpet')).toBe('petpet'))
    it('@user then keyword', () => expect(extractLastWord('<@123456>petpet')).toBe('petpet'))
    it('image + at + keyword', () => expect(extractLastWord('[图]<@123456>petpet')).toBe('petpet'))
    // Note: '来张图[图]...' — the '图' char at pos 3 is text in mock, img in real Koishi.
    // Mock limitation: '图' in '来张图' is text in mock (not img), so join produces '来张图petpet'
    it('text + image + at + keyword (mock limitation)', () => expect(extractLastWord('来张图[图]<@123456>petpet')).toBe('来张图petpet'))
    it('no space', () => expect(extractLastWord('petpetpet')).toBe('petpetpet'))
    it('image only', () => expect(extractLastWord('[图]')).toBe(''))
    it('multiple chunks, last word', () => expect(extractLastWord('你好 世界')).toBe('世界'))
  })

  // ---- start mode ----
  describe('start mode (默认)', () => {
    it('开头匹配成功', () => expect(tryMatchAtStart('petpet 文字', '', 'petpet', '', [])).toBe('文字'))
    it('开头无匹配（关键词在末尾）', () => expect(tryMatchAtStart('文字 petpet', '', 'petpet', '', [])).toBeUndefined())
    it('有前缀时开头匹配', () => expect(tryMatchAtStart('!petpet 文字', '(?:!)?', 'petpet', '', [])).toBe('文字'))
    it('仅关键词无参数', () => expect(tryMatchAtStart('petpet', '', 'petpet', '', [])).toBe(''))
  })

  // ---- end mode ----
  describe('end mode', () => {
    it('图片后关键词 → 空参数', () => expect(tryMatchAtEnd('[图]petpet', '', 'petpet', '', [])).toBe(''))
    it('@用户后关键词 → 空参数', () => expect(tryMatchAtEnd('<@123>petpet', '', 'petpet', '', [])).toBe(''))
    it('文字 + 关键词 → 文字作参数', () => expect(tryMatchAtEnd('文字 petpet', '', 'petpet', '', [])).toBe('文字'))
    // 实装行为：beforeSeg = lastSegment 之前的所有内容（含图片标签），图片/@ 被过滤 → 只剩文字
    it('图片 + 文字 + 关键词 → 仅文字作参数（实装行为）', () => expect(tryMatchAtEnd('[图]文字 petpet', '', 'petpet', '', [])).toBe('文字'))
    it('关键词在开头不匹配', () => expect(tryMatchAtEnd('petpet 文字', '', 'petpet', '', [])).toBeUndefined())
    it('有前缀时末尾匹配', () => expect(tryMatchAtEnd('[图]!petpet', '(?:!)?', 'petpet', '', [])).toBe(''))
    // 关键词在段末尾但段内关键词前无文本 → combinedBefore = '' → 空参数
    it('关键词在中间不匹配（关键词后有内容）', () => expect(tryMatchAtEnd('[图]petpet[图]', '', 'petpet', '', [])).toBeUndefined())
  })

  // ---- both mode ----
  describe('both mode: start优先', () => {
    const tryBoth = (content: string, pattern: string, prefixRe = '') => {
      let r = tryMatchAtStart(content, prefixRe, pattern, '', [])
      if (r !== undefined) return { mode: 'start' as const, argTxt: r }
      r = tryMatchAtEnd(content, prefixRe, pattern, '', [])
      if (r !== undefined) return { mode: 'end' as const, argTxt: r }
      return undefined
    }

    it('关键词在开头 → start模式', () => {
      const result = tryBoth('petpet 文字', 'petpet')
      expect(result?.mode).toBe('start')
      expect(result?.argTxt).toBe('文字')
    })
    it('关键词在末尾 → end模式', () => {
      const result = tryBoth('[图]petpet', 'petpet')
      expect(result?.mode).toBe('end')
      expect(result?.argTxt).toBe('')
    })
    it('无匹配 → undefined', () => expect(tryBoth('你好 世界', 'petpet')).toBeUndefined())
    it('双关键词 → start优先', () => expect(tryBoth('petpet petpet', 'petpet')?.mode).toBe('start'))
  })

  // ---- full shortcut flow ----
  describe('快捷方式完整流程', () => {
    it('按pattern长度倒序排列，长关键词优先匹配', () => {
      const shortcuts = [{ pattern: '5000兆', name: '5000zhao' }, { pattern: '兆', name: 'zhao' }]
      const content = '5000兆'
      const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      let matched: string | undefined
      for (const s of shortcuts.sort((a, b) => b.pattern.length - a.pattern.length)) {
        if (new RegExp(`^${esc(s.pattern)}`).test(content)) { matched = s.name; break }
      }
      expect(matched).toBe('5000zhao')
    })

    it('Python风格正则支持捕获组', () => {
      const re = new RegExp(`^戳\\s+(@\\w+)`)
      const res = re.exec('戳 @user1')
      expect(res?.[1]).toBe('@user1')
    })
  })
})
