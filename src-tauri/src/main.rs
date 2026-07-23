// Hide the console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{
  menu::{Menu, MenuItem},
  tray::TrayIconBuilder,
  Manager,
};

mod commands;

fn main() {
  tauri::Builder::default()
    .plugin(tauri_plugin_store::Builder::default().build())
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_shell::init())
    .invoke_handler(tauri::generate_handler![
      commands::scan_project,
      commands::scan_directory,
      commands::start_project,
      commands::install_project,
      commands::stop_project,
      commands::stop_all_projects,
      commands::load_app_config,
      commands::save_app_config,
      commands::create_workspace_id,
    ])
    .setup(|app| {
      let show_i = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
      let stop_all_i = MenuItem::with_id(app, "stop_all", "停止所有服务", true, None::<&str>)?;
      let quit_i = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
      
      let menu = Menu::with_items(app, &[&show_i, &stop_all_i, &quit_i])?;
      
      let _tray = TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().cloned().unwrap_or_else(|| {
          tauri::image::Image::new_owned([66, 126, 234, 255].repeat(32 * 32), 32, 32)
        }))
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| {
          match event.id().as_ref() {
            "quit" => {
              let _ = commands::stop_all_projects(app.clone());
              app.exit(0);
            }
            "show" => {
              if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
              }
            }
            "stop_all" => {
              let _ = commands::stop_all_projects(app.clone());
            }
            _ => {}
          }
        })
        .build(app)?;
      
      Ok(())
    })
    .on_window_event(|window, event| {
      if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        let _ = window.hide();
        api.prevent_close();
      }
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
