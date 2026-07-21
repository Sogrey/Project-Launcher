import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { toastError, toastWarning } from '@/utils/toast'

export interface Project {
  name: string
  path: string
  scripts: [string, string][]
}

export type PackageManager = 'npm' | 'pnpm' | 'yarn'

export interface RunningProject {
  project: Project
  script: string
  packageManager: PackageManager
  isRunning: boolean
}

const MAX_LOG_LINES = 2000

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

export const useProjectStore = defineStore('project', () => {
  const projects = ref<Project[]>([])
  const runningProjects = ref<Map<string, RunningProject>>(new Map())
  const projectLogs = ref<Map<string, string[]>>(new Map())
  const projectPorts = ref<Map<string, string[]>>(new Map())
  const erroredProjectPaths = ref<Set<string>>(new Set())
  const selectedProjectPath = ref<string | null>(null)
  const packageManager = ref<PackageManager>('npm')
  const workspacePath = ref<string | null>(null)
  const todayStartCount = ref(0)
  const initialized = ref(false)

  const totalProjects = computed(() => projects.value.length)
  const runningCount = computed(() => runningProjects.value.size)
  const erroredCount = computed(() => erroredProjectPaths.value.size)

  const runningProjectList = computed(() =>
    projects.value.filter((p) => runningProjects.value.has(p.path))
  )
  const stoppedProjects = computed(() =>
    projects.value.filter(
      (p) => !runningProjects.value.has(p.path) && !erroredProjectPaths.value.has(p.path)
    )
  )
  const erroredProjects = computed(() =>
    projects.value.filter((p) => erroredProjectPaths.value.has(p.path))
  )

  const selectedProject = computed(() =>
    selectedProjectPath.value
      ? projects.value.find((p) => p.path === selectedProjectPath.value)
      : null
  )

  function pathToProjectId(path: string): string {
    // Align with Rust char::is_alphanumeric() (Unicode letters + numbers).
    return path.replace(/[^\p{L}\p{N}]/gu, '_')
  }

  function pathFromProjectId(projectId: string): string | undefined {
    return projects.value.find((p) => pathToProjectId(p.path) === projectId)?.path
  }

  async function persistProjects() {
    try {
      await invoke('save_projects', { projects: projects.value })
    } catch (err) {
      console.error('persistProjects failed', err)
    }
  }

  async function loadPersistedState() {
    if (initialized.value) return
    try {
      const [savedProjects, savedWorkspace] = await Promise.all([
        invoke<Project[]>('load_projects'),
        invoke<string | null>('get_workspace_path'),
      ])
      projects.value = savedProjects || []
      workspacePath.value = savedWorkspace
      initialized.value = true
    } catch (err) {
      toastError(`加载配置失败: ${errorMessage(err)}`)
      initialized.value = true
    }
  }

  function selectProject(path: string | null) {
    selectedProjectPath.value = path
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
      await persistProjects()
    } catch (err) {
      toastError(`添加项目失败: ${errorMessage(err)}`)
      throw err
    }
  }

  async function removeProject(project: Project) {
    try {
      if (runningProjects.value.has(project.path)) {
        await stopProject(project)
      }
      projects.value = projects.value.filter((p) => p.path !== project.path)
      runningProjects.value.delete(project.path)
      projectLogs.value.delete(project.path)
      projectPorts.value.delete(project.path)
      erroredProjectPaths.value.delete(project.path)
      if (selectedProjectPath.value === project.path) {
        selectedProjectPath.value = null
      }
      await persistProjects()
    } catch (err) {
      toastError(`删除项目失败: ${errorMessage(err)}`)
      throw err
    }
  }

  async function scanWorkspace(path: string) {
    try {
      const scanned = await invoke<Project[]>('scan_directory', { path })
      await invoke('set_workspace_path', { path })
      workspacePath.value =
        (await invoke<string | null>('get_workspace_path')) || path

      const byPath = new Map(projects.value.map((p) => [p.path, p]))
      for (const project of scanned) {
        byPath.set(project.path, project)
      }
      projects.value = Array.from(byPath.values())
      await persistProjects()
      return scanned.length
    } catch (err) {
      toastError(`扫描工作区失败: ${errorMessage(err)}`)
      throw err
    }
  }

  async function startProject(project: Project, script: string) {
    try {
      const result = await invoke<{ success: boolean; message: string; project_id: string }>(
        'start_project',
        { path: project.path, script, packageManager: packageManager.value }
      )

      if (result.success) {
        erroredProjectPaths.value.delete(project.path)
        runningProjects.value.set(project.path, {
          project,
          script,
          packageManager: packageManager.value,
          isRunning: true,
        })
        if (!projectLogs.value.has(project.path)) {
          projectLogs.value.set(project.path, [])
        }
        todayStartCount.value += 1
      }

      return result
    } catch (err) {
      runningProjects.value.delete(project.path)
      toastError(`启动失败: ${errorMessage(err)}`)
      return { success: false, message: errorMessage(err), project_id: '' }
    }
  }

  async function stopProject(project: Project) {
    try {
      await invoke('stop_project', { path: project.path })
      runningProjects.value.delete(project.path)
      projectPorts.value.delete(project.path)
    } catch (err) {
      toastError(`停止失败: ${errorMessage(err)}`)
      throw err
    }
  }

  async function restartProject(project: Project) {
    const running = runningProjects.value.get(project.path)
    const script = running?.script
    if (!script) {
      toastWarning('项目未在运行，无法重启')
      return { success: false, message: '项目未在运行', project_id: '' }
    }
    await stopProject(project)
    return startProject(project, script)
  }

  async function stopAllProjects() {
    try {
      await invoke('stop_all_projects')
      runningProjects.value.clear()
      projectPorts.value.clear()
    } catch (err) {
      toastError(`一键全停失败: ${errorMessage(err)}`)
      throw err
    }
  }

  function markStopped(projectId: string) {
    const projectPath = pathFromProjectId(projectId)
    if (!projectPath) return
    runningProjects.value.delete(projectPath)
    projectPorts.value.delete(projectPath)
  }

  function markExited(projectId: string, success: boolean) {
    const projectPath = pathFromProjectId(projectId)
    if (!projectPath) return
    runningProjects.value.delete(projectPath)
    projectPorts.value.delete(projectPath)
    if (!success) {
      erroredProjectPaths.value.add(projectPath)
    } else {
      erroredProjectPaths.value.delete(projectPath)
    }
  }

  function addPort(projectPath: string, port: string) {
    const ports = projectPorts.value.get(projectPath) || []
    if (!ports.includes(port)) {
      ports.push(port)
      projectPorts.value.set(projectPath, ports)
    }
  }

  function clearPorts(projectPath: string) {
    projectPorts.value.set(projectPath, [])
  }

  function addLog(projectPath: string, log: string) {
    const logs = projectLogs.value.get(projectPath) || []
    logs.push(log)
    if (logs.length > MAX_LOG_LINES) {
      logs.splice(0, logs.length - MAX_LOG_LINES)
    }
    projectLogs.value.set(projectPath, [...logs])
  }

  function clearLogs(projectPath: string) {
    projectLogs.value.set(projectPath, [])
  }

  function clearError(projectPath: string) {
    erroredProjectPaths.value.delete(projectPath)
  }

  return {
    projects,
    runningProjects,
    projectLogs,
    projectPorts,
    erroredProjectPaths,
    selectedProjectPath,
    selectedProject,
    packageManager,
    workspacePath,
    todayStartCount,
    totalProjects,
    runningCount,
    erroredCount,
    runningProjectList,
    stoppedProjects,
    erroredProjects,
    loadPersistedState,
    addProject,
    removeProject,
    scanWorkspace,
    selectProject,
    startProject,
    stopProject,
    restartProject,
    stopAllProjects,
    markStopped,
    markExited,
    pathFromProjectId,
    addPort,
    clearPorts,
    addLog,
    clearLogs,
    clearError,
  }
})
