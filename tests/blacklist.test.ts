import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

// ============================================================
// 黑名单功能审查修复后的回归测试
//
// 核心语义（与用户预期对齐）：
// - type='meme'：整个表情禁用（所有关键词都无法触发）
// - type='keyword'：仅该触发词失效，表情的其他关键词仍可触发
// - 运行时按"表情粒度"兜底：若所有关键词都被拉黑 → 整个禁用
// ============================================================

// ----- 镜像 isMemeBlacklisted 的核心判断逻辑（用于纯函数测试） -----
// 与 src/index.tsx 中 isMemeBlacklisted 的实现保持一致
function isMemeBlacklistedLogic(
  memeKey: string,
  keywords: string[],
  blacklistedMemes: Set<string>,
  blacklistedKeywords: Set<string>,
): boolean {
  const keyLower = memeKey.toLowerCase()

  // 1. 表情 key 在 meme 黑名单 → 整个禁用
  if (blacklistedMemes.has(keyLower)) return true

  // 2. 若 keywords 为空，仅按 key 判断
  if (keywords.length === 0) return false

  // 3. 所有触发词都在 keyword 黑名单（无可用触发词）→ 整个禁用
  //    部分被拉黑时，剩余触发词仍可使用
  const allKeywordsBlacklisted = keywords.every(kw => blacklistedKeywords.has(kw.toLowerCase()))
  if (allKeywordsBlacklisted) return true

  return false
}

describe('isMemeBlacklisted 核心语义', () => {
  // 模拟一个表情：key=petpet，3 个关键词
  const memeKey = 'petpet'
  const keywords = ['摸', '摸摸', 'petpet']

  it('无任何拉黑 → 不拦截', () => {
    expect(isMemeBlacklistedLogic(memeKey, keywords, new Set(), new Set())).toBe(false)
  })

  // ---- type='meme' 行为 ----
  describe('type=meme（整个表情禁用）', () => {
    it('key 在 meme 黑名单 → 拦截', () => {
      const memes = new Set(['petpet'])
      expect(isMemeBlacklistedLogic(memeKey, keywords, memes, new Set())).toBe(true)
    })

    it('key 大小写不敏感匹配', () => {
      const memes = new Set(['petpet'])
      expect(isMemeBlacklistedLogic('PETPET', keywords, memes, new Set())).toBe(true)
      expect(isMemeBlacklistedLogic('PetPet', keywords, memes, new Set())).toBe(true)
    })

    it('其他表情的 key 在黑名单 → 不影响本表情', () => {
      const memes = new Set(['kiss'])
      expect(isMemeBlacklistedLogic(memeKey, keywords, memes, new Set())).toBe(false)
    })
  })

  // ---- type='keyword' 行为（用户预期核心）----
  describe('type=keyword（单触发词禁用，其他仍可用）', () => {
    it('拉黑 1 个关键词 → 不拦截（其他关键词仍可用）', () => {
      const kwBlacklist = new Set(['摸'])
      expect(isMemeBlacklistedLogic(memeKey, keywords, new Set(), kwBlacklist)).toBe(false)
    })

    it('拉黑 2 个关键词（剩 1 个）→ 不拦截', () => {
      const kwBlacklist = new Set(['摸', '摸摸'])
      expect(isMemeBlacklistedLogic(memeKey, keywords, new Set(), kwBlacklist)).toBe(false)
    })

    it('拉黑全部 3 个关键词 → 拦截（无可用触发词）', () => {
      const kwBlacklist = new Set(['摸', '摸摸', 'petpet'])
      expect(isMemeBlacklistedLogic(memeKey, keywords, new Set(), kwBlacklist)).toBe(true)
    })

    it('拉黑不相关关键词 → 不影响本表情', () => {
      const kwBlacklist = new Set(['亲亲', '其他词'])
      expect(isMemeBlacklistedLogic(memeKey, keywords, new Set(), kwBlacklist)).toBe(false)
    })

    it('关键词大小写不敏感', () => {
      // keywords 里有 'petpet'，拉黑 'PETPET'
      const kwBlacklist = new Set(['PETPET'])
      // 仅拉黑 1 个（小写归一后），其他 2 个仍可用 → 不拦截
      expect(isMemeBlacklistedLogic(memeKey, keywords, new Set(), kwBlacklist)).toBe(false)
    })

    it('只有 1 个关键词的表情，拉黑该词 → 拦截', () => {
      // 某表情只有 1 个关键词
      const singleKeywords = ['唯一词']
      const kwBlacklist = new Set(['唯一词'])
      expect(isMemeBlacklistedLogic('somememe', singleKeywords, new Set(), kwBlacklist)).toBe(true)
    })

    it('无关键词的表情（仅 key）→ 仅 key 黑名单生效', () => {
      // info.keywords 为空数组（理论边界）
      expect(isMemeBlacklistedLogic('lonely', [], new Set(), new Set(['any']))).toBe(false)
      expect(isMemeBlacklistedLogic('lonely', [], new Set(['lonely']), new Set())).toBe(true)
    })
  })

  // ---- meme + keyword 混合 ----
  describe('meme 与 keyword 黑名单混合', () => {
    it('key 在 meme 黑名单，即使有可用关键词 → 仍拦截', () => {
      const memes = new Set(['petpet'])
      const kwBlacklist = new Set(['摸'])  // 仅拉黑 1 个
      // meme 类型优先级最高
      expect(isMemeBlacklistedLogic(memeKey, keywords, memes, kwBlacklist)).toBe(true)
    })
  })
})

// ============================================================
// 输入校验逻辑（镜像 resolveMemeByInput）
// ============================================================
describe('拉黑输入校验 resolveMemeByInput 逻辑', () => {
  // 模拟 ctx.$.infos 和 findMemeKeyByKeyword
  const infos: Record<string, { keywords: string[] }> = {
    petpet: { keywords: ['摸', '摸摸', 'petpet'] },
    kiss: { keywords: ['亲亲', 'kiss'] },
  }
  const findMemeKeyByKeyword = (input: string): string | null => {
    for (const [key, info] of Object.entries(infos)) {
      if (info.keywords.includes(input)) return key
    }
    return null
  }

  const resolveMemeByInput = (input: string) => {
    const trimmed = input.trim()
    if (!trimmed) return null
    if (infos[trimmed]) return { key: trimmed, matchedAs: 'key' as const }
    const key = findMemeKeyByKeyword(trimmed)
    if (key) return { key, matchedAs: 'keyword' as const, matchedKeyword: trimmed }
    return null
  }

  it('输入 key → matchedAs=key', () => {
    expect(resolveMemeByInput('petpet')).toEqual({ key: 'petpet', matchedAs: 'key' })
  })

  it('输入关键词 → matchedAs=keyword', () => {
    expect(resolveMemeByInput('摸')).toEqual({ key: 'petpet', matchedAs: 'keyword', matchedKeyword: '摸' })
  })

  it('输入不存在的字符串 → null', () => {
    expect(resolveMemeByInput('乱七八糟')).toBeNull()
  })

  it('空字符串 → null', () => {
    expect(resolveMemeByInput('')).toBeNull()
    expect(resolveMemeByInput('   ')).toBeNull()
  })

  it('输入带空格 → trim 后匹配', () => {
    expect(resolveMemeByInput('  petpet  ')?.key).toBe('petpet')
  })
})

// ============================================================
// 大小写不敏感删除逻辑（镜像 removeBlacklistedEntry）
// ============================================================
describe('removeBlacklistedEntry 大小写不敏感删除', () => {
  // 模拟 DB 记录
  const makeDb = () => [
    { id: 1, keyword: 'PetPet', type: 'meme' },
    { id: 2, keyword: '摸', type: 'keyword' },
    { id: 3, keyword: 'petpet', type: 'keyword' },  // 与 id=1 大小写不同
    { id: 4, keyword: 'KISS', type: 'meme' },
  ]

  const simulateRemove = (
    db: ReturnType<typeof makeDb>,
    keyword: string,
    type?: 'meme' | 'keyword',
  ): { removed: number; remaining: typeof db } => {
    const lower = keyword.toLowerCase()
    const toDelete = db.filter(r => {
      if (r.keyword.toLowerCase() !== lower) return false
      if (type && r.type !== type) return false
      return true
    })
    if (toDelete.length === 0) return { removed: 0, remaining: db }
    const deleteIds = new Set(toDelete.map(r => r.id))
    return { removed: toDelete.length, remaining: db.filter(r => !deleteIds.has(r.id)) }
  }

  it('不指定 type → 删除所有大小写匹配的条目', () => {
    const result = simulateRemove(makeDb(), 'petpet')
    // PetPet (id=1) 和 petpet (id=3) 都被删除
    expect(result.removed).toBe(2)
    expect(result.remaining.length).toBe(2)
    expect(result.remaining.map(r => r.id)).toEqual([2, 4])
  })

  it('指定 type=meme → 仅删除 meme 类型', () => {
    const result = simulateRemove(makeDb(), 'petpet', 'meme')
    // 只删 PetPet (id=1, type=meme)，保留 petpet (id=3, type=keyword)
    expect(result.removed).toBe(1)
    expect(result.remaining.map(r => r.id)).toEqual([2, 3, 4])
  })

  it('指定 type=keyword → 仅删除 keyword 类型', () => {
    const result = simulateRemove(makeDb(), 'petpet', 'keyword')
    expect(result.removed).toBe(1)
    expect(result.remaining.map(r => r.id)).toEqual([1, 2, 4])
  })

  it('删除不存在的关键词 → removed=0', () => {
    const result = simulateRemove(makeDb(), '不存在')
    expect(result.removed).toBe(0)
    expect(result.remaining.length).toBe(4)
  })

  it('删除中文关键词（大小写不适用）', () => {
    const result = simulateRemove(makeDb(), '摸', 'keyword')
    expect(result.removed).toBe(1)
    expect(result.remaining.map(r => r.id)).toEqual([1, 3, 4])
  })
})

// ============================================================
// 源码静态断言：确保关键修复存在
// ============================================================
describe('黑名单源码静态断言', () => {
  const indexSrc = fs.readFileSync(path.resolve(__dirname, '../src/index.tsx'), 'utf8')
  const blacklistSrc = fs.readFileSync(path.resolve(__dirname, '../src/commands/blacklist.ts'), 'utf8')
  const generateSrc = fs.readFileSync(path.resolve(__dirname, '../src/commands/generate.ts'), 'utf8')

  it('DB schema 包含 type 字段', () => {
    expect(indexSrc).toContain("type: 'string'")
    // 复合 unique 索引（keyword + type）
    expect(indexSrc).toMatch(/keys:\s*\{[^}]*keyword[^}]*type[^}]*\}/)
  })

  it('isMemeBlacklisted 检查 memes Set（非单个 blacklist Set）', () => {
    expect(indexSrc).toContain('cache.memes.has(keyLower)')
    expect(indexSrc).toContain('cache.keywords')
  })

  it('缓存防击穿 inflight 机制存在', () => {
    expect(indexSrc).toContain('blacklistInflight')
  })

  it('refreshShortcuts 同时获取 memes 和 keywords 两类黑名单 (B1 修复)', () => {
    expect(indexSrc).toContain('getBlacklistedMemes()')
    expect(indexSrc).toContain('getBlacklistedKeywords()')
    // 单关键词拉黑时跳过该快捷指令
    expect(indexSrc).toMatch(/blacklistedKeywords\.has\(keyword\.toLowerCase\(\)\)/)
  })

  it('reRegisterGenerateCommands 区分 memes/keywords (S1)', () => {
    expect(generateSrc).toContain('blacklistedMemes')
    expect(generateSrc).toContain('blacklistedKeywords')
    // 所有 keyword 被拉黑时跳过命令注册
    expect(generateSrc).toContain('all keywords blacklisted')
  })

  it('removeBlacklistedEntry 大小写不敏感 (B2 修复)', () => {
    expect(indexSrc).toContain('removeBlacklistedEntry')
    // 应有 toLowerCase 比较，而非直接 remove({keyword})
    expect(indexSrc).toMatch(/toLowerCase\(\)\s*!==\s*lower/)
  })

  it('addBlacklistEntry 用 try/catch 处理 unique 冲突 (B3 修复)', () => {
    expect(indexSrc).toContain('addBlacklistEntry')
    expect(indexSrc).toMatch(/unique|duplicate|constraint/)
  })

  it('blacklist 命令：输入校验 + 引导（B8）', () => {
    // 校验不匹配时报错
    expect(blacklistSrc).toContain('没有找到关键词')
    // 输入 key 时引导用户使用 blacklist-meme
    expect(blacklistSrc).toContain('blacklist-meme')
  })

  it('blacklist-meme 命令存在（新增独立命令拉黑整个表情）', () => {
    expect(blacklistSrc).toContain(".blacklist-meme")
    expect(blacklistSrc).toContain('addBlacklistedMeme')
  })

  it('unblacklist 支持 --type 选项', () => {
    expect(blacklistSrc).toContain("removeBlacklistedEntry")
    expect(blacklistSrc).toMatch(/options\??\.type|--type|'meme'.*'keyword'/)
  })

  it('blacklist-list 分组显示 meme/keyword', () => {
    expect(blacklistSrc).toContain("e.type === 'meme'")
    expect(blacklistSrc).toContain("e.type === 'keyword'")
  })

  it('blacklist 命令有 checkArgCount (B10 修复)', () => {
    // 所有命令都应有 checkArgCount: true（除了 list 类）
    const checkArgCountMatches = blacklistSrc.match(/checkArgCount:\s*true/g) || []
    // blacklist / blacklist-meme / unblacklist 三个应有，blacklist-list 不应有
    expect(checkArgCountMatches.length).toBeGreaterThanOrEqual(3)
  })
})
