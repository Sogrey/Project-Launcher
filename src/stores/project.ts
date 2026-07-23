import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { toastError, toastWarning } from '@/utils/toast'

export interface Project {
  name: string
  path: string
  scripts: [string, string][]
}

export interface Workspace {
  id: string
  name: string
  projects: Project[]
}

export interface AppConfig {
  activeWorkspaceId: string
  workspaces: Workspace[]
}

export type PackageManager = 'npm' | 'pnpm' | 'yarn'

/** One running script instance (a project may have several). */
export interface RunningRun {
  runId: string
  project: Project
  script: string
  packageManager: PackageManager
  /** Bumped on each start; used to ignore stale stop events after restart. */
  epoch: number
}

export interface ErroredRun {
  runId: string
  project: Project
  script: string
}

const MAX_LOG_LINES = 2000

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

function defaultConfig(): AppConfig {
  return {
    activeWorkspaceId: 'ws_default',
    workspaces: [{ id: 'ws_default', name: '默认', projects: [] }],
  }
}

export const useProjectStore = defineStore('project', () => {
  const workspaces = ref<Workspace[]>([])
  const activeWorkspaceId = ref<string>('ws_default')
  const projects = ref<Project[]>([])
  /** Key = runId (`pathId@script`), matches Rust backend. */
  const runningRuns = ref<Map<string, RunningRun>>(new Map())
  /** Logs / ports keyed by runId so scripts do not share output or ports. */
  const runLogs = ref<Map<string, string[]>>(new Map())
  const runPorts = ref<Map<string, string[]>>(new Map())
  const erroredRuns = ref<Map<string, ErroredRun>>(new Map())
  /** Last start epoch per runId (monotonic). */
  const runEpochs = ref<Map<string, number>>(new Map())
  /** Epoch that a pending stop intends to clear; stale events are ignored. */
  const pendingStopEpoch = ref<Map<string, number>>(new Map())
  const selectedProjectPath = ref<string | null>(null)
  /** When set, detail drawer is for a single running script. */
  const selectedRunId = ref<string | null>(null)
  const packageManager = ref<PackageManager>('npm')
  const todayStartCount = ref(0)
  const initialized = ref(false)

  const activeWorkspace = computed(
    () => workspaces.value.find((w) => w.id === activeWorkspaceId.value) || null
  )
  const activeWorkspaceName = computed(() => activeWorkspace.value?.name || '未命名')

  const totalProjects = computed(() => projects.value.length)

  const runningRunList = computed(() =>
    [...runningRuns.value.values()].filter((run) =>
      projects.value.some((p) => p.path === run.project.path)
    )
  )

  const runningCount = computed(() => runningRunList.value.length)

  const erroredRunList = computed(() =>
    [...erroredRuns.value.values()].filter((run) =>
      projects.value.some((p) => p.path === run.project.path)
    )
  )

  const erroredCount = computed(() => erroredRunList.value.length)

  const selectedProject = computed(() =>
    selectedProjectPath.value
      ? projects.value.find((p) => p.path === selectedProjectPath.value)
      : null
  )

  /** `project` = script list drawer; `run` = single-script log drawer. */
  const detailMode = computed<'project' | 'run'>(() =>
    selectedRunId.value ? 'run' : 'project'
  )

  const selectedRun = computed(() =>
    selectedRunId.value ? runningRuns.value.get(selectedRunId.value) || null : null
  )

  function nextEpoch(runId: string): number {
    const epoch = (runEpochs.value.get(runId) || 0) + 1
    runEpochs.value.set(runId, epoch)
    return epoch
  }

  function clearRunRuntime(runId: string) {
    runningRuns.value.delete(runId)
    runPorts.value.delete(runId)
    runLogs.value.delete(runId)
    pendingStopEpoch.value.delete(runId)
    if (selectedRunId.value === runId) {
      clearSelection()
    }
  }

  function pathToProjectId(path: string): string {
    return path.replace(/[^\p{L}\p{N}]/gu, '_')
  }

  function runIdFor(path: string, script: string): string {
    return `${pathToProjectId(path)}@${script}`
  }

  function resolveRunId(runId: string): { path: string; script: string } | undefined {
    const at = runId.lastIndexOf('@')
    if (at <= 0) return undefined
    const pathId = runId.slice(0, at)
    const script = runId.slice(at + 1)
    const path = projects.value.find((p) => pathToProjectId(p.path) === pathId)?.path
    if (!path) return undefined
    return { path, script }
  }

  function pathFromRunId(runId: string): string | undefined {
    return resolveRunId(runId)?.path
  }

  function isScriptRunning(path: string, script: string): boolean {
    return runningRuns.value.has(runIdFor(path, script))
  }

  function runningScriptsFor(path: string): string[] {
    return [...runningRuns.value.values()]
      .filter((r) => r.project.path === path)
      .map((r) => r.script)
  }

  function hasRunningScripts(path: string): boolean {
    return runningScriptsFor(path).length > 0
  }

  function syncActiveProjectsFromWorkspaces() {
    const ws = workspaces.value.find((w) => w.id === activeWorkspaceId.value)
    projects.value = ws ? [...ws.projects] : []
  }

  function writeProjectsToActiveWorkspace() {
    const idx = workspaces.value.findIndex((w) => w.id === activeWorkspaceId.value)
    if (idx < 0) return
    workspaces.value[idx] = {
      ...workspaces.value[idx],
      projects: [...projects.value],
    }
  }

  async function persistConfig() {
    writeProjectsToActiveWorkspace()
    const config: AppConfig = {
      activeWorkspaceId: activeWorkspaceId.value,
      workspaces: workspaces.value.map((w) => ({
        ...w,
        projects: [...w.projects],
      })),
    }
    try {
      await invoke('save_app_config', { config })
    } catch (err) {
      console.error('persistConfig failed', err)
      toastError(`保存配置失败: ${errorMessage(err)}`)
    }
  }

  async function loadPersistedState() {
    if (initialized.value) return
    try {
      const config = await invoke<AppConfig>('load_app_config')
      const normalized = config?.workspaces?.length > 0 ? config : defaultConfig()

      workspaces.value = normalized.workspaces
      activeWorkspaceId.value = normalized.workspaces.some(
        (w) => w.id === normalized.activeWorkspaceId
      )
        ? normalized.activeWorkspaceId
        : normalized.workspaces[0].id
      syncActiveProjectsFromWorkspaces()
      initialized.value = true
    } catch (err) {
      const fallback = defaultConfig()
      workspaces.value = fallback.workspaces
      activeWorkspaceId.value = fallback.activeWorkspaceId
      syncActiveProjectsFromWorkspaces()
      toastError(`加载配置失败: ${errorMessage(err)}`)
      initialized.value = true
    }
  }

  function selectProject(path: string | null) {
    selectedProjectPath.value = path
    selectedRunId.value = null
  }

  function selectRun(runId: string | null) {
    if (!runId) {
      selectedRunId.value = null
      selectedProjectPath.value = null
      return
    }
    const run = runningRuns.value.get(runId)
    selectedRunId.value = runId
    selectedProjectPath.value = run?.project.path ?? pathFromRunId(runId) ?? null
  }

  function clearSelection() {
    selectedProjectPath.value = null
    selectedRunId.value = null
  }

  async function createWorkspace(name: string) {
    const trimmed = name.trim()
    if (!trimmed) {
      toastWarning('请输入工作区名称')
      return null
    }
    if (workspaces.value.some((w) => w.name === trimmed)) {
      toastWarning('已存在同名工作区')
      return null
    }

    if (runningRuns.value.size > 0) {
      await stopAllProjects()
    }

    writeProjectsToActiveWorkspace()
    const id = await invoke<string>('create_workspace_id')
    const ws: Workspace = { id, name: trimmed, projects: [] }
    workspaces.value.push(ws)
    activeWorkspaceId.value = id
    projects.value = []
    selectedProjectPath.value = null
    selectedRunId.value = null
    await persistConfig()
    return ws
  }

  async function switchWorkspace(id: string) {
    if (id === activeWorkspaceId.value) return
    const target = workspaces.value.find((w) => w.id === id)
    if (!target) {
      toastWarning('工作区不存在')
      return
    }

    if (runningRuns.value.size > 0) {
      await stopAllProjects()
    }

    writeProjectsToActiveWorkspace()
    activeWorkspaceId.value = id
    syncActiveProjectsFromWorkspaces()
    selectedProjectPath.value = null
    selectedRunId.value = null
    erroredRuns.value.clear()
    runLogs.value.clear()
    runPorts.value.clear()
    runEpochs.value.clear()
    pendingStopEpoch.value.clear()
    await persistConfig()
  }

  async function renameWorkspace(id: string, name: string) {
    const trimmed = name.trim()
    if (!trimmed) {
      toastWarning('请输入工作区名称')
      return
    }
    if (workspaces.value.some((w) => w.id !== id && w.name === trimmed)) {
      toastWarning('已存在同名工作区')
      return
    }
    const idx = workspaces.value.findIndex((w) => w.id === id)
    if (idx < 0) return
    workspaces.value[idx] = { ...workspaces.value[idx], name: trimmed }
    await persistConfig()
  }

  async function deleteWorkspace(id: string) {
    if (workspaces.value.length <= 1) {
      toastWarning('至少保留一个工作区')
      return
    }
    const idx = workspaces.value.findIndex((w) => w.id === id)
    if (idx < 0) return

    if (id === activeWorkspaceId.value && runningRuns.value.size > 0) {
      await stopAllProjects()
    }

    writeProjectsToActiveWorkspace()
    workspaces.value.splice(idx, 1)

    if (activeWorkspaceId.value === id) {
      activeWorkspaceId.value = workspaces.value[0].id
      syncActiveProjectsFromWorkspaces()
      selectedProjectPath.value = null
      selectedRunId.value = null
      erroredRuns.value.clear()
      runLogs.value.clear()
      runPorts.value.clear()
      runEpochs.value.clear()
      pendingStopEpoch.value.clear()
    }

    await persistConfig()
  }

  async function addProject(path: string) {
    try {
      const result = await invoke<Project | null>('scan_project', { path })
      if (!result) {
        toastWarning('未识别到 Node.js 项目（缺少 package.json）')
        return
      }
      const existingIndex = projects.value.findIndex((p) => p.path === result.path)
      if (existingIndex >= 0) {
        projects.value[existingIndex] = result
      } else {
        projects.value.push(result)
      }
      await persistConfig()
    } catch (err) {
      toastError(`添加项目失败: ${errorMessage(err)}`)
      throw err
    }
  }

  async function importFromDirectory(path: string) {
    try {
      const scanned = await invoke<Project[]>('scan_directory', { path })
      const byPath = new Map(projects.value.map((p) => [p.path, p]))
      for (const project of scanned) {
        byPath.set(project.path, project)
      }
      projects.value = Array.from(byPath.values())
      await persistConfig()
      return scanned.length
    } catch (err) {
      toastError(`导入失败: ${errorMessage(err)}`)
      throw err
    }
  }

  async function stopAllScriptsForProject(project: Project) {
    const scripts = runningScriptsFor(project.path)
    for (const script of scripts) {
      await stopProject(project, script)
    }
  }

  async function removeProject(project: Project) {
    try {
      await stopAllScriptsForProject(project)
      projects.value = projects.value.filter((p) => p.path !== project.path)
      for (const [runId, run] of [...runningRuns.value.entries()]) {
        if (run.project.path === project.path) runningRuns.value.delete(runId)
      }
      for (const [runId, run] of [...erroredRuns.value.entries()]) {
        if (run.project.path === project.path) erroredRuns.value.delete(runId)
      }
      for (const runId of [...runLogs.value.keys()]) {
        if (runId.startsWith(pathToProjectId(project.path) + '@') || pathFromRunId(runId) === project.path) {
          runLogs.value.delete(runId)
          runPorts.value.delete(runId)
        }
      }
      if (selectedProjectPath.value === project.path) {
        clearSelection()
      }
      await persistConfig()
    } catch (err) {
      toastError(`删除项目失败: ${errorMessage(err)}`)
      throw err
    }
  }

  async function startProject(project: Project, script: string) {
    const runId = runIdFor(project.path, script)
    try {
      const result = await invoke<{ success: boolean; message: string; project_id: string }>(
        'start_project',
        { path: project.path, script, packageManager: packageManager.value }
      )

      if (result.success) {
        erroredRuns.value.delete(runId)
        const id = result.project_id || runId
        const epoch = nextEpoch(id)
        runningRuns.value.set(id, {
          runId: id,
          project,
          script,
          packageManager: packageManager.value,
          epoch,
        })
        runLogs.value.set(id, [])
        todayStartCount.value += 1
      }

      return result
    } catch (err) {
      toastError(`启动失败: ${errorMessage(err)}`)
      return { success: false, message: errorMessage(err), project_id: '' }
    }
  }

  async function installProject(project: Project) {
    const runId = runIdFor(project.path, 'install')
    try {
      const result = await invoke<{ success: boolean; message: string; project_id: string }>(
        'install_project',
        { path: project.path, packageManager: packageManager.value }
      )

      if (result.success) {
        erroredRuns.value.delete(runId)
        const id = result.project_id || runId
        const epoch = nextEpoch(id)
        runningRuns.value.set(id, {
          runId: id,
          project,
          script: 'install',
          packageManager: packageManager.value,
          epoch,
        })
        runLogs.value.set(id, [])
      }

      return result
    } catch (err) {
      toastError(`安装失败: ${errorMessage(err)}`)
      return { success: false, message: errorMessage(err), project_id: '' }
    }
  }

  async function stopProject(project: Project, script: string) {
    const runId = runIdFor(project.path, script)
    const run = runningRuns.value.get(runId)
    if (run) {
      pendingStopEpoch.value.set(runId, run.epoch)
    }

    try {
      await invoke('stop_project', { path: project.path, script })
      const current = runningRuns.value.get(runId)
      const pending = pendingStopEpoch.value.get(runId)
      // Keep newer instance if restart already started after this stop.
      if (current && pending !== undefined && current.epoch !== pending) {
        return
      }
      clearRunRuntime(runId)
    } catch (err) {
      // Keep frontend running state so user can retry stop (#6).
      pendingStopEpoch.value.delete(runId)
      toastError(`停止失败: ${errorMessage(err)}`)
      throw err
    }
  }

  async function restartProject(project: Project, script: string) {
    if (script === 'install') {
      toastWarning('安装完成后请手动启动脚本')
      return { success: false, message: '无法重启', project_id: '' }
    }
    if (isScriptRunning(project.path, script)) {
      await stopProject(project, script)
    }
    return startProject(project, script)
  }

  async function stopAllProjects() {
    try {
      await invoke('stop_all_projects')
      runningRuns.value.clear()
      runPorts.value.clear()
      runLogs.value.clear()
      pendingStopEpoch.value.clear()
      if (selectedRunId.value) clearSelection()
    } catch (err) {
      // Best-effort clear; backend may have partially stopped.
      runningRuns.value.clear()
      runPorts.value.clear()
      runLogs.value.clear()
      pendingStopEpoch.value.clear()
      if (selectedRunId.value) clearSelection()
      toastError(`一键全停失败: ${errorMessage(err)}`)
      throw err
    }
  }

  function markStopped(runId: string) {
    const run = runningRuns.value.get(runId)
    const pending = pendingStopEpoch.value.get(runId)
    if (run && pending !== undefined && run.epoch !== pending) {
      // Stale stop event from a previous instance (e.g. after restart).
      pendingStopEpoch.value.delete(runId)
      return
    }
    if (run && pending === undefined) {
      // stop_all / external: clear only if no newer start race — treat as clear.
    }
    clearRunRuntime(runId)
  }

  function markExited(runId: string, success: boolean) {
    const run = runningRuns.value.get(runId)
    const pending = pendingStopEpoch.value.get(runId)
    if (run && pending !== undefined && run.epoch !== pending) {
      pendingStopEpoch.value.delete(runId)
      return
    }

    // Natural exit of current instance (or stop without pending epoch).
    if (run && pending === undefined) {
      // Could be exit of older instance after restart: epoch already bumped.
      // Without backend epoch we only clear if this is still the tracked run —
      // which it is if restart bumped epoch and replaced the map entry.
      // Stale exit for old process: old process was removed from backend map on
      // kill, so exit usually isn't emitted. Safe to clear current.
    }

    const exitedRun = run
    clearRunRuntime(runId)

    if (!success && exitedRun) {
      erroredRuns.value.set(runId, {
        runId,
        project: exitedRun.project,
        script: exitedRun.script,
      })
    } else {
      erroredRuns.value.delete(runId)
    }
  }

  function addPort(runId: string, port: string) {
    const ports = runPorts.value.get(runId) || []
    if (!ports.includes(port)) {
      runPorts.value.set(runId, [...ports, port])
    }
  }

  function clearPorts(runId: string) {
    runPorts.value.set(runId, [])
  }

  function portsForRun(runId: string): string[] {
    return runPorts.value.get(runId) || []
  }

  function addLog(runId: string, log: string) {
    const logs = runLogs.value.get(runId) || []
    logs.push(log)
    if (logs.length > MAX_LOG_LINES) {
      logs.splice(0, logs.length - MAX_LOG_LINES)
    }
    runLogs.value.set(runId, [...logs])
  }

  function clearLogs(runId: string) {
    runLogs.value.set(runId, [])
  }

  function logsForRun(runId: string): string[] {
    return runLogs.value.get(runId) || []
  }

  function clearError(runId: string) {
    erroredRuns.value.delete(runId)
  }

  return {
    workspaces,
    activeWorkspaceId,
    activeWorkspace,
    activeWorkspaceName,
    projects,
    runningRuns,
    runLogs,
    runPorts,
    erroredRuns,
    selectedProjectPath,
    selectedRunId,
    selectedProject,
    selectedRun,
    detailMode,
    packageManager,
    todayStartCount,
    totalProjects,
    runningCount,
    erroredCount,
    runningRunList,
    erroredRunList,
    loadPersistedState,
    createWorkspace,
    switchWorkspace,
    renameWorkspace,
    deleteWorkspace,
    addProject,
    importFromDirectory,
    removeProject,
    selectProject,
    selectRun,
    clearSelection,
    startProject,
    installProject,
    stopProject,
    restartProject,
    stopAllProjects,
    stopAllScriptsForProject,
    markStopped,
    markExited,
    pathFromRunId,
    resolveRunId,
    runIdFor,
    isScriptRunning,
    runningScriptsFor,
    hasRunningScripts,
    addPort,
    clearPorts,
    portsForRun,
    addLog,
    clearLogs,
    logsForRun,
    clearError,
  }
})
