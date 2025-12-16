// 扩展 Koishi 类型定义以解决编译错误

declare module 'koishi' {
  interface Context {
    logger: any
    i18n: any
    isolate: any
    set: any
    inject: any
    model: any
    http: any
    database: any
    timer: any
    root: any
    middleware: any
    command: any
  }

  interface Session {
    bot: any
    guildId: string
    isDirect: boolean
    event: any
    userId: string
    username: string
    platform: string
    quote: any
    text: any
    execute: any
  }

  interface Command {
    // Command 类型的扩展
  }

  // 导出缺失的成员
  export const Logger: any
  export const h: any
  export const Schema: any
  export const HTTP: any
  export const Time: any
  export const Random: any
  export const escapeRegExp: any
  export const paramCase: any
}

declare module 'koishi' {
  interface Tables {
    memes_blacklist: {
      id: number
      keyword: string
    }
    memes_usage_stats: {
      id: number
      meme_key: string
      guild_id: string
      user_id: string
      platform: string
      usage_count: number
      last_used: Date
    }
    memes_guild_settings: {
      id: number
      guild_id: string
      platform: string
      meme_key: string
      enabled: boolean
    }
  }
}
