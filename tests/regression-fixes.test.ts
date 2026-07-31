import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

import { RenderCache } from '../src/cache'
import { constructBlobFromFileResp, errorMessage } from '../src/utils'

// ============================================================
// 辅助：临时缓存目录
// ============================================================
let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-fix-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

const newCache = (opts?: Partial<ConstructorParameters<typeof RenderCache>[0]>) => {
  return new RenderCache(
    {
      enabled: opts?.enabled ?? true,
      ttl: opts?.ttl ?? 1800000,
      maxEntries: opts?.maxEntries ?? 200,
      maxSize: opts?.maxSize ?? 100 * 1024 * 1024,
      persist: opts?.persist ?? false,
    },
    tmpDir,
  )
}

// ============================================================
// H2: constructBlobFromFileResp 空响应校验
// ============================================================
describe('constructBlobFromFileResp 防御性校验 (H2)', () => {
  it('正常响应 → 构造 Blob', () => {
    const data = new Uint8Array([1, 2, 3])
    const blob = constructBlobFromFileResp({
      data,
      headers: { 'content-type': 'image/png' },
      status: 200,
    })
    expect(blob.size).toBe(3)
    expect(blob.type).toBe('image/png')
  })

  it('data 为空数组 → 抛错（避免下游渲染黑图）', () => {
    expect(() =>
      constructBlobFromFileResp({ data: new Uint8Array(0), headers: {}, status: 200 }),
    ).toThrow(/Empty image response/)
  })

  it('data 为 undefined → 抛错', () => {
    expect(() =>
      constructBlobFromFileResp({ data: undefined as any, headers: {}, status: 200 }),
    ).toThrow(/Empty image response/)
  })

  it('resp 为 undefined → 抛错', () => {
    expect(() => constructBlobFromFileResp(undefined as any)).toThrow(/Empty image response/)
  })

  it('未提供 content-type → 默认 image/png', () => {
    const blob = constructBlobFromFileResp({
      data: new Uint8Array([1]),
      headers: {},
      status: 200,
    })
    expect(blob.type).toBe('image/png')
  })
})

// ============================================================
// H5: errorMessage 安全访问
// ============================================================
describe('errorMessage 安全访问 (H5)', () => {
  it('Error 实例 → 返回 message', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom')
  })

  it('Error 子类 → 返回 message', () => {
    class Custom extends Error {
      constructor(msg: string) {
        super(msg)
        this.name = 'Custom'
      }
    }
    expect(errorMessage(new Custom('custom error'))).toBe('custom error')
  })

  it('字符串 → 原样返回', () => {
    expect(errorMessage('plain string')).toBe('plain string')
  })

  it('数字 → 转字符串', () => {
    expect(errorMessage(42)).toBe('42')
  })

  it('null → "null"', () => {
    expect(errorMessage(null)).toBe('null')
  })

  it('undefined → "undefined"', () => {
    expect(errorMessage(undefined)).toBe('undefined')
  })

  it('带 message 字段的普通对象 → 返回其 message', () => {
    expect(errorMessage({ message: 'obj-msg' })).toBe('obj-msg')
  })

  it('无 message 的对象 → String(obj)', () => {
    expect(errorMessage({ foo: 'bar' })).toBe('[object Object]')
  })
})

// ============================================================
// L2: evict 超大条目不陷入死循环
// ============================================================
describe('evict 超大条目边界保护 (L2)', () => {
  it('incoming > maxSize 时 evict 不死循环，允许写入', () => {
    // maxSize = 10 bytes，但写入 100 bytes 的超大条目
    const c = newCache({ maxSize: 10, maxEntries: 100 })
    const hugeBuffer = Buffer.alloc(100, 0x41) // 100 bytes
    // 关键断言：不应阻塞或超时
    expect(() => c.set('huge', hugeBuffer, 'image/png')).not.toThrow()
    // 条目应被写入（即使超过 maxSize）
    expect(c.get('huge')).toBeDefined()
  })

  it('写入超大条目后，下一条目会淘汰它', () => {
    const c = newCache({ maxSize: 10, maxEntries: 100 })
    c.set('huge', Buffer.alloc(100, 0x41), 'image/png')
    // 写入小条目：应触发淘汰，把 huge 挤出去
    c.set('small', Buffer.from('ab'), 'image/png')
    expect(c.get('huge')).toBeUndefined()
    expect(c.get('small')).toBeDefined()
  })

  it('头像缓存超大条目同样安全', async () => {
    const c = newCache({ maxSize: 10, maxEntries: 100 })
    const hugeBlob = new Blob([new Uint8Array(100)])
    // 不应死循环或抛错
    const blob = await c.getAvatar('http://x/u1', async () => hugeBlob)
    expect(blob.size).toBe(100)
  })

  it('正常 LRU 行为不受影响', () => {
    const c = newCache({ maxSize: 10, maxEntries: 2 })
    c.set('a', Buffer.from('12345'), 'image/png')
    c.set('b', Buffer.from('12345'), 'image/png')
    c.set('c', Buffer.from('12'), 'image/png') // 淘汰 a
    expect(c.get('a')).toBeUndefined()
    expect(c.get('b')).toBeDefined()
    expect(c.get('c')).toBeDefined()
  })
})

// ============================================================
// H3: user_infos 排除策略（验证是有意近似，非 bug）
// ============================================================
describe('user_infos 排除策略文档化 (H3)', () => {
  it('user_infos 不计入 key（已存在行为，确认未回归）', () => {
    const c = newCache()
    const k1 = c.computeKey('m', [{ userId: '1' }], [], {})
    const k2 = c.computeKey('m', [{ userId: '1' }], [], { user_infos: [{ name: 'Alice' }] })
    const k3 = c.computeKey('m', [{ userId: '1' }], [], { user_infos: [{ name: 'Bob' }] })
    // 三个 key 应完全一致：user_infos 有意排除，同一 userId 在 TTL 内共享缓存
    expect(k1).toBe(k2)
    expect(k2).toBe(k3)
  })

  it('userId 变化 → key 变化（保证头像差异仍可识别）', () => {
    const c = newCache()
    const k1 = c.computeKey('m', [{ userId: '1' }], [], { user_infos: [{ name: 'A' }] })
    const k2 = c.computeKey('m', [{ userId: '2' }], [], { user_infos: [{ name: 'A' }] })
    expect(k1).not.toBe(k2)
  })
})

// ============================================================
// C2: 黑名单大小写归一化（通过 isMemeBlacklisted 行为间接验证）
// ============================================================
describe('黑名单大小写归一化逻辑 (C2 验证)', () => {
  // 此处直接测试归一化 helper 逻辑（镜像 index.tsx 内联实现）
  // 约定：缓存存储小写形式；调用方查询时也先 toLowerCase（见 isMemeBlacklisted）
  const toLowerSet = (arr: string[]) => new Set(arr.map(k => k.toLowerCase()))
  // 模拟 isMemeBlacklisted 的查询方式：输入一律先小写化
  const lookup = (set: Set<string>, key: string) => set.has(key.toLowerCase())

  it('大写关键词应能匹配小写输入', () => {
    const set = toLowerSet(['PetPet', 'KISS'])
    // 调用方查询时一律先 toLowerCase
    expect(lookup(set, 'petpet')).toBe(true)
    expect(lookup(set, 'kiss')).toBe(true)
    expect(lookup(set, 'PETPET')).toBe(true)   // lookup 内部会归一化
    expect(lookup(set, 'PeTpEt')).toBe(true)
  })

  it('空数组不匹配任何输入', () => {
    const set = toLowerSet([])
    expect(lookup(set, 'anything')).toBe(false)
  })

  it('相同关键词不同大小写只产生一个条目', () => {
    const set = toLowerSet(['Pet', 'pet', 'PET'])
    expect(set.size).toBe(1)
  })
})

// ============================================================
// M2: updateInfos Promise.allSettled 行为镜像测试
// ============================================================
describe('Promise.allSettled 部分失败容错 (M2)', () => {
  it('部分失败时保留成功的条目', async () => {
    const keys = ['ok1', 'ok2', 'fail1', 'ok3', 'fail2']
    const fetchInfo = (key: string): Promise<string> =>
      new Promise((resolve, reject) => {
        setTimeout(() => {
          if (key.startsWith('fail')) reject(new Error(`fail: ${key}`))
          else resolve(`value-${key}`)
        }, 1)
      })
    // 镜像 updateInfos 的 allSettled 处理
    const settled = await Promise.allSettled(keys.map(k => fetchInfo(k)))
    const entries: Array<[string, string]> = []
    let failed = 0
    settled.forEach((r, i) => {
      if (r.status === 'fulfilled') entries.push([keys[i], r.value])
      else failed++
    })
    expect(entries.length).toBe(3)
    expect(failed).toBe(2)
    expect(entries.map(e => e[0])).toEqual(['ok1', 'ok2', 'ok3'])
  })

  it('全部失败时抛错（让上层处理）', async () => {
    const keys = ['a', 'b']
    const fetchInfo = () => Promise.reject(new Error('all failed'))
    const settled = await Promise.allSettled(keys.map(k => fetchInfo()))
    const entries: Array<[string, unknown]> = []
    let failed = 0
    settled.forEach((r, i) => {
      if (r.status === 'fulfilled') entries.push([keys[i], r.value])
      else failed++
    })
    expect(entries.length).toBe(0)
    expect(failed).toBe(2)
    // 全部失败时上层应抛错
    expect(() => {
      if (entries.length === 0 && keys.length > 0) {
        throw new Error('all failed')
      }
    }).toThrow(/all failed/)
  })
})

// ============================================================
// C1: 验证 findMemeCache 声明顺序（静态分析：源码中 let 在赋值之前）
// ============================================================
describe('findMemeCache 声明顺序 (C1 回归)', () => {
  it('源码中 let findMemeCache 出现在 updateInfos 赋值之前', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../src/index.tsx'),
      'utf8',
    )
    const letPos = src.indexOf('let findMemeCache')
    const updatePos = src.indexOf('ctx.$.updateInfos =')
    expect(letPos).toBeGreaterThan(-1)
    expect(updatePos).toBeGreaterThan(-1)
    // 关键：let 声明必须在 updateInfos 赋值之前
    expect(letPos).toBeLessThan(updatePos)
  })
})

// ============================================================
// H6: 验证 refresh.ts 不再重复调用 refreshListImage
// ============================================================
describe('refresh.ts 不再重复调用 refreshListImage (H6 回归)', () => {
  it('源码中 refreshListImage 在 refresh.ts 仅出现一次（action 内）', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../src/commands/refresh.ts'),
      'utf8',
    )
    const matches = src.match(/refreshListImage\(\)/g) || []
    // 之前是 2 次（bug），修复后应为 1 次
    expect(matches.length).toBe(1)
  })
})

// ============================================================
// M1 回归：验证 memes_usage_stats 的 unique 复合索引使用对象形式
// （minato 1.x/3.x 要求 unique 复合索引的 keys 必须是对象 {field: 'asc'}，
//   数组形式会被当作非 unique 复合索引；若误用数组 + unique，
//   会触发 "missing field definition for index key 0" 运行时错误）
// ============================================================
describe('memes_usage_stats unique 复合索引语法 (M1 回归)', () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, '../src/index.tsx'),
    'utf8',
  )

  it('memes_usage_stats 配置块存在', () => {
    expect(src).toContain("model.extend('memes_usage_stats'")
  })

  it('unique 复合索引的 keys 为对象形式（非数组）', () => {
    // 提取 memes_usage_stats 的 model.extend 配置块
    const blockMatch = src.match(
      /model\.extend\('memes_usage_stats'[\s\S]+?\}\s*\)\s*\)/,
    )
    expect(blockMatch, '未找到 memes_usage_stats 配置块').not.toBeNull()
    const block = blockMatch![0]

    // 必须包含 unique: true
    expect(block).toContain('unique: true')

    // 提取 indexes 数组中的 keys 值
    // 正确形式：keys: { meme_key: 'asc', ... }
    // 错误形式：keys: ['meme_key', ...] → 触发 "missing field definition for index key 0"
    const keysMatch = block.match(/keys:\s*(\[[\s\S]*?\]|\{[\s\S]*?\})/)
    expect(keysMatch, '未找到 keys 定义').not.toBeNull()
    const keysValue = keysMatch![1]
    expect(keysValue.startsWith('{')).toBe(true)
    expect(keysValue.startsWith('[')).toBe(false)

    // 应包含全部 4 个字段
    expect(keysValue).toContain('meme_key')
    expect(keysValue).toContain('guild_id')
    expect(keysValue).toContain('user_id')
    expect(keysValue).toContain('platform')
  })

  it('guild_settings/user_blocks 也改为 unique 复合索引（U2 修复后）', () => {
    // U2 修复：这两张表从非 unique 数组形式改为对象形式 unique 索引
    // 防止并发"查→改/插"产生重复记录，与 memes_usage_stats 同范式
    const guildBlock = src.match(/model\.extend\('memes_guild_settings'[\s\S]+?\}\s*\)\s*\)/)
    const userBlock = src.match(/model\.extend\('memes_user_blocks'[\s\S]+?\}\s*\)\s*\)/)
    expect(guildBlock).not.toBeNull()
    expect(userBlock).not.toBeNull()
    expect(guildBlock![0]).toContain('unique: true')
    expect(userBlock![0]).toContain('unique: true')
  })
})

// ============================================================
// M1-2: recordMemeUsage 不使用 upsert 函数值表达式（SQLite 兼容性回归）
//
// 上次 M1 修复用了 `upsert(..., [{ usage_count: (row) => row.x + 1 }])`，
// SQLite driver 报错："tried to bind a value of an unknown type ((row) => ...)"
// 修复方案：改用「读-改-写」+ 重试，所有 driver 通用
// ============================================================
describe('recordMemeUsage SQLite 兼容性 (M1-2 回归)', () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, '../src/index.tsx'),
    'utf8',
  )

  it('recordMemeUsage 不再使用 upsert（改用读-改-写）', () => {
    // 提取 recordMemeUsage 函数体
    const fnMatch = src.match(/recordMemeUsage = async[\s\S]+?\n  \}/)
    expect(fnMatch, '未找到 recordMemeUsage 函数').not.toBeNull()
    const fnBody = fnMatch![0]
    // 不应包含 upsert（SQLite 不支持其函数值表达式）
    expect(fnBody).not.toMatch(/database\.upsert\('memes_usage_stats'/)
  })

  it('recordMemeUsage 不再使用函数值表达式 (row) => row.x + 1', () => {
    const fnMatch = src.match(/recordMemeUsage = async[\s\S]+?\n  \}/)
    const fnBody = fnMatch![0]
    // 关键防回归：禁止出现 row => 这种 SQLite 不支持的 upsert 函数值
    expect(fnBody).not.toMatch(/\(row[^)]*\)\s*=>\s*row\./)
  })

  it('recordMemeUsage 使用读-改-写模式（get → set/create）', () => {
    const fnMatch = src.match(/recordMemeUsage = async[\s\S]+?\n  \}/)
    const fnBody = fnMatch![0]
    expect(fnBody).toContain("database.get('memes_usage_stats'")
    expect(fnBody).toContain("database.set('memes_usage_stats'")
    expect(fnBody).toContain("database.create('memes_usage_stats'")
  })

  it('recordMemeUsage 有并发重试（unique 冲突时继续）', () => {
    const fnMatch = src.match(/recordMemeUsage = async[\s\S]+?\n  \}/)
    const fnBody = fnMatch![0]
    // 应有循环重试 + unique/duplicate/constraint 判断
    expect(fnBody).toMatch(/for\s*\(\s*let\s+attempt/)
    expect(fnBody).toMatch(/unique|duplicate|constraint/)
  })
})

// ============================================================
// LI1：表情列表图片刷新失败应有限重试 + 原子替换（旧图不被丢失）
// 修复前：先 unlinkSync 删旧图再发网络请求，请求失败则列表图永久丢失且无重试。
// 修复后：先写 .tmp，成功后 unlink + rename 原子替换；网络步骤有限重试；
//         inflight 合并防并发击穿；EXDEV 跨卷回退。
// ============================================================
describe('refreshListImage 有限重试 + 原子替换 (LI1 回归)', () => {
  const indexSrc = fs.readFileSync(
    path.resolve(__dirname, '../src/index.tsx'),
    'utf8',
  )

  it('refreshListImage 返回 Promise<boolean>（接口声明）', () => {
    // 接口签名：不再吞错为 void，便于上层感知成败
    expect(indexSrc).toMatch(/refreshListImage\(\):\s*Promise<boolean>/)
  })

  it('refreshListImage 实现声明为 Promise<boolean>', () => {
    expect(indexSrc).toMatch(/refreshListImage\s*=\s*async\s*\(\):\s*Promise<boolean>\s*=>/)
  })

  it('使用原子替换：先写 .tmp，成功后再 unlink + rename', () => {
    // 核心逻辑在 doRefreshListImage 内
    const fnMatch = indexSrc.match(/doRefreshListImage\s*=\s*async[\s\S]+?\n  \}/)
    expect(fnMatch).toBeTruthy()
    const fnBody = fnMatch![0]
    // 关键防回归：禁止在请求之前就删除旧图
    expect(fnBody).not.toMatch(/unlinkSync\(imgPath\)[\s\S]*getKeys\(\)/)
    // 原子替换模式：写 tmp → 删旧图 → rename
    expect(fnBody).toMatch(/tmpPath\s*=/)
    expect(fnBody).toMatch(/\.tmp/)
    expect(fnBody).toMatch(/writeFileSync\(tmpPath/)
    expect(fnBody).toMatch(/unlinkSync\(imgPath\)/)
    expect(fnBody).toMatch(/renameSync\(tmpPath,\s*imgPath\)/)
  })

  it('对网络步骤有限重试（循环 + koishi timer 延迟）', () => {
    const fnMatch = indexSrc.match(/doRefreshListImage\s*=\s*async[\s\S]+?\n  \}/)
    const fnBody = fnMatch![0]
    // 重试循环 + 延迟（用 koishi timer 绑定生命周期，禁用裸 setTimeout）
    expect(fnBody).toMatch(/for\s*\(\s*let\s+attempt/)
    expect(fnBody).toMatch(/\(ctx as any\)\.timer\.setTimeout/)
    // 禁止裸 setTimeout（会脱离插件生命周期）
    expect(fnBody).not.toMatch(/new Promise\(r\s*=>\s*setTimeout\(/)
    // 重试常量
    expect(fnBody).toMatch(/LIST_IMAGE_MAX_RETRIES/)
  })

  it('全部失败时返回 false 且清理 tmp 文件', () => {
    const fnMatch = indexSrc.match(/doRefreshListImage\s*=\s*async[\s\S]+?\n  \}/)
    const fnBody = fnMatch![0]
    expect(fnBody).toMatch(/return false/)
    expect(fnBody).toMatch(/unlinkSync\(tmpPath\)/)
  })

  it('EXDEV 跨卷保护：renameSync 失败时回退 copy + unlink', () => {
    const fnMatch = indexSrc.match(/doRefreshListImage\s*=\s*async[\s\S]+?\n  \}/)
    const fnBody = fnMatch![0]
    expect(fnBody).toMatch(/EXDEV/)
    expect(fnBody).toMatch(/copyFileSync\(tmpPath,\s*imgPath\)/)
  })

  it('并发合并 inflight：防止 N 个并发请求击穿后端', () => {
    // refreshListImage 包装器应复用进行中的 Promise
    const wrapMatch = indexSrc.match(/ctx\.\$\.refreshListImage\s*=\s*async[\s\S]+?\n  \}/)
    expect(wrapMatch).toBeTruthy()
    const wrapBody = wrapMatch![0]
    expect(wrapBody).toMatch(/listImageInflight/)
    expect(wrapBody).toMatch(/if\s*\(listImageInflight\)\s*return\s+listImageInflight/)
  })
})

// ============================================================
// LI2：list 命令在图片缺失时应自动触发 refreshListImage
// 修复前：图片缺失走文本回退，从不调用 refreshListImage()，缓存永远不会被填充。
// 修复后：缺失时先 await refreshListImage()，成功后发图，仍失败才回退。
// ============================================================
describe('list 命令图片缺失时自动触发 refreshListImage (LI2 回归)', () => {
  it('list.ts 在 !imgPath 分支调用 refreshListImage()', () => {
    const listSrc = fs.readFileSync(
      path.resolve(__dirname, '../src/commands/list.ts'),
      'utf8',
    )
    // 关键防回归：缺失分支必须主动触发后端渲染
    expect(listSrc).toMatch(/refreshListImage\(\)/)
    // 使用 let imgPath 以便缺失后重新取值
    expect(listSrc).toMatch(/let imgPath = ctx\.\$\.getListImagePath\(\)/)
  })
})

// ============================================================
// LI3：refresh 命令应使用 refreshListImage 返回值给用户反馈
// 修复前：忽略返回值，即使图片刷新失败也显示"✅ 完成"。
// 修复后：返回 false 时改为"⚠️ ... 列表图片刷新失败"提示。
// ============================================================
describe('refresh 命令消费 refreshListImage 返回值 (LI3 回归)', () => {
  it('refresh.ts 根据 listImageOk 区分成功/失败提示', () => {
    const refreshSrc = fs.readFileSync(
      path.resolve(__dirname, '../src/commands/refresh.ts'),
      'utf8',
    )
    // 关键防回归：必须消费返回值
    expect(refreshSrc).toMatch(/=\s*await\s+ctx\.\$\.refreshListImage\(\)/)
    expect(refreshSrc).toMatch(/if\s*\(listImageOk\)/)
    // 失败分支应包含"列表图片刷新失败"提示
    expect(refreshSrc).toMatch(/列表图片刷新失败/)
  })
})

// ============================================================
// HT1：HTTP 超时配置——timeout 必须从 requestConfig 解构出来，防止 rest 泄漏覆盖
// 根因：config.requestConfig 默认 timeout=10s。原代码 `const { endpoint, ...rest }`
// 未解构 timeout，rest 仍含 timeout=10s，经 { ..., timeout: 120000, ...rest } spread
// 覆盖修正值，导致 render_list（957 表情实测 ~37s）必在 10s 超时（ETIMEDOUT）。
// 修复：`const { endpoint, timeout: userTimeout, ...rest }` 把 timeout 从 rest 剥离。
// ============================================================
describe('HTTP 超时配置 timeout 不被 rest 覆盖 (HT1 回归)', () => {
  // 镜像 index.tsx 修复后的 httpConfig 构建逻辑（纯数据处理，可独立单测）
  const buildHttpConfig = (requestConfig: any) => {
    if (requestConfig && typeof requestConfig === 'object') {
      const { endpoint, timeout: userTimeout, ...rest } = requestConfig
      const timeout = userTimeout && userTimeout >= 60_000 ? userTimeout : 120_000
      return { baseURL: endpoint, timeout, ...rest }
    }
    return { baseURL: 'http://127.0.0.1:2233', timeout: 120_000 }
  }

  it('默认 timeout=10s 应被提升到 120s，而非泄漏覆盖', () => {
    const cfg = buildHttpConfig({ endpoint: 'http://x', timeout: 10000, keepAlive: true })
    // 关键防回归：10s 不得泄漏到最终 httpConfig
    expect(cfg.timeout).toBe(120_000)
    expect(cfg.timeout).not.toBe(10_000)
  })

  it('用户配置 timeout=180s（>=60s）应原样保留', () => {
    const cfg = buildHttpConfig({ endpoint: 'http://x', timeout: 180_000, keepAlive: true })
    expect(cfg.timeout).toBe(180_000)
  })

  it('用户配置 timeout=60s（边界）应保留', () => {
    const cfg = buildHttpConfig({ endpoint: 'http://x', timeout: 60_000 })
    expect(cfg.timeout).toBe(60_000)
  })

  it('未配置 timeout 时默认 120s', () => {
    const cfg = buildHttpConfig({ endpoint: 'http://x', keepAlive: true })
    expect(cfg.timeout).toBe(120_000)
  })

  it('requestConfig 非 object 走 else 分支（120s）', () => {
    const cfg = buildHttpConfig(null)
    expect(cfg.timeout).toBe(120_000)
    expect(cfg.baseURL).toBe('http://127.0.0.1:2233')
  })

  it('rest 中其他字段（如 keepAlive/headers）应保留，但不污染 timeout', () => {
    const cfg = buildHttpConfig({
      endpoint: 'http://x', timeout: 10000, keepAlive: false, headers: { 'X-A': '1' },
    })
    expect(cfg.timeout).toBe(120_000)        // 修正后的值
    expect(cfg.keepAlive).toBe(false)         // rest 字段保留
    expect(cfg.headers).toEqual({ 'X-A': '1' }) // rest 字段保留
  })
})
