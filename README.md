# Project Launcher

基于 **Tauri 2 + Vue 3 + Rust** 的本地项目启动器，帮助开发者在可视化看板中统一管理多个 Node.js 项目的扫描、启停、日志与端口访问。

## 功能特性

- **工作区扫描** — 选择根目录，递归扫描（深度 ≤ 3）含 `package.json` 的项目
- **三列看板** — 待处理 / 进行中 / 异常，状态一目了然
- **一键启停 / 重启** — 支持 npm / pnpm / yarn 全部 scripts
- **彩色实时日志** — xterm.js 渲染，200ms / 50 行批量缓冲
- **端口检测** — 从日志提取端口，一键打开 `http://localhost:xxxx`
- **持久化** — 工作区路径与项目列表本地保存，重启后恢复
- **系统托盘** — 关闭窗口最小化到托盘，支持一键全停
- **安全加固** — 脚本名白名单、无 shell 拼接、CSP、路径校验、进程数上限

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

### 首次使用

1. 启动后点击「选择工作区」
2. 选择包含多个 Node.js 项目的根目录
3. 应用自动扫描并填入「待处理」列

### 添加 / 删除项目

- **新增**：看板「+」或顶栏「新增项目」
- **删除**：卡片右上角 ×，或详情面板「删除项目」（运行中会先停止）

### 启动 / 停止 / 重启

1. 点击项目卡片打开详情
2. 选择包管理器与脚本，点击「启动」
3. 运行中可「停止」或「重启」
4. 顶栏「一键全停」终止全部子进程树

### 查看日志与端口

1. 详情面板展开「运行日志」（xterm 彩色输出）
2. 检测到端口后显示可点击的本地地址

## 项目结构

```
Project-Launcher/
├── src/                         # 前端
│   ├── components/
│   │   ├── Dashboard.vue        # 三列看板
│   │   ├── ProjectDetail.vue    # 项目详情
│   │   └── LogPanel.vue         # xterm 日志面板
│   ├── stores/project.ts        # Pinia 状态
│   ├── utils/toast.ts           # 轻量提示
│   ├── App.vue
│   └── main.ts
├── src-tauri/                   # Rust 后端
│   ├── src/
│   │   ├── commands.rs          # IPC：扫描 / 启停 / 日志 / 持久化
│   │   └── main.rs              # 入口、托盘
│   └── tauri.conf.json
├── deliverables/gstack/         # 上线前全检报告
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
