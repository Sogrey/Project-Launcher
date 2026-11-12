import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { toastError, toastSuccess, toastWarning } from '@/utils/toast'

export interface Project {
  name: string
  path: string
  scripts: [string, string][]
  /** Per-project preference; detected from package.json / lockfile. */
  packageManager?: PackageManager
}

export interface Workspace {
  id: string
  name: string
  projects: Project[]
}

export interface AppConfig {
  activeWorkspaceId: string
  workspaces: Workspace[]
  /** Max concurrent *build* jobs; extras wait in heavyQueue. Default 3. */
  heavyConcurrencyLimit?: number
}

export interface QueuedRun {
  project: Project
  script: string
  packageManager: PackageManager
  enqueuedAt: number
}

export interface MemoryStatus {
  totalBytes: number
  availableBytes: number
  memoryLoadPercent: number
}

/** Default / clamp for packaging-task concurrency (keep in sync with Rust). */
export const DEFAULT_HEAVY_CONCURRENCY = 3
export const MIN_HEAVY_CONCURRENCY = 1
export const MAX_HEAVY_CONCURRENCY = 8

/** Warn when free RAM is below this (bytes) or load is very high. */
const MEMORY_WARN_AVAILABLE_BYTES = 2 * 1024 * 1024 * 1024
const MEMORY_WARN_LOAD_PERCENT = 85

/**
 * Only *build* / compile packaging scripts are concurrency-limited + queued.
 * Non-build (`dev` / `start` / `serve` / `install` / …) are unlimited.
 */
export function isHeavyScript(script: string): boolean {
  const s = script.trim().toLowerCase()
  if (!s) return false
  if (s === 'build' || s === 'compile' || s === 'bundle' || s === 'typecheck' || s === 'tsc') {
    return true
  }
  // e.g. build-dev, build:prod, vue-build — but not "rebuild-cache" false positives from "build" substring OK for packaging
  return s.includes('build') || s.includes('compile') || s.includes('bundle') || s.includes('typecheck')
}

export function clampHeavyConcurrency(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_HEAVY_CONCURRENCY
  return Math.min(MAX_HEAVY_CONCURRENCY, Math.max(MIN_HEAVY_CONCURRENCY, Math.round(n)))
}

export interface InstalledIde {
  id: string
  name: string
  path: string
}

export type PackageManager = 'npm' | 'pnpm' | 'yarn'

const DEFAULT_PACKAGE_MANAGER: PackageManager = 'npm'

/** Match Rust `is_listed_script_name` in commands.rs — keep rules in sync. */
const RUNNABLE_SCRIPT_RE = /^[a-zA-Z0-9_:-]+$/

export function normalizePackageManager(pm: unknown): PackageManager {
  if (pm === 'pnpm' || pm === 'yarn' || pm === 'npm') return pm
  return DEFAULT_PACKAGE_MANAGER
}

/** Mirrors Rust `is_listed_script_name` in `commands.rs` — keep in sync. */
export function isListedScriptName(name: string): boolean {
  const trimmed = name.trimStart()
  if (!trimmed) return false
  if (
    trimmed.startsWith('//') ||
    trimmed.startsWith('#') ||
    trimmed.startsWith('@') ||
    trimmed.startsWith('/*') ||
    trimmed.startsWith('*') ||
    trimmed.startsWith('!') ||
    trimmed.startsWith('?') ||
    trimmed.startsWith(';')
  ) {
    return false
  }
  const first = trimmed[0]
  if (!/[a-zA-Z0-9_]/.test(first)) return false
  return RUNNABLE_SCRIPT_RE.test(name.trim())
}

export function sanitizeProjectScripts(project: Project): Project {
  return {
    ...project,
    packageManager: normalizePackageManager(project.packageManager),
    scripts: project.scripts.filter(([name]) => isListedScriptName(name)),
  }
}

export function packageManagerFor(project: Project): PackageManager {
  return normalizePackageManager(project.packageManager)
}

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
    heavyConcurrencyLimit: DEFAULT_HEAVY_CONCURRENCY,
  }
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`
  return `${bytes} B`
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
  /** @deprecated Prefer per-project `project.packageManager`; kept as fallback default. */
  const packageManager = ref<PackageManager>(DEFAULT_PACKAGE_MANAGER)
  const todayStartCount = ref(0)
  const initialized = ref(false)
  /** Detected editors — loaded once per app session (registry scan is slow). */
  const installedIdes = ref<InstalledIde[]>([])
  const idesReady = ref(false)
  const idesLoading = ref(false)
  let idesLoadPromise: Promise<void> | null = null
  /** Packaging tasks waiting for a free concurrency slot. */
  const heavyQueue = ref<QueuedRun[]>([])
  const heavyConcurrencyLimit = ref(DEFAULT_HEAVY_CONCURRENCY)
  let drainingHeavyQueue = false

  const activeWorkspace = computed(
    () => workspaces.value.find((w) => w.id === activeWorkspaceId.value) || null
  )
  const activeWorkspaceName = computed(() => activeWorkspace.value?.name || '未命名')

  const totalProjects = computed(() => projects.value.length)

  const heavyRunningCount = computed(
    () => [...runningRuns.value.values()].filter((r) => isHeavyScript(r.script)).length
  )

  const heavyQueueCount = computed(() => heavyQueue.value.length)

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

  const selectedRun = computed(() =>
    selectedRunId.value ? runningRuns.value.get(selectedRunId.value) || null : null
  )

  function nextEpoch(runId: string): number {
    const epoch = (runEpochs.value.get(runId) || 0) + 1
    runEpochs.value.set(runId, epoch)
    return epoch
  }

  function clearRunRuntime(runId: string, options?: { keepLogs?: boolean }) {
    runningRuns.value.delete(runId)
    runPorts.value.delete(runId)
    pendingStopEpoch.value.delete(runId)
    if (!options?.keepLogs) {
      runLogs.value.delete(runId)
    }
    if (selectedRunId.value === runId && !options?.keepLogs) {
      selectedRunId.value = null
    }
  }

  /** Must match Rust `project_id_from_path` (non-alnum → `_HEX_`). */
  function pathToProjectId(path: string): string {
    let out = ''
    for (const ch of path) {
      if (/^[\p{L}\p{N}]$/u.test(ch)) {
        out += ch
      } else {
        out += `_${ch.codePointAt(0)!.toString(16).toUpperCase()}_`
      }
    }
    return out
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
    projects.value = ws ? ws.projects.map(sanitizeProjectScripts) : []
  }

  function sanitizeAllWorkspaces(): number {
    let removed = 0
    workspaces.value = workspaces.value.map((w) => ({
      ...w,
      projects: w.projects.map((p) => {
        const next = sanitizeProjectScripts(p)
        removed += p.scripts.length - next.scripts.length
        return next
      }),
    }))
    return removed
  }

  function writeProjectsToActiveWorkspace() {
    const idx = workspaces.value.findIndex((w) => w.id === activeWorkspaceId.value)
    if (idx < 0) return
    workspaces.value[idx] = {
      ...workspaces.value[idx],
      projects: projects.value.map(sanitizeProjectScripts),
    }
  }

  async function persistConfig() {
    // Active workspace is sanitized on write; other workspaces were cleaned on load.
    writeProjectsToActiveWorkspace()
    syncActiveProjectsFromWorkspaces()
    const config: AppConfig = {
      activeWorkspaceId: activeWorkspaceId.value,
      workspaces: workspaces.value.map((w) => ({
        ...w,
        projects: [...w.projects],
      })),
      heavyConcurrencyLimit: clampHeavyConcurrency(heavyConcurrencyLimit.value),
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
      heavyConcurrencyLimit.value = clampHeavyConcurrency(
        normalized.heavyConcurrencyLimit ?? DEFAULT_HEAVY_CONCURRENCY
      )
      const removed = sanitizeAllWorkspaces()
      activeWorkspaceId.value = normalized.workspaces.some(
        (w) => w.id === normalized.activeWorkspaceId
      )
        ? normalized.activeWorkspaceId
        : normalized.workspaces[0].id
      syncActiveProjectsFromWorkspaces()
      initialized.value = true
      // One-shot migration: drop fake comment keys then save (persistConfig won't recurse).
      if (removed > 0) {
        toastWarning(`已过滤 ${removed} 个注释类脚本（//、#、@ 等），配置已更新`)
        await persistConfig()
      }
      // Re-read package.json so newly added scripts appear after restart.
      void refreshAllProjectsFromDisk()
    } catch (err) {
      const fallback = defaultConfig()
      workspaces.value = fallback.workspaces
      activeWorkspaceId.value = fallback.activeWorkspaceId
      heavyConcurrencyLimit.value = DEFAULT_HEAVY_CONCURRENCY
      syncActiveProjectsFromWorkspaces()
      toastError(`加载配置失败: ${errorMessage(err)}`)
      initialized.value = true
    }
  }

  async function setHeavyConcurrencyLimit(n: number) {
    heavyConcurrencyLimit.value = clampHeavyConcurrency(n)
    await persistConfig()
    void drainHeavyQueue()
  }

  function isScriptQueued(path: string, script: string): boolean {
    return heavyQueue.value.some((q) => q.project.path === path && q.script === script)
  }

  function queuePosition(path: string, script: string): number {
    return heavyQueue.value.findIndex((q) => q.project.path === path && q.script === script)
  }

  function enqueueHeavy(project: Project, script: string): boolean {
    if (isScriptQueued(project.path, script) || isScriptRunning(project.path, script)) {
      return false
    }
    heavyQueue.value = [
      ...heavyQueue.value,
      {
        project,
        script,
        packageManager: packageManagerFor(project),
        enqueuedAt: Date.now(),
      },
    ]
    return true
  }

  function cancelQueued(path: string, script: string) {
    heavyQueue.value = heavyQueue.value.filter(
      (q) => !(q.project.path === path && q.script === script)
    )
  }

  function cancelQueuedForProject(path: string) {
    heavyQueue.value = heavyQueue.value.filter((q) => q.project.path !== path)
  }

  function clearHeavyQueue() {
    heavyQueue.value = []
  }

  /**
   * Non-blocking memory check. Returns false if user cancels the warning.
   * On check failure, allow continue (don't block startups).
   */
  async function confirmMemoryIfLow(): Promise<boolean> {
    try {
      const mem = await invoke<MemoryStatus>('get_memory_status')
      const low =
        mem.availableBytes < MEMORY_WARN_AVAILABLE_BYTES ||
        mem.memoryLoadPercent >= MEMORY_WARN_LOAD_PERCENT
      if (!low) return true
      return window.confirm(
        `当前可用内存较低（剩余 ${formatBytes(mem.availableBytes)}，占用 ${mem.memoryLoadPercent}%）。\n` +
          `继续可能加剧卡顿；确定仍要启动/加入排队吗？`
      )
    } catch {
      return true
    }
  }

  async function launchTracked(
    project: Project,
    script: string,
    kind: 'script' | 'install'
  ): Promise<{ success: boolean; message: string; project_id: string }> {
    const pm = packageManagerFor(project)
    const runId = runIdFor(project.path, script)
    try {
      const result =
        kind === 'install'
          ? await invoke<{ success: boolean; message: string; project_id: string }>(
              'install_project',
              { path: project.path, packageManager: pm }
            )
          : await invoke<{ success: boolean; message: string; project_id: string }>(
              'start_project',
              { path: project.path, script, packageManager: pm }
            )

      if (result.success) {
        erroredRuns.value.delete(runId)
        const id = result.project_id || runId
        const epoch = nextEpoch(id)
        runningRuns.value.set(id, {
          runId: id,
          project,
          script,
          packageManager: pm,
          epoch,
        })
        runLogs.value.set(id, [])
        if (kind === 'script') {
          todayStartCount.value += 1
        }
      }

      return result
    } catch (err) {
      const message = errorMessage(err)
      toastError(kind === 'install' ? `安装失败: ${message}` : `启动失败: ${message}`)
      return { success: false, message, project_id: '' }
    }
  }

  async function drainHeavyQueue() {
    if (drainingHeavyQueue) return
    drainingHeavyQueue = true
    try {
      while (heavyRunningCount.value < heavyConcurrencyLimit.value) {
        const next = heavyQueue.value[0]
        if (!next) break
        heavyQueue.value = heavyQueue.value.slice(1)

        // Project may have been removed while queued.
        if (!projects.value.some((p) => p.path === next.project.path)) {
          continue
        }
        if (isScriptRunning(next.project.path, next.script)) {
          continue
        }

        // Queue only holds build-class scripts (install is never heavy).
        const result = await launchTracked(next.project, next.script, 'script')
        if (result.success) {
          toastSuccess(`排队任务已启动：${next.project.name} / ${next.script}`)
          if (result.project_id) focusRunIfIdle(result.project_id)
        } else if (result.message) {
          toastError(`排队任务启动失败（${next.project.name} / ${next.script}）：${result.message}`)
        }
      }
    } finally {
      drainingHeavyQueue = false
    }
  }

  /**
   * Start a script, or enqueue packaging tasks when at concurrency limit.
   * @param options.skipMemoryCheck used when draining the queue
   * @param options.forceQueue put into queue even if a slot is free (unused currently)
   */
  async function requestStart(
    project: Project,
    script: string,
    options?: { skipMemoryCheck?: boolean; kind?: 'script' | 'install' }
  ): Promise<{ success: boolean; message: string; project_id: string; queued?: boolean }> {
    const kind = options?.kind ?? (script === 'install' ? 'install' : 'script')
    if (kind === 'script' && !isListedScriptName(script)) {
      toastWarning('非法脚本名（注释/元数据类脚本不可运行）')
      return { success: false, message: '非法脚本名', project_id: '' }
    }

    if (isScriptRunning(project.path, script)) {
      toastWarning('该脚本已在运行中')
      return { success: false, message: '该脚本已在运行中', project_id: '' }
    }

    // Memory warning only for build-class tasks; non-build starts stay frictionless.
    if (isHeavyScript(script) && !options?.skipMemoryCheck) {
      const ok = await confirmMemoryIfLow()
      if (!ok) {
        return { success: false, message: '已取消', project_id: '' }
      }
    }

    if (isHeavyScript(script)) {
      if (isScriptQueued(project.path, script)) {
        toastWarning('该 build 任务已在排队中')
        return { success: false, message: '已在排队中', project_id: '', queued: true }
      }
      if (heavyRunningCount.value >= heavyConcurrencyLimit.value) {
        enqueueHeavy(project, script)
        const pos = queuePosition(project.path, script) + 1
        toastSuccess(
          `build 并发已满（${heavyConcurrencyLimit.value}），已加入排队（第 ${pos} 位）：${project.name} / ${script}`
        )
        return { success: true, message: '已加入排队', project_id: '', queued: true }
      }
    }

    const result = await launchTracked(project, script, kind)
    if (result.success) {
      void drainHeavyQueue()
    }
    return result
  }

  /** Scan installed IDEs once; subsequent calls reuse the cached list. */
  async function ensureInstalledIdes() {
    if (idesReady.value) return
    if (idesLoadPromise) return idesLoadPromise

    idesLoading.value = true
    idesLoadPromise = (async () => {
      const IDE_SCAN_TIMEOUT_MS = 10_000
      try {
        const list = await Promise.race([
          invoke<InstalledIde[]>('list_installed_ides'),
          new Promise<never>((_, reject) => {
            window.setTimeout(
              () => reject(new Error('IDE 检测超时')),
              IDE_SCAN_TIMEOUT_MS
            )
          }),
        ])
        installedIdes.value = list
        idesReady.value = true
      } catch (err) {
        console.error('list_installed_ides failed', err)
        installedIdes.value = []
        // Allow retry on next open if the first scan failed/timed out.
        idesReady.value = false
      } finally {
        idesLoading.value = false
        idesLoadPromise = null
      }
    })()

    return idesLoadPromise
  }

  /** Open / close the project management drawer. Does not clear log focus. */
  function selectProject(path: string | null) {
    selectedProjectPath.value = path
  }

  /** Focus a running script for the right-side log panel (does not open the project drawer). */
  function selectRun(runId: string | null) {
    selectedRunId.value = runId
  }

  /**
   * Auto-focus a newly started run only when the log panel is idle
   * (no focus, or focused run already gone). Avoids stealing focus during batch starts.
   */
  function focusRunIfIdle(runId: string | null) {
    if (!runId) return
    const current = selectedRunId.value
    if (current && runningRuns.value.has(current)) return
    selectedRunId.value = runId
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
    } else {
      clearHeavyQueue()
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
    } else {
      clearHeavyQueue()
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
    } else if (id === activeWorkspaceId.value) {
      clearHeavyQueue()
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
      clearHeavyQueue()
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
      const sanitized = sanitizeProjectScripts(result)
      if (existingIndex >= 0) {
        projects.value[existingIndex] = sanitized
      } else {
        projects.value.push(sanitized)
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
        byPath.set(project.path, sanitizeProjectScripts(project))
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
    cancelQueuedForProject(project.path)
    const scripts = runningScriptsFor(project.path)
    if (scripts.length === 0) {
      void drainHeavyQueue()
      return
    }

    for (const script of scripts) {
      const runId = runIdFor(project.path, script)
      const run = runningRuns.value.get(runId)
      if (run) {
        pendingStopEpoch.value.set(runId, run.epoch)
      }
    }

    try {
      // One IPC + parallel process-tree kills on the backend (avoids serial UI stalls).
      await invoke('stop_scripts_for_path', { path: project.path })
      for (const script of scripts) {
        const runId = runIdFor(project.path, script)
        const current = runningRuns.value.get(runId)
        const pending = pendingStopEpoch.value.get(runId)
        if (current && pending !== undefined && current.epoch !== pending) {
          continue
        }
        clearRunRuntime(runId)
      }
      void drainHeavyQueue()
    } catch (err) {
      for (const script of scripts) {
        pendingStopEpoch.value.delete(runIdFor(project.path, script))
      }
      toastError(`停止失败: ${errorMessage(err)}`)
      throw err
    }
  }

  async function removeProject(project: Project) {
    try {
      cancelQueuedForProject(project.path)
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

  async function setProjectPackageManager(path: string, pm: PackageManager) {
    const idx = projects.value.findIndex((p) => p.path === path)
    if (idx < 0) return
    const next = normalizePackageManager(pm)
    if (projects.value[idx].packageManager === next) return
    projects.value[idx] = { ...projects.value[idx], packageManager: next }
    await persistConfig()
  }

  /**
   * Re-read package.json from disk: refresh scripts + package manager.
   * Scripts are only snapshotted at add/import time unless this runs.
   */
  async function refreshProjectFromDisk(path: string, options?: { persist?: boolean }) {
    const idx = projects.value.findIndex((p) => p.path === path)
    if (idx < 0) return null
    try {
      const result = await invoke<Project | null>('scan_project', { path })
      if (!result) return null
      const sanitized = sanitizeProjectScripts(result)
      const prev = projects.value[idx]
      const scriptsChanged =
        prev.scripts.length !== sanitized.scripts.length ||
        prev.scripts.some(
          ([name, cmd], i) =>
            sanitized.scripts[i]?.[0] !== name || sanitized.scripts[i]?.[1] !== cmd
        )
      const pmChanged = packageManagerFor(prev) !== packageManagerFor(sanitized)
      if (!scriptsChanged && !pmChanged && prev.name === sanitized.name) {
        return prev
      }
      projects.value[idx] = {
        ...prev,
        name: sanitized.name || prev.name,
        scripts: sanitized.scripts,
        packageManager: packageManagerFor(sanitized),
      }
      if (options?.persist !== false) {
        await persistConfig()
      }
      return projects.value[idx]
    } catch (err) {
      console.error('refreshProjectFromDisk failed', path, err)
      return null
    }
  }

  /** Refresh scripts/PM for every project in the active workspace (one persist). */
  async function refreshAllProjectsFromDisk() {
    const paths = projects.value.map((p) => p.path)
    await Promise.all(paths.map((path) => refreshProjectFromDisk(path, { persist: false })))
    await persistConfig()
  }

  /** @deprecated Prefer refreshProjectFromDisk — kept for call-site compatibility. */
  async function refreshProjectPackageManager(path: string) {
    const updated = await refreshProjectFromDisk(path)
    return packageManagerFor(
      updated || projects.value.find((p) => p.path === path) || { name: '', path, scripts: [] }
    )
  }

  async function startProject(project: Project, script: string) {
    return requestStart(project, script, { kind: 'script' })
  }

  async function installProject(project: Project) {
    return requestStart(project, 'install', { kind: 'install' })
  }

  async function stopProject(project: Project, script: string) {
    // Cancel queue entry if not running yet.
    if (isScriptQueued(project.path, script) && !isScriptRunning(project.path, script)) {
      cancelQueued(project.path, script)
      toastSuccess(`已取消排队：${script}`)
      return
    }

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
      void drainHeavyQueue()
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
    // Drop any queued duplicate so restart does not fight the queue.
    cancelQueued(project.path, script)

    if (isScriptRunning(project.path, script)) {
      // Stop without draining first — otherwise a queued build can steal the slot
      // before this restart relaunches.
      const runId = runIdFor(project.path, script)
      const run = runningRuns.value.get(runId)
      if (run) pendingStopEpoch.value.set(runId, run.epoch)
      try {
        await invoke('stop_project', { path: project.path, script })
        const current = runningRuns.value.get(runId)
        const pending = pendingStopEpoch.value.get(runId)
        if (!(current && pending !== undefined && current.epoch !== pending)) {
          clearRunRuntime(runId)
        }
      } catch (err) {
        pendingStopEpoch.value.delete(runId)
        toastError(`停止失败: ${errorMessage(err)}`)
        throw err
      }
    }

    const result = await requestStart(project, script, { kind: 'script' })
    void drainHeavyQueue()
    return result
  }

  async function stopAllProjects() {
    clearHeavyQueue()
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
    const wasHeavy = run ? isHeavyScript(run.script) : isHeavyScript(scriptFromRunId(runId))
    clearRunRuntime(runId)
    if (wasHeavy) void drainHeavyQueue()
  }

  function markExited(runId: string, success: boolean) {
    const run = runningRuns.value.get(runId)
    const pending = pendingStopEpoch.value.get(runId)
    if (run && pending !== undefined && run.epoch !== pending) {
      pendingStopEpoch.value.delete(runId)
      return
    }

    const exitedRun = run
    const wasHeavy = exitedRun
      ? isHeavyScript(exitedRun.script)
      : isHeavyScript(scriptFromRunId(runId))
    if (!success && exitedRun) {
      // Keep logs so the 异常 panel can reopen them in the log pane.
      clearRunRuntime(runId, { keepLogs: true })
      erroredRuns.value.set(runId, {
        runId,
        project: exitedRun.project,
        script: exitedRun.script,
      })
    } else {
      clearRunRuntime(runId)
      erroredRuns.value.delete(runId)
    }
    if (wasHeavy) void drainHeavyQueue()
  }

  function scriptFromRunId(runId: string): string {
    const at = runId.lastIndexOf('@')
    return at >= 0 ? runId.slice(at + 1) : runId
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
    runLogs.value.delete(runId)
    if (selectedRunId.value === runId) {
      selectedRunId.value = null
    }
  }

  async function reorderProjects(fromIndex: number, toIndex: number) {
    if (fromIndex === toIndex) return
    if (fromIndex < 0 || toIndex < 0) return
    if (fromIndex >= projects.value.length || toIndex >= projects.value.length) return
    const next = [...projects.value]
    const [item] = next.splice(fromIndex, 1)
    next.splice(toIndex, 0, item)
    projects.value = next
    await persistConfig()
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
    packageManager,
    setProjectPackageManager,
    refreshProjectFromDisk,
    refreshAllProjectsFromDisk,
    refreshProjectPackageManager,
    todayStartCount,
    totalProjects,
    runningCount,
    erroredCount,
    runningRunList,
    erroredRunList,
    heavyQueue,
    heavyQueueCount,
    heavyRunningCount,
    heavyConcurrencyLimit,
    setHeavyConcurrencyLimit,
    isScriptQueued,
    queuePosition,
    cancelQueued,
    clearHeavyQueue,
    installedIdes,
    idesReady,
    idesLoading,
    loadPersistedState,
    ensureInstalledIdes,
    createWorkspace,
    switchWorkspace,
    renameWorkspace,
    deleteWorkspace,
    addProject,
    importFromDirectory,
    removeProject,
    selectProject,
    selectRun,
    focusRunIfIdle,
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
    reorderProjects,
  }
})
