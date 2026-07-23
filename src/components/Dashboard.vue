<script setup lang="ts">
import { ref } from 'vue'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { open as openUrl } from '@tauri-apps/plugin-shell'
import { useProjectStore, type Project } from '@/stores/project'
import ProjectDetail from './ProjectDetail.vue'
import { toastSuccess, toastError } from '@/utils/toast'

const store = useProjectStore()
const showWorkspacePanel = ref(false)
const newWorkspaceName = ref('')
const renamingId = ref<string | null>(null)
const renameValue = ref('')

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

function handleProjectClick(project: Project) {
  store.selectProject(project.path)
}

function handleRunClick(runId: string) {
  store.selectRun(runId)
}

function handleCloseDetail() {
  store.clearSelection()
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

async function handleRemoveProject(project: Project) {
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
    <header class="header">
      <div class="header-left">
        <h1 class="title">Project Launcher</h1>
        <p class="subtitle">工作区: {{ store.activeWorkspaceName }}</p>
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
      <section class="column stopped">
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
            v-for="project in store.projects"
            :key="project.path"
            class="tile project-tile"
            :class="{
              selected:
                store.selectedProjectPath === project.path && store.detailMode === 'project',
              running: store.hasRunningScripts(project.path),
            }"
            @click="handleProjectClick(project)"
          >
            <div class="tile-header">
              <span
                class="status-dot"
                :class="store.hasRunningScripts(project.path) ? 'running' : 'stopped'"
              ></span>
              <h3 class="project-name">{{ project.name }}</h3>
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
          </div>
        </div>
      </section>

      <section class="column errored">
        <div class="column-header">
          <span class="column-dot errored"></span>
          <h2>异常</h2>
          <span class="column-count">{{ store.erroredRunList.length }}</span>
        </div>
        <div class="column-body">
          <div
            v-for="run in store.erroredRunList"
            :key="run.runId"
            class="tile project-tile errored"
            :class="{ selected: store.selectedProjectPath === run.project.path }"
            @click="handleProjectClick(run.project)"
          >
            <div class="tile-header">
              <span class="status-dot errored"></span>
              <h3 class="project-name">{{ run.project.name }}</h3>
              <button
                class="tile-delete"
                title="清除记录"
                @click.stop="handleClearError(run.runId)"
              >
                ×
              </button>
            </div>
            <p class="project-path">{{ run.project.path }}</p>
            <div class="errored-info">
              <span class="error-text">{{ run.script }} 异常退出</span>
              <button class="dismiss-btn" @click.stop="handleClearError(run.runId)">
                清除
              </button>
            </div>
          </div>

          <div v-if="store.erroredRunList.length === 0" class="empty-column">
            <p>暂无异常记录</p>
          </div>
        </div>
      </section>
    </main>

    <ProjectDetail
      v-if="store.selectedProject"
      :project="store.selectedProject"
      :mode="store.detailMode"
      :run-id="store.selectedRunId"
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
  display: flex;
  flex-direction: column;
  height: 100vh;
  padding: 20px;
  gap: 20px;
}

.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 20px 30px;
  background: rgba(255, 255, 255, 0.05);
  backdrop-filter: blur(20px);
  border-radius: 16px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  gap: 20px;
  flex-wrap: wrap;
}

.header-left {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.title {
  font-size: 24px;
  font-weight: 700;
  color: #fff;
  margin: 0;
}

.subtitle {
  font-size: 13px;
  color: rgba(255, 255, 255, 0.5);
  margin: 0;
  max-width: 420px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.header-right {
  display: flex;
  align-items: center;
  gap: 24px;
  flex-wrap: wrap;
}

.stats {
  display: flex;
  gap: 24px;
}

.stat-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}

.stat-value {
  font-size: 22px;
  font-weight: 700;
  color: #fff;
}

.stat-item.running .stat-value {
  color: #4ade80;
}

.stat-item.errored .stat-value {
  color: #f87171;
}

.stat-label {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.5);
}

.actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}

.btn {
  padding: 10px 16px;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  border: none;
  transition: all 0.2s;
}

.btn-secondary {
  background: rgba(255, 255, 255, 0.1);
  color: #fff;
}

.btn-secondary:hover {
  background: rgba(255, 255, 255, 0.2);
}

.btn-danger {
  background: #ef4444;
  color: #fff;
}

.btn-danger:hover {
  background: #dc2626;
}

.btn-outline {
  background: transparent;
  color: rgba(255, 255, 255, 0.8);
  border: 1px solid rgba(255, 255, 255, 0.2);
}

.btn-outline:hover {
  background: rgba(255, 255, 255, 0.1);
}

.board {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
}

.column {
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 16px;
  overflow: hidden;
}

.column-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px 16px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

.column-header h2 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.85);
  flex: 1;
}

.column-count {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.45);
  background: rgba(255, 255, 255, 0.08);
  padding: 2px 8px;
  border-radius: 999px;
}

.column-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.column-dot.stopped {
  background: #9ca3af;
}

.column-dot.running {
  background: #4ade80;
}

.column-dot.errored {
  background: #f87171;
}

.column-body {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.tile {
  background: rgba(255, 255, 255, 0.05);
  border-radius: 14px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  padding: 16px;
  cursor: pointer;
  transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.tile:hover {
  border-color: rgba(255, 255, 255, 0.2);
  transform: translateY(-2px);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25);
}

.add-tile {
  background: linear-gradient(135deg, rgba(102, 126, 234, 0.2) 0%, rgba(118, 75, 162, 0.2) 100%);
  border-color: rgba(102, 126, 234, 0.3);
  align-items: center;
  justify-content: center;
  min-height: 96px;
}

.add-tile:hover {
  background: linear-gradient(135deg, rgba(102, 126, 234, 0.3) 0%, rgba(118, 75, 162, 0.3) 100%);
}

.add-icon {
  color: #667eea;
}

.add-text {
  color: rgba(255, 255, 255, 0.7);
  font-size: 13px;
  font-weight: 500;
}

.project-tile.selected {
  border-color: #667eea;
  background: rgba(102, 126, 234, 0.1);
}

.project-tile.running {
  border-color: rgba(74, 222, 128, 0.4);
  background: rgba(74, 222, 128, 0.05);
}

.project-tile.errored {
  border-color: rgba(248, 113, 113, 0.45);
  background: rgba(248, 113, 113, 0.06);
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
  border-radius: 6px;
  background: transparent;
  color: rgba(255, 255, 255, 0.35);
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
  flex-shrink: 0;
}

.tile-delete:hover {
  background: rgba(239, 68, 68, 0.2);
  color: #f87171;
}

.tile-stop {
  margin-left: auto;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 6px;
  background: rgba(239, 68, 68, 0.15);
  color: #f87171;
  font-size: 10px;
  line-height: 1;
  cursor: pointer;
  flex-shrink: 0;
}

.tile-stop:hover {
  background: rgba(239, 68, 68, 0.3);
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.status-dot.running {
  background: #4ade80;
  animation: pulse 2s infinite;
}

.status-dot.stopped {
  background: #9ca3af;
}

.status-dot.errored {
  background: #f87171;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

.project-name {
  font-size: 15px;
  font-weight: 600;
  color: #fff;
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.project-path {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.4);
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.running-info,
.errored-info {
  margin-top: auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.stopped-info {
  margin-top: auto;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
}

.running-badge {
  font-size: 12px;
  color: #4ade80;
}

.current-script {
  font-size: 12px;
  color: #4ade80;
  font-weight: 500;
}

.ports {
  display: flex;
  gap: 6px;
  margin-top: 6px;
  flex-wrap: wrap;
}

.port {
  background: rgba(74, 222, 128, 0.2);
  color: #4ade80;
  padding: 2px 8px;
  border-radius: 12px;
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
  border: none;
}

.port:hover {
  background: rgba(74, 222, 128, 0.3);
  text-decoration: underline;
}

.waiting-port {
  margin-top: 6px;
  font-size: 11px;
  color: rgba(255, 255, 255, 0.35);
}

.script-count,
.error-text {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.45);
}

.error-text {
  color: #f87171;
}

.dismiss-btn {
  border: none;
  background: rgba(255, 255, 255, 0.08);
  color: rgba(255, 255, 255, 0.7);
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 6px;
  cursor: pointer;
}

.dismiss-btn:hover {
  background: rgba(255, 255, 255, 0.14);
}

.empty-column {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 32px 12px;
  color: rgba(255, 255, 255, 0.4);
  gap: 4px;
  text-align: center;
}

.empty-column p {
  margin: 0;
  font-size: 13px;
}

.empty-column .hint {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.28);
}

.ws-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(4px);
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
  background: linear-gradient(180deg, #1a1a2e 0%, #16213e 100%);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 16px;
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.ws-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.ws-header h2 {
  margin: 0;
  color: #fff;
  font-size: 18px;
}

.ws-header .close-btn {
  border: none;
  background: transparent;
  color: rgba(255, 255, 255, 0.5);
  font-size: 24px;
  cursor: pointer;
  line-height: 1;
}

.ws-hint {
  margin: 0;
  font-size: 13px;
  color: rgba(255, 255, 255, 0.45);
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
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(255, 255, 255, 0.06);
  color: #fff;
  outline: none;
}

.ws-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.ws-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px;
  border-radius: 12px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  background: rgba(255, 255, 255, 0.04);
}

.ws-item.active {
  border-color: rgba(102, 126, 234, 0.5);
  background: rgba(102, 126, 234, 0.12);
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
  color: #fff;
  font-weight: 600;
  font-size: 14px;
}

.ws-count {
  color: rgba(255, 255, 255, 0.4);
  font-size: 12px;
}

.ws-actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.ws-mini {
  border: none;
  border-radius: 6px;
  padding: 4px 8px;
  font-size: 12px;
  cursor: pointer;
  background: rgba(255, 255, 255, 0.1);
  color: rgba(255, 255, 255, 0.75);
}

.ws-mini:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.16);
}

.ws-mini.danger {
  color: #f87171;
  background: rgba(239, 68, 68, 0.15);
}

.ws-mini:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

@media (max-width: 960px) {
  .board {
    grid-template-columns: 1fr;
  }
}
</style>
