<script setup lang="ts">
import { computed } from 'vue'
import { useProjectStore, type Project } from '@/stores/project'
import { toastSuccess, toastError } from '@/utils/toast'
import { open } from '@tauri-apps/plugin-shell'

const props = defineProps<{
  project: Project
}>()

const emit = defineEmits<{
  (e: 'close'): void
}>()

const store = useProjectStore()

const runningScripts = computed(() => store.runningScriptsFor(props.project.path))
const isAnyRunning = computed(() => runningScripts.value.length > 0)
const erroredScripts = computed(() =>
  store.erroredRunList
    .filter((run) => run.project.path === props.project.path)
    .map((run) => run.script),
)

/** Status table rows: running + errored scripts. */
const statusRows = computed(() => {
  const rows: { script: string; status: 'running' | 'errored'; ports: string[] }[] = []
  const seen = new Set<string>()

  for (const script of runningScripts.value) {
    seen.add(script)
    const id = store.runIdFor(props.project.path, script)
    rows.push({
      script,
      status: 'running',
      ports: store.portsForRun(id),
    })
  }

  for (const script of erroredScripts.value) {
    if (seen.has(script)) continue
    rows.push({ script, status: 'errored', ports: [] })
  }

  return rows
})

const recommendedScripts = computed(() => {
  const priority = ['dev', 'serve', 'start', 'build']
  const sorted = [...props.project.scripts].sort((a, b) => {
    const indexA = priority.indexOf(a[0])
    const indexB = priority.indexOf(b[0])
    if (indexA === -1 && indexB === -1) return a[0].localeCompare(b[0])
    if (indexA === -1) return 1
    if (indexB === -1) return -1
    return indexA - indexB
  })
  return sorted
})

function isScriptRunning(script: string) {
  return store.isScriptRunning(props.project.path, script)
}

async function openUrl(port: string) {
  await open(`http://localhost:${port}`)
}

async function handleScriptClick(script: string) {
  try {
    if (isScriptRunning(script)) {
      await store.stopProject(props.project, script)
      toastSuccess(`已停止 ${script}`)
    } else {
      const result = await store.startProject(props.project, script)
      if (!result.success) {
        toastError(result.message || '启动失败')
      } else if (result.project_id) {
        store.focusRunIfIdle(result.project_id)
      }
    }
  } catch (e) {
    toastError(e instanceof Error ? e.message : '操作失败')
  }
}

async function handleRestart(script: string) {
  try {
    const result = await store.restartProject(props.project, script)
    if (!result.success) {
      toastError(result.message || '重启失败')
    } else {
      toastSuccess(`已重启 ${script}`)
      if (result.project_id) store.focusRunIfIdle(result.project_id)
    }
  } catch (e) {
    toastError(e instanceof Error ? e.message : '重启失败')
  }
}

async function handleInstall() {
  try {
    if (isScriptRunning('install')) {
      await store.stopProject(props.project, 'install')
      toastSuccess('已停止安装')
      return
    }
    const result = await store.installProject(props.project)
    if (!result.success) {
      toastError(result.message || '安装失败')
    } else {
      toastSuccess('开始安装依赖')
      if (result.project_id) store.focusRunIfIdle(result.project_id)
    }
  } catch (e) {
    toastError(e instanceof Error ? e.message : '安装失败')
  }
}

async function handleStopScript(script: string) {
  try {
    await store.stopProject(props.project, script)
    toastSuccess(`已停止 ${script}`)
  } catch (e) {
    toastError(e instanceof Error ? e.message : '停止失败')
  }
}

async function handleStopAllScripts() {
  try {
    await store.stopAllScriptsForProject(props.project)
    toastSuccess('已停止全部脚本')
  } catch (e) {
    toastError(e instanceof Error ? e.message : '停止失败')
  }
}

async function handleRemove() {
  if (
    !window.confirm(
      `确定从工作区移除「${props.project.name}」？\n不会删除磁盘上的文件；若有脚本在运行会先全部停止。`
    )
  ) {
    return
  }
  try {
    await store.removeProject(props.project)
    toastSuccess('项目已删除')
    emit('close')
  } catch {
    // store already shows error
  }
}
</script>

<template>
  <div class="detail-overlay" @click.self="emit('close')">
    <div class="detail-panel">
      <div class="detail-header">
        <div class="project-header">
          <span class="status-indicator" :class="{ running: isAnyRunning }"></span>
          <div class="project-title-block">
            <div class="title-row">
              <h2 class="project-name">{{ project.name }}</h2>
              <button
                v-if="isAnyRunning"
                class="action-btn stop header-stop-all"
                @click="handleStopAllScripts"
              >
                停止全部
              </button>
              <button class="action-btn danger header-remove" @click="handleRemove">
                从工作区移除
              </button>
            </div>
            <p class="project-path">{{ project.path }}</p>
          </div>
        </div>
        <button class="close-btn" @click="emit('close')">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/>
            <line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>

      <div class="detail-body">
        <div class="section status-section">
          <h3 class="section-title">运行状态</h3>
          <div class="status-table-wrap">
            <table class="status-table">
              <thead>
                <tr>
                  <th>命令</th>
                  <th>运行状态</th>
                  <th>访问地址</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in statusRows" :key="row.script">
                  <td class="col-cmd">{{ row.script }}</td>
                  <td>
                    <span class="status-pill" :class="row.status">
                      {{ row.status === 'running' ? '运行中' : '异常' }}
                    </span>
                  </td>
                  <td>
                    <div class="col-url">
                      <template v-if="row.ports.length > 0">
                        <button
                          v-for="port in row.ports"
                          :key="port"
                          class="port-tag"
                          @click="openUrl(port)"
                        >
                          http://localhost:{{ port }}
                        </button>
                      </template>
                      <span v-else class="url-empty">—</span>
                    </div>
                  </td>
                  <td class="col-action">
                    <button
                      v-if="row.status === 'running'"
                      class="table-stop-btn"
                      @click="handleStopScript(row.script)"
                    >
                      停止
                    </button>
                    <button
                      v-else
                      class="table-clear-btn"
                      @click="store.clearError(store.runIdFor(project.path, row.script))"
                    >
                      清除
                    </button>
                  </td>
                </tr>
                <tr v-if="statusRows.length === 0">
                  <td colspan="4" class="empty-row">暂无运行中的命令</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div class="section">
          <h3 class="section-title">包管理器</h3>
          <div class="pm-selector">
            <select v-model="store.packageManager" class="pm-select-native">
              <option value="npm">npm</option>
              <option value="pnpm">pnpm</option>
              <option value="yarn">yarn</option>
            </select>
          </div>
          <button
            class="install-btn"
            :class="{ running: isScriptRunning('install') }"
            @click="handleInstall"
          >
            {{ isScriptRunning('install') ? '停止安装' : `${store.packageManager} install` }}
          </button>
        </div>

        <div class="section">
          <h3 class="section-title">脚本列表</h3>
          <p class="section-hint">可同时启动多个脚本；日志请在主界面右侧查看</p>
          <div class="script-list">
            <div
              v-for="[name, value] in recommendedScripts"
              :key="name"
              class="script-item"
            >
              <span class="status-dot" :class="{ running: isScriptRunning(name) }"></span>
              <span class="script-name">{{ name }}</span>
              <span class="script-value">{{ value }}</span>
              <button
                v-if="isScriptRunning(name) && name !== 'install'"
                class="script-restart-btn"
                @click="handleRestart(name)"
              >
                重启
              </button>
              <button
                class="script-action-btn"
                :class="{ running: isScriptRunning(name) }"
                @click="handleScriptClick(name)"
              >
                {{ isScriptRunning(name) ? '停止' : '启动' }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.detail-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  justify-content: flex-end;
  z-index: 100;
  animation: fadeIn 0.2s ease;
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

.detail-panel {
  width: min(480px, 100vw);
  height: 100%;
  background: rgba(8, 14, 26, 0.96);
  border-left: 1px solid rgba(56, 189, 248, 0.28);
  box-shadow: -8px 0 40px rgba(56, 189, 248, 0.08);
  display: flex;
  flex-direction: column;
  animation: slideIn 0.25s ease;
  overflow: hidden;
}

@keyframes slideIn {
  from { transform: translateX(100%); }
  to { transform: translateX(0); }
}

.detail-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  padding: 20px 24px;
  border-bottom: 1px solid rgba(56, 189, 248, 0.14);
  flex-shrink: 0;
}

.project-header {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  min-width: 0;
  flex: 1;
}

.project-title-block {
  min-width: 0;
  flex: 1;
}

.title-row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 4px;
}

.status-indicator {
  width: 10px;
  height: 10px;
  border-radius: 2px;
  background: #64748b;
  margin-top: 6px;
  flex-shrink: 0;
}

.status-indicator.running {
  background: #34d399;
  box-shadow: 0 0 8px rgba(52, 211, 153, 0.5);
}

.project-name {
  font-size: 18px;
  font-weight: 600;
  color: #e8f1ff;
  margin: 0;
}

.header-remove {
  flex-shrink: 0;
}

.project-path {
  font-size: 12px;
  color: rgba(186, 210, 240, 0.55);
  margin: 0;
  word-break: break-all;
}

.close-btn {
  background: none;
  border: none;
  color: rgba(186, 210, 240, 0.55);
  cursor: pointer;
  padding: 4px;
  border-radius: 6px;
  flex-shrink: 0;
}

.close-btn:hover {
  background: rgba(56, 189, 248, 0.1);
  color: #e8f1ff;
}

.detail-body {
  flex: 1;
  overflow-y: auto;
  padding: 20px 24px;
  display: flex;
  flex-direction: column;
  gap: 24px;
  min-height: 0;
}

.section-title {
  font-size: 12px;
  font-weight: 700;
  color: rgba(186, 210, 240, 0.55);
  letter-spacing: 0.08em;
  margin: 0 0 12px;
  text-transform: uppercase;
}

.section-hint {
  font-size: 12px;
  color: rgba(186, 210, 240, 0.45);
  margin: -4px 0 12px;
}

.status-table-wrap {
  background: rgba(12, 22, 40, 0.8);
  border: 1px solid rgba(56, 189, 248, 0.18);
  border-radius: 8px;
  overflow: hidden;
}

.status-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.status-table th {
  text-align: left;
  padding: 10px 12px;
  color: rgba(186, 210, 240, 0.55);
  font-weight: 600;
  font-size: 11px;
  letter-spacing: 0.06em;
  background: rgba(56, 189, 248, 0.06);
  border-bottom: 1px solid rgba(56, 189, 248, 0.14);
}

.status-table td {
  padding: 10px 12px;
  color: #e8f1ff;
  border-bottom: 1px solid rgba(56, 189, 248, 0.08);
  vertical-align: middle;
}

.status-table tbody tr:last-child td {
  border-bottom: none;
}

.col-cmd {
  font-weight: 600;
  font-family: inherit;
  white-space: nowrap;
}

.col-action {
  white-space: nowrap;
  width: 1%;
}

.table-stop-btn {
  padding: 4px 12px;
  background: rgba(251, 113, 133, 0.2);
  color: #fb7185;
  border: 1px solid rgba(251, 113, 133, 0.35);
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
  font-family: inherit;
}

.table-stop-btn:hover {
  background: rgba(251, 113, 133, 0.35);
}

.table-clear-btn {
  padding: 4px 12px;
  background: rgba(148, 163, 184, 0.12);
  color: #94a3b8;
  border: 1px solid rgba(148, 163, 184, 0.25);
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
  font-family: inherit;
}

.table-clear-btn:hover {
  background: rgba(148, 163, 184, 0.22);
  color: #e8f1ff;
}

.col-url {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}

.status-pill {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 500;
}

.status-pill.running {
  background: rgba(52, 211, 153, 0.15);
  color: #34d399;
}

.status-pill.errored {
  background: rgba(251, 113, 133, 0.15);
  color: #fb7185;
}

.url-empty {
  color: rgba(186, 210, 240, 0.4);
}

.empty-row {
  text-align: center;
  color: rgba(186, 210, 240, 0.45);
  padding: 16px 12px !important;
}

.action-btn {
  padding: 6px 14px;
  border-radius: 6px;
  border: none;
  font-size: 12px;
  cursor: pointer;
  font-weight: 600;
  font-family: inherit;
}

.action-btn.danger {
  background: rgba(251, 113, 133, 0.15);
  color: #fb7185;
  border: 1px solid rgba(251, 113, 133, 0.3);
}

.action-btn.danger:hover {
  background: rgba(251, 113, 133, 0.25);
}

.action-btn.stop {
  background: rgba(251, 113, 133, 0.12);
  color: #fb7185;
  border: 1px solid rgba(251, 113, 133, 0.3);
}

.action-btn.stop:hover {
  background: rgba(251, 113, 133, 0.22);
}

.port-tag {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: rgba(52, 211, 153, 0.12);
  color: #34d399;
  padding: 4px 10px;
  border-radius: 4px;
  font-size: 12px;
  border: 1px solid rgba(52, 211, 153, 0.3);
  cursor: pointer;
  font-family: inherit;
}

.port-tag:hover {
  background: rgba(52, 211, 153, 0.22);
}

.pm-selector {
  margin-bottom: 10px;
}

.pm-select-native {
  width: 100%;
  padding: 8px 12px;
  background: rgba(12, 22, 40, 0.8);
  border: 1px solid rgba(56, 189, 248, 0.22);
  border-radius: 6px;
  color: #e8f1ff;
  font-size: 14px;
  font-family: inherit;
}

.install-btn {
  width: 100%;
  padding: 10px;
  background: rgba(56, 189, 248, 0.18);
  color: #38bdf8;
  border: 1px solid rgba(56, 189, 248, 0.4);
  border-radius: 6px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  font-family: inherit;
}

.install-btn:hover {
  background: rgba(56, 189, 248, 0.28);
}

.install-btn.running {
  background: rgba(251, 113, 133, 0.18);
  color: #fb7185;
  border-color: rgba(251, 113, 133, 0.4);
}

.script-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.script-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  background: rgba(12, 22, 40, 0.8);
  border: 1px solid rgba(56, 189, 248, 0.14);
  border-radius: 6px;
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 2px;
  background: #64748b;
  flex-shrink: 0;
}

.status-dot.running {
  background: #34d399;
  box-shadow: 0 0 6px rgba(52, 211, 153, 0.5);
}

.script-name {
  font-size: 13px;
  font-weight: 600;
  color: #e8f1ff;
  min-width: 60px;
}

.script-value {
  flex: 1;
  font-size: 12px;
  color: rgba(186, 210, 240, 0.45);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.script-restart-btn {
  padding: 4px 10px;
  background: rgba(56, 189, 248, 0.12);
  color: #38bdf8;
  border: 1px solid rgba(56, 189, 248, 0.3);
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
  flex-shrink: 0;
  font-family: inherit;
}

.script-restart-btn:hover {
  background: rgba(56, 189, 248, 0.22);
}

.script-action-btn {
  padding: 4px 12px;
  background: rgba(56, 189, 248, 0.2);
  color: #38bdf8;
  border: 1px solid rgba(56, 189, 248, 0.35);
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
  flex-shrink: 0;
  font-family: inherit;
}

.script-action-btn:hover {
  background: rgba(56, 189, 248, 0.32);
}

.script-action-btn.running {
  background: rgba(251, 113, 133, 0.18);
  color: #fb7185;
  border-color: rgba(251, 113, 133, 0.4);
}

@media (max-width: 640px) {
  .detail-panel {
    width: 100vw;
  }
}
</style>
