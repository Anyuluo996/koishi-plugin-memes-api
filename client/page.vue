<template>
  <k-layout>
    <template #header>
      <span>表情包插件 - 快捷指令设置</span>
    </template>

    <div class="memes-settings">
      <k-card title="快捷指令前缀设置" style="margin-bottom: 1rem;">
        <template #description>
          <p style="margin: 0 0 1rem; color: var(--el-text-color-secondary); font-size: 0.875rem;">
            设置快捷指令的前缀。留空则使用全局指令前缀（koishi 配置中的 prefix）。<br>
            例如设置 <code>#</code> 后，发送 <code>#摸头</code> 即可触发快捷指令。
          </p>
        </template>

        <!-- shortcutUsePrefix 开关 -->
        <div class="setting-item">
          <div class="setting-label">
            <span>启用前缀匹配</span>
            <el-switch
              v-model="localConfig.shortcutUsePrefix"
              :disabled="!localConfig.enableShortcut"
              @change="saveConfig"
            />
          </div>
          <p class="setting-desc">关闭后，快捷指令无需前缀即可触发（如直接发送"摸头"）</p>
        </div>

        <!-- shortcutPrefix 自定义前缀 -->
        <div class="setting-item" v-if="localConfig.shortcutUsePrefix && localConfig.enableShortcut">
          <div class="setting-label">
            <span>自定义前缀</span>
          </div>
          <p class="setting-desc">设置快捷指令的专属前缀（覆盖全局前缀）。支持多个前缀，用逗号分隔。</p>

          <div class="prefix-list">
            <div
              v-for="(prefix, index) in localConfig.shortcutPrefix || []"
              :key="index"
              class="prefix-item"
            >
              <el-input
                v-model="localConfig.shortcutPrefix[index]"
                placeholder="例如 #"
                @blur="saveConfig"
                style="flex: 1;"
              />
              <el-button
                type="danger"
                :icon="Delete"
                circle
                @click="removePrefix(index)"
                style="margin-left: 0.5rem;"
              />
            </div>
          </div>

          <div class="prefix-actions" style="margin-top: 0.75rem;">
            <el-button type="primary" plain @click="addPrefix" :icon="Plus">
              添加前缀
            </el-button>
            <el-button @click="clearPrefixes" v-if="(localConfig.shortcutPrefix?.length || 0) > 0">
              清空
            </el-button>
            <el-button type="success" @click="saveConfig" :loading="saving" v-if="hasChanges">
              保存
            </el-button>
          </div>

          <div class="prefix-preview" v-if="(localConfig.shortcutPrefix?.length || 0) > 0" style="margin-top: 1rem;">
            <el-alert type="info" :closable="false">
              <template #title>
                当前生效前缀：
                <code v-for="(p, i) in localConfig.shortcutPrefix.filter(Boolean)" :key="i" class="prefix-code">
                  {{ p }}
                </code>
                <span v-if="!localConfig.shortcutPrefix.filter(Boolean).length" style="color: var(--el-color-warning);">
                  （已清空，将使用全局前缀）
                </span>
              </template>
            </el-alert>
          </div>
        </div>

        <div class="setting-item" v-if="!localConfig.enableShortcut">
          <el-alert type="warning" :closable="false">
            快捷指令功能已禁用，请在插件配置中启用 enableShortcut
          </el-alert>
        </div>

        <!-- 全局前缀提示 -->
        <div class="setting-tip" style="margin-top: 1rem;">
          <el-alert type="info" :closable="false" show-icon>
            <template #title>
              全局指令前缀（koishi 配置）在不设置自定义前缀时生效。修改请前往 Koishi 配置页面。
            </template>
          </el-alert>
        </div>
      </k-card>

      <!-- 状态信息 -->
      <k-card title="当前状态" style="margin-bottom: 1rem;">
        <div class="status-info">
          <div class="status-item">
            <span class="status-label">快捷指令：</span>
            <el-tag :type="localConfig.enableShortcut ? 'success' : 'danger'" size="small">
              {{ localConfig.enableShortcut ? '已启用' : '已禁用' }}
            </el-tag>
          </div>
          <div class="status-item">
            <span class="status-label">前缀匹配：</span>
            <el-tag :type="localConfig.shortcutUsePrefix ? 'success' : 'info'" size="small">
              {{ localConfig.shortcutUsePrefix ? '需要前缀' : '无需前缀' }}
            </el-tag>
          </div>
          <div class="status-item" v-if="localConfig.shortcutUsePrefix">
            <span class="status-label">自定义前缀：</span>
            <el-tag
              v-for="(p, i) in (localConfig.shortcutPrefix || []).filter(Boolean)"
              :key="i"
              type="primary"
              size="small"
              style="margin-right: 0.25rem;"
            >
              {{ p }}
            </el-tag>
            <el-tag v-if="!(localConfig.shortcutPrefix || []).filter(Boolean).length" type="info" size="small">
              使用全局前缀
            </el-tag>
          </div>
        </div>
      </k-card>
    </div>
  </k-layout>
</template>

<script lang="ts" setup>
import { computed, onMounted, ref, watch } from 'vue'
import { Plus, Delete } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'

const saving = ref(false)

// @ts-ignore - store.config is available at runtime from @koishijs/plugin-config
const configData = store.config as any

const localConfig = ref<any>({
  enableShortcut: true,
  shortcutUsePrefix: true,
  shortcutPrefix: [] as string[],
})

const originalConfig = ref<any>(null)

const hasChanges = computed(() => {
  return JSON.stringify(localConfig.value) !== JSON.stringify(originalConfig.value)
})

function loadConfig() {
  try {
    const plugins = configData?.plugins
    if (plugins && plugins['~@anyul/memes-api:66gcya']) {
      const cfg = { ...plugins['~@anyul/memes-api:66gcya'] }
      // 确保 shortcutPrefix 是数组
      if (!Array.isArray(cfg.shortcutPrefix)) {
        cfg.shortcutPrefix = []
      }
      localConfig.value = cfg
      originalConfig.value = JSON.parse(JSON.stringify(cfg))
    }
  } catch (e) {
    console.error('[memes-api] Failed to load config:', e)
  }
}

async function saveConfig() {
  if (saving.value) return
  saving.value = true
  try {
    // 使用 send 触发 manager/reload 来保存配置
    // manager/reload(parent, key, config) - parent 通常是 '$'，key 是插件的 fork 标识
    await send('manager/reload', '$', '~@anyul/memes-api:66gcya', localConfig.value)
    originalConfig.value = JSON.parse(JSON.stringify(localConfig.value))
    ElMessage.success('设置已保存')
  } catch (e: any) {
    console.error('[memes-api] Failed to save config:', e)
    ElMessage.error('保存失败: ' + (e.message || String(e)))
  } finally {
    saving.value = false
  }
}

function addPrefix() {
  if (!localConfig.value.shortcutPrefix) {
    localConfig.value.shortcutPrefix = []
  }
  localConfig.value.shortcutPrefix.push('')
}

function removePrefix(index: number) {
  if (localConfig.value.shortcutPrefix) {
    localConfig.value.shortcutPrefix.splice(index, 1)
    saveConfig()
  }
}

function clearPrefixes() {
  localConfig.value.shortcutPrefix = []
  saveConfig()
}

// 监听 store.config 变化（远程配置更新）
watch(() => configData?.plugins, () => {
  loadConfig()
}, { deep: true })

onMounted(() => {
  loadConfig()
})
</script>

<style lang="scss" scoped>
.memes-settings {
  padding: 1.5rem;
  max-width: 800px;
}

.setting-item {
  margin-bottom: 1.5rem;

  &:last-child {
    margin-bottom: 0;
  }
}

.setting-label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.5rem;
  font-weight: 500;
  font-size: 0.9375rem;
}

.setting-desc {
  margin: 0 0 0.75rem;
  color: var(--el-text-color-secondary);
  font-size: 0.8125rem;
  line-height: 1.5;
}

.prefix-list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.prefix-item {
  display: flex;
  align-items: center;
}

.prefix-actions {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.prefix-code {
  display: inline-block;
  padding: 0.125rem 0.5rem;
  margin: 0 0.125rem;
  background: var(--el-fill-color-light);
  border-radius: 4px;
  font-family: monospace;
  font-size: 0.875rem;
  color: var(--el-color-primary);
}

.status-info {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.status-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.875rem;
}

.status-label {
  color: var(--el-text-color-secondary);
  min-width: 100px;
}

code {
  font-family: 'Fira Code', 'Cascadia Code', Consolas, monospace;
}
</style>
