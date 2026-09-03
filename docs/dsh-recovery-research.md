# DSH「自动恢复 / 安全模式 / 修复模式」生态调研报告

> 调研时间：本会话。数据源：GitHub 仓库/README、npm registry、awesome-dsh-plugin 全量目录
> （约 2777 条）、本机运行中的 `@deepseek-ai/dsh@0.1.1-rc.2` 源码与 `~/.dsh` 实机布局。
> 结论先行：社区**已经有人做过安全模式、修复模式、崩溃恢复**，而且数量不少、形态五花八门；
> 但没有统一标准，也没有一个方案把「检测 → 自动进入安全/修复模式 → 修复 → 验证」串成一个闭环。
> 这是我们设计新东西的最大机会，也是最大风险。

---

## 1. 官方现状（以本机实机为准）

先明确官方给了什么、没给什么，这是所有社区方案的共同底座：

- **启动 = fail-loud**：`dsh web` 的插件树是「bundle 层 → profile `cordis.patch.yml` →
  家目录 `$DSH_HOME/cordis.patch.yml` → `--patch` overlay」的补丁层栈，任何一个 bundle 的
  patch 加载/激活失败（缺包、`dsh.bundle` 声明丢失、重复 loader entry id、`name:` 解析失败、
  YAML 坏）都会让整个进程退出。**坏一个插件 = 整个 GUI 起不来**。
- **官方 CLI 只有**：`dsh web / --profile / --patch / --dump-config / --dump-default-config /
  plugin add|remove`。没有 doctor、没有 safe-mode、没有 recovery 命令。
- **`dsh plugin` 是 pnpm 转发器**：`pnpm` 退出码为 0 时才执行 `reconcilePlugins()` 把
  `dsh.profile.bundles` 层栈对账成已安装依赖。**pnpm 失败 → 层栈不写 → 插件“装上了但没挂载”，
  且静默无感**（社区称之为五道关卡之一）。
- **官方已有的自我修复**（有限）：profile 模板自动初始化；`healProfilesModuleFallback`
  每次启动重建 `$DSH_HOME/profiles/node_modules` 符号链接兜底；`normalizeShippedProfile`
  校正被改过的出厂 bundle 列表；profile 与家目录两个 patch 层都有 chokidar 热重载
  （`disabled: true` 约 1s 生效）。
- **版本现实**：DSH 仍是 developer preview（本机 0.1.1-rc.2），API 常变；官方讨论区里的
  崩溃家族有编号可查（如 #1497/#1586 的 `seq gap`、#4365 的空 tool-call id 链、
  #4825 的插件对账问题）。

**推论**：任何“自动恢复”系统都必须自带一部分运行在插件加载链**之外**的能力（进程外
守护/独立 profile/独立 home），因为坏插件会在任何用户插件有机会运行之前就把进程杀掉。

## 2. 社区全景：六类方案

### A. 插件市场与插件管理（问题的入口）

| 项目 | 要点 |
|---|---|
| [dsh-market/dsh-market](https://github.com/dsh-market/dsh-market)（dshmarket，~2.9k★） | Settings 内市场；一键启停（写 patch `disabled`）；配置备份/恢复、WebDAV/Gist 同步；一键更新 |
| [AlexYin-Tongji/dsh-plugin-console](https://github.com/AlexYin-Tongji/dsh-plugin-console) | 安装前验证（SemVer/integrity/生命周期脚本）；**隔离试运行**（临时 DSH_HOME + 随机端口完整启动验证）；DSH 本体一键更新 + 失败自动重装旧版 |
| [qinyre/dsh-plugin-install](https://github.com/qinyre/dsh-plugin-install) | 设置页任意 spec 安装，走官方 CLI；处理 pnpm `minimumReleaseAge` 陷阱 |
| [oxlyn/dsh-plugin-mgr](https://github.com/oxlyn/dsh-plugin-mgr) / [fazhu4/dsh-plugin-studio](https://github.com/fazhu4/dsh-plugin-studio) | 已装插件启停/详情/更新/卸载；监听 fiber 状态显示加载失败 |
| [nonentity303/dsh-plugin-manager](https://github.com/nonentity303/dsh-plugin-manager)（dsh-plugin-manager-pro） | “救砖中心”：**独立救砖守护 3081 端口**（主引擎挂了也能自检/修复/拉起）、`/rescue` 页、Steam 式启动序列 |
| [awesome-dsh-plugin/awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) / dshfind / [dsh-find-plugin](https://github.com/awesome-dsh-plugin/dsh-find-plugin) / [Nagi-ovo/dsh-find-plugins](https://github.com/Nagi-ovo/dsh-find-plugins) / [meme-dog/dsh-plugin-finder](https://github.com/meme-dog/dsh-plugin-finder) | 发现层：目录、会话内搜索、**装前静态安全审计**（生命周期脚本/网络/子进程/密钥/危险模式） |

### B. 备份 / 快照 / 回滚

| 项目 | 要点 |
|---|---|
| [xiaoyuyu6420/dsh-backup](https://github.com/xiaoyuyu6420/dsh-backup) | 整 `~/.dsh` tar.gz 备份；**检测宿主版本变化自动做 pre-upgrade 快照**；会话日志 doctor；凭据脱敏；GitHub 同步；带独立救援控制台 |
| [lire1131/dsh-undo-savepoint](https://github.com/lire1131/dsh-undo-savepoint)（~138★，最完整之一） | 配置+插件代码快照、消息级工作区撤销、密钥脱敏 vault、**一键安全模式**、崩溃归因（last-good 快照一键回退）、会话文件扫描修复、局外 WebUI/GUI/CLI |
| [lxzy-7/dsh-plugin-guard](https://github.com/lxzy-7/dsh-plugin-guard) | 安装前自动快照；**守护启动 = 快照 → 启动 → HTTP 健康检查（含客户端渲染）→ 失败自动回滚重试**；回滚仍失败则从启动日志定位坏插件并隔离；事故报告自动触发 agent 分析 |
| [q862877400-ux/dsh-fuhuobi](https://github.com/q862877400-ux/dsh-fuhuobi) | “复活币”：每次成功启动铸一枚快照币，桌面双击 `DSH复活币X1.cmd` 恢复；三级轮换；回滚前自动 pre-rollback 快照 |
| [x2802490130-prog/dsh-guard](https://github.com/x2802490130-prog/dsh-guard) | 滚动快照；启动成功宽限期后自动存档；运行期插件失败三护栏内自动回退 |
| [SuCriss/dsh-version-update](https://github.com/SuCriss/dsh-version-update) | 针对 **DSH 本体**：安装前快照、秒级回滚、`recoverOnFailedRestart`（新版本起不来自动恢复旧版）、更新策略引擎（时间窗/自动/泊车） |

### C. 安全模式 / 修复模式 / 崩溃恢复（用户问的重点，确实有）

| 项目 | 要点 |
|---|---|
| [jinsiyu/dsh-safemode-profile](https://github.com/jinsiyu/dsh-safemode-profile) | 维护一个永远干净的 `dsh --profile safemode`：启动时强制把 profile 写回白名单模板（核心 bundle + 空 patch），运行期 fs.watch + 30s 轮询防漂移 |
| [aorucshiea/dsh-safe-tui](https://github.com/aorucshiea/dsh-safe-tui) | 安全模式 TUI（`dsh --profile safe`）：不加载用户插件、不加载 Web、只允许官方预设；`/sessions` 续历史、`/repair` 从内置 pristine 副本修复官方客户端文件；也可作为 Web 内“控制台”Tab |
| [SaiSenBox/dsh-boot-guard](https://github.com/SaiSenBox/dsh-boot-guard) | 解决“插件把插件管理页一起弄崩”的死循环：host 把**最小救援脚本直接注入失败页面**，跳过疑似插件（写带标记的 `disabled` 补丁）、刷新即试、只恢复自己写的块 |
| [@linxin666/dsh-doctor](https://github.com/zhu1090093659/dsh-web/tree/main/packages/dsh-doctor)（dsh-web 全家桶成员） | 目前最“产品化”的救助模式：**Doctor Launcher**（接管每次 `dsh` 启动，转发 argv/信号/退出事实）+ **Doctor Supervisor**（用户级后台服务，心跳/退出分类/崩溃循环熔断）+ **救援胶囊**（pinned DSH 运行时 + 独立 DSH_HOME，坏 overlay 也挡不住）+ 事务化修复（快照→候选→隔离健康门→promote→失败字节级回滚）+ 白屏客户端探针 |
| [lanbaolu/dsh-fail-soft](https://github.com/lanbaolu/dsh-fail-soft) | 改内核给挂载期加“隔离委托插槽”：坏插件自动写 disabled 再重试，其余照常起；自带内核补丁自愈；另有**进程外包装器**第二层兜底。缺点：依赖内核补丁，官方升级需重新适配 |
| [baosfeng/my-dsh-plugins](https://github.com/baosfeng/my-dsh-plugins)（dsh-my-guardian） | 插件治理：新装/更新先进候选区，启动后热挂载，成功转正、失败隔离、连续失败冻结，一键安全模式 + 侧边栏诊断面板 |
| [dong3434/dsh-auto-maintenance](https://github.com/dong3434/dsh-auto-maintenance) | 启动自检/修复、周期备份、端口检测、插件变更 watcher 自动快照回滚、连续 3 次启动失败自动救援重启 |
| [yushaner/dsh-plugin-sentinel](https://github.com/yushaner/dsh-plugin-sentinel) | 装前兼容判定（safe/caution/block + 规则表）、快照回滚、safemode enter/exit（临时把坏插件移出 bundles，核心 bundle 保护） |
| [aokamoaki/dsh-startup-guard](https://github.com/aokamoaki/dsh-startup-guard) | 启动早期七道检查：会话日志修复、清单指纹快照、bundle 预检回滚、组合预检（重复 id/name 失效）、client 产物 vm 加载校验、**宿主 apply() 子进程冒烟**、崩溃标记强制全量冒烟隔离 |
| [Shizuku-keop/dsh-plugin-console](https://github.com/Shizuku-keop/dsh-plugin-console) | **插件期望状态对账器**：`plugins.intent.json`（profile 外）→ boot 后实测 loader 树 → 缺失自动补写；五道加载关卡逐一诊断；确定性 heal |

### D. 会话/数据损坏修复（崩溃后的“后遗症”）

[Zn-Dk/dsh-session-repair](https://github.com/Zn-Dk/dsh-session-repair)（空 tool-call id 链整链修复、pre-repair 备份、指纹校验）、[xiaoshenming/dsh-session-surgeon](https://github.com/xiaoshenming/dsh-session-surgeon)（seq gap/torn zstd/lone surrogate 修复 + 复制会话 ID）、[MedicineKing/dsh-corrupt-session-repair](https://github.com/MedicineKing/dsh-corrupt-session-repair)（#1497 end-seed 对，零安装单文件）、[Coprexist/dsh-session-recovery](https://github.com/Coprexist/dsh-session-recovery)（从原始磁盘恢复 zstd 帧与 memory.db）、[Semidia/dsh-session-repair-ui](https://github.com/Semidia/dsh-session-repair-ui)、[Leeminjing/dsh-messages-sanitizer](https://github.com/Leeminjing/dsh-messages-sanitizer)（400 INVALID_REQUEST）。

### E. 运行期自愈 / 看门狗

[cyanseek/dsh-autofix](https://github.com/cyanseek/dsh-autofix)（工具错误配方：重试/刷新/等价命令/Error Atlas）、[dsh-clawshell](https://github.com/jorinyang/dsh-clawshell)（运行时自愈层）、dsh-daemon（systemd 看门狗）、dsh-auto-continue / dsh-autoresume / dsh-restart-recover（崩溃后自动继续被打断的 agent 回合）、[Asuna486-desuwa/dsh-safety-net](https://github.com/Asuna486-desuwa/dsh-safety-net)（对 `~/.dsh` 关键路径的写意图硬拦截 + 拒绝前快照 + CLI 自救通道）。

### F. 插件健康检查 / 兼容性审计

[CMSKL/dsh-plugin-observatory](https://github.com/CMSKL/dsh-plugin-observatory)（`plugin_audit` 静态清单审计 + `plugin_observe` 有界 loader 生命周期观测）、[dsh-perfscope](https://github.com/Evhye38496/dsh-perfscope)（0-100 健康分 + 可逆修复）、[zhao1012/dsh-fix-duplicate-loader-id](https://github.com/zhao1012/dsh-fix-duplicate-loader-id)（重复 entry id 崩溃的确定性修复 skill）、dsh-plugin-doctor（zoahdev）、dsh-plugin-check、dsh-depguard（依赖拓扑/多副本检测）、[dsh-win32](https://github.com/sjh9714/dsh-win32)（Windows 专属诊断修复）。

## 3. 社区已经验证过的关键经验（设计必须吸收）

1. **进程外兜底是刚需**：dsh-plugin-manager-pro 的 3081 守护、dsh-backup 的 rescue console、
   dsh-doctor 的 Rescue Capsule、fuhuobi 的桌面 .cmd、undo-savepoint 的局外 WebUI——所有
   “起不来还能救”的方案都做到了同一件事：救援通道不依赖插件树。
2. **健康检查要验“渲染”而不只是 HTTP 200**：lxzy-7 的 boot-guard v0.3.1 起确认客户端真正渲染，
   否则黑屏会被误判为健康。
3. **回滚必须可逆**（pre-rollback 快照）、**按 profile 粒度**（5 个配置文件 + frozen lockfile
   重装）、**快照必须记录 DSH 版本**（升级导致的坏不是 profile 回滚能救的，见 lxzy-7 v0.3.2）。
4. **自动修复只做确定性操作**：Shizuku 的“heal 只做幂等修复，不确定的只给命令”、astra3294
   dsh-doctor 的“safe actions 零确认 + 其余显式确认”、@linxin666/dsh-doctor 的“ambiguous 生成
   候选等待确认”——三者独立得出同一结论。
5. **隔离优于卸载**：写 `- id: X / disabled: true` 补丁，保留包与数据，可一键恢复。
6. **多入口自保**：dsh-startup-guard 的 fire-and-forget（守卫自身失败绝不拖垮启动）、
   dsh-boot-guard 的“不能跳过自己”、dsh-fail-soft 的“官方核心组件不写持久隔离”（避免把端口
   冲突误判成坏插件）。
7. **把“意图”从“被修对象”里拿出来**：Shizuku 的 `plugins.intent.json` 放 profile 外——
   修复清单不能住在易碎区里。
8. **升级是独立故障类**：升级破坏 ≠ 插件破坏。profile 快照回滚救不了 `npx` 重装的新 DSH；
   需要 DSH 本体快照（SuCriss）、pre-upgrade 快照（dsh-backup）、内核补丁自愈（fail-soft）
   三套机制分别处理。

## 4. 现状缺口（为什么还值得做）

- **官方没有** safe/repair 模式，boot fail-loud；`dsh plugin` 的层栈对账依赖 pnpm 退出码。
- **碎片化**：十几个恢复类插件各自维护自己的快照目录、CLI、patch 标记，互不认识；多个一起
  装会互相覆盖 patch（尤其家目录层优先级高于 profile 层，容易被忽略）。
- **恢复工具自身也会被升级/坏插件干掉**：内核补丁类方案（fail-soft）每次官方升级都要适配；
  装在 profile 里的恢复插件在 fail-loud 场景下根本轮不到执行。
- **没有统一协议**：意图文件、健康检查结果、隔离标记、快照 manifest、退出分类没有共享格式，
  也没有统一的“安全模式/修复模式”进入条件。
- **质量参差**：多数方案只验证过一两个 DSH 版本、或偏 Windows、或只有 CLI 没有 UI、或反过来。
