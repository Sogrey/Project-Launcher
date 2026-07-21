<script setup lang="ts">
import { ref, computed } from 'vue'
import { useProjectStore, type Project } from '@/stores/project'
import { toastSuccess, toastError } from '@/utils/toast'
import { open } from '@tauri-apps/plugin-shell'
import LogPanel from '@/components/LogPanel.vue'

const props = defineProps<{
  project: Project
}>()

const emit = defineEmits<{
  (e: 'close'): void
}>()

const store = useProjectStore()
const showLogs = ref(false)

const runningInfo = computed(() => store.runningProjects.get(props.project.path))
const isRunning = computed(() => runningInfo.value?.isRunning ?? false)
const isErrored = computed(() => store.erroredProjectPaths.has(props.project.path))
const currentScript = computed(() => runningInfo.value?.script ?? '')
const ports = computed(() => store.projectPorts.get(props.project.path) || [])
const projectLogs = computed(() => store.projectLogs.get(props.project.path) || [])

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

function toggleLogs() {
  showLogs.value = !showLogs.value
}

async function openUrl(port: string) {
  await open(`http://localhost:${port}`)
}

async function handleScriptClick(script: string) {
  try {
    if (isRunning.value && currentScript.value === script) {
      await store.stopProject(props.project)
    } else {
      const result = await store.startProject(props.project, script)
      if (!result.success) {
        toastError(result.message || '启动失败')
      }
    }
  } catch (e) {
    toastError(e instanceof Error ? e.message : '操作失败')
  }
}

async function handleRestart() {
  try {
    const result = await store.restartProject(props.project)
    if (!result.success) {
      toastError(result.message || '重启失败')
    } else {
      toastSuccess('已重启')
    }
  } catch (e) {
    toastError(e instanceof Error ? e.message : '重启失败')
  }
}

async function handleRemove() {
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
          <span class="status-indicator" :class="{ running: isRunning }"></span>
          <div>
            <h2 class="project-name">{{ project.name }}</h2>
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
        <div class="section">
          <h3 class="section-title">运行状态</h3>
          <div class="status-card" :class="{ running: isRunning, errored: isErrored && !isRunning }">
            <div class="status-info">
              <span class="status-text">{{ isRunning ? '运行中' : (isErrored ? '异常退出' : '已停止') }}</span>
              <span v-if="isRunning" class="current-script">脚本: {{ currentScript }}</span>
            </div>
            <div class="status-actions">
              <button
                v-if="isRunning"
                class="action-btn restart"
                @click="handleRestart"
              >
                重启
              </button>
              <button class="action-btn danger" @click="handleRemove">
                删除项目
              </button>
            </div>
            <div v-if="ports.length > 0" class="ports">
              <button 
                v-for="port in ports" 
                :key="port" 
                class="port-tag"
                @click="openUrl(port)"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                </svg>
                http://localhost:{{ port }}
              </button>
            </div>
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
        </div>

        <div class="section">
          <h3 class="section-title">脚本列表</h3>
          <div class="script-list">
            <div 
              v-for="[name, value] in recommendedScripts" 
              :key="name"
              class="script-item"
            >
              <span class="status-dot" :class="{ running: isRunning && currentScript === name }"></span>
              <span class="script-name">{{ name }}</span>
              <span class="script-value">{{ value }}</span>
              <button 
                class="script-action-btn"
                :class="{ running: isRunning && currentScript === name }"
                @click="handleScriptClick(name)"
              >
                {{ isRunning && currentScript === name ? '停止' : '启动' }}
              </button>
            </div>
          </div>
        </div>

        <div class="section">
          <div class="section-header">
            <h3 class="section-title">运行日志</h3>
            <button class="log-toggle" @click="toggleLogs">
              {{ showLogs ? '收起' : '展开' }}
            </button>
          </div>
          <LogPanel
            v-if="showLogs"
            :project-path="project.path"
            :logs="projectLogs"
            @clear="store.clearLogs(project.path)"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.detail-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(4px);
  z-index: 1000;
  display: flex;
  justify-content: flex-end;
}

.detail-panel {
  width: 90vw;
  max-width: 420px;
  height: 100%;
  background: linear-gradient(180deg, #1a1a2e 0%, #16213e 100%);
  border-left: 1px solid rgba(255, 255, 255, 0.1);
  display: flex;
  flex-direction: column;
  animation: slideIn 0.3s ease-out;
}

@keyframes slideIn {
  from { transform: translateX(100%); opacity: 0; }
  to { transform: translateX(0); opacity: 1; }
}

.detail-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 20px 24px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
}

.project-header {
  display: flex;
  align-items: center;
  gap: 12px;
}

.status-indicator {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #9ca3af;
}

.status-indicator.running {
  background: #4ade80;
  animation: pulse 2s infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

.project-name {
  font-size: 20px;
  font-weight: 700;
  color: #fff;
  margin: 0 0 4px 0;
}

.project-path {
  font-size: 12px;
  color: rgba(255, 255, 255, 0.4);
  margin: 0;
  max-width: 280px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.close-btn {
  background: transparent;
  border: none;
  color: rgba(255, 255, 255, 0.5);
  cursor: pointer;
  padding: 8px;
  border-radius: 8px;
  transition: all 0.2s;
}

.close-btn:hover {
  background: rgba(255, 255, 255, 0.1);
  color: rgba(255, 255, 255, 0.8);
}

.detail-body {
  flex: 1;
  overflow-y: auto;
  padding: 20px 24px;
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.section {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.section-title {
  font-size: 14px;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.7);
  margin: 0;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.log-toggle {
  background: transparent;
  border: none;
  color: #667eea;
  font-size: 13px;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 4px;
  transition: all 0.2s;
}

.log-toggle:hover {
  background: rgba(102, 126, 234, 0.1);
}

.status-card {
  background: rgba(255, 255, 255, 0.05);
  border-radius: 12px;
  padding: 16px;
  border: 1px solid rgba(255, 255, 255, 0.1);
}

.status-card.running {
  background: rgba(74, 222, 128, 0.05);
  border-color: rgba(74, 222, 128, 0.3);
}

.status-card.errored {
  background: rgba(239, 68, 68, 0.05);
  border-color: rgba(239, 68, 68, 0.3);
}

.status-info {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.status-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}

.action-btn {
  padding: 6px 12px;
  font-size: 12px;
  border-radius: 6px;
  border: none;
  cursor: pointer;
  transition: all 0.2s;
  background: rgba(255, 255, 255, 0.1);
  color: rgba(255, 255, 255, 0.8);
}

.action-btn:hover {
  background: rgba(255, 255, 255, 0.16);
}

.action-btn.restart {
  background: rgba(102, 126, 234, 0.25);
  color: #a5b4fc;
}

.action-btn.restart:hover {
  background: rgba(102, 126, 234, 0.35);
}

.action-btn.danger {
  background: rgba(239, 68, 68, 0.2);
  color: #f87171;
}

.action-btn.danger:hover {
  background: rgba(239, 68, 68, 0.3);
}

.status-text {
  font-size: 16px;
  font-weight: 600;
  color: #fff;
}

.current-script {
  font-size: 13px;
  color: rgba(255, 255, 255, 0.5);
}

.ports {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 12px;
}

.port-tag {
  display: flex;
  align-items: center;
  gap: 4px;
  background: rgba(102, 126, 234, 0.2);
  color: #667eea;
  padding: 4px 10px;
  border-radius: 20px;
  font-size: 12px;
  cursor: pointer;
  border: none;
  transition: all 0.2s;
}

.port-tag:hover {
  background: rgba(102, 126, 234, 0.3);
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
  padding: 12px 14px;
  background: rgba(255, 255, 255, 0.05);
  border-radius: 10px;
  border: 1px solid rgba(255, 255, 255, 0.1);
}

.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #9ca3af;
  flex-shrink: 0;
}

.status-dot.running {
  background: #4ade80;
  animation: pulse 2s infinite;
}

.script-name {
  font-size: 14px;
  font-weight: 600;
  color: #fff;
  flex-shrink: 0;
  min-width: 60px;
}

.script-value {
  font-size: 13px;
  color: rgba(255, 255, 255, 0.5);
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.script-action-btn {
  padding: 4px 12px;
  font-size: 12px;
  border-radius: 6px;
  border: none;
  cursor: pointer;
  transition: all 0.2s;
  background: rgba(255, 255, 255, 0.1);
  color: rgba(255, 255, 255, 0.7);
}

.script-action-btn:hover {
  background: rgba(255, 255, 255, 0.15);
}

.script-action-btn.running {
  background: rgba(239, 68, 68, 0.2);
  color: #ef4444;
}

.script-action-btn.running:hover {
  background: rgba(239, 68, 68, 0.3);
}

.pm-select-native {
  width: 100%;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(255, 255, 255, 0.05);
  color: #fff;
  font-size: 14px;
  outline: none;
}

.pm-select-native:focus {
  border-color: rgba(102, 126, 234, 0.6);
}

.pm-select-native option {
  background: #1a1a2e;
  color: #fff;
}

</style>
