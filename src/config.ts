import { Schema } from 'koishi'

export enum ListSortBy {
  default = 'default',
  type = 'type',
  key = 'key',
  keywords = 'keywords',
  dateCreated = 'dateCreated',
  dateModified = 'dateModified',
}

// 定义接口
export interface GenerateCommandConfig {
  enableShortcut: boolean
  shortcutUsePrefix?: boolean
  silentShortcut?: boolean
  moreSilent?: boolean
  autoUseDefaultTexts: boolean
  autoUseSenderAvatarWhenOnlyOne: boolean
  autoUseSenderAvatarWhenOneLeft: boolean
}

export interface ListConfig {
  listSortBy: ListSortBy
  listSortReverse: boolean
  listNewTimeDelta: number
  listTextTemplate: string
  listAddCategoryIcon: boolean
}

export interface OtherCommandConfig {
  randomMemeShowInfo: boolean
  generateSubCommandCountToFather: boolean
  randomCommandCountToGenerate: boolean
}

export interface CacheConfig {
  cacheDir: string
  keepCache: boolean
}

export interface RequestConfig {
  requestConfig: string | { endpoint?: string, timeout?: number, keepAlive?: boolean, headers?: Record<string, string> }
  getInfoConcurrency: number
}

// Schema 定义
const shortcutCmdConfig = Schema.object({
  enableShortcut: Schema.boolean().default(true).description('是否注册快捷指令（如：5000兆 ...）'),
}).description('生成指令配置')

const shortcutCmdCfgWithSilent = Schema.intersect([
  shortcutCmdConfig,
  Schema.union([
    Schema.object({
      enableShortcut: Schema.const(true),
      shortcutUsePrefix: Schema.boolean().default(true).description('快捷指令是否需要携带指令前缀'),
      silentShortcut: Schema.boolean().default(false).description('禁用快捷指令的参数错误提示'),
    }),
    Schema.object({}),
  ]),
])

const shortcutCmdCfgWithMoreSilent = Schema.intersect([
  shortcutCmdCfgWithSilent,
  Schema.union([
    Schema.object({
      enableShortcut: Schema.const(true),
      silentShortcut: Schema.const(true).required(),
      moreSilent: Schema.boolean().default(false).description('禁用快捷指令的所有错误提示'),
    }),
    Schema.object({}),
  ]),
])

export const GenerateCommandConfigSchema = Schema.intersect([
  shortcutCmdCfgWithMoreSilent,
  Schema.object({
    autoUseDefaultTexts: Schema.boolean().default(true).description('未提供文字时自动使用默认文字'),
    autoUseSenderAvatarWhenOnlyOne: Schema.boolean().default(true).description('仅需一张图时自动使用发送者头像'),
    autoUseSenderAvatarWhenOneLeft: Schema.boolean().default(true).description('仅缺一张图时自动使用发送者头像'),
  }),
])

export const ListConfigSchema = Schema.object({
  listSortBy: Schema.union(Object.values(ListSortBy)).default(ListSortBy.default)
    .description('表情排序方式'),
  listSortReverse: Schema.boolean().default(false).description('是否倒序排列'),
  listNewTimeDelta: Schema.natural().min(1).default(30).description('新表情标识的时间间隔(天)'),
  listTextTemplate: Schema.string().default('{keywords}').description('列表显示模板 ({index},{key},{keywords}...)'),
  listAddCategoryIcon: Schema.boolean().default(true).description('显示表情类型图标'),
}).description('表情列表配置')

export const OtherCommandConfigSchema = Schema.object({
  randomMemeShowInfo: Schema.boolean().default(true).description('随机表情时显示关键词'),
  generateSubCommandCountToFather: Schema.boolean().default(false).description('计入父指令调用次数'),
  randomCommandCountToGenerate: Schema.boolean().default(false).description('随机表情计入生成指令次数'),
}).description('其他指令配置')

export const CacheConfigSchema = Schema.object({
  cacheDir: Schema.path({
    filters: ['directory'],
    allowCreate: true,
  }).default('cache/memes').description('缓存目录'),
  keepCache: Schema.boolean().default(false).description('重启不清理缓存'),
}).hidden()

// 定义 HttpConfigSchema
export const HttpConfigSchema = Schema.object({
  endpoint: Schema.string().default('http://127.0.0.1:2233').description('要连接的服务器地址。'),

  // 修改 headers 定义：显式声明为 Record<string, string> 的字典，
  // 并且使用 schema.entry 设置键值对的展示标签
  headers: Schema.dict(String)
    .role('table')
    .description('要附加的额外请求头。'),

  timeout: Schema.natural().role('ms').default(10000).description('等待连接建立的最长时间。'),
  keepAlive: Schema.boolean().default(true).description('是否保持连接。'),
}).description('请求详细配置')

export const RequestConfigSchema = Schema.object({
  // 将 union 的顺序调整：把对象类型 HttpConfigSchema 放在后面，
  // 或者如果不常用字符串简写，建议直接移除 union，只保留 HttpConfigSchema 展开显示
  // 为了最佳体验，我们推荐让 "请求配置" 作为一个折叠项或者直接平铺
  requestConfig: Schema.union([
    // 方案 A: 兼容字符串简写（可能会显示下拉选择或者默认折叠）
    // Schema.string().default('http://127.0.0.1:2233').description('仅服务器地址'),

    // 方案 B: 强制展开详细配置 (推荐使用这种，效果和你的截图一致)
    HttpConfigSchema,
  ]).description('API 服务器配置'),

  getInfoConcurrency: Schema.natural().min(1).default(8).description('获取表情信息的并发数。'),
}).description('请求配置')

// 导出主 Config
export type Config = GenerateCommandConfig & ListConfig & OtherCommandConfig & CacheConfig & RequestConfig
export const Config = Schema.intersect([
  GenerateCommandConfigSchema,
  ListConfigSchema,
  OtherCommandConfigSchema,
  CacheConfigSchema,
  RequestConfigSchema,
])
