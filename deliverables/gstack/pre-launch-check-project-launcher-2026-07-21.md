# Project Launcher（启航）上线前全检报告

**日期**：2026-07-21
**场景**：上线前检查（代码审查 + 安全审计 + QA测试）
**参与成员**：产品评审员（gstack-product-reviewer） + 安全官（gstack-security-officer） + QA负责人（gstack-qa-lead）

---

## 📌 TL;DR（执行摘要）

- **整体结论：🔴 NO-GO** — 三位成员中两位给出 NO-GO（产品评审员 4.5/10、QA 30/100），安全官给出 Conditional Go（C+），但前提条件（修复3个P0）尚未满足
- **阻塞项数量：9 项 P0**（构建失败、日志管道断裂、命令注入→RCE、CSP缺失、进程退出无通知、xterm内存泄漏、unwrap panic风险、启动状态不一致、僵尸进程风险）
- **下一步：修复全部 P0 阻塞项（预估 ~30h）→ 重新执行 QA 验证 → 通过后再上线**

---

## 🎯 核心结论卡片

| 项目 | 内容 |
|------|------|
| Go / No-Go | 🔴 NO-GO |
| 严重度分布 | 🔴 9 / 🟠 8 / 🟡 7 / 🟢 4 |
| 关键行动项 | 12 条（含 9 条 P0） |
| 建议负责人 | 前端工程师（日志管道+UI） + Rust工程师（进程管理+安全） |
| 代码质量评分 | 4.5/10（产品评审员） |
| 安全评级 | C+（安全官） |
| QA健康评分 | 30/100（QA负责人） |
| 功能覆盖率 | 25%完全实现 / 37.5%部分实现 / 37.5%未实现 |

---

## 1. 各成员核心结论

### 🔍 产品评审员（代码审查）
- **核心判断**：代码质量评分 4.5/10，🛑 NO-GO。架构骨架基本合理（Vue 3 + Tauri V2 + Pinia + xterm.js），但核心功能链路存在严重断裂——日志管道从后端到前端完全不通。进程管理有多处 panic 风险（11 处 unwrap()）和僵尸进程隐患。资源泄漏普遍存在（xterm 实例不销毁、Tauri 事件监听器不清理）。发现 8 个 Critical、14 个 Major、6 个 Minor、4 个 Info 级问题。
- **关键建议**：按优先级修复——日志管道（C1）→ unwrap安全处理（C4/C5/C6）→ 资源泄漏（C2/C3）→ 启动状态一致性（C7）→ 僵尸进程（C8）→ 错误处理（M7）→ 清理死代码（M3/M4/M5/M6）→ CSP配置（M10）。

### 🛡️ 安全官（OWASP+STRIDE 审计）
- **核心判断**：安全评级 C+，⚠️ Conditional Go。作为本地开发者工具威胁模型相对受限，但存在完整的命令注入→RCE攻击链：`script参数未校验 → cmd /c执行 → cmd.exe元字符解析 → 任意命令执行`，配合CSP缺失可构成 `XSS → invoke('start_project') → RCE` 的完整链路。OWASP Top 10 中 A03注入🔴Fail、A05安全配置错误🔴Fail、A09日志监控🔴Fail。STRIDE 威胁建模中 Tampering 和 Information Disclosure 为 Medium 风险。发现 2 个 High、4 个 Medium、5 个 Low 级漏洞。
- **关键建议**：修复3个P0阻塞项后可上线——① script参数白名单校验（仅`[a-zA-Z0-9_-:]`）② 配置CSP策略 ③ 修复日志转发（统一事件名+转发stdout/stderr）。P1项包括创建.gitignore和path参数校验。

### ✅ QA负责人（QA测试与发布）
- **核心判断**：健康评分 30/100，🛑 NO-GO。**构建直接失败**——`npm run typecheck` 报4个TypeScript编译错误（projectLogs未定义、addLog空函数），vue-tsc中断导致vite build从未执行，无法生成前端产物。功能覆盖度仅25%完全实现，核心功能"日志查看"从后端到前端整条链路断裂。进程退出无通知导致状态永远卡在"运行中"。项目列表不持久化，重启后丢失。三列看板未实现（实际为flat grid）。xterm.js未接入实际UI（仅在死代码ProjectCard中引用）。
- **关键建议**：P0阻塞项预估~9h修复（TypeScript编译修复1h + 日志发送+缓冲4h + 事件名统一1h + 进程退出检测3h），P1建议项预估~12h。建议完成全部P0+P1后重新QA验证。

---

## 2. 综合审查发现（去重合并后按严重度排序）

| # | 严重度 | 类别 | 位置 | 问题描述 | 建议 | 来源成员 |
|---|--------|------|------|---------|------|---------|
| 1 | 🔴P0 | 功能 | commands.rs L181-218; project.ts L105; ProjectDetail.vue L147 | **日志数据管道完全断裂**：后端stdout仅提取端口不emit日志、stderr直接丢弃；事件名不匹配(后端`project:log` vs 前端`project:${id}:log`)；store.addLog为空实现；ProjectDetail引用未定义变量projectLogs | 修复整条链路：后端emit `project:{id}:log` → 前端listen匹配 → store.addLog实现 → xterm渲染 | 产品官+安全官+QA |
| 2 | 🔴P0 | 安全 | commands.rs L131-137 | **命令注入→RCE**：script参数未校验直接传入`cmd /c npm run <script>`，Windows Command不转义`&`/`|`/`;`等元字符，恶意package.json脚本名可执行任意命令 | script参数白名单校验(仅`[a-zA-Z0-9_-:]`)，或使用Command::arg()逐参数传递 | 安全官+产品官 |
| 3 | 🔴P0 | 安全 | tauri.conf.json | **CSP缺失**：WebView无XSS防护层，配合命令注入构成完整RCE攻击链(XSS→invoke→cmd注入→RCE) | 配置CSP: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ipc: http://ipc.localhost` | 安全官+产品官 |
| 4 | 🔴P0 | 构建 | ProjectDetail.vue L147,150; project.ts L105 | **TypeScript编译失败(4错误)**：projectLogs未定义(TS2339)、addLog空函数参数未使用(TS6133)，vue-tsc中断，vite build从未执行 | 修复projectLogs为`store.projectLogs.get(path)||[]`，实现或移除addLog | QA |
| 5 | 🔴P0 | 功能 | commands.rs(无wait调用) | **进程退出无通知**：无child.wait()，进程退出/崩溃后UI永远显示"运行中"，erroredProjects永远返回空数组，"异常"状态永不触发 | 读取线程结束后emit `project:exited`事件，区分正常/异常退出，前端更新状态 | QA+产品官 |
| 6 | 🔴P0 | 资源泄漏 | LogPanel.vue L21-46 | **xterm Terminal实例从不销毁**：onUnmounted未调用dispose()，每次切换日志面板泄漏DOM+事件监听器+内部缓冲区+FitAddon | onUnmounted中调用`terminal.dispose()`并置null | 产品官 |
| 7 | 🔴P0 | 健壮性 | commands.rs L114,175,231,250; main.rs L61-62; commands.rs L64,90 | **11处unwrap() panic风险**：Mutex中毒后所有lock调用panic导致全后端不可用；file_name()在根路径返回None；窗口hide()失败panic | 替换为unwrap_or_else/匹配处理；Mutex用`lock().unwrap_or_else(\|e\| e.into_inner())` | 产品官+安全官 |
| 8 | 🔴P0 | 功能 | commands.rs L110-226 | **启动状态不一致**：spawn在线程内执行，主线程提前返回success:true，进程启动失败但UI已显示"运行中" | 在主线程spawn进程，成功后再启动读取线程，返回真实结果 | 产品官 |
| 9 | 🔴P0 | 功能 | commands.rs L234-246,253-263; main.rs L39-41 | **僵尸进程风险**：taskkill用spawn()非阻塞，quit时app.exit(0)在taskkill执行前退出；stop_project不emit stopped事件 | 使用.status()等待taskkill完成；quit时同步等待所有进程终止；统一emit stopped事件 | 产品官 |
| 10 | 🟠P1 | 跨平台 | commands.rs L131,146 | **仅支持Windows**：cmd硬编码、creation_flags(0x08000000) Windows专属、taskkill Windows命令，macOS/Linux完全无法运行 | 添加`#[cfg(target_os)]`分支，非Windows用`sh -c`和`pkill` | 产品官 |
| 11 | 🟠P1 | 功能 | ProjectDetail.vue; LogPanel.vue | **xterm.js未接入实际UI**：ProjectDetail用纯文本div渲染日志，LogPanel(含xterm)仅在死代码ProjectCard中引用 | ProjectDetail接入xterm.js替换纯文本div | QA |
| 12 | 🟠P1 | 功能 | store.rs; project.ts | **项目列表不持久化**：重启后项目丢失，PRD 4.4要求恢复；workspace_path虽保存但前端从未调用set/get命令 | 持久化项目列表到tauri-plugin-store，启动时加载 | QA |
| 13 | 🟠P1 | 功能 | Dashboard.vue | **三列看板未实现**：PRD要求待处理/进行中/异常三列布局，实际为flat grid所有项目混合显示 | 实现三列分组布局，按状态过滤 | QA |
| 14 | 🟠P1 | 功能 | scan_directory未接入前端 | **工作区递归扫描未启用**：Rust命令已实现(max_depth=3, 排除node_modules)但前端从未调用，只调用scan_project单目录扫描 | 前端接入scan_directory实现工作区选择 | QA |
| 15 | 🟠P1 | 功能 | stores/project.ts L58-84 | **无错误处理**：store中startProject/stopProject的invoke()无try-catch，Rust命令panic或返回错误时Promise rejection无人处理 | 包裹try-catch，catch中ElMessage.error()并清理不一致状态 | 产品官 |
| 16 | 🟠P1 | 资源泄漏 | App.vue L10,21; ProjectCard.vue L37 | **Tauri事件监听器从不清理**：listen()返回的unlisten函数从未存储或调用，监听器持续累积 | onUnmounted中调用unlisten函数 | 产品官 |
| 17 | 🟠P1 | 安全 | 项目根目录 | **无.gitignore**：node_modules/dist/src-tauri/target可能被意外提交到版本控制 | 创建.gitignore文件 | 安全官 |
| 18 | 🟡P2 | 代码质量 | ProjectCard.vue(整个文件); port.ts; store.rs | **死代码**：ProjectCard.vue从未被导入(287行)；port.ts从未使用；store.rs空文件但声明mod store | 删除死代码或重构复用 | 产品官+QA |
| 19 | 🟡P2 | 代码质量 | Dashboard.vue L17; ProjectDetail.vue L45,47,50,52; project.ts L59,64 | **6处console.log调试语句残留**：包括packageManager值和invoke result | 删除或改用可配置debug logger | 产品官+QA |
| 20 | 🟡P2 | 安全 | commands.rs L82,104,110,229 | **path参数无校验**：无canonicalize、无长度限制、无白名单、无符号链接检测 | 添加path校验函数(canonicalize+is_dir+长度检查) | 安全官 |
| 21 | 🟡P2 | 安全 | commands.rs L17 | **无进程数量限制**：RUNNING_PROCESSES HashMap无大小限制，可通过IPC循环启动数十进程耗尽内存 | 添加MAX_RUNNING_PROCESSES=20限制 | 安全官 |
| 22 | 🟡P2 | 代码质量 | commands.rs L193 | **regex在循环内重复编译**：每匹配一行就编译一次正则 | 使用lazy_static编译一次 | 产品官 |
| 23 | 🟡P2 | 代码质量 | Cargo.toml L24 | **tokio features="full"过度引入**：项目用std::thread而非tokio，full引入所有模块增大二进制体积 | 缩小feature范围或移除(Tauri内部已含tokio) | 产品官+安全官 |
| 24 | 🟡P2 | 功能 | ProjectDetail.vue L181 | **固定420px宽度无响应式**：小屏幕上可能过宽 | 改用`max-width:420px; width:90vw` | 产品官 |
| 25 | 🟢Info | — | main.rs L33 | 托盘图标为32x32纯蓝色块占位 | 生产环境需要真实图标 | 产品官 |
| 26 | 🟢Info | — | 全项目 | 零测试覆盖，无任何单元/集成测试 | 建议覆盖进程管理和端口提取逻辑 | 产品官 |
| 27 | 🟢Info | — | capabilities/default.json | Tauri权限最小化配置正确(仅dialog/store/shell:allow-open) | 保持当前配置 | 产品官 |
| 28 | 🟢Info | — | Cargo.toml | release profile优化(lto=true, codegen-units=1) | 保持 | 产品官 |

---

## 🚫 阻塞项清单（上线前必须修复）

| # | 阻塞项 | 严重度 | 预估修复时间 | 负责方 |
|---|--------|--------|-------------|--------|
| 1 | TypeScript编译失败(4错误) — 构建直接中断 | 🔴P0 | 1h | 前端 |
| 2 | 日志管道完全断裂(后端不emit+事件名不匹配+store空实现+变量未定义) | 🔴P0 | 4h | 全栈 |
| 3 | 命令注入→RCE(script参数无校验+cmd /c执行) | 🔴P0 | 2h | Rust |
| 4 | CSP缺失(XSS入口+RCE攻击链环节) | 🔴P0 | 0.5h | 配置 |
| 5 | 进程退出无通知(状态永远卡"运行中"+"异常"永不触发) | 🔴P0 | 3h | Rust |
| 6 | xterm Terminal实例内存泄漏(不dispose) | 🔴P0 | 0.5h | 前端 |
| 7 | 11处unwrap() panic风险(Mutex中毒+根路径+窗口操作) | 🔴P0 | 2h | Rust |
| 8 | 启动状态不一致(提前返回success) | 🔴P0 | 2h | Rust |
| 9 | 僵尸进程风险(taskkill非阻塞+quit时未等待) | 🔴P0 | 1h | Rust |
| **合计** | | | **~16h** | |

---

## 🔄 回滚预案

### 触发条件
- 当前版本**不应发布**，标记为 `v0.9-pre-alpha`
- 如已分发给测试用户，立即通知停止使用

### 回滚步骤
1. **代码回滚**：`git revert` 到上一个稳定 commit（如有），或保留当前代码标记为 `v0.9-pre-alpha` 不发布
2. **进程清理**（如已分发）：
   - 通过任务管理器手动结束 `cmd.exe` 子进程树
   - 或提供清理脚本：`taskkill /F /IM node.exe /T`（⚠️ 谨慎使用，会杀所有 node 进程）
3. **配置清理**：删除 `%APPDATA%/com.project-launcher.dev/config.json`
4. **发布说明**：通知测试用户当前版本为不可用 pre-release，等待修复后重新发布

### 修复后验证流程
1. 修复全部 P0 阻塞项（~16h）
2. 修复 P1 建议项（~12h）
3. 重新执行 QA 验证（typecheck + build + 功能测试）
4. 重新执行安全复审（命令注入 + CSP）
5. 通过后方可发布

---

## ✅ 行动清单

| # | 行动 | 负责方 | 紧急度 | 期望完成 |
|---|------|--------|--------|---------|
| 1 | 修复TypeScript编译错误：ProjectDetail.vue projectLogs引用 + project.ts addLog空函数 | 前端 | P0 | 立即 |
| 2 | 修复日志管道：后端stdout/stderr emit `project:{id}:log` + 前端统一listen + store.addLog实现 + 200ms缓冲 | 全栈 | P0 | 立即 |
| 3 | 修复命令注入：script参数白名单校验(仅`[a-zA-Z0-9_-:]`) | Rust | P0 | 立即 |
| 4 | 配置CSP策略到tauri.conf.json | 配置 | P0 | 立即 |
| 5 | 实现进程退出检测：读取线程结束后emit退出事件，前端更新状态 | Rust | P0 | 立即 |
| 6 | 修复xterm内存泄漏：onUnmounted调用terminal.dispose() | 前端 | P0 | 立即 |
| 7 | 替换11处unwrap()为安全错误处理 | Rust | P0 | 立即 |
| 8 | 重构start_project：主线程spawn成功后再启动读取线程 | Rust | P0 | 立即 |
| 9 | 修复僵尸进程：taskkill用.status()等待完成 + quit时同步等待 | Rust | P0 | 立即 |
| 10 | ProjectDetail.vue接入xterm.js替换纯文本日志渲染 | 前端 | P1 | 本周 |
| 11 | 实现项目列表持久化到tauri-plugin-store | 全栈 | P1 | 本周 |
| 12 | 创建.gitignore + 清理console.log和死代码 | 全栈 | P1 | 本周 |

---

## ⚠️ 待完善 / 已知局限

- **Rust 构建未实际编译**：QA 仅做了代码审查，未运行 `cargo build`（需要 Rust 编译环境），可能存在编译错误未被发现
- **功能测试为代码层面推断**：由于构建失败无法生成产物，所有功能测试基于代码审查推断，未实际运行应用
- **跨平台测试缺失**：当前仅评估了 Windows 平台，macOS/Linux 完全无法运行（cmd/taskkill 硬编码）
- **性能测试缺失**：未实际测试 10+ 项目同时运行时的内存和 UI 响应
- **安全审计范围**：未进行实际渗透测试，基于代码审查和威胁建模
- **store.rs 空文件**：`mod store` 声明但文件为空，可能是未完成的迁移，需确认意图

---

## 📚 成员产出索引

- **gstack-product-reviewer（产品评审员）** 原始产出：PR级代码审查报告，评分4.5/10，8 Critical + 14 Major + 6 Minor + 4 Info，含代码亮点6项和修复优先级建议
- **gstack-security-officer（安全官）** 原始产出：OWASP Top 10检查表 + STRIDE威胁建模矩阵，评级C+，2 High + 4 Medium + 5 Low，含完整攻击场景和修复代码示例
- **gstack-qa-lead（QA负责人）** 原始产出：构建验证(typecheck FAIL) + 功能覆盖度矩阵(25%完全实现) + 边界场景分析 + Go/No-Go检查清单 + 回滚预案，健康评分30/100
- **交叉验证补充**：产品评审员与安全官完成交叉验证，确认命令注入→RCE完整攻击链(CSP缺失→XSS→invoke→cmd注入→RCE)，提供交叉引用映射表

---

> 本报告由软件工坊 AI 协作生成，关键决策请由工程负责人复核。
