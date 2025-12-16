export default {
  commands: {
    meme: {
      description: '制作各种沙雕表情',
    },
    'meme.list': {
      description: '查看表情列表',
    },
    'meme.info': {
      description: '查看表情详情',
    },
    'meme.generate': {
      description: '生成表情包，每个表情生成指令会注册为本指令的子指令',
      examples: 'meme generate 5000兆 我去 洛天依\nmeme generate rua -圆 @自己',
    },
    'meme.random': {
      description: '生成随机表情',
    },
  },
  'memes-api': {
    errors: {
      'no-such-meme': '表情 {0} 不存在！',
      'syntax-error': {
        'unexpected-char': '参数语法错误，遇到意外字符 {char} ( 索引 {index} )，如果是左引号请考虑使用反斜杠转义。',
        'unterminated-quote': '参数语法错误，遇到未闭合引号 {char} ( 索引 {index} )。',
      },
      'image-number-mismatch': '输入图片数量不符，图片数量应为 {0}，但当前为 {1}。',
      'text-number-mismatch': '输入文字数量不符，文字数量应为 {0}，但当前为 {1}。',
      'can-not-get-avatar': '无法获取平台 {platform} 中 ID 为 {userId} 的用户的头像信息。',
      'download-image-failed': '下载图片失败。',
    },
    list: {
      tip: '触发方式："关键词 + 图片/文字"\n发送 "表情详情 + 关键词" 查看表情参数和预览\n目前支持的表情列表：\n{0}',
      'tip-no-shortcut': '触发指令："meme generate <关键词/序号> [...图片/文字]"\n发送指令 "meme info <关键词/序号>" 查看表情参数和预览\n目前支持的表情列表：\n{0}',
    },
    info: {
      key: '表情名：{0}',
      keywords: '关键词：{0}',
      shortcuts: '快捷指令：{0}',
      'image-num': '需要图片数目：{0}',
      'text-num': '需要文字数目：{0}',
      'default-texts': '默认文字：{0}',
      option: ' * {0} - {1}',
      options: '可选参数：\n{0}',
      preview: '表情预览：\n{0}',
    },
    random: {
      'no-suitable-meme': '找不到符合参数数量的表情。',
      info: '关键词：{0}',
    },
  },
}

