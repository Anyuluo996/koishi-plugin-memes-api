import { Context, Logger } from 'koishi'
import { Config } from '../config'

const logger = new Logger('memes-cache')

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function formatPercent(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`
}

export async function apply(ctx: Context, config: Config) {
  // 缓存统计命令
  const cacheCmd = ctx.$.cmd.subcommand('.cache', '查看表情包缓存统计信息')
  if (config.enableShortcut) {
    cacheCmd.alias('缓存统计')
    cacheCmd.alias('缓存信息')
  }

  cacheCmd.action(async ({ session }) => {
    if (!session) return

    try {
      const stats = ctx.$.renderCache.getStats()

      if (!stats.enabled) {
        await session.send('📊 渲染缓存已禁用')
        return
      }

      const totalRequests = stats.hits + stats.misses
      const avatarTotal = stats.avatarHits + stats.avatarMisses
      const lines = [
        '📊 渲染缓存统计',
        '━━━━━━━━━━━━━━━━━━',
        `状态: ${stats.enabled ? '✅ 已启用' : '❌ 已禁用'}`,
        `持久化: ${stats.persist ? '✅ 是' : '❌ 否'}`,
        '',
        '⚡ 渲染性能',
        `总请求: ${totalRequests}`,
        `命中: ${stats.hits} | 未命中: ${stats.misses}`,
        `命中率: ${formatPercent(stats.hitRate)}`,
        `并发合并: ${stats.deduped} 次`,
        `条目数: ${stats.entries} | 占用: ${formatBytes(stats.sizeBytes)}`,
        '',
        '🖼️ 头像下载缓存',
        `总请求: ${avatarTotal}`,
        `命中: ${stats.avatarHits} | 未命中: ${stats.avatarMisses}`,
        `命中率: ${formatPercent(stats.avatarHitRate)}`,
        `条目数: ${stats.avatarEntries} | 占用: ${formatBytes(stats.avatarSizeBytes)}`,
      ]

      await session.send(lines.join('\n'))
    } catch (error) {
      logger.warn('获取缓存统计失败', error)
      await session.send(`❌ 获取缓存统计失败: ${(error as Error).message}`)
    }
  })
}
