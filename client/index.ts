import { defineExtension } from '@koishijs/client'
import page from './page.vue'

export default defineExtension((ctx) => {
  ctx.page({
    name: '快捷指令前缀',
    path: '/memes-prefix',
    icon: 'koishi',
    order: 500,
    component: page,
  })
})
