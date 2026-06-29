import { Command, Context } from 'koishi'

import { Config } from '../config'
import * as Generate from './generate'
import * as Info from './info'
import * as List from './list'
import * as Random from './random'
import * as Shortcut from './shortcut'
import * as Blacklist from './blacklist'
import * as Refresh from './refresh'
import * as Stats from './stats'
import * as Cache from './cache'
import * as Guild from './guild'
import * as UserBlock from './user-block'

declare module '../index' {
  interface MemeInternal {
    cmd?: any
  }
}

export async function apply(ctx: Context, config: Config) {
  ctx.$.cmd = ctx.command('meme')
  await Generate.apply(ctx, config)
  await Shortcut.apply(ctx, config)
  await Random.apply(ctx, config)
  await List.apply(ctx, config)
  await Info.apply(ctx, config)
  await Blacklist.apply(ctx, config)
  await Refresh.apply(ctx, config)
  await Stats.apply(ctx, config)
  await Cache.apply(ctx, config)
  await Guild.apply(ctx, config)
  await UserBlock.apply(ctx, config)
}
