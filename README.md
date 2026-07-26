# Project Launcher

基于 **Tauri 2 + Vue 3 + Rust** 的本地项目启动器。按**命名工作区**管理多个 Node.js 项目，支持多脚本并行启停、实时日志与端口快捷打开。

界面为深色科技风（网格底纹），主区域三栏布局：**项目列表 | 运行中 | 日志 / 异常**。

## 功能特性

- **命名工作区** — 工作区是分组名称（不是目录）；可按业务创建多个工作区并本地持久化
- **三栏看板**
  - 左：项目列表（常驻，不因启动而移出）
  - 中：运行中（每个「项目 + 脚本」一条）
  - 右上：选中运行任务的实时日志；右下：异常退出记录
- **多脚本并行** — 同一项目可同时跑多个命令（如 `dev` + `build`）；结束后自动离开「运行中」
- **项目管理抽屉** — 点击左侧项目：运行状态表、包管理器、脚本启停/重启（日志在右侧，不在抽屉内）
- **一键启停 / install** — 支持 npm / pnpm / yarn；可停单脚本、停项目全部脚本、一键全停
- **智能日志焦点** — 点击中间列查看对应日志；批量启动时不会抢当前焦点（`focusRunIfIdle`）
- **彩色实时日志** — xterm.js + ResizeObserver；端口按脚本从日志中提取并隔离显示
- **可选目录导入** — 扫描某根目录下的 `package.json` 并入当前工作区
- **系统托盘** — 关闭窗口最小化到托盘，托盘菜单可一键全停

## 技术栈

| 类型 | 技术 |
|------|------|
| 桌面框架 | Tauri 2.x |
| 前端 | Vue 3 + TypeScript + Pinia + Vite 5 |
| 终端 | xterm.js |
| UI 提示 | Element Plus（按需 Message） |
| 后端 | Rust（进程管理 / IPC / 持久化） |

## 前置依赖

- Node.js >= 18
- Rust >= 1.75
- Windows：Visual Studio Build Tools（含 C++ 工具链）

## 安装与运行

```bash
# 安装依赖
npm install

# 开发模式（推荐）
npm run tauri:dev

# 仅前端（无 Tauri 壳）
npm run dev
```

### 生产构建

```bash
npm run build          # 构建前端
npm run tauri:build    # 打包桌面应用
```

### 常用脚本

| 脚本 | 说明 |
|------|------|
| `npm run tauri:dev` | Tauri 开发模式 |
| `npm run tauri:build` | 构建安装包 |
| `npm run typecheck` | TypeScript 检查 |
| `npm run build` | 构建前端到 `dist/` |
| `npm run clean` | 清理构建产物 |

## 使用说明

### 工作区

1. 顶栏点击「工作区」
2. 输入名称创建分组（如「前台」「Demo」）
3. 切换工作区前会停止当前运行中的进程
4. 配置保存在应用本地 JSON，重启后恢复上次工作区

### 添加 / 移除项目

- **新增**：选择含 `package.json` 的目录，加入当前工作区
- **从目录导入**：在工作区面板中批量扫描并入
- **移除**：卡片 × 或抽屉「从工作区移除」（需确认；仅解绑关联，不删磁盘文件；运行中会先停止）

### 看板布局

| 区域 | 说明 |
|------|------|
| **项目列表** | 工作区内全部项目；点击打开管理抽屉 |
| **运行中** | 每个运行中的脚本一条；点击后在右上显示对应日志；有端口时显示可点击链接 |
| **日志输出** | 当前选中运行任务的输出；可点「取消」清除焦点；任务结束后焦点自动清空 |
| **异常** | 非正常退出记录，可清除 |

关闭项目管理抽屉**不会**清除右侧日志焦点（二者独立）；需要时可在日志区点「取消」。

### 启动 / 停止

1. 在「项目列表」打开抽屉，可选先 `install`，再启动 `dev` / `build` 等（可并行）
2. 无日志焦点时，新启动的任务会自动出现在右侧；已有焦点时保持当前任务（避免批量启动乱跳）
3. 也可在中间列手动点选要看的任务
4. 停止方式：运行中卡片 ■、抽屉内按脚本停止 / 停止全部、项目卡片 ■■、顶栏「一键全停」

### 端口

仅当**该脚本**的日志中检测到端口时才显示链接（按 run 隔离，不会把 `dev` 的端口挂到 `build` 上）。点击即可打开 `http://localhost:端口`。

## 项目结构

```
Project-Launcher/
├── src/
│   ├── components/
│   │   ├── Dashboard.vue        # 三栏看板 + 工作区 + 右侧日志/异常
│   │   ├── ProjectDetail.vue    # 项目管理抽屉（无内嵌日志）
│   │   └── LogPanel.vue         # xterm 日志面板
│   ├── stores/project.ts        # 工作区 / 项目 / 多进程运行状态
│   ├── style.css                # 全局科技风主题与网格底纹
│   ├── utils/toast.ts
│   ├── App.vue
│   └── main.ts
├── src-tauri/
│   ├── src/
│   │   ├── commands.rs          # IPC：扫描 / 启停 / 配置
│   │   └── main.rs
│   └── tauri.conf.json
├── package.json
└── vite.config.ts
```

## 开发提示

1. **后端**：`src-tauri/src/commands.rs`  
   - 进程以 `runId = pathId@script` 为键  
   - 入队检查与 insert 在同一把锁内（避免 TOCTOU）；拒绝入队时先释放锁再 `kill_process_tree`  
   - 同时运行上限：`MAX_RUNNING_PROCESSES`（默认 20）
2. **前端状态**：`src/stores/project.ts`  
   - `selectProject` → 开/关抽屉  
   - `selectRun` → 右侧日志焦点  
   - `focusRunIfIdle` → 仅在无焦点或原焦点已结束时自动切换  
   - `epoch` / `pendingStopEpoch` → 忽略重启后的陈旧 stop/exit 事件
3. **UI**：`src/components/` + `src/style.css`

### Run ID 格式

进程标识为 `{pathId}@{script}`：

- `pathId`：路径中字母/数字保留，其余字符编码为 `_HEX_`（如 `-` → `_2D_`），前后端算法一致
- `script`：白名单脚本名或 `install`

**升级说明**：早期版本曾把所有非字母数字统一替换为 `_`，与当前 `_HEX_` 编码不兼容。runId **仅存在于内存**（配置里存的是项目路径，不是 pathId）；升级后重启应用即可。若有外部工具监听 `project:log` / `project:exited` / `project:stopped` 等事件，请按新格式解析 payload 中的 id 字段（历史命名仍为 `project_id`，值为 runId）。

调试：`npm run tauri:dev`；可用 WebView 开发者工具。

## 许可证

MIT License

## 贡献

欢迎提交 Issue 和 Pull Request：  
[https://github.com/Sogrey/Project-Launcher](https://github.com/Sogrey/Project-Launcher)
