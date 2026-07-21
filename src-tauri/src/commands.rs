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
  static ref PORT_RE: Regex = Regex::new(r":(\d{4,5})").unwrap();
  static ref SCRIPT_RE: Regex = Regex::new(r"^[a-zA-Z0-9_:-]+$").unwrap();
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

#[derive(Debug, Serialize, Deserialize)]
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
  extract_ports: bool,
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

          if extract_ports && (line.contains("Local:") || line.contains("localhost:")) {
            if let Some(captures) = PORT_RE.captures(&line) {
              let port = captures[1].to_string();
              let _ = app.emit("project:port", (project_id.clone(), port));
            }
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
        project_id: project_id_from_path(&path),
      };
    }
  };
  // Keep caller path for project_id so frontend Map keys and IPC events stay aligned.
  let project_id = project_id_from_path(&path);

  if !is_valid_script(&script) {
    return StartResult {
      success: false,
      message: "非法脚本名：仅允许字母、数字、下划线、连字符和冒号".to_string(),
      project_id,
    };
  }

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
        message: format!("同时运行项目数不能超过 {}", MAX_RUNNING_PROCESSES),
        project_id,
      };
    }
    if processes.contains_key(&project_id) {
      return StartResult {
        success: false,
        message: "项目已在运行中".to_string(),
        project_id,
      };
    }
  }

  // Avoid shell metacharacter injection: invoke package manager with discrete args.
  #[cfg(windows)]
  let program = match package_manager.as_str() {
    "pnpm" => "pnpm.cmd",
    "yarn" => "yarn.cmd",
    _ => "npm.cmd",
  };
  #[cfg(not(windows))]
  let program = match package_manager.as_str() {
    "pnpm" => "pnpm",
    "yarn" => "yarn",
    _ => "npm",
  };

  let mut cmd = Command::new(program);
  match package_manager.as_str() {
    "yarn" => {
      cmd.arg(&script);
    }
    _ => {
      cmd.arg("run").arg(&script);
    }
  }
  cmd.current_dir(&validated_path);
  cmd.env("FORCE_COLOR", "1");
  cmd.stdout(Stdio::piped());
  cmd.stderr(Stdio::piped());

  #[cfg(windows)]
  cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

  #[cfg(unix)]
  {
    use std::os::unix::process::CommandExt;
    // Put the child in its own process group so we can kill the whole tree.
    cmd.process_group(0);
  }

  let mut child = match cmd.spawn() {
    Ok(c) => c,
    Err(e) => {
      return StartResult {
        success: false,
        message: format!("启动失败: {}", e),
        project_id,
      };
    }
  };

  let stdout = match child.stdout.take() {
    Some(s) => s,
    None => {
      let _ = child.kill();
      return StartResult {
        success: false,
        message: "无法获取标准输出".to_string(),
        project_id,
      };
    }
  };

  let stderr = match child.stderr.take() {
    Some(s) => s,
    None => {
      let _ = child.kill();
      return StartResult {
        success: false,
        message: "无法获取错误输出".to_string(),
        project_id,
      };
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
    true,
    readers_done.clone(),
  );
  spawn_log_reader(
    app_handle,
    project_id.clone(),
    stderr,
    false,
    readers_done,
  );

  StartResult {
    success: true,
    message: "项目已启动".to_string(),
    project_id,
  }
}

#[tauri::command]
pub fn stop_project(app_handle: AppHandle, path: String) -> Result<bool, String> {
  validate_path_input(&path)?;
  let project_id = project_id_from_path(&path);

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

#[tauri::command]
pub fn get_workspace_path(app_handle: AppHandle) -> Option<String> {
  let store = open_config_store(&app_handle)?;
  store
    .get("workspace_path")
    .and_then(|v| v.as_str().map(|s| s.to_string()))
}

#[tauri::command]
pub fn set_workspace_path(app_handle: AppHandle, path: String) -> Result<bool, String> {
  let validated = validate_dir_path(&path)?;
  let path = path_to_string(&validated);
  let store = match open_config_store(&app_handle) {
    Some(s) => s,
    None => return Err("无法打开配置存储".to_string()),
  };
  store.set("workspace_path".to_string(), json!(path));
  store
    .save()
    .map(|_| true)
    .map_err(|e| format!("保存工作区失败: {}", e))
}

#[tauri::command]
pub fn save_projects(app_handle: AppHandle, projects: Vec<Project>) -> bool {
  let store = match open_config_store(&app_handle) {
    Some(s) => s,
    None => return false,
  };
  store.set("projects".to_string(), json!(projects));
  store.save().is_ok()
}

#[tauri::command]
pub fn load_projects(app_handle: AppHandle) -> Vec<Project> {
  let store = match open_config_store(&app_handle) {
    Some(s) => s,
    None => return Vec::new(),
  };
  store
    .get("projects")
    .and_then(|v| serde_json::from_value(v.clone()).ok())
    .unwrap_or_default()
}
