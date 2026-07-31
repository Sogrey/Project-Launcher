<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { open as openUrl } from '@tauri-apps/plugin-shell'
import { useProjectStore, type Project } from '@/stores/project'
import ProjectDetail from './ProjectDetail.vue'
import LogPanel from './LogPanel.vue'
import { toastSuccess, toastError } from '@/utils/toast'

const store = useProjectStore()
const showWorkspacePanel = ref(false)
const newWorkspaceName = ref('')
const renamingId = ref<string | null>(null)
const renameValue = ref('')

const focusedMeta = computed(() => {
  const id = store.selectedRunId
  if (!id) return null
  const running = store.runningRuns.get(id)
  if (running) {
    return {
      name: running.project.name,
      script: running.script,
      kind: 'running' as const,
    }
  }
  const errored = store.erroredRuns.get(id)
  if (errored) {
    return {
      name: errored.project.name,
      script: errored.script,
      kind: 'errored' as const,
    }
  }
  return null
})

const focusedLogs = computed(() =>
  store.selectedRunId ? store.logsForRun(store.selectedRunId) : []
)

const focusedLogLabel = computed(() => {
  if (!focusedMeta.value) return ''
  const tag = focusedMeta.value.kind === 'errored' ? '异常' : ''
  const base = `${focusedMeta.value.name} / ${focusedMeta.value.script}`
  return tag ? `${base} · ${tag}` : base
})

const showLogPanel = computed(
  () => !!store.selectedRunId && (!!focusedMeta.value || focusedLogs.value.length > 0)
)

// Clear log focus only when the run is gone from both running and errored lists.
watch(
  () => ({
    running: store.runningRunList.map((r) => r.runId),
    errored: store.erroredRunList.map((r) => r.runId),
  }),
  ({ running, errored }) => {
    const id = store.selectedRunId
    if (!id) return
    if (running.includes(id) || errored.includes(id)) return
    store.selectRun(null)
  }
)

const dragFromIndex = ref<number | null>(null)
const dragOverIndex = ref<number | null>(null)
let suppressProjectClick = false

function onProjectDragStart(event: DragEvent, index: number) {
  // Prefer dragging from the handle; allow whole card as fallback.
  const target = event.target as HTMLElement | null
  const fromHandle = Boolean(target?.closest?.('.drag-handle'))
  if (!fromHandle && target?.closest?.('button')) {
    event.preventDefault()
    return
  }
  dragFromIndex.value = index
  suppressProjectClick = false
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', String(index))
  }
}

function onProjectDragOver(event: DragEvent, index: number) {
  event.preventDefault()
  event.stopPropagation()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  if (dragFromIndex.value === null || dragFromIndex.value === index) {
    dragOverIndex.value = null
    return
  }
  dragOverIndex.value = index
}

function onProjectDragLeave(index: number) {
  if (dragOverIndex.value === index) dragOverIndex.value = null
}

async function onProjectDrop(event: DragEvent, toIndex: number) {
  event.preventDefault()
  event.stopPropagation()
  const fromIndex = dragFromIndex.value
  dragOverIndex.value = null
  if (fromIndex === null || fromIndex === toIndex) {
    dragFromIndex.value = null
    return
  }
  suppressProjectClick = true
  try {
    await store.reorderProjects(fromIndex, toIndex)
  } catch {
    // store already shows error
  } finally {
    dragFromIndex.value = null
  }
}

function onProjectDragEnd() {
  dragFromIndex.value = null
  dragOverIndex.value = null
  // Drop may set this to suppress the following click; always clear leftovers.
  // Use a microtask so the click from the same gesture can still see `true`.
  queueMicrotask(() => {
    suppressProjectClick = false
  })
}

function handleProjectClick(project: Project) {
  if (suppressProjectClick) {
    suppressProjectClick = false
    return
  }
  store.selectProject(project.path)
}

function handleRunClick(runId: string) {
  store.selectRun(runId)
}

function handleErrorClick(runId: string) {
  store.selectRun(runId)
}

function handleCloseDetail() {
  store.selectProject(null)
}

function clearLogFocus() {
  store.selectRun(null)
}

async function handleAddProject() {
  try {
    const result = await openDialog({ directory: true, title: '选择项目目录' })
    if (result) {
      await store.addProject(result.toString())
      toastSuccess('项目添加成功')
    }
  } catch (err: unknown) {
    toastError(String(err))
  }
}

async function handleImportDirectory() {
  try {
    const result = await openDialog({ directory: true, title: '选择要扫描的目录' })
    if (!result) return
    const count = await store.importFromDirectory(result.toString())
    toastSuccess(`已导入 ${count} 个项目到「${store.activeWorkspaceName}」`)
    showWorkspacePanel.value = false
  } catch (err: unknown) {
    toastError(String(err))
  }
}

async function handleCreateWorkspace() {
  const ws = await store.createWorkspace(newWorkspaceName.value)
  if (ws) {
    toastSuccess(`已创建工作区「${ws.name}」`)
    newWorkspaceName.value = ''
  }
}

async function handleSwitchWorkspace(id: string) {
  try {
    await store.switchWorkspace(id)
    toastSuccess(`已切换到「${store.activeWorkspaceName}」`)
    showWorkspacePanel.value = false
  } catch (err: unknown) {
    toastError(String(err))
  }
}

function startRename(id: string, name: string) {
  renamingId.value = id
  renameValue.value = name
}

async function confirmRename() {
  if (!renamingId.value) return
  try {
    await store.renameWorkspace(renamingId.value, renameValue.value)
    toastSuccess('已重命名')
    renamingId.value = null
    renameValue.value = ''
  } catch (err: unknown) {
    toastError(String(err))
  }
}

async function handleDeleteWorkspace(id: string, name: string) {
  if (!window.confirm(`确定删除工作区「${name}」？其中的项目关联会一并移除（不会删除磁盘文件）。`)) {
    return
  }
  try {
    await store.deleteWorkspace(id)
    toastSuccess('工作区已删除')
  } catch (err: unknown) {
    toastError(String(err))
  }
}

async function handleOpenUrl(port: string) {
  await openUrl(`http://localhost:${port}`)
}

function getRunPorts(runId: string) {
  return store.portsForRun(runId)
}

function runningScriptsLabel(project: Project) {
  const scripts = store.runningScriptsFor(project.path)
  return scripts.length ? scripts.join(', ') : ''
}

async function handleStopAll() {
  try {
    await store.stopAllProjects()
    toastSuccess('已停止所有项目')
  } catch {
    // store already shows error
  }
}

async function handleStopProject(project: Project, script: string) {
  try {
    await store.stopProject(project, script)
    toastSuccess(`已停止 ${project.name} / ${script}`)
  } catch {
    // store already shows error
  }
}

async function handleStopAllScripts(project: Project) {
  try {
    await store.stopAllScriptsForProject(project)
    toastSuccess(`已停止 ${project.name} 的全部脚本`)
  } catch {
    // store already shows error
  }
}

async function handleRemoveProject(project: Project) {
  if (
    !window.confirm(
      `确定从工作区移除「${project.name}」？\n不会删除磁盘上的文件；若有脚本在运行会先全部停止。`
    )
  ) {
    return
  }
  try {
    await store.removeProject(project)
    toastSuccess(`已删除 ${project.name}`)
  } catch {
    // store already shows error
  }
}

function handleClearError(runId: string) {
  store.clearError(runId)
}
</script>

<template>
  <div class="dashboard-container">
    <div class="scanlines" aria-hidden="true"></div>

    <header class="header">
      <div class="header-left">
        <div class="brand-row">
          <span class="brand-mark"></span>
          <h1 class="title">Project Launcher</h1>
        </div>
        <p class="subtitle">工作区 // {{ store.activeWorkspaceName }}</p>
      </div>
      <div class="header-right">
        <div class="stats">
          <div class="stat-item">
            <span class="stat-value">{{ store.totalProjects }}</span>
            <span class="stat-label">总项目</span>
          </div>
          <div class="stat-item running">
            <span class="stat-value">{{ store.runningCount }}</span>
            <span class="stat-label">运行中</span>
          </div>
          <div class="stat-item errored">
            <span class="stat-value">{{ store.erroredCount }}</span>
            <span class="stat-label">异常</span>
          </div>
          <div class="stat-item">
            <span class="stat-value">{{ store.todayStartCount }}</span>
            <span class="stat-label">今日启动</span>
          </div>
        </div>
        <div class="actions">
          <button class="btn btn-outline" @click="showWorkspacePanel = true">工作区</button>
          <button class="btn btn-secondary" @click="handleAddProject">新增项目</button>
          <button class="btn btn-danger" @click="handleStopAll">一键全停</button>
        </div>
      </div>
    </header>

    <main class="board">
      <!-- 左：项目列表 -->
      <section class="column projects">
        <div class="column-header">
          <span class="column-dot stopped"></span>
          <h2>项目列表</h2>
          <span class="column-count">{{ store.projects.length }}</span>
        </div>
        <div class="column-body">
          <button class="tile add-tile" @click="handleAddProject">
            <div class="add-icon">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="12" y1="5" x2="12" y2="19"/>
                <line x1="5" y1="12" x2="19" y2="12"/>
              </svg>
            </div>
            <span class="add-text">新增项目</span>
          </button>

          <div
            v-for="(project, index) in store.projects"
            :key="project.path"
            class="tile project-tile"
            :class="{
              selected: store.selectedProjectPath === project.path,
              running: store.hasRunningScripts(project.path),
              dragging: dragFromIndex === index,
              'drag-over': dragOverIndex === index && dragFromIndex !== index,
            }"
            draggable="true"
            @dragstart="onProjectDragStart($event, index)"
            @dragover="onProjectDragOver($event, index)"
            @dragleave="onProjectDragLeave(index)"
            @drop="onProjectDrop($event, index)"
            @dragend="onProjectDragEnd"
            @click="handleProjectClick(project)"
          >
            <div class="tile-header">
              <span class="drag-handle" title="拖拽排序" @click.stop>⋮⋮</span>
              <span
                class="status-dot"
                :class="store.hasRunningScripts(project.path) ? 'running' : 'stopped'"
              ></span>
              <h3 class="project-name">{{ project.name }}</h3>
              <button
                v-if="store.hasRunningScripts(project.path)"
                class="tile-stop-all"
                title="停止该项目全部脚本"
                @click.stop="handleStopAllScripts(project)"
              >
                ■■
              </button>
              <button
                class="tile-delete"
                title="从工作区移除"
                @click.stop="handleRemoveProject(project)"
              >
                ×
              </button>
            </div>
            <p class="project-path">{{ project.path }}</p>
            <div class="stopped-info">
              <span class="script-count">{{ project.scripts.length }} 个脚本</span>
              <span v-if="runningScriptsLabel(project)" class="running-badge">
                运行中: {{ runningScriptsLabel(project) }}
              </span>
            </div>
          </div>

          <div v-if="store.projects.length === 0" class="empty-column">
            <p>暂无项目</p>
            <p class="hint">在当前工作区新增项目，或从目录批量导入</p>
          </div>
        </div>
      </section>

      <!-- 中：运行中 -->
      <section class="column running">
        <div class="column-header">
          <span class="column-dot running"></span>
          <h2>运行中</h2>
          <span class="column-count">{{ store.runningRunList.length }}</span>
        </div>
        <div class="column-body">
          <div
            v-for="run in store.runningRunList"
            :key="run.runId"
            class="tile project-tile running"
            :class="{ selected: store.selectedRunId === run.runId }"
            @click="handleRunClick(run.runId)"
          >
            <div class="tile-header">
              <span class="status-dot running"></span>
              <h3 class="project-name">{{ run.project.name }}</h3>
              <button
                class="tile-stop"
                title="停止该脚本"
                @click.stop="handleStopProject(run.project, run.script)"
              >
                ■
              </button>
            </div>
            <p class="project-path">{{ run.project.path }}</p>
            <div class="running-info">
              <span class="current-script">脚本: {{ run.script }}</span>
              <div v-if="getRunPorts(run.runId).length > 0" class="ports">
                <button
                  v-for="port in getRunPorts(run.runId)"
                  :key="port"
                  class="port"
                  title="在浏览器中打开"
                  @click.stop="handleOpenUrl(port)"
                >
                  http://localhost:{{ port }}
                </button>
              </div>
            </div>
          </div>

          <div v-if="store.runningRunList.length === 0" class="empty-column">
            <p>暂无运行中的脚本</p>
            <p class="hint">点击左侧项目启动脚本后会出现在这里</p>
          </div>
        </div>
      </section>

      <!-- 右：上日志 / 下异常 -->
      <section class="column side-panel">
        <div class="side-logs">
          <div class="column-header">
            <span class="column-dot running"></span>
            <h2>日志输出</h2>
            <span
              v-if="focusedLogLabel"
              class="log-focus-tag"
              :class="{ errored: focusedMeta?.kind === 'errored' }"
              :title="focusedLogLabel"
            >
              {{ focusedLogLabel }}
            </span>
            <button
              v-if="store.selectedRunId"
              class="log-clear-focus"
              title="取消日志焦点"
              @click="clearLogFocus"
            >
              取消
            </button>
          </div>
          <div class="log-body">
            <LogPanel
              v-if="showLogPanel && store.selectedRunId"
              :key="store.selectedRunId"
              :project-path="store.selectedRunId"
              :logs="focusedLogs"
              fill
              @clear="store.clearLogs(store.selectedRunId!)"
            />
            <div v-else class="empty-column log-empty">
              <p>选择中间列运行中任务，或下方异常记录</p>
              <p class="hint">在右上查看对应日志</p>
            </div>
          </div>
        </div>

        <div class="side-errors">
          <div class="column-header compact">
            <span class="column-dot errored"></span>
            <h2>异常</h2>
            <span class="column-count">{{ store.erroredRunList.length }}</span>
          </div>
          <div class="error-body">
            <div
              v-for="run in store.erroredRunList"
              :key="run.runId"
              class="error-row"
              :class="{ selected: store.selectedRunId === run.runId }"
              @click="handleErrorClick(run.runId)"
            >
              <div class="error-main">
                <span class="error-name">{{ run.project.name }}</span>
                <span class="error-script">{{ run.script }}</span>
              </div>
              <button
                class="dismiss-btn"
                title="清除记录"
                @click.stop="handleClearError(run.runId)"
              >
                清除
              </button>
            </div>
            <div v-if="store.erroredRunList.length === 0" class="empty-errors">
              暂无异常记录
            </div>
          </div>
        </div>
      </section>
    </main>

    <ProjectDetail
      v-if="store.selectedProject"
      :project="store.selectedProject"
      @close="handleCloseDetail"
    />

    <div
      v-if="showWorkspacePanel"
      class="ws-overlay"
      @click.self="showWorkspacePanel = false"
    >
      <div class="ws-panel">
        <div class="ws-header">
          <h2>工作区管理</h2>
          <button class="close-btn" @click="showWorkspacePanel = false">×</button>
        </div>
        <p class="ws-hint">工作区是项目分组名称，用于分类管理；配置会保存到本地 JSON。</p>

        <div class="ws-create">
          <input
            v-model="newWorkspaceName"
            class="ws-input"
            placeholder="新建工作区名称"
            @keyup.enter="handleCreateWorkspace"
          />
          <button class="btn btn-secondary" @click="handleCreateWorkspace">创建</button>
        </div>

        <div class="ws-list">
          <div
            v-for="ws in store.workspaces"
            :key="ws.id"
            class="ws-item"
            :class="{ active: ws.id === store.activeWorkspaceId }"
          >
            <template v-if="renamingId === ws.id">
              <input v-model="renameValue" class="ws-input" @keyup.enter="confirmRename" />
              <button class="ws-mini" @click="confirmRename">保存</button>
              <button class="ws-mini" @click="renamingId = null">取消</button>
            </template>
            <template v-else>
              <div class="ws-meta" @click="handleSwitchWorkspace(ws.id)">
                <span class="ws-name">{{ ws.name }}</span>
                <span class="ws-count">{{ ws.projects.length }} 个项目</span>
              </div>
              <div class="ws-actions">
                <button
                  v-if="ws.id !== store.activeWorkspaceId"
                  class="ws-mini"
                  @click="handleSwitchWorkspace(ws.id)"
                >
                  切换
                </button>
                <button class="ws-mini" @click="startRename(ws.id, ws.name)">重命名</button>
                <button
                  class="ws-mini danger"
                  :disabled="store.workspaces.length <= 1"
                  @click="handleDeleteWorkspace(ws.id, ws.name)"
                >
                  删除
                </button>
              </div>
            </template>
          </div>
        </div>

        <div class="ws-footer">
          <button class="btn btn-outline" @click="handleImportDirectory">
            从目录导入到当前工作区
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dashboard-container {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100vh;
  padding: 16px 18px;
  gap: 14px;
  overflow: hidden;
}

.scanlines {
  pointer-events: none;
  position: fixed;
  inset: 0;
  z-index: 0;
  background: repeating-linear-gradient(
    0deg,
    transparent,
    transparent 2px,
    rgba(0, 0, 0, 0.06) 2px,
    rgba(0, 0, 0, 0.06) 4px
  );
  opacity: 0.35;
}

.header,
.board {
  position: relative;
  z-index: 1;
}

.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 14px 20px;
  background: rgba(8, 14, 26, 0.78);
  backdrop-filter: blur(16px);
  border-radius: 12px;
  border: 1px solid var(--border-glow);
  box-shadow:
    0 0 0 1px rgba(56, 189, 248, 0.04) inset,
    0 8px 32px rgba(0, 0, 0, 0.35);
  gap: 16px;
  flex-wrap: wrap;
}

.header-left {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.brand-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.brand-mark {
  width: 10px;
  height: 10px;
  border-radius: 2px;
  background: var(--accent-cyan);
  box-shadow: 0 0 12px var(--accent-cyan);
  animation: pulse-mark 2.4s ease-in-out infinite;
}

@keyframes pulse-mark {
  0%, 100% { opacity: 1; box-shadow: 0 0 10px var(--accent-cyan); }
  50% { opacity: 0.65; box-shadow: 0 0 18px var(--accent-cyan); }
}

.title {
  font-size: 20px;
  font-weight: 700;
  letter-spacing: 0.04em;
  color: var(--text-primary);
  margin: 0;
  text-transform: uppercase;
}

.subtitle {
  font-size: 12px;
  color: var(--text-muted);
  margin: 0;
  max-width: 420px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  letter-spacing: 0.02em;
}

.header-right {
  display: flex;
  align-items: center;
  gap: 20px;
  flex-wrap: wrap;
}

.stats {
  display: flex;
  gap: 18px;
}

.stat-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  min-width: 52px;
}

.stat-value {
  font-size: 20px;
  font-weight: 700;
  color: var(--text-primary);
  font-variant-numeric: tabular-nums;
}

.stat-item.running .stat-value {
  color: var(--accent-mint);
  text-shadow: 0 0 12px rgba(52, 211, 153, 0.45);
}

.stat-item.errored .stat-value {
  color: var(--accent-rose);
  text-shadow: 0 0 12px rgba(251, 113, 133, 0.4);
}

.stat-label {
  font-size: 10px;
  color: var(--text-muted);
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.btn {
  padding: 8px 14px;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
  cursor: pointer;
  border: none;
  transition: all 0.2s;
  font-family: inherit;
}

.btn-secondary {
  background: rgba(56, 189, 248, 0.12);
  color: var(--accent-cyan);
  border: 1px solid rgba(56, 189, 248, 0.35);
}

.btn-secondary:hover {
  background: rgba(56, 189, 248, 0.22);
  box-shadow: 0 0 16px rgba(56, 189, 248, 0.2);
}

.btn-danger {
  background: rgba(251, 113, 133, 0.15);
  color: var(--accent-rose);
  border: 1px solid rgba(251, 113, 133, 0.4);
}

.btn-danger:hover {
  background: rgba(251, 113, 133, 0.28);
  box-shadow: 0 0 16px rgba(251, 113, 133, 0.25);
}

.btn-outline {
  background: transparent;
  color: var(--text-muted);
  border: 1px solid rgba(186, 210, 240, 0.2);
}

.btn-outline:hover {
  background: rgba(255, 255, 255, 0.05);
  color: var(--text-primary);
}

.board {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(240px, 1fr) minmax(240px, 1fr) minmax(320px, 1.35fr);
  gap: 12px;
}

.column {
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--bg-panel);
  border: 1px solid var(--border-glow);
  border-radius: 12px;
  overflow: hidden;
  box-shadow: 0 0 0 1px rgba(56, 189, 248, 0.03) inset;
}

.column-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 14px;
  border-bottom: 1px solid rgba(56, 189, 248, 0.12);
  background: linear-gradient(90deg, rgba(56, 189, 248, 0.08), transparent 70%);
}

.column-header.compact {
  padding: 8px 12px;
}

.column-header h2 {
  margin: 0;
  font-size: 12px;
  font-weight: 700;
  color: var(--text-primary);
  flex: 1;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.column-count {
  font-size: 11px;
  color: var(--accent-cyan);
  background: rgba(56, 189, 248, 0.1);
  border: 1px solid rgba(56, 189, 248, 0.25);
  padding: 1px 8px;
  border-radius: 4px;
  font-variant-numeric: tabular-nums;
}

.log-focus-tag {
  font-size: 11px;
  color: var(--accent-mint);
  background: rgba(52, 211, 153, 0.1);
  border: 1px solid rgba(52, 211, 153, 0.3);
  padding: 2px 8px;
  border-radius: 4px;
  max-width: 45%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.log-clear-focus {
  border: 1px solid rgba(56, 189, 248, 0.25);
  background: rgba(56, 189, 248, 0.08);
  color: var(--text-muted);
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 4px;
  cursor: pointer;
  font-family: inherit;
  flex-shrink: 0;
}

.log-clear-focus:hover {
  color: var(--accent-cyan);
  border-color: rgba(56, 189, 248, 0.45);
}

.column-dot {
  width: 7px;
  height: 7px;
  border-radius: 1px;
  flex-shrink: 0;
}

.column-dot.stopped {
  background: #64748b;
}

.column-dot.running {
  background: var(--accent-mint);
  box-shadow: 0 0 8px var(--accent-mint);
}

.column-dot.errored {
  background: var(--accent-rose);
  box-shadow: 0 0 8px var(--accent-rose);
}

.column-body {
  flex: 1;
  overflow-y: auto;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

/* 右侧分栏 */
.side-panel {
  display: flex;
  flex-direction: column;
  gap: 0;
}

.side-logs {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border-bottom: 1px solid rgba(56, 189, 248, 0.14);
}

.log-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 8px;
}

.side-errors {
  flex: 0 0 28%;
  max-height: 32%;
  min-height: 120px;
  display: flex;
  flex-direction: column;
  background: rgba(251, 113, 133, 0.03);
}

.error-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.error-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 6px;
  border: 1px solid rgba(251, 113, 133, 0.25);
  background: rgba(251, 113, 133, 0.06);
  cursor: pointer;
  transition: background 0.15s;
}

.error-row:hover {
  background: rgba(251, 113, 133, 0.12);
}

.error-row.selected {
  border-color: rgba(251, 113, 133, 0.55);
  background: rgba(251, 113, 133, 0.16);
  box-shadow: 0 0 12px rgba(251, 113, 133, 0.15);
}

.log-focus-tag.errored {
  color: var(--accent-rose);
  background: rgba(251, 113, 133, 0.12);
  border-color: rgba(251, 113, 133, 0.35);
}

.error-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.error-name {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.error-script {
  font-size: 11px;
  color: var(--accent-rose);
}

.empty-errors {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  color: var(--text-muted);
}

.tile {
  background: rgba(12, 22, 40, 0.65);
  border-radius: 8px;
  border: 1px solid rgba(56, 189, 248, 0.14);
  padding: 12px 14px;
  cursor: pointer;
  transition: all 0.2s ease;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.tile:hover {
  border-color: rgba(56, 189, 248, 0.4);
  box-shadow: 0 0 20px rgba(56, 189, 248, 0.08);
  transform: translateY(-1px);
}

.add-tile {
  background: rgba(56, 189, 248, 0.06);
  border-style: dashed;
  border-color: rgba(56, 189, 248, 0.35);
  align-items: center;
  justify-content: center;
  min-height: 84px;
}

.add-tile:hover {
  background: rgba(56, 189, 248, 0.12);
}

.add-icon {
  color: var(--accent-cyan);
}

.add-text {
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.06em;
}

.project-tile.selected {
  border-color: var(--accent-cyan);
  background: rgba(56, 189, 248, 0.1);
  box-shadow: 0 0 0 1px rgba(56, 189, 248, 0.2), 0 0 24px rgba(56, 189, 248, 0.12);
}

.project-tile.running {
  border-color: rgba(52, 211, 153, 0.35);
}

.project-tile {
  -webkit-user-drag: element;
  user-select: none;
}

.project-tile.dragging {
  opacity: 0.45;
}

.project-tile.drag-over {
  border-color: var(--accent-cyan);
  box-shadow: 0 0 0 1px rgba(56, 189, 248, 0.45);
}

.drag-handle {
  color: var(--text-muted);
  font-size: 11px;
  letter-spacing: -2px;
  cursor: grab;
  user-select: none;
  flex-shrink: 0;
  padding: 4px 2px;
  line-height: 1;
  touch-action: none;
}

.drag-handle:active {
  cursor: grabbing;
}

.tile-header {
  display: flex;
  align-items: center;
  gap: 8px;
}

.tile-delete {
  margin-left: auto;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-muted);
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
  flex-shrink: 0;
}

.tile-delete:hover {
  background: rgba(251, 113, 133, 0.2);
  color: var(--accent-rose);
}

.tile-stop {
  margin-left: auto;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 4px;
  background: rgba(251, 113, 133, 0.12);
  color: var(--accent-rose);
  font-size: 10px;
  line-height: 1;
  cursor: pointer;
  flex-shrink: 0;
}

.tile-stop:hover {
  background: rgba(251, 113, 133, 0.28);
}

.tile-stop-all {
  width: 28px;
  height: 24px;
  border: none;
  border-radius: 4px;
  background: rgba(251, 113, 133, 0.1);
  color: var(--accent-rose);
  font-size: 9px;
  letter-spacing: -1px;
  line-height: 1;
  cursor: pointer;
  flex-shrink: 0;
}

.tile-stop-all:hover {
  background: rgba(251, 113, 133, 0.25);
}

.status-dot {
  width: 7px;
  height: 7px;
  border-radius: 1px;
  flex-shrink: 0;
}

.status-dot.running {
  background: var(--accent-mint);
  box-shadow: 0 0 8px var(--accent-mint);
  animation: pulse 2s infinite;
}

.status-dot.stopped {
  background: #64748b;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.45; }
}

.project-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.project-path {
  font-size: 11px;
  color: var(--text-muted);
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.running-info {
  margin-top: auto;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
}

.stopped-info {
  margin-top: auto;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
}

.running-badge,
.current-script {
  font-size: 11px;
  color: var(--accent-mint);
  font-weight: 500;
}

.ports {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.port {
  background: rgba(52, 211, 153, 0.12);
  color: var(--accent-mint);
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
  border: 1px solid rgba(52, 211, 153, 0.3);
  font-family: inherit;
}

.port:hover {
  background: rgba(52, 211, 153, 0.22);
  text-decoration: underline;
}

.script-count {
  font-size: 11px;
  color: var(--text-muted);
}

.dismiss-btn {
  border: 1px solid rgba(251, 113, 133, 0.3);
  background: rgba(251, 113, 133, 0.1);
  color: var(--accent-rose);
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 4px;
  cursor: pointer;
  font-family: inherit;
  flex-shrink: 0;
}

.dismiss-btn:hover {
  background: rgba(251, 113, 133, 0.22);
}

.empty-column {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 28px 12px;
  color: var(--text-muted);
  gap: 4px;
  text-align: center;
  flex: 1;
}

.empty-column p {
  margin: 0;
  font-size: 12px;
}

.empty-column .hint {
  font-size: 11px;
  opacity: 0.7;
}

.log-empty {
  border: 1px dashed rgba(56, 189, 248, 0.2);
  border-radius: 8px;
  background: rgba(56, 189, 248, 0.03);
}

.ws-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.65);
  backdrop-filter: blur(6px);
  z-index: 1200;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
}

.ws-panel {
  width: min(520px, 100%);
  max-height: 80vh;
  overflow: auto;
  background: rgba(8, 14, 26, 0.95);
  border: 1px solid var(--border-glow);
  border-radius: 12px;
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  box-shadow: 0 0 40px rgba(56, 189, 248, 0.1);
}

.ws-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.ws-header h2 {
  margin: 0;
  color: var(--text-primary);
  font-size: 16px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.ws-header .close-btn {
  border: none;
  background: transparent;
  color: var(--text-muted);
  font-size: 22px;
  cursor: pointer;
  line-height: 1;
}

.ws-hint {
  margin: 0;
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.5;
}

.ws-create,
.ws-footer {
  display: flex;
  gap: 10px;
}

.ws-input {
  flex: 1;
  padding: 10px 12px;
  border-radius: 6px;
  border: 1px solid rgba(56, 189, 248, 0.25);
  background: rgba(56, 189, 248, 0.06);
  color: var(--text-primary);
  outline: none;
  font-family: inherit;
  font-size: 13px;
}

.ws-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.ws-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px;
  border-radius: 8px;
  border: 1px solid rgba(56, 189, 248, 0.14);
  background: rgba(12, 22, 40, 0.6);
}

.ws-item.active {
  border-color: rgba(56, 189, 248, 0.5);
  background: rgba(56, 189, 248, 0.1);
  box-shadow: 0 0 16px rgba(56, 189, 248, 0.1);
}

.ws-meta {
  flex: 1;
  min-width: 0;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.ws-name {
  color: var(--text-primary);
  font-weight: 600;
  font-size: 13px;
}

.ws-count {
  color: var(--text-muted);
  font-size: 11px;
}

.ws-actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.ws-mini {
  border: 1px solid rgba(56, 189, 248, 0.2);
  border-radius: 4px;
  padding: 4px 8px;
  font-size: 11px;
  cursor: pointer;
  background: rgba(56, 189, 248, 0.08);
  color: var(--text-muted);
  font-family: inherit;
}

.ws-mini:hover:not(:disabled) {
  color: var(--accent-cyan);
  border-color: rgba(56, 189, 248, 0.4);
}

.ws-mini.danger {
  color: var(--accent-rose);
  border-color: rgba(251, 113, 133, 0.3);
  background: rgba(251, 113, 133, 0.08);
}

.ws-mini:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

@media (max-width: 1200px) {
  .board {
    grid-template-columns: minmax(200px, 1fr) minmax(200px, 1fr) minmax(280px, 1.2fr);
  }
}

@media (max-width: 960px) {
  .board {
    grid-template-columns: 1fr 1fr;
    grid-template-rows: minmax(220px, 1fr) minmax(240px, 0.85fr);
    gap: 10px;
  }

  .side-panel {
    grid-column: 1 / -1;
  }

  .side-errors {
    flex-basis: 34%;
    max-height: 40%;
  }
}

@media (max-width: 640px) {
  .dashboard-container {
    padding: 10px;
  }

  .board {
    grid-template-columns: 1fr;
    grid-template-rows: minmax(180px, 0.9fr) minmax(180px, 0.9fr) minmax(260px, 1.1fr);
  }

  .side-panel {
    grid-column: auto;
  }

  .stats {
    gap: 12px;
  }
}
</style>
