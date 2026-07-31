import { Context, h } from 'koishi'
import * as fs from 'fs'
import {
  MemeKeyWithProperties,
  MemeKeyWithPropertiesLabel,
} from 'meme-generator-api'

import { Config } from '../config'
import { sortInfos, isNewMeme } from '../list-renderer'

export async function apply(ctx: Context, config: Config) {
  const subCmd = ctx.$.cmd.subcommand('.list')

  if (config.enableShortcut) {
    subCmd.alias('表情包制作').alias('表情列表').alias('头像表情包').alias('文字表情包')
  }

  subCmd.action(async ({ session }) => {
    if (!session) return

    // 直接发送缓存的表情列表图片
    let imgPath = ctx.$.getListImagePath()
    if (!imgPath) {
      // 图片未生成（如启动时刷新失败）：自动触发后端渲染并缓存，避免用户陷入"永远没有列表图"。
      // refreshListImage 内部含有限重试；这里同步等待，成功后本次即可发图，仍失败则回退到文本列表。
      await ctx.$.refreshListImage()
      imgPath = ctx.$.getListImagePath()
    }
    if (imgPath) {
      const buf = fs.readFileSync(imgPath)
      // h.image(Buffer, mimeString) 会自动转为 data:image/png;base64,... 格式
      return h.image(buf, 'image/png')
    }

    // 图片未生成时，回退到旧的文本列表（后端 renderList）
    // 排序/标签逻辑复用 list-renderer，消除重复
    const memeList: MemeKeyWithProperties[] = sortInfos(ctx.$.infos, config).map((v) => {
      const labels: MemeKeyWithPropertiesLabel[] = []
      if (isNewMeme(v, config.listNewTimeDelta)) labels.push('new')
      return { meme_key: v.key, disabled: false, labels }
    })

    const img = await ctx.$.api.renderList({
      meme_list: memeList,
      text_template: config.listTextTemplate,
      add_category_icon: config.listAddCategoryIcon,
    })
    return session.i18n(
      config.enableShortcut ? 'memes-api.list.tip' : 'memes-api.list.tip-no-shortcut',
      [h.image(await img.arrayBuffer(), img.type)],
    )
  })
}
