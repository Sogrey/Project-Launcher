# Project Launcher 第二轮上线前全检报告

**日期**：2026-07-22
**场景**：上线前检查（第二轮复审）
**参与成员**：产品评审员 + 安全官 + QA负责人

---

## 📌 TL;DR（执行摘要）

- **整体结论：🟡 Conditional Go** — 第一轮全部 9 项 P0 阻塞项已修复，构建三件套全部通过，核心功能链路打通。仅剩 1 项新发现的 Critical（前后端 project_id 算法不一致，中文路径失效），一行代码可修复。
- **评分跃升**：代码质量 4.5→7.5/10 | 安全评级 C+→A- | QA健康评分 30→80/100
- **下一步**：修复 project_id 算法对齐后即可上线

---

## 🎯 核心结论卡片

| 项目 | 内容 |
|------|------|
| Go / No-Go | 🟡 Conditional Go |
| 第一轮 P0 修复率 | 9/9 = 100% ✅ |
| 严重度分布（第二轮） | 🔴 1 项 P0 / 🟠 0 项 P1 / 🟡 7 项 P2 / 🟢 6 项 Info |
| 代码质量评分 | 7.5/10（产品评审员，第一轮 4.5） |
| 安全评级 | A-（安全官，第一轮 C+） |
| QA 健康评分 | 80/100（QA负责人，第一轮 30） |
| 构建验证 | ✅ typecheck PASS / ✅ build PASS / ✅ cargo check PASS |
| 功能覆盖率（V1） | 88.2%（完全实现 70.6% + 部分实现 17.6%） |
| 上线检查清单 | 16/16 Pass |
| 关键阻塞项 | 1 项（project_id 算法对齐，估时 0.5h） |
| 建议负责人 | 前端开发 |

---

## 1. 各成员核心结论

### 🔍 产品评审员（代码复审）
- **核心判断**：第一轮 8 项 Critical 全部修复 ✅，评分 4.5→7.5。日志管道、内存管理、错误处理、进程生命周期管理都有实质性改进。修复过程中暴露了 1 项新 Critical——前后端 project_id 生成算法不一致（Rust 的 `is_alphanumeric()` 是 Unicode 感知的，前端 `/[^a-zA-Z0-9]/g` 仅 ASCII），导致中文路径下 `project:log`/`project:port`/`project:exited` 事件路由全部失效。
- **关键建议**：前端改用 `/[^\p{L}\p{N}]/gu` 与 Rust 对齐，一行代码改动。

### 🛡️ 安全官（OWASP+STRIDE 复审）
- **核心判断**：第一轮 3 个 P0 阻塞项全部修复，修复质量"优秀"。命令注入采用了"输入白名单 + 消除 shell 调用"双重防御（教科书级），CSP 配置严格（script-src 'self'，无 unsafe-eval），日志转发通过 AtomicUsize 读取器追踪优雅处理竞态。安全评级 C+→A-，0 阻塞项。
- **关键建议**：后续为 `shell:allow-open` 配置 URL scope（P3，非阻塞）。

### ✅ QA负责人（QA复测）
- **核心判断**：构建三件套（typecheck/build/cargo check）全部通过，第一轮 4 项 Critical + 7 项重要问题全部修复。核心功能链路（扫描→启动→日志→停止→退出检测→持久化）完整打通。V1 功能覆盖率 88.2%。健康评分 30→80。16/16 上线检查清单全部 Pass。新发现 0 个 Critical/Major。
- **关键建议**：上线前建议补加"重启"按钮和"删除项目"功能（非阻塞）。

> 设计师和排障手本次未上场

---

## 2. 第一轮 P0 阻塞项修复验证（对照表）

| # | 第一轮 P0 项 | 严重度 | 修复状态 | 验证人 | 修复说明 |
|---|-------------|--------|---------|--------|---------|
| 1 | TypeScript 编译失败 | 🔴 | ✅ 已修复 | QA | projectLogs 改为 computed，addLog 实现完整逻辑，typecheck exit 0 |
| 2 | 日志管道完全断裂 | 🔴 | ✅ 已修复 | 产品+QA | spawn_log_reader 转发 stdout/stderr，200ms/50行批量缓冲，事件名统一为 project:log |
| 3 | 命令注入→RCE | 🔴 | ✅ 已修复 | 安全+产品 | 双重防御：SCRIPT_RE 白名单 `^[a-zA-Z0-9_:-]+$` + 消除 shell 调用（Command::new+arg） |
| 4 | CSP 缺失 | 🔴 | ✅ 已修复 | 安全 | 完整 CSP 配置，script-src 'self'，connect-src 仅 IPC |
| 5 | 进程退出无通知 | 🔴 | ✅ 已修复 | 产品+QA | reap_and_emit_exit + child.wait() + AtomicUsize 计数器，emit project:exited |
| 6 | xterm 内存泄漏 | 🔴 | ✅ 已修复 | 产品 | onUnmounted 调用 terminal.dispose() + 置 null |
| 7 | 11处 unwrap() panic | 🔴 | ✅ 已修复 | 安全+产品 | lock_processes() 使用 unwrap_or_else 恢复 poisoned mutex，仅剩 lazy_static 正则 unwrap（安全） |
| 8 | 启动状态不一致 | 🔴 | ✅ 已修复 | 产品 | start_project 主线程同步 spawn，成功后才返回 success: true |
| 9 | 僵尸进程风险 | 🔴 | ✅ 已修复 | 产品 | kill_process_tree 使用 .status() 阻塞等待 + child.wait() reap |

**第一轮 P0 修复率：9/9 = 100%**

---

## 3. 综合审查发现（第二轮，按严重度排序）

| # | 严重度 | 类别 | 位置 | 问题描述 | 建议 | 来源成员 |
|---|--------|------|------|---------|------|---------|
| 1 | 🔴 P0 | 功能 | commands.rs L78-80 vs project.ts L63-67 | 前后端 project_id 算法不一致：Rust `is_alphanumeric()` 是 Unicode 感知（中文保留），前端 `/[^a-zA-Z0-9]/g` 仅 ASCII（中文替换为 _）。中文路径下 ID 不匹配导致 log/port/exited 事件路由失效 | 前端正则改用 `/[^\p{L}\p{N}]/gu`，或后端改用 `is_ascii_alphanumeric` | 产品评审员 |
| 2 | 🟡 P2 | 性能 | dist/assets (1,359kB) | 前端打包体积超 500KB 阈值，Element Plus + xterm.js 全量打包 | 配置 manualChunks 或按需导入 | QA |
| 3 | 🟡 P2 | 功能 | ProjectDetail.vue | 缺少"重启"按钮（PRD V1 要求） | 添加重启按钮，stop 后立即 start | QA |
| 4 | 🟡 P2 | 功能 | Dashboard.vue | 缺少"删除项目"功能，列表只增不减 | 项目卡片添加删除按钮 | QA |
| 5 | 🟡 P2 | 代码 | commands.rs L465-475 | stop_all_projects 持锁执行阻塞 kill，20 进程时锁持有较久 | drain 后释放锁再逐个 kill | 产品评审员 |
| 6 | 🟡 P2 | 代码 | LogPanel.vue L56 | watch 使用 deep:true 不必要，2000 元素数组增加遍历开销 | 移除 deep:true | 产品评审员 |
| 7 | 🟡 P2 | 代码 | commands.rs L270-285 | scan_project 吞没路径验证错误，路径无效和非 Node.js 项目返回相同 None | 改为 Result<Option<Project>, String> | 产品评审员 |
| 8 | 🟢 Info | 安全 | capabilities/default.json L14 | shell:allow-open 缺少显式 URL scope（当前安全但缺纵深防御） | 配置 scope 为 http://localhost:* | 安全官 |
| 9 | 🟢 Info | 功能 | LogPanel.vue | FitAddon 未响应窗口 resize | 添加 ResizeObserver | QA |
| 10 | 🟢 Info | 功能 | PRD 1.4 | 缺少项目别名功能 | ProjectDetail 添加别名编辑 | QA |
| 11 | 🟢 Info | 质量 | 全项目 | 零测试覆盖 | 优先覆盖 project_id_from_path、is_valid_script | QA |
| 12 | 🟢 Info | 视觉 | main.rs L33 | 托盘图标为 32x32 纯蓝色占位符 | 设计正式应用图标 | QA |
| 13 | 🟢 Info | 代码 | project.ts L18 | RunningProject.logs 字段为死数据 | 删除该字段 | 产品评审员 |

---

## ✅ 行动清单

| # | 行动 | 负责方 | 紧急度 | 期望完成 |
|---|------|--------|--------|---------|
| 1 | **修复 project_id 算法对齐**：前端 `path.replace(/[^a-zA-Z0-9]/g, '_')` → `path.replace(/[^\p{L}\p{N}]/gu, '_')`，或后端 `is_alphanumeric()` → `is_ascii_alphanumeric()` | 前端 | P0 | 上线前 |
| 2 | 添加"重启"按钮（PRD V1 要求） | 前端 | P2 | 下一迭代 |
| 3 | 添加"删除项目"功能 | 前端 | P2 | 下一迭代 |
| 4 | 优化打包体积（manualChunks 或按需导入 Element Plus） | 前端 | P2 | 下一迭代 |
| 5 | CI/CD 集成 cargo audit + npm audit | DevOps | P2 | 下一迭代 |
| 6 | 添加基础单元测试（project_id_from_path, is_valid_script, parse_package_json） | 全栈 | P3 | Backlog |
| 7 | 设计正式应用图标替换占位符 | 设计 | P3 | Backlog |

---

## 📊 第一轮 vs 第二轮对比

| 维度 | 第一轮 | 第二轮 | 变化 |
|------|--------|--------|------|
| **整体判定** | 🔴 NO-GO | 🟡 Conditional Go | 📈 质变 |
| 代码质量评分 | 4.5/10 | 7.5/10 | +3.0 |
| 安全评级 | C+ | A- | +2 级 |
| QA 健康评分 | 30/100 | 80/100 | +50 |
| P0 阻塞项 | 9 项 | 1 项（新发现） | -8 |
| 构建状态 | ❌ FAIL | ✅ PASS | 修复 |
| 功能覆盖率（V1） | ~25% 完全实现 | 88.2% 覆盖 | +63% |
| 安全 P0 项 | 3 项 | 0 项 | -3 |
| 死代码 | 3 个文件 | 0 | 清理 |

---

## 🏗️ 阻塞项清单与回滚预案

### 阻塞项清单（上线前必须修复）

| # | 问题 | 位置 | 修复方案 | 估时 |
|---|------|------|---------|------|
| 1 | 前后端 project_id 算法不一致 | project.ts L63-67 | 正则改为 `/[^\p{L}\p{N}]/gu` | 0.5h |

### 回滚预案

**触发条件**：
- 上线后发现有未覆盖的 Critical 问题
- 进程管理异常导致僵尸进程

**回滚步骤**：
1. **版本标记**：当前版本标记为 v1.0.0-beta，可发布
2. **进程清理**（如需）：任务管理器结束 project-launcher.exe 进程树，或 `taskkill /F /IM node.exe /T`（谨慎使用）
3. **配置清理**：删除 `%APPDATA%/com.project-launcher.dev/config.json`
4. **代码回滚**：`git revert` 到上一个稳定 commit
5. **通知**：通知测试用户停止使用并等待修复版本

---

## ⚠️ 待完善 / 已知局限

- **功能测试为代码层面推断**：未实际运行 Tauri 应用进行端到端测试，所有功能验证基于代码审查 + 构建验证 + 逻辑推演
- **Rust 构建为 check 非 build**：cargo check 验证编译正确性但未生成最终二进制，tauri build 未执行
- **性能测试缺失**：未实际测试 10+ 项目同时运行时的内存和 UI 响应
- **跨平台未实测**：代码层面有 cfg(unix) 分支，但仅在 Windows 环境验证
- **project_id 碰撞风险**：不同路径可能映射到相同 ID（如 `C:\a\b` 和 `C:\a_b`），后端通过 contains_key 检查防止进程覆盖，但建议未来改用路径哈希

---

## 📚 成员产出索引

- **gstack-product-reviewer（产品评审员）原始产出**：第二轮代码复审报告 — 8项Critical全部修复验证 + 5项新发现 + 评分4.5→7.5
- **gstack-security-officer（安全官）原始产出**：第二轮安全复审报告 — 3项P0全部修复验证 + OWASP/STRIDE更新 + 评级C+→A- + 3项新发现
- **gstack-qa-lead（QA负责人）原始产出**：第二轮QA复测报告 — 4项Critical全部修复验证 + 构建三件套PASS + 功能覆盖度88.2% + 评分30→80 + 7项新发现

---

## 🎯 三位成员修复质量评价共识

三位成员一致认为本次修复质量**优秀**，具体亮点：

1. **命令注入修复**（安全官评）：双重防御——白名单校验 + 消除 shell 调用，"教科书级防御纵深"
2. **日志管道修复**（QA评）：200ms/50行双触发批量缓冲 + AtomicUsize 读取器完成追踪，"兼顾实时性和性能"
3. **进程管理修复**（产品评审员评）：kill_process_tree 跨平台 + child.wait() reap + 主线程同步 spawn，"进程生命周期管理完整"
4. **错误处理修复**（产品评审员评）：lock_processes() 恢复 poisoned mutex，"没有走过场"
5. **CSP 配置**（安全官评）：script-src 'self' 严格限制，connect-src 仅 IPC，"有效防止 XSS 和数据外泄"

---

> 本报告由软件工坊 AI 协作生成，关键决策请由工程负责人复核。
> 第一轮报告：deliverables/gstack/pre-launch-check-project-launcher-2026-07-21.md
