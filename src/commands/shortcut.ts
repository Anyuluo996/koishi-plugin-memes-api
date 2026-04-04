import { Context } from 'koishi'
import { Config } from '../config'

export async function apply(ctx: Context, config: Config) {
  // 注意：ctx.$.refreshShortcuts() 的完整实现在 index.tsx 中
  // 此文件保留正则转换等辅助函数供 index.tsx 调用
}
