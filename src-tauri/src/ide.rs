//! Detect installed editors and open a project folder in Explorer / IDE.
//!
//! Windows detection priority (custom install paths are common):
//! 1. Uninstall registry (`InstallLocation` / `DisplayIcon`) — most reliable
//! 2. PATH (`where code` / `cursor` / …) — works when CLI was added to PATH
//! 3. Well-known default folders — last fallback only

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use crate::commands::validate_dir_path;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledIde {
  pub id: String,
  pub name: String,
  /// Absolute path to the launcher (.exe / .cmd / binary).
  pub path: String,
}

struct IdeSpec {
  id: &'static str,
  name: &'static str,
  /// CLI names to resolve via `where` / `which`.
  cli_names: &'static [&'static str],
  /// Path must contain at least one of these (case-insensitive). Empty = no include filter.
  path_includes: &'static [&'static str],
  /// Path must not contain any of these (case-insensitive).
  path_excludes: &'static [&'static str],
  /// Relative paths under common install roots (last-resort fallback).
  #[cfg(windows)]
  windows_rel: &'static [&'static str],
  /// Substrings that must ALL appear in uninstall DisplayName (case-insensitive).
  #[cfg(windows)]
  reg_includes: &'static [&'static str],
  /// Substrings that must NOT appear in DisplayName.
  #[cfg(windows)]
  reg_excludes: &'static [&'static str],
  /// Candidate exe names under InstallLocation.
  #[cfg(windows)]
  exe_names: &'static [&'static str],
  /// macOS app bundle names for `open -a`.
  #[cfg(target_os = "macos")]
  mac_apps: &'static [&'static str],
  /// Extra absolute-ish binary candidates on Unix.
  #[cfg(any(target_os = "macos", target_os = "linux"))]
  unix_bins: &'static [&'static str],
}

fn ide_specs() -> Vec<IdeSpec> {
  vec![
    IdeSpec {
      id: "vscode",
      name: "Visual Studio Code",
      cli_names: &["code"],
      path_includes: &["microsoft vs code", "vscode"],
      path_excludes: &[],
      #[cfg(windows)]
      windows_rel: &[
        r"Microsoft VS Code\Code.exe",
        r"Microsoft VS Code\bin\code.cmd",
      ],
      #[cfg(windows)]
      reg_includes: &["visual studio code"],
      #[cfg(windows)]
      reg_excludes: &[],
      #[cfg(windows)]
      exe_names: &["Code.exe"],
      #[cfg(target_os = "macos")]
      mac_apps: &["Visual Studio Code"],
      #[cfg(any(target_os = "macos", target_os = "linux"))]
      unix_bins: &[
        "/usr/local/bin/code",
        "/usr/bin/code",
        "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
      ],
    },
    IdeSpec {
      id: "cursor",
      name: "Cursor",
      cli_names: &["cursor"],
      path_includes: &["cursor"],
      path_excludes: &[],
      #[cfg(windows)]
      windows_rel: &[
        r"cursor\Cursor.exe",
        r"Cursor\Cursor.exe",
        r"cursor\resources\app\bin\cursor.cmd",
      ],
      #[cfg(windows)]
      reg_includes: &["cursor"],
      #[cfg(windows)]
      reg_excludes: &[],
      #[cfg(windows)]
      exe_names: &["Cursor.exe"],
      #[cfg(target_os = "macos")]
      mac_apps: &["Cursor"],
      #[cfg(any(target_os = "macos", target_os = "linux"))]
      unix_bins: &[
        "/usr/local/bin/cursor",
        "/usr/bin/cursor",
        "/Applications/Cursor.app/Contents/Resources/app/bin/cursor",
      ],
    },
    IdeSpec {
      id: "trae-solo-cn",
      name: "TRAE SOLO CN",
      cli_names: &["trae"],
      path_includes: &["trae solo"],
      path_excludes: &[],
      #[cfg(windows)]
      windows_rel: &[r"TRAE SOLO CN\TRAE SOLO CN.exe"],
      #[cfg(windows)]
      reg_includes: &["trae solo"],
      #[cfg(windows)]
      reg_excludes: &[],
      #[cfg(windows)]
      exe_names: &["TRAE SOLO CN.exe", "Trae Solo CN.exe"],
      #[cfg(target_os = "macos")]
      mac_apps: &["TRAE SOLO CN"],
      #[cfg(any(target_os = "macos", target_os = "linux"))]
      unix_bins: &[],
    },
    IdeSpec {
      id: "trae-cn",
      name: "Trae CN",
      cli_names: &["trae"],
      path_includes: &["trae cn"],
      path_excludes: &["solo"],
      #[cfg(windows)]
      windows_rel: &[
        r"Trae CN\Trae CN.exe",
        r"Trae CN\bin\trae.cmd",
        r"Trae CN\bin\trae.exe",
      ],
      #[cfg(windows)]
      reg_includes: &["trae cn"],
      #[cfg(windows)]
      reg_excludes: &["solo"],
      #[cfg(windows)]
      exe_names: &["Trae CN.exe"],
      #[cfg(target_os = "macos")]
      mac_apps: &["Trae CN"],
      #[cfg(any(target_os = "macos", target_os = "linux"))]
      unix_bins: &["/usr/local/bin/trae", "/usr/bin/trae"],
    },
    IdeSpec {
      id: "trae",
      name: "Trae",
      cli_names: &["trae"],
      path_includes: &["trae"],
      path_excludes: &["trae cn", "solo"],
      #[cfg(windows)]
      windows_rel: &[r"Trae\Trae.exe", r"Trae\bin\trae.cmd"],
      #[cfg(windows)]
      reg_includes: &["trae"],
      #[cfg(windows)]
      reg_excludes: &["trae cn", "solo"],
      #[cfg(windows)]
      exe_names: &["Trae.exe"],
      #[cfg(target_os = "macos")]
      mac_apps: &["Trae"],
      #[cfg(any(target_os = "macos", target_os = "linux"))]
      unix_bins: &["/usr/local/bin/trae", "/usr/bin/trae"],
    },
    IdeSpec {
      id: "codebuddy-cn",
      name: "CodeBuddy (CN)",
      cli_names: &["codebuddy", "CodeBuddy"],
      path_includes: &["codebuddy cn", "codebuddy-cn"],
      path_excludes: &[],
      #[cfg(windows)]
      windows_rel: &[
        r"CodeBuddy CN\CodeBuddy CN.exe",
        r"CodeBuddy CN\CodeBuddy.exe",
        r"CodeBuddy CN\bin\codebuddy.cmd",
        r"CodeBuddy\CodeBuddy CN.exe",
      ],
      #[cfg(windows)]
      reg_includes: &["codebuddy cn"],
      #[cfg(windows)]
      reg_excludes: &[],
      #[cfg(windows)]
      exe_names: &["CodeBuddy CN.exe", "CodeBuddy.exe"],
      #[cfg(target_os = "macos")]
      mac_apps: &["CodeBuddy CN"],
      #[cfg(any(target_os = "macos", target_os = "linux"))]
      unix_bins: &[],
    },
    IdeSpec {
      id: "codebuddy",
      name: "CodeBuddy (Intl)",
      cli_names: &["codebuddy", "CodeBuddy"],
      path_includes: &["codebuddy"],
      path_excludes: &["codebuddy cn", "codebuddy-cn", "workbuddy"],
      #[cfg(windows)]
      windows_rel: &[
        r"CodeBuddy\CodeBuddy.exe",
        r"CodeBuddy\bin\codebuddy.cmd",
      ],
      #[cfg(windows)]
      reg_includes: &["codebuddy"],
      #[cfg(windows)]
      reg_excludes: &["codebuddy cn", "workbuddy"],
      #[cfg(windows)]
      exe_names: &["CodeBuddy.exe"],
      #[cfg(target_os = "macos")]
      mac_apps: &["CodeBuddy"],
      #[cfg(any(target_os = "macos", target_os = "linux"))]
      unix_bins: &["/usr/local/bin/codebuddy", "/usr/bin/codebuddy"],
    },
    IdeSpec {
      id: "windsurf",
      name: "Windsurf",
      cli_names: &["windsurf"],
      path_includes: &["windsurf"],
      path_excludes: &[],
      #[cfg(windows)]
      windows_rel: &[
        r"Windsurf\Windsurf.exe",
        r"Windsurf\bin\windsurf.cmd",
      ],
      #[cfg(windows)]
      reg_includes: &["windsurf"],
      #[cfg(windows)]
      reg_excludes: &[],
      #[cfg(windows)]
      exe_names: &["Windsurf.exe"],
      #[cfg(target_os = "macos")]
      mac_apps: &["Windsurf"],
      #[cfg(any(target_os = "macos", target_os = "linux"))]
      unix_bins: &["/usr/local/bin/windsurf", "/usr/bin/windsurf"],
    },
    IdeSpec {
      id: "vscodium",
      name: "VSCodium",
      cli_names: &["codium"],
      path_includes: &["vscodium"],
      path_excludes: &[],
      #[cfg(windows)]
      windows_rel: &[
        r"VSCodium\VSCodium.exe",
        r"VSCodium\bin\codium.cmd",
      ],
      #[cfg(windows)]
      reg_includes: &["vscodium"],
      #[cfg(windows)]
      reg_excludes: &[],
      #[cfg(windows)]
      exe_names: &["VSCodium.exe"],
      #[cfg(target_os = "macos")]
      mac_apps: &["VSCodium"],
      #[cfg(any(target_os = "macos", target_os = "linux"))]
      unix_bins: &["/usr/local/bin/codium", "/usr/bin/codium"],
    },
  ]
}

fn path_exists_file(path: &Path) -> bool {
  path.is_file()
}

fn strip_extended_path(path: &Path) -> PathBuf {
  let s = path.to_string_lossy();
  #[cfg(windows)]
  {
    if let Some(stripped) = s.strip_prefix(r"\\?\") {
      return PathBuf::from(stripped);
    }
  }
  path.to_path_buf()
}

/// Path keyword rules from `IdeSpec` (used by detection + open validation).
fn path_matches_spec(spec: &IdeSpec, path: &Path) -> bool {
  let lower = path.to_string_lossy().to_ascii_lowercase();
  let include_ok = spec.path_includes.is_empty()
    || spec
      .path_includes
      .iter()
      .any(|needle| lower.contains(&needle.to_ascii_lowercase()));
  let exclude_ok = !spec
    .path_excludes
    .iter()
    .any(|needle| lower.contains(&needle.to_ascii_lowercase()));
  include_ok && exclude_ok
}

fn path_matches_edition(spec_id: &str, path: &Path) -> bool {
  ide_specs()
    .into_iter()
    .find(|s| s.id == spec_id)
    .map(|s| path_matches_spec(&s, path))
    .unwrap_or(false)
}

/// Reject obviously unsafe locations (temp spoofing), but allow custom install dirs.
fn is_unsafe_install_location(path: &Path) -> bool {
  let path = strip_extended_path(path);
  let lower = path.to_string_lossy().to_ascii_lowercase();

  let blocked_markers = [
    r"\temp\",
    r"/temp/",
    r"\tmp\",
    r"/tmp/",
    r"\windows\temp",
    r"/var/tmp",
    r"\appdata\local\temp",
    r"\appdata\local\tmp",
  ];
  if blocked_markers.iter().any(|m| lower.contains(m)) {
    return true;
  }

  // Also block if under process TEMP / TMP env dirs.
  for key in ["TEMP", "TMP", "TMPDIR"] {
    if let Ok(tmp) = std::env::var(key) {
      let tmp = strip_extended_path(Path::new(tmp.trim()));
      if !tmp.as_os_str().is_empty() && path.starts_with(&tmp) {
        return true;
      }
    }
  }
  false
}

/// Allow common install roots and arbitrary custom dirs; block temp-like paths only.
fn is_trusted_install_path(path: &Path) -> bool {
  if is_unsafe_install_location(path) {
    return false;
  }

  // Custom install directories (e.g. D:\MyApps\Cursor) are allowed once they pass
  // filename + path-keyword checks. Temp spoofing is rejected above.
  true
}

#[cfg(windows)]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegAppJson {
  display_name: String,
  install_location: String,
  display_icon: String,
}

#[cfg(windows)]
struct RegApp {
  display_name: String,
  install_location: Option<PathBuf>,
  icon_exe: Option<PathBuf>,
}

#[cfg(windows)]
fn normalize_icon_path(raw: &str) -> Option<PathBuf> {
  // e.g. `E:\Programs\cursor\Cursor.exe,0` or quoted paths
  let mut s = raw.trim().trim_matches('"');
  if let Some((left, _)) = s.split_once(',') {
    s = left.trim().trim_matches('"');
  }
  if s.is_empty() {
    return None;
  }
  let p = PathBuf::from(s);
  if path_exists_file(&p) {
    Some(p)
  } else {
    None
  }
}

/// Read Windows uninstall entries via PowerShell (covers custom install paths).
#[cfg(windows)]
fn scan_uninstall_registry() -> Vec<RegApp> {
  let script = r#"
$ErrorActionPreference = 'SilentlyContinue'
$roots = @(
  'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
)
$apps = Get-ItemProperty $roots | Where-Object { $_.DisplayName } | ForEach-Object {
  [PSCustomObject]@{
    displayName = [string]$_.DisplayName
    installLocation = [string]$_.InstallLocation
    displayIcon = [string]$_.DisplayIcon
  }
}
if ($null -eq $apps) { '[]' } else { @($apps) | ConvertTo-Json -Compress }
"#;

  let mut cmd = Command::new("powershell");
  cmd.args([
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    script,
  ]);
  cmd.stdin(Stdio::null());
  cmd.stdout(Stdio::piped());
  cmd.stderr(Stdio::null());
  cmd.creation_flags(CREATE_NO_WINDOW);

  let output = match cmd.output() {
    Ok(o) if o.status.success() => o,
    _ => return Vec::new(),
  };
  let text = String::from_utf8_lossy(&output.stdout);
  let trimmed = text.trim();
  if trimmed.is_empty() {
    return Vec::new();
  }

  // ConvertTo-Json emits a single object (not array) when only one item.
  let parsed: Result<Vec<RegAppJson>, _> = serde_json::from_str(trimmed);
  let list = match parsed {
    Ok(v) => v,
    Err(_) => match serde_json::from_str::<RegAppJson>(trimmed) {
      Ok(one) => vec![one],
      Err(_) => return Vec::new(),
    },
  };

  list
    .into_iter()
    .map(|j| {
      let install_location = {
        let s = j.install_location.trim().trim_matches('"');
        if s.is_empty() {
          None
        } else {
          Some(PathBuf::from(s))
        }
      };
      let icon_exe = normalize_icon_path(&j.display_icon);
      RegApp {
        display_name: j.display_name,
        install_location,
        icon_exe,
      }
    })
    .collect()
}

#[cfg(windows)]
fn reg_name_matches(spec: &IdeSpec, display_name: &str) -> bool {
  let lower = display_name.to_ascii_lowercase();
  if !spec
    .reg_includes
    .iter()
    .all(|needle| lower.contains(&needle.to_ascii_lowercase()))
  {
    return false;
  }
  !spec
    .reg_excludes
    .iter()
    .any(|needle| lower.contains(&needle.to_ascii_lowercase()))
}

#[cfg(windows)]
fn resolve_via_registry(spec: &IdeSpec, apps: &[RegApp]) -> Option<PathBuf> {
  for app in apps {
    if !reg_name_matches(spec, &app.display_name) {
      continue;
    }
    if let Some(loc) = &app.install_location {
      for exe in spec.exe_names {
        let candidate = loc.join(exe);
        if path_exists_file(&candidate) {
          return Some(candidate);
        }
      }
    }
    if let Some(icon) = &app.icon_exe {
      let name = icon
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
      // Prefer real editor exe, skip uninstallers.
      if name.contains("uninstall") {
        continue;
      }
      if spec
        .exe_names
        .iter()
        .any(|exe| name.eq_ignore_ascii_case(&exe.to_ascii_lowercase()))
        || path_matches_edition(spec.id, icon)
        || name.ends_with(".exe")
      {
        return Some(icon.clone());
      }
    }
  }
  None
}

#[cfg(windows)]
fn windows_install_roots() -> Vec<PathBuf> {
  let mut roots = Vec::new();
  if let Ok(local) = std::env::var("LOCALAPPDATA") {
    roots.push(PathBuf::from(local).join("Programs"));
  }
  if let Ok(pf) = std::env::var("ProgramFiles") {
    roots.push(PathBuf::from(pf));
  }
  if let Ok(pf86) = std::env::var("ProgramFiles(x86)") {
    roots.push(PathBuf::from(pf86));
  }
  for drive in ["C:", "D:", "E:", "F:", "G:"] {
    roots.push(PathBuf::from(format!(r"{drive}\Programs")));
    roots.push(PathBuf::from(format!(r"{drive}\Program Files")));
  }
  roots
}

#[cfg(windows)]
fn resolve_via_where(name: &str) -> Option<PathBuf> {
  let mut cmd = Command::new("where");
  cmd
    .arg(name)
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::null());
  cmd.creation_flags(CREATE_NO_WINDOW);
  let output = cmd.output().ok()?;
  if !output.status.success() {
    return None;
  }
  let text = String::from_utf8_lossy(&output.stdout);
  for line in text.lines() {
    let trimmed = line.trim();
    if trimmed.is_empty() {
      continue;
    }
    let p = PathBuf::from(trimmed);
    if path_exists_file(&p) {
      return Some(p);
    }
  }
  None
}

#[cfg(not(windows))]
fn resolve_via_which(name: &str) -> Option<PathBuf> {
  let output = Command::new("which")
    .arg(name)
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::null())
    .output()
    .ok()?;
  if !output.status.success() {
    return None;
  }
  let text = String::from_utf8_lossy(&output.stdout);
  let trimmed = text.lines().next()?.trim();
  if trimmed.is_empty() {
    return None;
  }
  let p = PathBuf::from(trimmed);
  if path_exists_file(&p) {
    Some(p)
  } else {
    None
  }
}

/// Prefer a real GUI .exe next to VS Code–style `bin\*.cmd` wrappers.
#[cfg(windows)]
fn prefer_gui_exe(launcher: &Path) -> PathBuf {
  let name = launcher
    .file_name()
    .and_then(|s| s.to_str())
    .unwrap_or("")
    .to_ascii_lowercase();

  if name.ends_with(".cmd") || name.ends_with(".bat") {
    if let Some(bin_dir) = launcher.parent() {
      if let Some(install_root) = bin_dir
        .parent() // app
        .and_then(|p| p.parent()) // resources
        .and_then(|p| p.parent())
      {
        for candidate in [
          "Cursor.exe",
          "Code.exe",
          "CodeBuddy CN.exe",
          "CodeBuddy.exe",
          "Windsurf.exe",
          "VSCodium.exe",
          "Trae CN.exe",
          "TRAE SOLO CN.exe",
          "Trae.exe",
        ] {
          let exe = install_root.join(candidate);
          if path_exists_file(&exe) {
            return exe;
          }
        }
      }
      if let Some(parent) = bin_dir.parent() {
        for candidate in [
          "Code.exe",
          "Cursor.exe",
          "CodeBuddy CN.exe",
          "CodeBuddy.exe",
          "Windsurf.exe",
          "VSCodium.exe",
          "Trae CN.exe",
          "TRAE SOLO CN.exe",
          "Trae.exe",
        ] {
          let exe = parent.join(candidate);
          if path_exists_file(&exe) {
            return exe;
          }
        }
      }
    }
  }
  launcher.to_path_buf()
}

#[cfg(windows)]
fn resolve_via_common_paths(spec: &IdeSpec) -> Option<PathBuf> {
  for rel in spec.windows_rel {
    for root in windows_install_roots() {
      let candidate = root.join(rel);
      if path_exists_file(&candidate) {
        return Some(prefer_gui_exe(&candidate));
      }
    }
  }
  None
}

#[cfg(windows)]
fn detect_ide(spec: &IdeSpec, reg_apps: &[RegApp]) -> Option<InstalledIde> {
  // 1) Registry — finds custom install directories reliably.
  if let Some(found) = resolve_via_registry(spec, reg_apps) {
    return Some(InstalledIde {
      id: spec.id.to_string(),
      name: spec.name.to_string(),
      path: prefer_gui_exe(&found).to_string_lossy().to_string(),
    });
  }

  // 2) PATH CLI (installer option “Add to PATH”).
  for cli in spec.cli_names {
    if let Some(found) = resolve_via_where(cli) {
      if !path_matches_edition(spec.id, &found) {
        continue;
      }
      let launcher = prefer_gui_exe(&found);
      return Some(InstalledIde {
        id: spec.id.to_string(),
        name: spec.name.to_string(),
        path: launcher.to_string_lossy().to_string(),
      });
    }
  }

  // 3) Well-known default folders (weakest; misses many custom paths).
  if let Some(found) = resolve_via_common_paths(spec) {
    if path_matches_edition(spec.id, &found) {
      return Some(InstalledIde {
        id: spec.id.to_string(),
        name: spec.name.to_string(),
        path: found.to_string_lossy().to_string(),
      });
    }
  }

  None
}

#[cfg(not(windows))]
fn detect_ide(spec: &IdeSpec) -> Option<InstalledIde> {
  for cli in spec.cli_names {
    if let Some(found) = resolve_via_which(cli) {
      if !path_matches_edition(spec.id, &found) {
        continue;
      }
      return Some(InstalledIde {
        id: spec.id.to_string(),
        name: spec.name.to_string(),
        path: found.to_string_lossy().to_string(),
      });
    }
  }
  for bin in spec.unix_bins {
    let p = PathBuf::from(bin);
    if path_exists_file(&p) {
      return Some(InstalledIde {
        id: spec.id.to_string(),
        name: spec.name.to_string(),
        path: p.to_string_lossy().to_string(),
      });
    }
  }
  #[cfg(target_os = "macos")]
  {
    for app in spec.mac_apps {
      let app_path = PathBuf::from(format!("/Applications/{app}.app"));
      if app_path.is_dir() {
        return Some(InstalledIde {
          id: spec.id.to_string(),
          name: spec.name.to_string(),
          path: app_path.to_string_lossy().to_string(),
        });
      }
    }
  }
  None
}

lazy_static::lazy_static! {
  /// Process-lifetime cache — registry scan is expensive; IDEs rarely change mid-session.
  static ref IDE_CACHE: Mutex<Option<Vec<InstalledIde>>> = Mutex::new(None);
}

fn detect_all_ides() -> Vec<InstalledIde> {
  let mut found = Vec::new();
  let mut seen = std::collections::HashSet::new();

  #[cfg(windows)]
  let reg_apps = scan_uninstall_registry();

  for spec in ide_specs() {
    #[cfg(windows)]
    let ide = detect_ide(&spec, &reg_apps);
    #[cfg(not(windows))]
    let ide = detect_ide(&spec);

    if let Some(ide) = ide {
      if seen.insert(ide.id.clone()) {
        found.push(ide);
      }
    }
  }

  // If CN + international editions resolve to the same launcher, keep CN only.
  for (cn_id, intl_id) in [("trae-cn", "trae"), ("codebuddy-cn", "codebuddy")] {
    if let (Some(cn), Some(intl)) = (
      found.iter().position(|i| i.id == cn_id),
      found.iter().position(|i| i.id == intl_id),
    ) {
      if found[cn].path.eq_ignore_ascii_case(&found[intl].path) {
        found.remove(intl);
      }
    }
  }

  found
}

/// List editors actually present on this machine (cached after first scan).
#[tauri::command]
pub fn list_installed_ides() -> Result<Vec<InstalledIde>, String> {
  {
    let cache = IDE_CACHE
      .lock()
      .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(ref list) = *cache {
      return Ok(list.clone());
    }
  }

  let found = detect_all_ides();
  let mut cache = IDE_CACHE
    .lock()
    .unwrap_or_else(|poisoned| poisoned.into_inner());
  *cache = Some(found.clone());
  Ok(found)
}

fn spawn_detached(mut cmd: Command) -> Result<(), String> {
  cmd.stdin(Stdio::null());
  cmd.stdout(Stdio::null());
  cmd.stderr(Stdio::null());
  cmd
    .spawn()
    .map(|_| ())
    .map_err(|e| format!("启动失败: {e}"))
}

/// Re-validate a cached IDE launcher before executing it (mitigate registry/path injection).
fn validate_ide_launcher(ide_id: &str, launcher: &Path) -> Result<PathBuf, String> {
  let spec = ide_specs()
    .into_iter()
    .find(|s| s.id == ide_id)
    .ok_or_else(|| format!("未知的 IDE: {ide_id}"))?;

  if !launcher.exists() {
    return Err(format!("IDE 路径不存在: {}", launcher.display()));
  }

  let canonical = launcher
    .canonicalize()
    .map_err(|e| format!("无法解析 IDE 路径: {e}"))?;

  #[cfg(target_os = "macos")]
  {
    if canonical.is_dir() {
      let name = canonical
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
      if name.ends_with(".app") {
        let allowed = spec.mac_apps.iter().any(|app| {
          name == format!("{}.app", app.to_ascii_lowercase())
            || name.contains(&app.to_ascii_lowercase())
        });
        if allowed && is_trusted_install_path(&canonical) {
          return Ok(canonical);
        }
      }
      return Err("IDE 应用包未通过安全校验".to_string());
    }
  }

  if !canonical.is_file() {
    return Err("IDE 启动器不是有效文件".to_string());
  }

  let file_name = canonical
    .file_name()
    .and_then(|n| n.to_str())
    .unwrap_or("")
    .to_ascii_lowercase();

  if file_name.contains("uninstall") || file_name.starts_with("unins") {
    return Err("拒绝执行卸载程序".to_string());
  }

  let mut allowed_names: Vec<String> = Vec::new();
  #[cfg(windows)]
  {
    for exe in spec.exe_names {
      allowed_names.push(exe.to_ascii_lowercase());
    }
  }
  for cli in spec.cli_names {
    let lower = cli.to_ascii_lowercase();
    allowed_names.push(lower.clone());
    allowed_names.push(format!("{lower}.cmd"));
    allowed_names.push(format!("{lower}.bat"));
    allowed_names.push(format!("{lower}.exe"));
  }

  let name_ok = allowed_names.iter().any(|n| n == &file_name);
  if !name_ok {
    return Err("IDE 可执行文件名未通过白名单校验".to_string());
  }
  if !path_matches_spec(&spec, &canonical) {
    return Err("IDE 路径关键词未通过校验".to_string());
  }
  if !is_trusted_install_path(&canonical) {
    return Err("IDE 位于临时目录等不安全路径，已拒绝启动".to_string());
  }

  Ok(canonical)
}

/// Open folder in the OS file manager.
#[tauri::command]
pub fn open_in_explorer(path: String) -> Result<(), String> {
  let dir = validate_dir_path(&path)?;
  let dir_str = {
    let s = dir.to_string_lossy().to_string();
    #[cfg(windows)]
    {
      s.strip_prefix(r"\\?\").unwrap_or(&s).to_string()
    }
    #[cfg(not(windows))]
    {
      s
    }
  };

  #[cfg(windows)]
  {
    let mut cmd = Command::new("explorer");
    cmd.arg(&dir_str);
    return spawn_detached(cmd);
  }

  #[cfg(target_os = "macos")]
  {
    let mut cmd = Command::new("open");
    cmd.arg(&dir_str);
    return spawn_detached(cmd);
  }

  #[cfg(target_os = "linux")]
  {
    let mut cmd = Command::new("xdg-open");
    cmd.arg(&dir_str);
    return spawn_detached(cmd);
  }

  #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
  {
    Err("当前系统不支持打开资源管理器".to_string())
  }
}

/// Open folder with a previously detected IDE (`ide_id` from `list_installed_ides`).
#[tauri::command]
pub fn open_in_ide(path: String, ide_id: String) -> Result<(), String> {
  if ide_id.is_empty() || ide_id.len() > 64 || ide_id.contains('\0') {
    return Err("无效的 IDE 标识".to_string());
  }
  if !ide_specs().iter().any(|s| s.id == ide_id) {
    return Err(format!("未知的 IDE: {ide_id}"));
  }

  let dir = validate_dir_path(&path)?;
  let dir_str = {
    let s = dir.to_string_lossy().to_string();
    #[cfg(windows)]
    {
      s.strip_prefix(r"\\?\").unwrap_or(&s).to_string()
    }
    #[cfg(not(windows))]
    {
      s
    }
  };

  let ides = list_installed_ides()?;
  let ide = ides
    .into_iter()
    .find(|i| i.id == ide_id)
    .ok_or_else(|| format!("未检测到已安装的 IDE: {ide_id}"))?;

  let launcher = validate_ide_launcher(&ide_id, Path::new(&ide.path))?;
  let launcher_str = launcher.to_string_lossy().to_string();

  #[cfg(target_os = "macos")]
  {
    if launcher.is_dir() {
      let mut cmd = Command::new("open");
      cmd.arg("-a").arg(&launcher_str).arg(&dir_str);
      return spawn_detached(cmd);
    }
  }

  #[cfg(windows)]
  {
    let ext = launcher
      .extension()
      .and_then(|e| e.to_str())
      .unwrap_or("")
      .to_ascii_lowercase();
    if ext == "cmd" || ext == "bat" {
      let mut cmd = Command::new("cmd");
      cmd.args(["/C", &launcher_str, &dir_str]);
      cmd.creation_flags(CREATE_NO_WINDOW);
      return spawn_detached(cmd);
    }
  }

  let mut cmd = Command::new(&launcher);
  cmd.arg(&dir_str);
  spawn_detached(cmd)
}
