import { createHash } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'

// 图片描述符：来自 generate.ts 的 ImageFetchInfo
// - { userId } 渲染前即可确定（映射到头像 URL）
// - { src }    直接是图片 URL
export type ImageFetchInfo = { src: string } | { userId: string }

export interface RenderCacheOptions {
  enabled: boolean
  ttl: number           // 毫秒
  maxEntries: number
  maxSize: number       // 字节
  persist: boolean      // 持久化到文件系统
}

export interface CacheEntry {
  buffer: Buffer
  mime: string
  ts: number
  size: number
}

/**
 * 稳定序列化 args：递归对对象 key 排序，并剔除 user_infos
 * （user_infos 是后端填入的昵称/性别，渲染前未知，不计入缓存键）
 */
function stableStringify(value: any, excludeKeys: Set<string> = new Set(['user_infos'])): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) {
    return '[' + value.map((v) => stableStringify(v, excludeKeys)).join(',') + ']'
  }
  const keys = Object.keys(value).filter((k) => !excludeKeys.has(k)).sort()
  return '{' + keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k], excludeKeys)}`).join(',') + '}'
}

/**
 * 计算图片描述符 token：渲染前已知信息，无需下载
 * userId 稳定映射到头像 URL（q.qlogo.cn?dst_uin=${userId}）
 */
function imageToken(info: ImageFetchInfo): string {
  return 'userId' in info ? `u:${info.userId}` : `s:${info.src}`
}

/**
 * 表情渲染结果缓存。
 *
 * 双层结构：
 *  - Layer 1 内存 LRU（Map 插入序实现，双限：条数 + 字节）
 *  - Layer 2 文件系统持久化（重启可复用，受 keepCache 控制）
 *  - 并发合并（inflight Map）：群发 N 个相同请求只渲染 1 次
 *
 * fast 模式：用 userId/src（而非图片字节）当 key，可在下载前命中，跳过下载+渲染。
 */
export interface RenderCacheStats {
  enabled: boolean
  hits: number
  misses: number
  deduped: number          // 并发合并次数（命中 inflight）
  hitRate: number          // 命中率 = hits / (hits + misses)
  entries: number          // 当前内存条目数
  sizeBytes: number        // 当前内存总字节
  persist: boolean
}

export class RenderCache {
  private mem = new Map<string, CacheEntry>()   // Map 天然插入序 → 做 LRU
  private inflight = new Map<string, Promise<CacheEntry>>()
  private memBytes = 0
  private readonly dir: string
  // 统计计数器
  private hits = 0
  private misses = 0
  private deduped = 0

  constructor(
    private readonly opts: RenderCacheOptions,
    cacheDir: string,
  ) {
    this.dir = path.join(cacheDir, 'renders')
    if (opts.enabled && opts.persist) {
      try {
        fs.mkdirSync(this.dir, { recursive: true })
      } catch {
        // 目录创建失败不致命：降级为纯内存缓存
      }
    }
  }

  /** 缓存统计快照 */
  getStats(): RenderCacheStats {
    const total = this.hits + this.misses
    return {
      enabled: this.opts.enabled,
      hits: this.hits,
      misses: this.misses,
      deduped: this.deduped,
      hitRate: total === 0 ? 0 : this.hits / total,
      entries: this.mem.size,
      sizeBytes: this.memBytes,
      persist: this.opts.persist,
    }
  }

  /** 重置统计计数器（不清缓存数据） */
  resetStats(): void {
    this.hits = 0
    this.misses = 0
    this.deduped = 0
  }

  /** 计算缓存键（fast 模式，下载前即可计算） */
  computeKey(
    memeKey: string,
    imageInfos: ImageFetchInfo[],
    texts: string[],
    options: Record<string, unknown> | undefined,
  ): string {
    const img = imageInfos.map(imageToken).join('|')
    const args = stableStringify(options ?? {})
    const raw = `${memeKey}\0${img}\0${JSON.stringify(texts)}\0${args}`
    return createHash('sha256').update(raw).digest('hex').slice(0, 32)
  }

  /**
   * 并发合并：相同 key 的并发渲染共用一个 Promise。
   * 命中缓存直接返回；未命中则执行 renderFn，成功后写入缓存。
   * renderFn 抛错不缓存，rejection 传播给所有等待者。
   */
  async dedup(
    key: string,
    render: () => Promise<{ buffer: Buffer; mime: string }>,
  ): Promise<CacheEntry> {
    if (!this.opts.enabled) {
      const r = await render()
      return { buffer: r.buffer, mime: r.mime, ts: Date.now(), size: r.buffer.length }
    }

    const hit = this.get(key)
    if (hit) {
      this.hits++
      return hit
    }

    let p = this.inflight.get(key)
    if (!p) {
      // 真正未命中：创建 inflight 并渲染（只有这条路径算 miss）
      this.misses++
      p = (async () => {
        const r = await render()
        return this.set(key, r.buffer, r.mime)
      })()
      p.catch(() => { /* 错误已通过 rejection 传播 */ }).finally(() => {
        this.inflight.delete(key)
      })
      this.inflight.set(key, p)
    } else {
      // 命中正在进行的渲染：并发合并（不算 miss，已由首个请求计 miss）
      this.deduped++
    }
    return p
  }

  /** 查；返回 undefined 表示未命中 */
  get(key: string): CacheEntry | undefined {
    if (!this.opts.enabled) return

    const now = Date.now()

    // Layer 1 内存
    const m = this.mem.get(key)
    if (m) {
      if (now - m.ts < this.opts.ttl) return this.touch(key, m)
      // 过期：淘汰
      this.mem.delete(key)
      this.memBytes -= m.size
    }

    // Layer 2 文件
    if (this.opts.persist) {
      const entry = this.readFromDisk(key, now)
      if (entry) return this.set(key, entry.buffer, entry.mime, entry.ts)
    }
    return undefined
  }

  /** 写入缓存（含 LRU 淘汰 + 可选持久化） */
  set(key: string, buffer: Buffer, mime: string, ts?: number): CacheEntry {
    const entry: CacheEntry = { buffer, mime, ts: ts ?? Date.now(), size: buffer.length }
    if (!this.opts.enabled) return entry

    this.evict(entry.size)
    this.mem.set(key, entry)
    this.memBytes += entry.size

    if (this.opts.persist) {
      this.writeToDisk(key, entry)
    }
    return entry
  }

  /** 清空内存缓存（文件缓存保留，受 keepCache 控制） */
  clearMemory(): void {
    this.mem.clear()
    this.memBytes = 0
  }

  /** 清空文件缓存目录 */
  clearDisk(): void {
    if (!this.opts.persist) return
    try {
      if (fs.existsSync(this.dir)) {
        for (const name of fs.readdirSync(this.dir)) {
          fs.unlinkSync(path.join(this.dir, name))
        }
      }
    } catch {
      // 清理失败不致命
    }
  }

  // ===== 内部方法 =====

  private fp(key: string): string {
    return path.join(this.dir, key)
  }

  private metaFp(key: string): string {
    return path.join(this.dir, `${key}.meta`)
  }

  /** LRU touch：删除再插入，移到末尾（最新） */
  private touch(key: string, entry: CacheEntry): CacheEntry {
    this.mem.delete(key)
    this.mem.set(key, entry)
    return entry
  }

  /** 主动淘汰：保证容量不超限（双限：条数 + 字节） */
  private evict(incoming: number): void {
    while (
      (this.opts.maxSize > 0 && this.memBytes + incoming > this.opts.maxSize) ||
      (this.opts.maxEntries > 0 && this.mem.size >= this.opts.maxEntries)
    ) {
      const oldest = this.mem.keys().next().value as string | undefined
      if (oldest === undefined) break
      const e = this.mem.get(oldest)
      this.mem.delete(oldest)
      if (e) this.memBytes -= e.size
    }
  }

  private writeToDisk(key: string, entry: CacheEntry): void {
    try {
      fs.writeFileSync(this.fp(key), entry.buffer)
      fs.writeFileSync(this.metaFp(key), `${entry.mime}\n${entry.ts}`)
    } catch {
      // 写盘失败不致命：降级为纯内存
    }
  }

  private readFromDisk(key: string, now: number): CacheEntry | undefined {
    try {
      const metaRaw = fs.readFileSync(this.metaFp(key), 'utf8').split('\n')
      const mime = metaRaw[0] || 'image/png'
      const ts = metaRaw[1] ? parseInt(metaRaw[1], 10) : now
      if (now - ts >= this.opts.ttl) return undefined
      const buffer = fs.readFileSync(this.fp(key))
      return { buffer, mime, ts, size: buffer.length }
    } catch {
      return undefined
    }
  }
}
