# Project Launcher

基于 **Tauri 2 + Vue 3 + Rust** 的本地项目启动器，帮助开发者在可视化看板中按**工作区**分类管理多个 Node.js 项目的启停、日志与端口访问。

## 功能特性

- **命名工作区** — 工作区只是分组名称（不是目录）；可为不同业务创建多个工作区
- **JSON 配置持久化** — 工作区与项目关联保存在本地配置，下次直接切换名称即可加载
- **三列看板** — 项目列表 / 运行中 / 异常
- **多脚本并行** — 同一项目可同时跑多个命令（如 `dev` + `build`）；进程结束后自动离开「运行中」
- **一键启停 / 重启 / install** — 支持 npm / pnpm / yarn
- **彩色实时日志** — xterm.js 渲染，批量缓冲
- **端口检测** — 从日志提取端口，点击打开浏览器
- **可选目录导入** — 可从某个目录批量扫描 `package.json` 并入**当前工作区**
- **系统托盘** — 关闭窗口最小化到托盘，支持一键全停

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

### 工作区（项目分组）

1. 点击顶栏「工作区」
2. 输入名称创建分组（如「前台」「Demo」）
3. 在列表中切换已有工作区（切换前会停止当前运行中的项目）
4. 配置以 JSON 形式保存在应用本地存储，重启后自动恢复上次工作区

### 添加 / 导入项目

- **新增**：选择单个含 `package.json` 的项目目录，加入**当前工作区**
- **从目录导入**：在工作区面板中扫描某根目录，批量并入当前工作区
- **删除**：卡片 × 或详情「删除项目」（仅移除关联，不删磁盘文件；运行中会先停止）

### 看板三列

| 列 | 含义 |
|----|------|
| **项目列表** | 当前工作区内全部项目，常驻；启动脚本后**不会**从本列移除，仅从工作区删除时离开。点击打开脚本管理抽屉（无日志） |
| **运行中** | 每个「项目 + 脚本」一条；同一项目多脚本并行时会出现多条；如 `build` 结束后自动消失。**仅当该脚本日志里检测到端口时**才显示链接。点击打开该脚本的运行日志抽屉 |
| **异常** | 非正常退出的脚本记录，可清除 |

### 启动 / 停止 / 重启

1. 在「项目列表」点击卡片打开详情
2. 需要时可先执行 `install`，再启动 `dev` / `build` 等（可同时开多个）
3. 「运行中」卡片 ■ 停止对应脚本；详情内可按脚本启停/重启；顶栏「一键全停」终止全部子进程树

### 查看日志与端口

1. 详情面板展开「运行日志」
2. 看板/详情出现 `http://localhost:端口` 后可点击打开

## 项目结构

```
Project-Launcher/
├── src/                         # 前端
│   ├── components/
│   │   ├── Dashboard.vue        # 三列看板 + 工作区管理
│   │   ├── ProjectDetail.vue    # 项目详情
│   │   └── LogPanel.vue         # xterm 日志面板
│   ├── stores/project.ts        # Pinia：工作区 / 项目 / 进程状态
│   ├── utils/toast.ts
│   ├── App.vue
│   └── main.ts
├── src-tauri/                   # Rust 后端
│   ├── src/
│   │   ├── commands.rs          # IPC：扫描 / 启停 / 配置
│   │   └── main.rs
│   └── tauri.conf.json
├── package.json
└── vite.config.ts
```

## 开发提示

1. 后端命令：`src-tauri/src/commands.rs`
2. 前端状态：`src/stores/project.ts`
3. UI 组件：`src/components/`

调试：`npm run tauri:dev`；前端可用 WebView 开发者工具。

## 许可证

MIT License

## 贡献

欢迎提交 Issue 和 Pull Request：
[https://github.com/Sogrey/Project-Launcher](https://github.com/Sogrey/Project-Launcher)
