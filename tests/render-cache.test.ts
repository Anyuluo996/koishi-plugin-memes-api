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

describe('RenderCache getStats 统计', () => {
  it('初始统计全为 0', () => {
    const c = newCache({ persist: false })
    const s = c.getStats()
    expect(s.enabled).toBe(true)
    expect(s.hits).toBe(0)
    expect(s.misses).toBe(0)
    expect(s.deduped).toBe(0)
    expect(s.hitRate).toBe(0)
    expect(s.entries).toBe(0)
    expect(s.sizeBytes).toBe(0)
  })

  it('dedup 正确累计 hit/miss', async () => {
    const c = newCache({ persist: false })
    const key = c.computeKey('petpet', [u('1')], [], {})
    const render = async () => ({ buffer: Buffer.from('img'), mime: 'image/png' })

    // 第一次：miss
    await c.dedup(key, render)
    expect(c.getStats().misses).toBe(1)
    expect(c.getStats().hits).toBe(0)

    // 第二次：hit
    await c.dedup(key, render)
    expect(c.getStats().hits).toBe(1)
    expect(c.getStats().hitRate).toBeCloseTo(0.5)
  })

  it('并发调用累计 deduped（命中 inflight）', async () => {
    const c = newCache({ persist: false })
    const key = c.computeKey('petpet', [u('1')], [], {})
    const render = async () => {
      await new Promise((r) => setTimeout(r, 20))
      return { buffer: Buffer.from('img'), mime: 'image/png' }
    }
    // 5 个并发：第一个创建 inflight（miss），其余命中 inflight（deduped）
    // 由于 inflight.set 与后续 inflight.get 之间有微小竞态，
    // misses 可能略大于 1，但 deduped 一定 ≥1，hits=0，最终只渲染 1 次
    await Promise.all([
      c.dedup(key, render),
      c.dedup(key, render),
      c.dedup(key, render),
      c.dedup(key, render),
      c.dedup(key, render),
    ])
    const s = c.getStats()
    expect(s.hits).toBe(0)
    expect(s.entries).toBe(1)            // 只渲染 1 次
    expect(s.misses).toBeGreaterThanOrEqual(1)
    expect(s.misses).toBeLessThanOrEqual(5)
    expect(s.deduped).toBeGreaterThan(0) // 至少有合并
    // 总请求数 = hits + misses + deduped（hit 不重复合并）
    expect(s.hits + s.misses + s.deduped).toBe(5)
  })

  it('entries 和 sizeBytes 反映内存占用', async () => {
    const c = newCache({ persist: false })
    const k1 = c.computeKey('a', [u('1')], [], {})
    await c.dedup(k1, async () => ({ buffer: Buffer.from('12345'), mime: 'image/png' }))
    let s = c.getStats()
    expect(s.entries).toBe(1)
    expect(s.sizeBytes).toBe(5)

    const k2 = c.computeKey('b', [u('1')], [], {})
    await c.dedup(k2, async () => ({ buffer: Buffer.from('abc'), mime: 'image/png' }))
    s = c.getStats()
    expect(s.entries).toBe(2)
    expect(s.sizeBytes).toBe(8)
  })

  it('resetStats 清零计数器但保留缓存数据', async () => {
    const c = newCache({ persist: false })
    const key = c.computeKey('petpet', [u('1')], [], {})
    await c.dedup(key, async () => ({ buffer: Buffer.from('x'), mime: 'image/png' }))
    expect(c.getStats().misses).toBe(1)

    c.resetStats()
    const s = c.getStats()
    expect(s.hits).toBe(0)
    expect(s.misses).toBe(0)
    expect(s.entries).toBe(1)  // 数据保留
  })

  it('disabled 时 dedup 不计入统计', async () => {
    const c = newCache({ enabled: false, persist: false })
    const key = c.computeKey('petpet', [u('1')], [], {})
    await c.dedup(key, async () => ({ buffer: Buffer.from('x'), mime: 'image/png' }))
    await c.dedup(key, async () => ({ buffer: Buffer.from('x'), mime: 'image/png' }))
    const s = c.getStats()
    expect(s.enabled).toBe(false)
    expect(s.hits).toBe(0)
    expect(s.misses).toBe(0)
  })
})

describe('RenderCache 头像下载缓存 getAvatar', () => {
  const mkBlob = (size: number) => new Blob([new Uint8Array(size)])

  it('首次下载算 miss，第二次命中算 hit', async () => {
    const c = newCache({ persist: false })
    let downloadCount = 0
    const fetcher = async () => { downloadCount++; return mkBlob(100) }
    await c.getAvatar('http://q.qlogo.cn/u1', fetcher)
    await c.getAvatar('http://q.qlogo.cn/u1', fetcher)
    expect(downloadCount).toBe(1)              // 只下载 1 次
    const s = c.getStats()
    expect(s.avatarHits).toBe(1)
    expect(s.avatarMisses).toBe(1)
    expect(s.avatarHitRate).toBeCloseTo(0.5)
  })

  it('不同 url 不命中', async () => {
    const c = newCache({ persist: false })
    let downloadCount = 0
    const fetcher = async () => { downloadCount++; return mkBlob(100) }
    await c.getAvatar('http://q.qlogo.cn/u1', fetcher)
    await c.getAvatar('http://q.qlogo.cn/u2', fetcher)
    expect(downloadCount).toBe(2)
    expect(c.getStats().avatarMisses).toBe(2)
    expect(c.getStats().avatarHits).toBe(0)
  })

  it('返回缓存的同一个 Blob 实例（不重复下载）', async () => {
    const c = newCache({ persist: false })
    const blob = mkBlob(100)
    const b1 = await c.getAvatar('http://q.qlogo.cn/u1', async () => blob)
    const b2 = await c.getAvatar('http://q.qlogo.cn/u1', async () => mkBlob(100))
    expect(b1).toBe(b2)  // 第二次应返回缓存的第一个 blob，不调 fetcher
  })

  it('TTL 过期后重新下载', async () => {
    const c = newCache({ ttl: 10, persist: false })  // 10ms
    let downloadCount = 0
    const fetcher = async () => { downloadCount++; return mkBlob(100) }
    await c.getAvatar('http://q.qlogo.cn/u1', fetcher)
    await new Promise((r) => setTimeout(r, 30))  // 等 TTL 过期
    await c.getAvatar('http://q.qlogo.cn/u1', fetcher)
    expect(downloadCount).toBe(2)  // 过期后重新下载
  })

  it('LRU 淘汰：超过 maxSize 淡出最旧', async () => {
    const c = newCache({ maxSize: 250, persist: false })  // 只能装 2 个 100B
    await c.getAvatar('http://q.qlogo.cn/u1', async () => mkBlob(100))
    await c.getAvatar('http://q.qlogo.cn/u2', async () => mkBlob(100))
    await c.getAvatar('http://q.qlogo.cn/u3', async () => mkBlob(100))  // 挤掉 u1
    const s = c.getStats()
    expect(s.avatarEntries).toBeLessThanOrEqual(2)
    expect(s.avatarSizeBytes).toBeLessThanOrEqual(250)
  })

  it('disabled 时透传不缓存不计统计', async () => {
    const c = newCache({ enabled: false, persist: false })
    let downloadCount = 0
    const fetcher = async () => { downloadCount++; return mkBlob(100) }
    await c.getAvatar('http://q.qlogo.cn/u1', fetcher)
    await c.getAvatar('http://q.qlogo.cn/u1', fetcher)
    expect(downloadCount).toBe(2)  // 不缓存，每次都下载
    const s = c.getStats()
    expect(s.avatarHits).toBe(0)
    expect(s.avatarMisses).toBe(0)
  })
})

describe('RenderCache URL 规范化 normalizeSrc', () => {
  const c = new RenderCache(
    { enabled: true, ttl: 1800000, maxEntries: 200, maxSize: 100 * 1024 * 1024, persist: false },
    '/tmp/unused',
  )

  it('去掉易变参数（time/sig/nonce）后 key 一致', () => {
    const k1 = c.computeKey('m', [s('https://cdn.qq.com/img/abc.png?time=123&sig=xyz')], [], {})
    const k2 = c.computeKey('m', [s('https://cdn.qq.com/img/abc.png?time=456&sig=def')], [], {})
    expect(k1).toBe(k2)  // 规范化后命中
  })

  it('保留稳定的 query 参数（如 spec=640）', () => {
    const k1 = c.computeKey('m', [s('https://q.qlogo.cn/headimg?dst_uin=1&spec=640')], [], {})
    const k2 = c.computeKey('m', [s('https://q.qlogo.cn/headimg?dst_uin=1&spec=640&time=999')], [], {})
    expect(k1).toBe(k2)  // 去掉 time，保留 spec=640，命中
  })

  it('不同路径仍然不命中', () => {
    const k1 = c.computeKey('m', [s('https://cdn.qq.com/img/a.png')], [], {})
    const k2 = c.computeKey('m', [s('https://cdn.qq.com/img/b.png')], [], {})
    expect(k1).not.toBe(k2)
  })

  it('非 URL 的 src 原样保留', () => {
    const k1 = c.computeKey('m', [s('not-a-url-abc')], [], {})
    const k2 = c.computeKey('m', [s('not-a-url-abc')], [], {})
    expect(k1).toBe(k2)
  })

  it('userId 不受规范化影响', () => {
    const k1 = c.computeKey('m', [u('123')], [], {})
    const k2 = c.computeKey('m', [u('123')], [], {})
    expect(k1).toBe(k2)
  })
})

