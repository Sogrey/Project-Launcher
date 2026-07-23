use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Emitter};
use tauri_plugin_store::StoreExt;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

lazy_static::lazy_static! {
  static ref RUNNING_PROCESSES: Mutex<HashMap<String, Child>> = Mutex::new(HashMap::new());
  static ref SCRIPT_RE: Regex = Regex::new(r"^[a-zA-Z0-9_:-]+$").unwrap();
  static ref ANSI_RE: Regex = Regex::new(r"\x1b\[[0-9;]*[a-zA-Z]").unwrap();
  static ref PORT_URL_RE: Regex =
    Regex::new(r"(?i)(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{2,5})").unwrap();
  static ref PORT_FALLBACK_RE: Regex = Regex::new(r":(\d{4,5})\b").unwrap();
}

const LOG_FLUSH_INTERVAL: Duration = Duration::from_millis(200);
const LOG_FLUSH_LINES: usize = 50;
const MAX_PATH_LEN: usize = 4096;
const MAX_RUNNING_PROCESSES: usize = 20;

fn lock_processes() -> MutexGuard<'static, HashMap<String, Child>> {
  RUNNING_PROCESSES
    .lock()
    .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn path_to_string(path: &Path) -> String {
  let s = path.to_string_lossy().to_string();
  #[cfg(windows)]
  {
    if let Some(stripped) = s.strip_prefix(r"\\?\") {
      return stripped.to_string();
    }
  }
  s
}

/// Lightweight input checks (length / null bytes) without requiring the path to exist.
fn validate_path_input(path: &str) -> Result<(), String> {
  if path.is_empty() || path.len() > MAX_PATH_LEN {
    return Err("路径无效或过长".to_string());
  }
  if path.contains('\0') {
    return Err("路径包含非法字符".to_string());
  }
  Ok(())
}

/// Validate and canonicalize a directory path from the frontend.
fn validate_dir_path(path: &str) -> Result<PathBuf, String> {
  validate_path_input(path)?;

  let raw = Path::new(path);
  if !raw.is_dir() {
    return Err("路径不是有效目录".to_string());
  }

  let canonical = raw
    .canonicalize()
    .map_err(|e| format!("无法解析路径: {}", e))?;

  if !canonical.is_dir() {
    return Err("规范化后的路径不是目录".to_string());
  }

  Ok(canonical)
}

fn project_id_from_path(path: &str) -> String {
  path.replace(|c: char| !c.is_alphanumeric(), "_")
}

/// Unique run id so one project can run multiple scripts in parallel.
fn run_id_from(path: &str, script: &str) -> String {
  format!("{}@{}", project_id_from_path(path), script)
}

fn project_name_from_path(path: &Path) -> String {
  path
    .file_name()
    .and_then(|n| n.to_str())
    .unwrap_or("unknown")
    .to_string()
}

fn is_valid_script(script: &str) -> bool {
  !script.is_empty() && SCRIPT_RE.is_match(script)
}

fn is_valid_package_manager(pm: &str) -> bool {
  matches!(pm, "npm" | "pnpm" | "yarn")
}

fn strip_ansi(input: &str) -> String {
  ANSI_RE.replace_all(input, "").to_string()
}

fn extract_port_from_line(line: &str) -> Option<String> {
  let plain = strip_ansi(line);
  if let Some(captures) = PORT_URL_RE.captures(&plain) {
    return Some(captures[1].to_string());
  }

  let lower = plain.to_lowercase();
  if lower.contains("local:")
    || lower.contains("localhost")
    || lower.contains("network:")
    || lower.contains("127.0.0.1")
  {
    if let Some(captures) = PORT_FALLBACK_RE.captures(&plain) {
      return Some(captures[1].to_string());
    }
  }

  None
}

fn pm_program(package_manager: &str) -> &'static str {
  #[cfg(windows)]
  {
    match package_manager {
      "pnpm" => "pnpm.cmd",
      "yarn" => "yarn.cmd",
      _ => "npm.cmd",
    }
  }
  #[cfg(not(windows))]
  {
    match package_manager {
      "pnpm" => "pnpm",
      "yarn" => "yarn",
      _ => "npm",
    }
  }
}

fn kill_process_tree(child: &mut Child) {
  let pid = child.id();

  #[cfg(windows)]
  {
    let _ = Command::new("taskkill")
      .args(["/F", "/T", "/PID", &pid.to_string()])
      .stdout(Stdio::null())
      .stderr(Stdio::null())
      .status();
  }

  #[cfg(unix)]
  {
    // Negative PID targets the process group created via process_group(0).
    let _ = Command::new("kill")
      .args(["-TERM", &format!("-{}", pid)])
      .stdout(Stdio::null())
      .stderr(Stdio::null())
      .status();
    thread::sleep(Duration::from_millis(200));
    let _ = Command::new("kill")
      .args(["-KILL", &format!("-{}", pid)])
      .stdout(Stdio::null())
      .stderr(Stdio::null())
      .status();
  }

  let _ = child.kill();
  let _ = child.wait();
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
  pub name: String,
  pub path: String,
  pub scripts: Vec<(String, String)>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct StartResult {
  pub success: bool,
  pub message: String,
  pub project_id: String,
}

fn parse_package_json(path: &Path) -> Option<Vec<(String, String)>> {
  let content = std::fs::read_to_string(path.join("package.json")).ok()?;
  let json: serde_json::Value = serde_json::from_str(&content).ok()?;
  let scripts = json.get("scripts")?.as_object()?;
  Some(
    scripts
      .iter()
      .map(|(k, v)| (k.clone(), v.as_str().unwrap_or("").to_string()))
      .collect(),
  )
}

fn scan_directory_recursive(dir: &Path, depth: usize, max_depth: usize) -> Vec<Project> {
  let mut projects = Vec::new();

  if depth > max_depth {
    return projects;
  }

  let entries = match std::fs::read_dir(dir) {
    Ok(e) => e,
    Err(_) => return projects,
  };

  for entry in entries.flatten() {
    let path = entry.path();

    if path.is_dir() {
      if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
        if name == "node_modules" || name.starts_with('.') {
          continue;
        }
      }

      if path.join("package.json").exists() {
        let name = project_name_from_path(&path);
        if let Some(scripts) = parse_package_json(&path) {
          projects.push(Project {
            name,
            path: path_to_string(&path),
            scripts,
          });
        }
      } else {
        projects.extend(scan_directory_recursive(&path, depth + 1, max_depth));
      }
    }
  }

  projects
}

fn flush_logs(app: &AppHandle, project_id: &str, buffer: &mut Vec<String>) {
  if buffer.is_empty() {
    return;
  }
  let chunk = buffer.join("\n") + "\n";
  buffer.clear();
  let _ = app.emit("project:log", (project_id.to_string(), chunk));
}

fn spawn_log_reader<R: std::io::Read + Send + 'static>(
  app: AppHandle,
  project_id: String,
  reader: R,
  readers_done: Arc<AtomicUsize>,
) {
  thread::spawn(move || {
    let mut reader = BufReader::new(reader);
    let mut line_buf = String::new();
    let mut batch: Vec<String> = Vec::new();
    let mut last_flush = Instant::now();

    loop {
      match reader.read_line(&mut line_buf) {
        Ok(0) => break,
        Ok(_) => {
          let line = line_buf.trim_end_matches(['\r', '\n']).to_string();
          line_buf.clear();

          if let Some(port) = extract_port_from_line(&line) {
            let _ = app.emit("project:port", (project_id.clone(), port));
          }

          batch.push(line);
          if batch.len() >= LOG_FLUSH_LINES || last_flush.elapsed() >= LOG_FLUSH_INTERVAL {
            flush_logs(&app, &project_id, &mut batch);
            last_flush = Instant::now();
          }
        }
        Err(_) => break,
      }
    }

    flush_logs(&app, &project_id, &mut batch);

    if readers_done.fetch_add(1, Ordering::SeqCst) == 1 {
      reap_and_emit_exit(&app, &project_id);
    }
  });
}

fn begin_tracked_process(
  app_handle: AppHandle,
  project_id: String,
  mut child: Child,
) -> Result<(), String> {
  let stdout = match child.stdout.take() {
    Some(s) => s,
    None => {
      let _ = child.kill();
      return Err("无法获取标准输出".to_string());
    }
  };

  let stderr = match child.stderr.take() {
    Some(s) => s,
    None => {
      let _ = child.kill();
      return Err("无法获取错误输出".to_string());
    }
  };

  {
    let mut processes = lock_processes();
    processes.insert(project_id.clone(), child);
  }

  let readers_done = Arc::new(AtomicUsize::new(0));
  spawn_log_reader(
    app_handle.clone(),
    project_id.clone(),
    stdout,
    readers_done.clone(),
  );
  spawn_log_reader(app_handle, project_id, stderr, readers_done);
  Ok(())
}

fn reap_and_emit_exit(app: &AppHandle, project_id: &str) {
  let mut processes = lock_processes();
  if let Some(mut child) = processes.remove(project_id) {
    let code = match child.wait() {
      Ok(status) => status.code().unwrap_or(-1),
      Err(_) => -1,
    };
    let success = code == 0;
    let _ = app.emit(
      "project:exited",
      json!({
        "project_id": project_id,
        "code": code,
        "success": success,
      }),
    );
  }
}

#[tauri::command]
pub fn scan_project(path: String) -> Result<Option<Project>, String> {
  let dir = validate_dir_path(&path)?;

  if dir.join("package.json").exists() {
    let name = project_name_from_path(&dir);
    if let Some(scripts) = parse_package_json(&dir) {
      return Ok(Some(Project {
        name,
        path: path_to_string(&dir),
        scripts,
      }));
    }
    return Err("package.json 存在但无法解析 scripts".to_string());
  }

  Ok(None)
}

#[tauri::command]
pub fn scan_directory(path: String) -> Result<Vec<Project>, String> {
  let dir = validate_dir_path(&path)?;
  Ok(scan_directory_recursive(&dir, 0, 3))
}

#[tauri::command]
pub fn start_project(
  app_handle: AppHandle,
  path: String,
  script: String,
  package_manager: String,
) -> StartResult {
  let validated_path = match validate_dir_path(&path) {
    Ok(p) => p,
    Err(message) => {
      return StartResult {
        success: false,
        message,
        project_id: run_id_from(&path, &script),
      };
    }
  };

  if !is_valid_script(&script) {
    return StartResult {
      success: false,
      message: "非法脚本名：仅允许字母、数字、下划线、连字符和冒号".to_string(),
      project_id: run_id_from(&path, &script),
    };
  }

  let project_id = run_id_from(&path, &script);

  if !is_valid_package_manager(&package_manager) {
    return StartResult {
      success: false,
      message: "不支持的包管理器".to_string(),
      project_id,
    };
  }

  {
    let processes = lock_processes();
    if processes.len() >= MAX_RUNNING_PROCESSES {
      return StartResult {
        success: false,
        message: format!("同时运行进程数不能超过 {}", MAX_RUNNING_PROCESSES),
        project_id,
      };
    }
    if processes.contains_key(&project_id) {
      return StartResult {
        success: false,
        message: format!("脚本 {} 已在运行中", script),
        project_id,
      };
    }
  }

  let program = pm_program(&package_manager);
  let mut cmd = Command::new(program);
  match package_manager.as_str() {
    "yarn" => {
      cmd.arg(&script);
    }
    _ => {
      cmd.arg("run").arg(&script);
    }
  }
  let workdir = path_to_string(&validated_path);
  cmd.current_dir(&workdir);
  cmd.env("FORCE_COLOR", "1");
  cmd.stdin(Stdio::null());
  cmd.stdout(Stdio::piped());
  cmd.stderr(Stdio::piped());

  #[cfg(windows)]
  cmd.creation_flags(0x08000000);

  #[cfg(unix)]
  {
    use std::os::unix::process::CommandExt;
    cmd.process_group(0);
  }

  let child = match cmd.spawn() {
    Ok(c) => c,
    Err(e) => {
      return StartResult {
        success: false,
        message: format!("启动失败: {}", e),
        project_id,
      };
    }
  };

  if let Err(message) = begin_tracked_process(app_handle, project_id.clone(), child) {
    return StartResult {
      success: false,
      message,
      project_id,
    };
  }

  StartResult {
    success: true,
    message: "项目已启动".to_string(),
    project_id,
  }
}

#[tauri::command]
pub fn install_project(
  app_handle: AppHandle,
  path: String,
  package_manager: String,
) -> StartResult {
  let script = "install".to_string();
  let validated_path = match validate_dir_path(&path) {
    Ok(p) => p,
    Err(message) => {
      return StartResult {
        success: false,
        message,
        project_id: run_id_from(&path, &script),
      };
    }
  };
  let project_id = run_id_from(&path, &script);

  if !is_valid_package_manager(&package_manager) {
    return StartResult {
      success: false,
      message: "不支持的包管理器".to_string(),
      project_id,
    };
  }

  {
    let processes = lock_processes();
    if processes.len() >= MAX_RUNNING_PROCESSES {
      return StartResult {
        success: false,
        message: format!("同时运行进程数不能超过 {}", MAX_RUNNING_PROCESSES),
        project_id,
      };
    }
    if processes.contains_key(&project_id) {
      return StartResult {
        success: false,
        message: "依赖安装已在进行中".to_string(),
        project_id,
      };
    }
  }

  let program = pm_program(&package_manager);
  let mut cmd = Command::new(program);
  cmd.arg("install");
  let workdir = path_to_string(&validated_path);
  cmd.current_dir(&workdir);
  cmd.env("FORCE_COLOR", "1");
  cmd.stdin(Stdio::null());
  cmd.stdout(Stdio::piped());
  cmd.stderr(Stdio::piped());

  #[cfg(windows)]
  cmd.creation_flags(0x08000000);

  #[cfg(unix)]
  {
    use std::os::unix::process::CommandExt;
    cmd.process_group(0);
  }

  let child = match cmd.spawn() {
    Ok(c) => c,
    Err(e) => {
      return StartResult {
        success: false,
        message: format!("安装启动失败: {}", e),
        project_id,
      };
    }
  };

  if let Err(message) = begin_tracked_process(app_handle, project_id.clone(), child) {
    return StartResult {
      success: false,
      message,
      project_id,
    };
  }

  StartResult {
    success: true,
    message: "依赖安装已开始".to_string(),
    project_id,
  }
}

#[tauri::command]
pub fn stop_project(app_handle: AppHandle, path: String, script: String) -> Result<bool, String> {
  validate_path_input(&path)?;
  if script != "install" && !is_valid_script(&script) {
    return Err("非法脚本名".to_string());
  }
  let project_id = run_id_from(&path, &script);

  let child = {
    let mut processes = lock_processes();
    processes.remove(&project_id)
  };

  if let Some(mut child) = child {
    kill_process_tree(&mut child);
    let _ = app_handle.emit("project:stopped", project_id);
    Ok(true)
  } else {
    Ok(false)
  }
}

#[tauri::command]
pub fn stop_all_projects(app_handle: AppHandle) -> usize {
  let children: Vec<(String, Child)> = {
    let mut processes = lock_processes();
    processes.drain().collect()
  };
  let count = children.len();

  for (project_id, mut child) in children {
    kill_process_tree(&mut child);
    let _ = app_handle.emit("project:stopped", project_id);
  }

  count
}

fn open_config_store(app_handle: &AppHandle) -> Option<std::sync::Arc<tauri_plugin_store::Store<tauri::Wry>>> {
  app_handle.store("config.json").ok()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
  pub id: String,
  pub name: String,
  pub projects: Vec<Project>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
  pub active_workspace_id: String,
  pub workspaces: Vec<Workspace>,
}

fn new_workspace_id() -> String {
  format!(
    "ws_{}",
    std::time::SystemTime::now()
      .duration_since(std::time::UNIX_EPOCH)
      .map(|d| d.as_millis())
      .unwrap_or(0)
  )
}

fn default_app_config() -> AppConfig {
  let id = "ws_default".to_string();
  AppConfig {
    active_workspace_id: id.clone(),
    workspaces: vec![Workspace {
      id,
      name: "默认".to_string(),
      projects: Vec::new(),
    }],
  }
}

fn read_app_config_from_store(
  store: &std::sync::Arc<tauri_plugin_store::Store<tauri::Wry>>,
) -> AppConfig {
  // New format
  if let Some(value) = store.get("app_config") {
    if let Ok(config) = serde_json::from_value::<AppConfig>(value.clone()) {
      if !config.workspaces.is_empty() {
        return config;
      }
    }
  }

  // Migrate legacy flat projects / workspace_path
  let legacy_projects: Vec<Project> = store
    .get("projects")
    .and_then(|v| serde_json::from_value(v.clone()).ok())
    .unwrap_or_default();

  let mut config = default_app_config();
  if let Some(ws) = config.workspaces.first_mut() {
    ws.projects = legacy_projects;
  }

  store.set("app_config".to_string(), json!(config));
  let _ = store.delete("projects");
  let _ = store.delete("workspace_path");
  let _ = store.save();

  config
}

#[tauri::command]
pub fn load_app_config(app_handle: AppHandle) -> Result<AppConfig, String> {
  let store = open_config_store(&app_handle).ok_or_else(|| "无法打开配置存储".to_string())?;
  let config = read_app_config_from_store(&store);
  Ok(config)
}

#[tauri::command]
pub fn save_app_config(app_handle: AppHandle, config: AppConfig) -> Result<bool, String> {
  if config.workspaces.is_empty() {
    return Err("至少需要一个工作区".to_string());
  }
  if !config
    .workspaces
    .iter()
    .any(|w| w.id == config.active_workspace_id)
  {
    return Err("activeWorkspaceId 不存在".to_string());
  }

  let store = open_config_store(&app_handle).ok_or_else(|| "无法打开配置存储".to_string())?;
  store.set("app_config".to_string(), json!(config));
  // Ensure legacy keys are gone after adopting the new model.
  let _ = store.delete("projects");
  let _ = store.delete("workspace_path");
  store
    .save()
    .map(|_| true)
    .map_err(|e| format!("保存配置失败: {}", e))
}

/// Helper kept for generating ids from the frontend when creating workspaces.
#[tauri::command]
pub fn create_workspace_id() -> String {
  new_workspace_id()
}
