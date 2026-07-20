import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

// ============================================================
// user-block + guild 功能修复回归测试
//
// 覆盖：
// - U1: random.ts 黑名单回归（memes + keywords 两类）
// - U2: guild_settings/user_blocks unique 复合索引
// - U3: enable-guild 删除记录（恢复默认）
// - U4: 不可屏蔽同级/更高权限用户
// - U5/U6/S2: 内存缓存（guild settings + user blocks）
// - U7: resolveTargetUser 用户存在性校验
// - U9: guild-list 显示关键词
// - U10/S3: unblock 删除记录（不再写 blocked=false）
// - U14: 移除"显式允许"分类
// - S1: checkMemeAvailability 统一接口
// ============================================================

// ---------- 纯函数逻辑镜像 ----------

/**
 * 镜像 isMemeGuildEnabled 的缓存查找逻辑。
 * cache 结构：scopeKey → Map<memeKey(lower), enabled>
 */
function isMemeGuildEnabledLogic(
  guildId: string, platform: string, memeKey: string,
  cache: Map<string, Map<string, boolean>>,
): boolean {
  const inner = cache.get(`${guildId}\0${platform}`)
  if (!inner) return true
  const v = inner.get(memeKey.toLowerCase())
  return v === undefined ? true : v
}

/**
 * 镜像 isUserMemeBlocked 的缓存查找逻辑。
 * cache 结构：scopeKey → Map<userId(lower), Set<memeKey(lower)>>
 */
function isUserMemeBlockedLogic(
  guildId: string, platform: string, userId: string, memeKey: string,
  cache: Map<string, Map<string, Set<string>>>,
): boolean {
  const byUser = cache.get(`${guildId}\0${platform}`)
  if (!byUser) return false
  return byUser.get(userId.toLowerCase())?.has(memeKey.toLowerCase()) ?? false
}

/**
 * 镜像 U4 的权限比较逻辑：不可屏蔽同级或更高权限用户。
 */
function canBlock(operatorAuth: number, targetAuth: number): boolean {
  // targetAuth > 0 防止查询失败（0）被误判
  return !(targetAuth >= operatorAuth && targetAuth > 0)
}

// ============================================================
// U5/U6/S2: 缓存查找语义
// ============================================================
describe('isMemeGuildEnabled 缓存查找（U5/S2）', () => {
  const makeCache = (entries: Array<[string, string, boolean]>) => {
    const cache = new Map<string, Map<string, boolean>>()
    for (const [scope, key, enabled] of entries) {
      if (!cache.has(scope)) cache.set(scope, new Map())
      cache.get(scope)!.set(key.toLowerCase(), enabled)
    }
    return cache
  }

  it('无任何设置 → 默认启用', () => {
    const cache = makeCache([])
    expect(isMemeGuildEnabledLogic('g1', 'onebot', 'petpet', cache)).toBe(true)
  })

  it('该群有设置但本表情无记录 → 启用', () => {
    const cache = makeCache([['g1\0onebot', 'kiss', false]])
    expect(isMemeGuildEnabledLogic('g1', 'onebot', 'petpet', cache)).toBe(true)
  })

  it('本表情被禁用 → false', () => {
    const cache = makeCache([['g1\0onebot', 'petpet', false]])
    expect(isMemeGuildEnabledLogic('g1', 'onebot', 'petpet', cache)).toBe(false)
  })

  it('大小写不敏感', () => {
    const cache = makeCache([['g1\0onebot', 'petpet', false]])
    expect(isMemeGuildEnabledLogic('g1', 'onebot', 'PETPET', cache)).toBe(false)
  })

  it('不同群/平台互不影响', () => {
    const cache = makeCache([['g1\0onebot', 'petpet', false]])
    expect(isMemeGuildEnabledLogic('g2', 'onebot', 'petpet', cache)).toBe(true)
    expect(isMemeGuildEnabledLogic('g1', 'discord', 'petpet', cache)).toBe(true)
  })
})

describe('isUserMemeBlocked 缓存查找（U6/S2）', () => {
  const makeCache = (entries: Array<[string, string, string]>) => {
    const cache = new Map<string, Map<string, Set<string>>>()
    for (const [scope, userId, memeKey] of entries) {
      if (!cache.has(scope)) cache.set(scope, new Map())
      const byUser = cache.get(scope)!
      if (!byUser.has(userId.toLowerCase())) byUser.set(userId.toLowerCase(), new Set())
      byUser.get(userId.toLowerCase())!.add(memeKey.toLowerCase())
    }
    return cache
  }

  it('无记录 → 未屏蔽', () => {
    expect(isUserMemeBlockedLogic('g1', 'onebot', 'u1', 'petpet', makeCache([]))).toBe(false)
  })

  it('被屏蔽 → true', () => {
    const cache = makeCache([['g1\0onebot', 'u1', 'petpet']])
    expect(isUserMemeBlockedLogic('g1', 'onebot', 'u1', 'petpet', cache)).toBe(true)
  })

  it('只屏蔽了某表情，其他表情不受影响', () => {
    const cache = makeCache([['g1\0onebot', 'u1', 'petpet']])
    expect(isUserMemeBlockedLogic('g1', 'onebot', 'u1', 'kiss', cache)).toBe(false)
  })

  it('大小写不敏感（userId + memeKey）', () => {
    const cache = makeCache([['g1\0onebot', 'u1', 'petpet']])
    expect(isUserMemeBlockedLogic('g1', 'onebot', 'U1', 'PETPET', cache)).toBe(true)
  })

  it('不同群互不影响', () => {
    const cache = makeCache([['g1\0onebot', 'u1', 'petpet']])
    expect(isUserMemeBlockedLogic('g2', 'onebot', 'u1', 'petpet', cache)).toBe(false)
  })
})

// ============================================================
// U4: 权限比较
// ============================================================
describe('canBlock 权限比较（U4）', () => {
  it('操作者 4，目标 1（普通成员）→ 可屏蔽', () => {
    expect(canBlock(4, 1)).toBe(true)
  })

  it('操作者 4，目标 4（同级管理员）→ 不可屏蔽', () => {
    expect(canBlock(4, 4)).toBe(false)
  })

  it('操作者 4，目标 5（更高权限）→ 不可屏蔽', () => {
    expect(canBlock(4, 5)).toBe(false)
  })

  it('操作者 4，目标 0（查询失败）→ 可屏蔽（保守允许）', () => {
    expect(canBlock(4, 0)).toBe(true)
  })

  it('操作者 1（普通成员本不该有权限，但若绕过），目标 1 → 不可屏蔽', () => {
    expect(canBlock(1, 1)).toBe(false)
  })
})

// ============================================================
// U10/S3: 缓存构建时忽略 blocked=false 的僵尸记录
// ============================================================
describe('buildUserBlocksCache 忽略僵尸记录（U10/S3）', () => {
  // 镜像 buildUserBlocksCache 的核心过滤逻辑
  const buildCache = (records: Array<{ user_id: string; meme_key: string; blocked: boolean }>) => {
    const cache = new Map<string, Map<string, Set<string>>>()
    for (const r of records) {
      if (!r.blocked) continue  // ← 关键：跳过僵尸记录
      const scope = 'g1\0onebot'
      if (!cache.has(scope)) cache.set(scope, new Map())
      const byUser = cache.get(scope)!
      if (!byUser.has(r.user_id.toLowerCase())) byUser.set(r.user_id.toLowerCase(), new Set())
      byUser.get(r.user_id.toLowerCase())!.add(r.meme_key.toLowerCase())
    }
    return cache
  }

  it('只含 blocked=true 的记录 → 正常缓存', () => {
    const cache = buildCache([
      { user_id: 'u1', meme_key: 'petpet', blocked: true },
      { user_id: 'u2', meme_key: 'kiss', blocked: true },
    ])
    expect(cache.get('g1\0onebot')?.get('u1')?.has('petpet')).toBe(true)
    expect(cache.get('g1\0onebot')?.get('u2')?.has('kiss')).toBe(true)
  })

  it('含 blocked=false 的僵尸记录 → 被忽略', () => {
    const cache = buildCache([
      { user_id: 'u1', meme_key: 'petpet', blocked: true },
      { user_id: 'u1', meme_key: 'kiss', blocked: false },  // 僵尸
    ])
    expect(cache.get('g1\0onebot')?.get('u1')?.has('petpet')).toBe(true)
    expect(cache.get('g1\0onebot')?.get('u1')?.has('kiss')).toBe(false)
  })

  it('全部是僵尸记录 → 缓存为空', () => {
    const cache = buildCache([
      { user_id: 'u1', meme_key: 'petpet', blocked: false },
    ])
    expect(cache.size).toBe(0)
  })
})

// ============================================================
// 源码静态断言
// ============================================================
describe('源码静态断言（U1-U14/S1-S3 修复）', () => {
  const indexSrc = fs.readFileSync(path.resolve(__dirname, '../src/index.tsx'), 'utf8')
  const guildSrc = fs.readFileSync(path.resolve(__dirname, '../src/commands/guild.ts'), 'utf8')
  const userBlockSrc = fs.readFileSync(path.resolve(__dirname, '../src/commands/user-block.ts'), 'utf8')
  const randomSrc = fs.readFileSync(path.resolve(__dirname, '../src/commands/random.ts'), 'utf8')
  const generateSrc = fs.readFileSync(path.resolve(__dirname, '../src/commands/generate.ts'), 'utf8')

  // ---- U1: random.ts 黑名单回归修复 ----
  it('random.ts 同时获取 memes + keywords 两类黑名单（U1）', () => {
    expect(randomSrc).toContain('getBlacklistedMemes()')
    expect(randomSrc).toContain('getBlacklistedKeywords()')
    // 应有 "所有关键词被拉黑 → 整体禁用" 的兜底
    expect(randomSrc).toMatch(/info\.keywords\.every\(kw\s*=>\s*blacklistedKeywords\.has/)
  })

  // ---- U2: unique 索引 ----
  it('guild_settings 用 unique 复合索引（U2）', () => {
    // 提取 memes_guild_settings 的 model.extend 配置块
    const block = indexSrc.match(/model\.extend\('memes_guild_settings'[\s\S]+?\}\s*\)\s*\)/)
    expect(block, '未找到 memes_guild_settings 配置').not.toBeNull()
    const cfg = block![0]
    expect(cfg).toContain("guild_id: 'asc'")
    expect(cfg).toContain("platform: 'asc'")
    expect(cfg).toContain("meme_key: 'asc'")
    expect(cfg).toContain('unique: true')
  })

  it('user_blocks 用 unique 复合索引（U2）', () => {
    const block = indexSrc.match(/model\.extend\('memes_user_blocks'[\s\S]+?\}\s*\)\s*\)/)
    expect(block, '未找到 memes_user_blocks 配置').not.toBeNull()
    const cfg = block![0]
    expect(cfg).toContain("guild_id: 'asc'")
    expect(cfg).toContain("platform: 'asc'")
    expect(cfg).toContain("user_id: 'asc'")
    expect(cfg).toContain("meme_key: 'asc'")
    expect(cfg).toContain('unique: true')
  })

  it('setMemeGuildEnabled/setUserMemeBlocked 用 upsert（U2）', () => {
    expect(indexSrc).toContain("database.upsert('memes_guild_settings'")
    expect(indexSrc).toContain("database.upsert('memes_user_blocks'")
  })

  // ---- U3: enable = 删除记录 ----
  it('enable-guild 通过 removeMemeGuildSetting 删除（U3）', () => {
    expect(indexSrc).toContain('removeMemeGuildSetting')
    expect(guildSrc).toContain('removeMemeGuildSetting')
  })

  it('guild.ts 不再直接调用 db.remove（已封装到 index）', () => {
    expect(guildSrc).not.toContain("database.remove('memes_guild_settings'")
  })

  // ---- U5/U6/S2: 内存缓存 ----
  it('群组设置内存缓存存在（U5/S2）', () => {
    expect(indexSrc).toContain('guildSettingsCache')
    expect(indexSrc).toContain('ensureGuildSettingsCache')
    expect(indexSrc).toContain('guildSettingsInflight')
  })

  it('用户屏蔽内存缓存存在（U6/S2）', () => {
    expect(indexSrc).toContain('userBlocksCache')
    expect(indexSrc).toContain('ensureUserBlocksCache')
    expect(indexSrc).toContain('userBlocksInflight')
  })

  it('setMemeGuildEnabled 写后更新缓存（避免重新查 DB）', () => {
    expect(indexSrc).toMatch(/setMemeGuildEnabled[\s\S]*?cache\.set\(scopeKey/)
  })

  // ---- U4: 权限检查 ----
  it('user-block 有权限比较逻辑（U4）', () => {
    expect(userBlockSrc).toContain('getUserAuthority')
    expect(userBlockSrc).toContain('targetAuth')
    // 应有"不可屏蔽同级或更高权限"的判断
    expect(userBlockSrc).toMatch(/targetAuth\s*>=\s*operatorAuth|权限等级不低于你/)
  })

  // ---- U7: 用户存在性校验 ----
  it('user-block 有 resolveTargetUser 校验（U7）', () => {
    expect(userBlockSrc).toContain('resolveTargetUser')
    expect(userBlockSrc).toContain('找不到用户')
  })

  // ---- U8: 跳过自己的注释 ----
  it('generate.ts 有"故意跳过自己"注释（U8）', () => {
    expect(generateSrc).toMatch(/故意跳过自己|自我屏蔽死锁/)
  })

  it('random.ts 有"跳过自己"注释（U8）', () => {
    expect(randomSrc).toMatch(/跳过自己/)
  })

  // ---- U9: guild-list 显示关键词 ----
  it('guild-list formatEntry 显示关键词 + key（U9）', () => {
    expect(guildSrc).toContain('formatEntry')
    expect(guildSrc).toMatch(/keywords\[0\]/)
  })

  // ---- U10/S3: unblock 删除记录 ----
  it('unblock 通过 removeUserMemeBlock 删除（U10/S3）', () => {
    expect(indexSrc).toContain('removeUserMemeBlock')
    expect(userBlockSrc).toContain('removeUserMemeBlock')
  })

  it('unblock 不再写 blocked=false（U10/S3）', () => {
    // 不应直接调用 setUserMemeBlocked(..., false) 在 unblock 命令里
    // 注意：setUserMemeBlocked 内部仍兼容 false（转调 remove），但 unblock 命令应直接用 remove
    expect(userBlockSrc).not.toMatch(/setUserMemeBlocked\([\s\S]*?,\s*false\)/)
  })

  // ---- U13: getName 加日志 ----
  it('getName 失败时记录 logger.debug（U13）', () => {
    expect(userBlockSrc).toMatch(/logger\.debug/)
  })

  // ---- U14: 移除"显式允许"分类 ----
  it('user-block.list 不再输出"显式允许"文案（U14）', () => {
    // 注释里提到"移除显式允许"是合理的，但实际 outputLines.push 不应含此字符串
    // 提取所有 outputLines.push(...) 的字符串字面量
    const pushes = userBlockSrc.match(/outputLines\.push\(`[^`]*`\)|outputLines\.push\([^)]+\)/g) || []
    const joined = pushes.join('\n')
    expect(joined).not.toMatch(/显式允许/)
  })

  // ---- S1: checkMemeAvailability 统一接口 ----
  it('index.tsx 提供 checkMemeAvailability 统一接口（S1）', () => {
    expect(indexSrc).toContain('checkMemeAvailability')
    expect(indexSrc).toContain("'blacklisted'")
    expect(indexSrc).toContain("'guild-disabled'")
    expect(indexSrc).toContain("'user-blocked'")
  })

  it('generate.ts 声明 checkMemeAvailability 类型（S1）', () => {
    expect(generateSrc).toContain('checkMemeAvailability')
  })
})
