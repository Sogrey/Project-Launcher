<script setup lang="ts">
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { open as openUrl } from '@tauri-apps/plugin-shell'
import { useProjectStore, type Project } from '@/stores/project'
import ProjectDetail from './ProjectDetail.vue'
import { toastSuccess, toastError } from '@/utils/toast'

const store = useProjectStore()

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

async function handleSelectWorkspace() {
  try {
    const result = await openDialog({ directory: true, title: '选择工作区根目录' })
    if (!result) return
    const count = await store.scanWorkspace(result.toString())
    toastSuccess(`工作区扫描完成，发现 ${count} 个项目`)
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

function handleCloseDetail() {
  store.selectProject(null)
}

function getCurrentScript(project: Project) {
  return store.runningProjects.get(project.path)?.script || ''
}

function getProjectPorts(project: Project) {
  return store.projectPorts.get(project.path) || []
}

async function handleStopAll() {
  try {
    await store.stopAllProjects()
    toastSuccess('已停止所有项目')
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
</script>

<template>
  <div class="dashboard-container">
    <header class="header">
      <div class="header-left">
        <h1 class="title">Project Launcher</h1>
        <p v-if="store.workspacePath" class="subtitle" :title="store.workspacePath">
          工作区: {{ store.workspacePath }}
        </p>
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
          <button class="btn btn-outline" @click="handleSelectWorkspace">
            {{ store.workspacePath ? '更换工作区' : '选择工作区' }}
          </button>
          <button class="btn btn-secondary" @click="handleAddProject">新增项目</button>
          <button class="btn btn-danger" @click="handleStopAll">一键全停</button>
        </div>
      </div>
    </header>

    <main class="board">
      <section class="column stopped">
        <div class="column-header">
          <span class="column-dot stopped"></span>
          <h2>待处理</h2>
          <span class="column-count">{{ store.stoppedProjects.length }}</span>
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
            v-for="project in store.stoppedProjects"
            :key="project.path"
            class="tile project-tile"
            :class="{ selected: store.selectedProjectPath === project.path }"
            @click="handleProjectClick(project)"
          >
            <div class="tile-header">
              <span class="status-dot stopped"></span>
              <h3 class="project-name">{{ project.name }}</h3>
              <button
                class="tile-delete"
                title="删除项目"
                @click.stop="handleRemoveProject(project)"
              >
                ×
              </button>
            </div>
            <p class="project-path">{{ project.path }}</p>
            <div class="stopped-info">
              <span class="script-count">{{ project.scripts.length }} 个脚本</span>
            </div>
          </div>

          <div v-if="store.stoppedProjects.length === 0" class="empty-column">
            <p>暂无待处理项目</p>
            <p class="hint">选择工作区或手动添加</p>
          </div>
        </div>
      </section>

      <section class="column running">
        <div class="column-header">
          <span class="column-dot running"></span>
          <h2>进行中</h2>
          <span class="column-count">{{ store.runningProjectList.length }}</span>
        </div>
        <div class="column-body">
          <div
            v-for="project in store.runningProjectList"
            :key="project.path"
            class="tile project-tile running"
            :class="{ selected: store.selectedProjectPath === project.path }"
            @click="handleProjectClick(project)"
          >
            <div class="tile-header">
              <span class="status-dot running"></span>
              <h3 class="project-name">{{ project.name }}</h3>
              <button
                class="tile-delete"
                title="删除项目"
                @click.stop="handleRemoveProject(project)"
              >
                ×
              </button>
            </div>
            <p class="project-path">{{ project.path }}</p>
            <div class="running-info">
              <span class="current-script">运行中: {{ getCurrentScript(project) }}</span>
              <div v-if="getProjectPorts(project).length > 0" class="ports">
                <button
                  v-for="port in getProjectPorts(project).slice(0, 2)"
                  :key="port"
                  class="port"
                  @click.stop="handleOpenUrl(port)"
                >
                  {{ port }}
                </button>
              </div>
            </div>
          </div>

          <div v-if="store.runningProjectList.length === 0" class="empty-column">
            <p>暂无运行中的项目</p>
          </div>
        </div>
      </section>

      <section class="column errored">
        <div class="column-header">
          <span class="column-dot errored"></span>
          <h2>异常</h2>
          <span class="column-count">{{ store.erroredProjects.length }}</span>
        </div>
        <div class="column-body">
          <div
            v-for="project in store.erroredProjects"
            :key="project.path"
            class="tile project-tile errored"
            :class="{ selected: store.selectedProjectPath === project.path }"
            @click="handleProjectClick(project)"
          >
            <div class="tile-header">
              <span class="status-dot errored"></span>
              <h3 class="project-name">{{ project.name }}</h3>
              <button
                class="tile-delete"
                title="删除项目"
                @click.stop="handleRemoveProject(project)"
              >
                ×
              </button>
            </div>
            <p class="project-path">{{ project.path }}</p>
            <div class="errored-info">
              <span class="error-text">异常退出</span>
              <button
                class="dismiss-btn"
                @click.stop="store.clearError(project.path)"
              >
                清除
              </button>
            </div>
          </div>

          <div v-if="store.erroredProjects.length === 0" class="empty-column">
            <p>暂无异常项目</p>
          </div>
        </div>
      </section>
    </main>

    <ProjectDetail
      v-if="store.selectedProject"
      :project="store.selectedProject"
      @close="handleCloseDetail"
    />
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
.stopped-info,
.errored-info {
  margin-top: auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
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

@media (max-width: 960px) {
  .board {
    grid-template-columns: 1fr;
  }
}
</style>
