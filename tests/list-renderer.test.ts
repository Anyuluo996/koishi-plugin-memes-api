import { describe, it, expect } from 'vitest'
import { MemeInfoResponse } from 'meme-generator-api'

import { buildListItems, buildListHtml, sortInfos, isNewMeme } from '../src/list-renderer'

// ============================================================
// 构造 mock MemeInfoResponse
// ============================================================
const mkInfo = (
  key: string,
  keywords: string[],
  opts: { maxImages?: number; dateCreated?: string; dateModified?: string } = {},
): MemeInfoResponse => ({
  key,
  keywords,
  shortcuts: [],
  tags: [],
  date_created: opts.dateCreated ?? '2020-01-01',
  date_modified: opts.dateModified ?? '2020-01-01',
  params_type: {
    min_images: 0,
    max_images: opts.maxImages ?? 0,
    min_texts: 0,
    max_texts: 0,
    default_texts: [],
  },
})

const RECENT = new Date(Date.now() - 10 * 24 * 3600 * 1000).toISOString() // 10 天前（30天内 = new）
const OLD = '2020-01-01'

describe('sortInfos', () => {
  it('按 key 排序', () => {
    const infos = { b: mkInfo('b', ['b']), a: mkInfo('a', ['a']), c: mkInfo('c', ['c']) }
    const sorted = sortInfos(infos, { listSortBy: 'key', listSortReverse: false })
    expect(sorted.map((i) => i.key)).toEqual(['a', 'b', 'c'])
  })

  it('listSortReverse 倒序', () => {
    const infos = { b: mkInfo('b', ['b']), a: mkInfo('a', ['a']) }
    const sorted = sortInfos(infos, { listSortBy: 'key', listSortReverse: true })
    expect(sorted.map((i) => i.key)).toEqual(['b', 'a'])
  })

  it('按 type 排序：图片表情(max_images>0)优先', () => {
    const infos = {
      text_only: mkInfo('text_only', ['纯文字'], { maxImages: 0 }),
      has_image: mkInfo('has_image', ['有图'], { maxImages: 1 }),
    }
    const sorted = sortInfos(infos, { listSortBy: 'type', listSortReverse: false })
    expect(sorted[0].key).toBe('has_image')
  })

  it('不修改原 infos 对象', () => {
    const infos = { b: mkInfo('b', ['b']), a: mkInfo('a', ['a']) }
    const keysBefore = Object.keys(infos)
    sortInfos(infos, { listSortBy: 'key', listSortReverse: false })
    expect(Object.keys(infos)).toEqual(keysBefore) // 原对象 key 顺序不变
  })
})

describe('isNewMeme', () => {
  it('30 天内创建 → true', () => {
    expect(isNewMeme(mkInfo('x', ['x'], { dateCreated: RECENT }), 30)).toBe(true)
  })

  it('超过 30 天 → false', () => {
    expect(isNewMeme(mkInfo('x', ['x'], { dateCreated: OLD }), 30)).toBe(false)
  })

  it('无 date_created → false（不崩）', () => {
    const info = mkInfo('x', ['x']) as any
    info.date_created = undefined
    expect(isNewMeme(info, 30)).toBe(false)
  })
})

describe('buildListItems', () => {
  const cfg = (overrides: any = {}) => ({
    listSortBy: 'default',
    listSortReverse: false,
    listNewTimeDelta: 30,
    ...overrides,
  })

  it('合并多关键词为单条（/ 连接）', () => {
    const infos = { rub: mkInfo('rub', ['贴', '贴贴', '蹭', '蹭蹭']) }
    const items = buildListItems(infos, cfg())
    expect(items).toHaveLength(1)
    expect(items[0].text).toBe('贴 / 贴贴 / 蹭 / 蹭蹭')
  })

  it('字号分级：1个→s1，2-3个→s2，4+→s3', () => {
    const infos = {
      one: mkInfo('one', ['单']),
      two: mkInfo('two', ['二', '三']),
      four: mkInfo('four', ['四', '五', '六', '七']),
    }
    const items = buildListItems(infos, cfg())
    const byKey = Object.fromEntries(items.map((i) => [i.text.split(' / ')[0], i]))
    expect(byKey['单'].sizeClass).toBe('s1')
    expect(byKey['二'].sizeClass).toBe('s2')
    expect(byKey['四'].sizeClass).toBe('s3')
  })

  it('新增标签：30天内 → isNew=true', () => {
    const infos = {
      new_meme: mkInfo('new_meme', ['新'], { dateCreated: RECENT }),
      old_meme: mkInfo('old_meme', ['旧'], { dateCreated: OLD }),
    }
    const items = buildListItems(infos, cfg())
    const byText = Object.fromEntries(items.map((i) => [i.text, i]))
    expect(byText['新'].isNew).toBe(true)
    expect(byText['旧'].isNew).toBe(false)
  })

  it('空 infos → 空数组（不崩）', () => {
    expect(buildListItems({}, cfg())).toEqual([])
  })
})

describe('buildListHtml', () => {
  it('生成完整 HTML 文档', () => {
    const items = buildListItems({ x: mkInfo('x', ['测试']) }, { listSortBy: 'default', listSortReverse: false, listNewTimeDelta: 30 })
    const html = buildListHtml(items)
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true)
    expect(html.includes('</html>')).toBe(true)
  })

  it('包含分级字号 class s1/s2/s3', () => {
    const items = [
      { text: '单', isNew: false, sizeClass: 's1' as const },
      { text: '二 / 三', isNew: false, sizeClass: 's2' as const },
      { text: '四 / 五 / 六 / 七', isNew: false, sizeClass: 's3' as const },
    ]
    const html = buildListHtml(items)
    expect(html).toMatch(/class="kw s1"/)
    expect(html).toMatch(/class="kw s2"/)
    expect(html).toMatch(/class="kw s3"/)
  })

  it('统一 48px 卡片高度', () => {
    const html = buildListHtml([{ text: 'x', isNew: false, sizeClass: 's1' as const }])
    expect(html).toMatch(/height:48px/)
  })

  it('新增条目带 new class + ✨', () => {
    const html = buildListHtml([{ text: '新表情', isNew: true, sizeClass: 's1' as const }])
    expect(html).toMatch(/class="kw s1 new"/)
    expect(html).toMatch(/\\2728|✨/) // ✨ 的 CSS content 转义或原文
  })

  it('HTML 转义关键词文本（防 XSS）', () => {
    const html = buildListHtml([{ text: '<script>x</script>', isNew: false, sizeClass: 's1' as const }])
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>x</script>')
  })

  it('每列 100 个：101 条 → 2 列', () => {
    const items = Array.from({ length: 101 }, (_, i) => ({
      text: `m${i}`, isNew: false, sizeClass: 's1' as const,
    }))
    const html = buildListHtml(items)
    // 列数 = ceil(101/100) = 2，header 文案应显示"2 列"
    expect(html).toMatch(/2 列/)
  })

  it('空列表不崩（至少 1 列）', () => {
    const html = buildListHtml([])
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true)
  })
})
