<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { useProjectStore } from '@/stores/project'
import Dashboard from '@/components/Dashboard.vue'

const store = useProjectStore()
const unlistens: UnlistenFn[] = []

onMounted(async () => {
  await store.loadPersistedState()

  unlistens.push(
    await listen<string>('project:stopped', (event) => {
      store.markStopped(event.payload)
    })
  )

  unlistens.push(
    await listen<[string, string]>('project:port', (event) => {
      const [projectId, port] = event.payload
      const projectPath = store.pathFromProjectId(projectId)
      if (projectPath) {
        store.addPort(projectPath, port)
      }
    })
  )

  unlistens.push(
    await listen<[string, string]>('project:log', (event) => {
      const [projectId, chunk] = event.payload
      const projectPath = store.pathFromProjectId(projectId)
      if (projectPath) {
        store.addLog(projectPath, chunk)
      }
    })
  )

  unlistens.push(
    await listen<{ project_id: string; code: number; success: boolean }>(
      'project:exited',
      (event) => {
        const { project_id, success } = event.payload
        store.markExited(project_id, success)
      }
    )
  )
})

onUnmounted(() => {
  unlistens.forEach((fn) => fn())
  unlistens.length = 0
})
</script>

<template>
  <div class="app-container">
    <Dashboard />
  </div>
</template>

<style scoped>
.app-container {
  width: 100%;
  min-height: 100vh;
}
</style>
