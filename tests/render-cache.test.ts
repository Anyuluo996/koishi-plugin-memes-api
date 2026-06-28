import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

import { RenderCache, type ImageFetchInfo } from '../src/cache'

// ============================================================
// 辅助：创建临时缓存目录，测试后清理
// ============================================================
let tmpDir: string

const newCache = (opts?: Partial<ConstructorParameters<typeof RenderCache>[0]>) => {
  return new RenderCache(
    {
      enabled: opts?.enabled ?? true,
      ttl: opts?.ttl ?? 1800000,
      maxEntries: opts?.maxEntries ?? 200,
      maxSize: opts?.maxSize ?? 100 * 1024 * 1024,
      persist: opts?.persist ?? true,
    },
    tmpDir,
  )
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-test-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

const u = (id: string): ImageFetchInfo => ({ userId: id })
const s = (src: string): ImageFetchInfo => ({ src })

// ============================================================
// Tests
// ============================================================

describe('RenderCache.computeKey', () => {
  const c = new RenderCache(
    { enabled: true, ttl: 1800000, maxEntries: 200, maxSize: 100 * 1024 * 1024, persist: false },
    '/tmp/unused',
  )

  it('相同输入 → 相同 key（确定性）', () => {
    const k1 = c.computeKey('petpet', [u('123')], ['hi'], { circle: true })
    const k2 = c.computeKey('petpet', [u('123')], ['hi'], { circle: true })
    expect(k1).toBe(k2)
  })

  it('不同 memeKey → 不同 key', () => {
    expect(c.computeKey('petpet', [u('1')], [], {})).not.toBe(c.computeKey('kiss', [u('1')], [], {}))
  })

  it('userId vs src 不同', () => {
    expect(c.computeKey('m', [u('123')], [], {})).not.toBe(c.computeKey('m', [s('123')], [], {}))
  })

  it('不同 userId → 不同 key', () => {
    expect(c.computeKey('m', [u('1')], [], {})).not.toBe(c.computeKey('m', [u('2')], [], {}))
  })

  it('不同 texts → 不同 key', () => {
    expect(c.computeKey('m', [u('1')], ['a'], {})).not.toBe(c.computeKey('m', [u('1')], ['b'], {}))
  })

  it('user_infos 不计入 key（昵称变化不应使缓存失效）', () => {
    const k1 = c.computeKey('petpet', [u('1')], [], { user_infos: [{ name: 'Alice' }] })
    const k2 = c.computeKey('petpet', [u('1')], [], { user_infos: [{ name: 'Bob' }] })
    expect(k1).toBe(k2)
  })

  it('args key 顺序无关（{a:1,b:2} === {b:2,a:1}）', () => {
    const k1 = c.computeKey('m', [u('1')], [], { a: 1, b: 2 })
    const k2 = c.computeKey('m', [u('1')], [], { b: 2, a: 1 })
    expect(k1).toBe(k2)
  })

  it('options 为 undefined 时也能计算', () => {
    expect(() => c.computeKey('m', [u('1')], [], undefined)).not.toThrow()
  })

  it('多张图顺序敏感', () => {
    expect(c.computeKey('m', [u('1'), u('2')], [], {})).not.toBe(c.computeKey('m', [u('2'), u('1')], [], {}))
  })
})

describe('RenderCache LRU 淘汰', () => {
  it('超过 maxEntries 淘汰最旧', () => {
    const c = newCache({ maxEntries: 3, persist: false })
    c.set('a', Buffer.from('1'), 'image/png')
    c.set('b', Buffer.from('2'), 'image/png')
    c.set('c', Buffer.from('3'), 'image/png')
    // touch a，使其成为最新
    c.get('a')
    c.set('d', Buffer.from('4'), 'image/png')  // 应淘汰 b（最旧的未使用）
    expect(c.get('a')).toBeDefined()
    expect(c.get('b')).toBeUndefined()
    expect(c.get('c')).toBeDefined()
    expect(c.get('d')).toBeDefined()
  })

  it('超过 maxSize 淘汰最旧', () => {
    const c = newCache({ maxEntries: 100, maxSize: 10, persist: false })
    c.set('a', Buffer.from('12345'), 'image/png')  // 5 bytes
    c.set('b', Buffer.from('12345'), 'image/png')  // 5 bytes，总 10
    c.set('c', Buffer.from('1'), 'image/png')       // 再加 1，超限，淘汰 a
    expect(c.get('a')).toBeUndefined()
    expect(c.get('b')).toBeDefined()
    expect(c.get('c')).toBeDefined()
  })
})

describe('RenderCache TTL 过期', () => {
  it('过期后 get 返回 undefined', () => {
    const c = newCache({ ttl: 10, persist: false })  // 10ms
    c.set('a', Buffer.from('x'), 'image/png')
    expect(c.get('a')).toBeDefined()
    // 手动把内存条目的时间戳改到很久以前模拟过期
    // （get 已命中会更新 LRU 位置但 ts 不变，用直接等待验证）
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(c.get('a')).toBeUndefined()
        resolve()
      }, 30)
    })
  })
})

describe('RenderCache dedup 并发合并', () => {
  it('并发调用相同 key 只执行 1 次 render', async () => {
    const c = newCache({ persist: false })
    let renderCount = 0
    const render = async () => {
      renderCount++
      // 模拟异步渲染耗时，让其他并发调用有机会进入
      await new Promise((r) => setTimeout(r, 20))
      return { buffer: Buffer.from('img'), mime: 'image/gif' }
    }
    const key = c.computeKey('petpet', [u('1')], [], {})
    // 同时发起 5 个
    const results = await Promise.all([
      c.dedup(key, render),
      c.dedup(key, render),
      c.dedup(key, render),
      c.dedup(key, render),
      c.dedup(key, render),
    ])
    expect(renderCount).toBe(1)  // 只渲染 1 次
    // 所有结果相同
    for (const r of results) {
      expect(r.buffer.toString()).toBe('img')
      expect(r.mime).toBe('image/gif')
    }
  })

  it('命中缓存时不调用 render', async () => {
    const c = newCache({ persist: false })
    const key = c.computeKey('petpet', [u('1')], [], {})
    let renderCount = 0
    await c.dedup(key, async () => {
      renderCount++
      return { buffer: Buffer.from('first'), mime: 'image/png' }
    })
    // 第二次应命中缓存
    const entry = await c.dedup(key, async () => {
      renderCount++
      return { buffer: Buffer.from('second'), mime: 'image/png' }
    })
    expect(renderCount).toBe(1)
    expect(entry.buffer.toString()).toBe('first')  // 返回缓存值
  })

  it('render 抛错不写入缓存，错误传播给所有等待者', async () => {
    const c = newCache({ persist: false })
    const key = c.computeKey('petpet', [u('1')], [], {})
    let renderCount = 0
    const render = async () => {
      renderCount++
      await new Promise((r) => setTimeout(r, 10))
      throw new Error('render failed')
    }
    const results = await Promise.allSettled([
      c.dedup(key, render),
      c.dedup(key, render),
    ])
    expect(renderCount).toBe(1)  // 合并，只调用 1 次
    expect(results[0].status).toBe('rejected')
    expect(results[1].status).toBe('rejected')
    // 错误后缓存为空：再次调用应重新渲染
    let secondCount = 0
    await expect(
      c.dedup(key, async () => {
        secondCount++
        throw new Error('again')
      }),
    ).rejects.toThrow('again')
    expect(secondCount).toBe(1)  // 重新渲染（未缓存错误）
  })

  it('不同 key 并发不合并，各自渲染', async () => {
    const c = newCache({ persist: false })
    let renderCount = 0
    const k1 = c.computeKey('a', [u('1')], [], {})
    const k2 = c.computeKey('b', [u('1')], [], {})
    await Promise.all([
      c.dedup(k1, async () => { renderCount++; return { buffer: Buffer.from('1'), mime: 'image/png' } }),
      c.dedup(k2, async () => { renderCount++; return { buffer: Buffer.from('2'), mime: 'image/png' } }),
    ])
    expect(renderCount).toBe(2)
  })
})

describe('RenderCache disabled 透传', () => {
  it('enabled=false 时每次都调用 render 且不缓存', async () => {
    const c = newCache({ enabled: false, persist: false })
    let renderCount = 0
    const key = c.computeKey('petpet', [u('1')], [], {})
    await c.dedup(key, async () => {
      renderCount++
      return { buffer: Buffer.from('a'), mime: 'image/png' }
    })
    await c.dedup(key, async () => {
      renderCount++
      return { buffer: Buffer.from('b'), mime: 'image/png' }
    })
    expect(renderCount).toBe(2)  // 不缓存，每次都渲染
  })
})

describe('RenderCache 文件持久化', () => {
  it('persist=true 时重启后可从文件回填内存', () => {
    const c1 = newCache({ persist: true })
    const key = c1.computeKey('petpet', [u('1')], ['hi'], {})
    c1.set(key, Buffer.from('persisted'), 'image/gif')
    // 文件应存在
    expect(fs.existsSync(path.join(tmpDir, 'renders', key))).toBe(true)
    expect(fs.existsSync(path.join(tmpDir, 'renders', `${key}.meta`))).toBe(true)

    // 新实例（模拟重启）应能从文件读回
    const c2 = newCache({ persist: true })
    const entry = c2.get(key)
    expect(entry).toBeDefined()
    expect(entry!.buffer.toString()).toBe('persisted')
    expect(entry!.mime).toBe('image/gif')
  })

  it('persist=false 不写文件', () => {
    const c = newCache({ persist: false })
    const key = c.computeKey('petpet', [u('1')], [], {})
    c.set(key, Buffer.from('x'), 'image/png')
    expect(fs.existsSync(path.join(tmpDir, 'renders', key))).toBe(false)
  })

  it('clearDisk 清空文件缓存', () => {
    const c = newCache({ persist: true })
    const key = c.computeKey('petpet', [u('1')], [], {})
    c.set(key, Buffer.from('x'), 'image/png')
    expect(fs.existsSync(path.join(tmpDir, 'renders', key))).toBe(true)
    c.clearDisk()
    expect(fs.existsSync(path.join(tmpDir, 'renders', key))).toBe(false)
  })
})
