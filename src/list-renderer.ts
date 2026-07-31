import { MemeInfoResponse } from 'meme-generator-api'

// ============================================================
// 客户端表情列表图渲染（纯函数，无副作用，可单测）
//
// 用途：替代后端 /memes/render_list（957 表情实测 37s）。
// 用 ctx.$.infos（初始化后已就绪）构建 HTML，由 puppeteer 截图（~2s）。
// 注意：故意不 import koishi 或 ./config（避免在 vitest 下加载整个 koishi 框架）。
//       排序字段用本地类型别名，与 config.ListSortBy 枚举值字符串兼容。
// ============================================================

/** 每列条目数（用户期望"每列 100 个"） */
const PER_COL = 100
/** 每列宽（px）—— 容纳多关键词合并后的长文本 */
const COL_WIDTH = 220
/** 列间距（px） */
const COL_GAP = 12
/** 一天的毫秒数（等价 koishi 的 Time.day，避免引入 koishi 运行时依赖） */
const NEW_DELTA_UNIT = 24 * 60 * 60 * 1000

/**
 * 排序方式（与 config.ListSortBy 枚举值一一对应，字符串兼容）。
 * 不直接引用 config 模块以保持本文件可独立单测。
 */
export type ListSortByValue = 'default' | 'type' | 'key' | 'keywords' | 'dateCreated' | 'dateModified'

/** 列表条目：一个表情一条（多关键词合并） */
export interface ListItem {
  /** 合并后的触发词文本，如 "贴 / 贴贴 / 蹭 / 蹭蹭" */
  text: string
  /** 是否 30 天内新增 */
  isNew: boolean
  /** 字号分级（由关键词数量决定） */
  sizeClass: 's1' | 's2' | 's3'
}

/**
 * 排序 infos（共享比较器，供 buildListItems 与 list.ts 文本回退复用）。
 * 返回新数组，不修改入参。
 */
export function sortInfos(
  infos: Record<string, MemeInfoResponse>,
  config: { listSortBy: ListSortByValue; listSortReverse: boolean },
): MemeInfoResponse[] {
  const hasImage = (info: MemeInfoResponse) => info.params_type.max_images > 0
  const compareStr = (s1: string, s2: string) =>
    config.listSortReverse ? s2.localeCompare(s1) : s1.localeCompare(s2)
  const compareNumber = (n1: number, n2: number) =>
    config.listSortReverse ? n2 - n1 : n1 - n2
  const compareStrDate = (s1: string, s2: string) =>
    compareNumber(new Date(s1).getTime(), new Date(s2).getTime())
  const compareType = (info1: MemeInfoResponse, info2: MemeInfoResponse) =>
    compareNumber(hasImage(info1) ? 0 : 1, hasImage(info2) ? 0 : 1) // image meme first

  const infoSorter = (info1: MemeInfoResponse, info2: MemeInfoResponse) => {
    switch (config.listSortBy) {
      case 'key':
        return compareStr(info1.key, info2.key)
      case 'type':
        return compareType(info1, info2)
      case 'keywords':
        return compareStr(info1.keywords[0], info2.keywords[0])
      case 'dateCreated':
        return compareStrDate(info1.date_created, info2.date_created)
      case 'dateModified':
        return compareStrDate(info1.date_modified, info2.date_modified)
      default:
        return 0
    }
  }

  return Object.values(infos).sort(infoSorter)
}

/** 判断 info 是否属于"新增"（date_created 在 listNewTimeDelta 天内） */
export function isNewMeme(
  info: MemeInfoResponse,
  listNewTimeDelta: number,
  now = Date.now(),
): boolean {
  if (!info.date_created) return false
  return now - new Date(info.date_created).getTime() <= listNewTimeDelta * NEW_DELTA_UNIT
}

/**
 * 从 infos 构建排好序的列表条目。
 * 复用原 list.ts 的 infoSorter + 'new' 标签逻辑，并加上：
 *   - 关键词合并（每表情一条，join(' / ')）
 *   - 字号分级（kwCount<=1→s1, <=3→s2, 4+→s3）
 *
 * 纯函数：相同输入 → 相同输出，无副作用，便于单测。
 */
export function buildListItems(
  infos: Record<string, MemeInfoResponse>,
  config: { listSortBy: ListSortByValue; listSortReverse: boolean; listNewTimeDelta: number },
): ListItem[] {
  return sortInfos(infos, config).map((info) => {
    const kws = info.keywords || []
    const sizeClass: ListItem['sizeClass'] =
      kws.length <= 1 ? 's1' : kws.length <= 3 ? 's2' : 's3'
    return {
      text: kws.join(' / '),
      isNew: isNewMeme(info, config.listNewTimeDelta),
      sizeClass,
    }
  })
}

/**
 * 把列表条目渲染成完整 HTML 字符串（供 puppeteer.setContent 截图）。
 *
 * 样式（用户已确认）：
 *   - 白底黑字，Microsoft YaHei
 *   - 每列 PER_COL 个，flex 横向，列宽 COL_WIDTH
 *   - 统一 48px 卡片高度，单行截断（-webkit-line-clamp:1）
 *   - 字号分级 .s1=16px .s2=13px .s3=11px
 *   - 卡片浅灰底；新增词浅红底 + 红字 + ✨
 *   - deviceScaleFactor 由调用方控制，HTML 不含
 */
export function buildListHtml(items: ListItem[]): string {
  const colCount = Math.max(1, Math.ceil(items.length / PER_COL))
  const totalWidth = colCount * COL_WIDTH + (colCount - 1) * COL_GAP + 40

  // 按 PER_COL 切列
  const cols: ListItem[][] = []
  for (let i = 0; i < items.length; i += PER_COL) {
    cols.push(items.slice(i, i + PER_COL))
  }

  const escapeHtml = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

  const colHtml = cols
    .map(
      (col) =>
        `<div class="col">${col
          .map(
            (it) =>
              `<div class="kw ${it.sizeClass}${it.isNew ? ' new' : ''}">${escapeHtml(it.text)}</div>`,
          )
          .join('')}</div>`,
    )
    .join('')

  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:#ffffff; font-family:"Microsoft YaHei","PingFang SC",sans-serif; padding:20px; color:#000; width:${totalWidth}px; }
  .header { margin-bottom:14px; padding-bottom:10px; border-bottom:2px solid #000; }
  .header h1 { font-size:20px; color:#000; font-weight:700; }
  .header span { font-size:13px; color:#666; }
  .cols { display:flex; flex-direction:row; gap:${COL_GAP}px; }
  .col { width:${COL_WIDTH}px; display:flex; flex-direction:column; }
  .kw {
    color:#000; line-height:1.3;
    height:48px; padding:6px 8px; margin-bottom:3px;
    overflow:hidden; display:-webkit-box; -webkit-line-clamp:1; -webkit-box-orient:vertical;
    word-break:break-word; background:#f7f7f7; border-radius:5px;
  }
  .kw.s1 { font-size:16px; }
  .kw.s2 { font-size:13px; }
  .kw.s3 { font-size:11px; }
  .kw.new { color:#cc0000; font-weight:600; background:#fff5f5; }
  .kw.new::after { content:" \\2728"; font-size:11px; }
</style></head><body>
  <div class="header"><h1>表情包列表</h1><span>共 ${items.length} 个表情 · ${colCount} 列（每列 ${PER_COL}）</span></div>
  <div class="cols">${colHtml}</div>
</body></html>`
}
