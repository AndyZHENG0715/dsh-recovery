# 设计：DSH 自动恢复系统（工作名 dsh-recovery，暂称「救援医生」）

> 基于《[dsh-recovery-research.md](./dsh-recovery-research.md)》的调研结论设计。
> 一句话定位：**让 DSH 在“被改坏”之后自己进入安全模式 / 修复模式，按阶梯自动恢复到
> 最近一次可用的状态，只有真正修不了才找人。** 全部动作遵守一个铁律：可逆优先、确定性优先、
> 自保优先。

---

## 1. 目标与设计原则

### 1.1 目标（按优先级）

1. **能开机**：任何单个插件/配置损坏都不能让 `dsh web` 永久起不来（今天官方是 fail-loud）。
2. **能自动进安全模式**：崩溃循环、启动失败达到阈值时，自动切到“只含核心 + 救援组件”的
   最小组合启动，不要求人改文件。
3. **能自动修**：确定性故障（坏 patch、重复 entry id、断依赖、层栈与依赖不一致、会话日志
   已知损坏家族）自动修复并**验证后**放行；不确定的生成候选，等一次确认。
4. **升级可回退**：DSH 本体升级前后自动快照；升级后验证失败自动回退本体或隔离不适配插件。
5. **修不了也要留下出口**：完整诊断报告 + 精确的下一步命令 + 可导出的取证包。

### 1.2 设计原则

- **救援通道必须独立于插件树**。恢复系统的“大脑”（supervisor + rescue capsule）运行在
  profile 之外：独立进程、独立 DSH_HOME 或独立 profile。插件只能做“快腿”，不能做“主脑”。
- **只做确定性修复**。规则引擎能证明幂等、可逆、有验证门的操作才自动执行；其余一律
  `candidate + 显式确认`（三个独立社区项目得出同一结论）。
- **隔离优先于卸载**。自动修复的唯一持久化副作用是向 patch 层写
  `- id: X` + `disabled: true`（带本系统标记注释），不删包、不删数据。
- **一切变更可回滚**：写任何 profile 文件前先落 pre-change 快照；回滚前再落 pre-rollback 快照。
- **自保**：恢复组件永不隔离自己；官方核心行（loader/webserver/connection/client-runtime/
  settings 等）默认禁写；恢复组件自身失败只记录日志，绝不抛进启动流程。
- **走官方契约**：只通过 `dsh plugin` CLI 与文档化的 patch 层/`dsh.profile.bundles` 格式修改
  profile；不 patch DSH 安装目录里的内核代码（fail-soft 路线明确不采纳，理由见 §9）。
- **明说版本**：所有检查点/快照/事故记录都带 DSH 版本与插件版本指纹；对不认识的 DSH 版本
  自动降级为只读保守模式（astra3294 dsh-doctor 的做法）。

### 1.3 故障模型（我们到底要救什么）

| 类 | 现象 | 发生时机 |
|---|---|---|
| F1 组合层结构损坏 | profile 5+1 文件坏 JSON/YAML、重复 entry id、`name:` 解析失败、bundle 缺声明；**`settings.yaml` 坏、`storages/*.json` 坏、用户预设 `agent.cordis.yml`/`preset.yml` 坏或引用不存在、skills 索引坏** | 插件加载前 / 会话挂载前 |
| F2 插件不兼容/崩溃 | 某个 bundle 加载或 `apply()` 抛错 | 启动期 |
| F3 运行期故障 | fiber 失败、工具超时风暴、资源泄漏 | 运行期 |
| F4 升级破坏 | DSH 本体升级后，profile/插件/皮肤/**预设/技能**与新 API 不兼容 | 升级后首次启动 |
| F5 会话/数据损坏 | `seq gap`、torn zstd 尾帧、空 tool-call id、inbox splice 错乱、`storages` 数据层错乱 | 崩溃后 / 读盘时 |
| F6 环境故障 | 端口占用、Node/pnpm 缺失、磁盘不可写、密钥失效、凭据文件损坏 | 任意时刻 |

设计目标：F1/F2/F4/F5 全自动或一键；F3 半自动（自动降级 + 报告）；F6 只诊断给命令
（凭据文件坏 → 提示从 vault/备份恢复，不自动改写）。

---

## 2. 总体架构

```
                    ┌────────────────────────────────────────────────┐
   用户/桌面图标 ──► │ dsh-recovery launch <dsh 原参数>                 │  ← 唯一启动入口(可选)
                    │  (透明转发 argv/stdio/signals, 记录退出事实)      │
                    └──────────────┬─────────────────────────────────┘
                                   ▼
              ┌──────────────────────────────────────┐
              │  Boot Gate(进程外,纯 Node,零依赖)       │  快照→预检→boot probe→健康门
              │  1) 读 recovery-state.json             │  →失败则按阶梯: 隔离/回滚/安全模式/修复模式
              │  2) --dump-config 静态验证              │
              │  3) 临时端口起真实 dsh web,验HTTP+渲染   │
              └──────┬───────────────────┬─────────────┘
                     │ 通过              │ 不通过/熔断
                     ▼                   ▼
          ┌───────────────────┐   ┌───────────────────────────────┐
          │ 正常 profile       │   │ 安全模式 profile               │
          │ (用户插件全量)      │   │ profiles/safemode:             │
          │  + host 内 watchdog │   │  白名单核心 bundles + 救援行   │
          │  (写boot标记/心跳/   │   │  (只读诊断+逐步恢复用户插件)    │
          │   fiber失败→HMR隔离) │   └──────────────┬────────────────┘
          └──────────┬────────┘                     │ 安全模式也起不来
                     ▼                              ▼
          ┌────────────────────────────────────────────────────┐
          │ 修复模式 Rescue Capsule(最后防线)                     │
          │  pinned DSH 运行时 + 独立 DSH_HOME + 只挂救援插件     │
          │  loopback 3081 救援页/API: 事务化修复,回滚,DSH本体回退 │
          └────────────────────────────────────────────────────┘

  共享状态层(profile 外,所有入口读同一份):
  ~/.dsh/recovery/
    state.json            当前模式/启动计数/崩溃熔断/最后良好快照指针
    plugins.intent.json   期望插件集合(借鉴 Shizuku 对账器)
    snapshots/composition/ 组合层快照: profile 5+1 + 脱敏settings + storages + 预设/技能索引指纹
    snapshots/usercode/    用户资产快照: .agent-presets/** 与 skills/** 树(不含 node_modules)
    snapshots/data/        数据层快照(可选/周期/升级前): 会话索引与日志副本
    vault/                 凭据原值(仅本机 0600,快照正文只存脱敏值+哈希)
    dsh-snapshots/         DSH 本体安装目录快照(全局 npm 时)
    incidents/             事故报告(退出分类+日志签名+修复计划,一律脱敏)
    quarantine/            插件/预设隔离存根(便于一键恢复)
    journal.log            追加式 journal
```

三个入口共用同一决策引擎与状态层：
1. **CLI**：`dsh-recovery scan|snapshot|launch|safemode|repair|rollback|doctor|status`
   （起不来时的最终人工通道）；
2. **独立救援守护**：`dsh-recovery daemon` 常驻 loopback:3081（借鉴
   dsh-plugin-manager-pro / dsh-backup rescue console）；
3. **host 内插件**（薄）：只做 boot 标记写入/清除、心跳上报、运行期 fiber 失败→写隔离、
   设置页状态卡片、失败页注入最小救援脚本（借鉴 dsh-boot-guard）。它**永不参与**自己的
   抢救决策——决策全在进程外。

---

## 3. 核心机制

### 3.1 快照与检查点（一切的地基，三层快照）

> 红队修订：原「profile 5+1 文件」只覆盖了组合层。用户会改、启动/会话会读、坏了会让会话
> 或预设出问题的还有三类资产——用户自建 agent-presets、settings/storages、skills 与
> 会话数据。因此快照改为三层：

- **Tier A 组合层（每次变更前后都拍，回滚的主对象）**：
  1. profile 5+1：`package.json` / `pnpm-lock.yaml` / `pnpm-workspace.yaml` /
     `cordis.yml` / `cordis.patch.yml` + 家目录 `$DSH_HOME/cordis.patch.yml`；
  2. **`$DSH_HOME/settings.yaml`（脱敏）**——沙箱策略、默认预设、模型路由都在里面，
     坏了直接开不了机或会话挂错预设；
  3. **`$DSH_HOME/storages/*.json`**（workspace.json / session_projcache.json）——
     工作区与会话注册表，坏了侧栏/会话列表解析失败；
  4. **`$DSH_HOME/.agent-presets/**/agent.cordis.yml` + `preset.yml` 内容**——
     用户自建预设是「用户可改、会话挂载时读取」的活代码；
  5. `--patch` overlay 路径 + 哈希（文件在工作区，只记指纹，回滚时校验漂移并告警）。
- **Tier B 用户资产层（装/卸插件前、升级前、首次成功启动后）**：
  `$DSH_HOME/.agent-presets/**`（含 `tool-*.mjs` 与随预设 skills，**排除 node_modules**）、
  `$DSH_HOME/skills/**`、`~/.agents/skills/**`。项目级 `<workspace>/.dsh/**` 默认只体检
  不备份（超出 DSH_HOME，需授权才纳入）。
- **Tier C 数据层（周期 / pre-upgrade / pre-repair，可选开关）**：
  会话索引 + 逐会话 `session.jsonl.zstd` 增量副本（加密或仅本机）；**绝不与 Tier A 混放**——
  profile 回滚永远不得碰会话数据。
- **manifest**：DSH 精确版本、每个 bundle 包名+版本+patch 指纹、快照原因、健康状态、
  参与 Tier A 的每个 home 级文件哈希。
- **凭据纪律**：`.credentials.yaml` 与 settings 里任何形如 key/token/secret/password 的
  值**永不进快照正文**；快照只存脱敏占位 + 哈希，原值进本机 `vault/`（0600）。事故报告、
  导出包一律先过脱敏器。快照导出必须显式且可选 AES 加密（undo-savepoint 的做法）。
- **自动快照时机**（借鉴 dsh-plugin-guard / fuhuobi / dsh-backup 的合集）：
  1. `dsh plugin add/remove/update` 前（Tier A+B，in-process hook + CLI 包装双保险）；
  2. 检测到 DSH 本体版本变化时（pre-upgrade，Tier A+B+C）；
  3. 启动成功且度过宽限期（如 60s）后（Tier A，last-good 指针更新，保留 N=5~10 份）；
  4. 任何修复动作前（pre-repair，Tier A+B）。
- **回滚语义**：恢复 Tier A 文件 → `pnpm install --frozen-lockfile` → `--dump-config`
  门禁 → boot probe；Tier B 独立回滚（预设/技能回退不触发依赖重装）；回滚前先落
  pre-rollback 快照；**settings.yaml 回滚用 vault 的真实凭据回填，绝不把脱敏占位写回**——
  还原目标是「配置结构回到快照点，秘密保持本机现状」。

### 3.2 Boot Gate：启动预检与 boot probe

静态预检（只读，全自动）：
- 组合层：JSON/YAML 语法、patch 顶层必须是数组、`dsh.profile.bundles` 每个条目可解析且
  声明 `dsh.bundle`、依赖存在、无重复 entry id（含 group insert）、`name:` 可解析；
- **home 级状态**：`settings.yaml` 可解析且关键键存在（`agent-presets.default`、
  `permission.defaultPreset` 指向的预设存在）；`storages/*.json` 可解析；
  `.credentials.yaml` 结构可解析（内容不读不打印）；
- **用户预设**：每个 `agent.cordis.yml` 可解析、`preset.yml` 可解析、被引用的
  `tool-*.mjs` 等模块存在且 `node --check` 通过；坏预设不阻断诊断，只标
  `preset-broken`（会话挂载时由 L1 看门狗用 `ctx.agentPresets.standingKeyFor(id)` 复核）；
- **技能层**：skills 目录索引与文件名可解析，坏条目标 `skill-broken` 待隔离；
- `--dump-config` 与实际挂载前状态交叉验证（官方纯静态入口，零风险）；
- 会话目录轻量扫描（只查已知损坏签名，不重写）；
- 所有报告与日志先过脱敏器（settings/凭据字段）。

隔离冒烟（借鉴 dsh-startup-guard，但默认只报告）：
- 每个第三方 bundle 的 host 入口在子进程 + mock Cordis 环境跑一次 `apply()`；
- client 产物在 vm 中执行加载校验；
- 冒烟失败**不自动隔离**（mock 环境有误报），除非崩溃标记在场 → 此时强制全量冒烟 +
  隔离失败者。

boot probe（真实验证，只在有变更时跑）：
- 复制 profile 配置到临时目录 → 临时 `DSH_HOME` → 随机端口启动完整 `dsh web` →
  等 HTTP 200 → 客户端渲染探针（页面里埋的探针回包）→ 关闭并清理；
- 结果写 health-state，失败则进入决策阶梯。这与 dsh-plugin-console 的“隔离试运行”、
  lxzy-7 boot-guard 的“健康检查”同构，但统一在进程外执行。

### 3.3 崩溃检测 / 退出分类 / 熔断

- **boot 标记**：launcher 启动时写 `~/.dsh/recovery/boot-state.json`，正常关闭清除；
  异常退出遗留 → 下次启动视为“上次崩溃”。纯 `dsh web` 用户（不经 launcher）由 host 插件
  补写同一标记（dsh-startup-guard 已验证可行）。
- **退出分类**（借鉴 @linxin666/dsh-doctor 的分类表）：用户 Ctrl+C/正常退出 → 不算故障；
  启动阶段（配置/插件加载）非零退出 → boot failure；起来后信号/非零退出 → runtime crash；
  headless 业务非零退出 → 仅报告。
- **熔断**：时间窗内 N 次（默认 3）真实故障 → 暂停自动重试 → 自动进安全模式，避免
  crash-loop 无限重启。
- **归因**：从 stderr/启动日志按签名分类（`duplicate loader entry id`、`cannot resolve
  profile bundle`、`patch failed`、`ERR_MODULE_NOT_FOUND`、会话 `seq gap`…），映射到
  F1-F6 与对应修复动作；日志里定位到具体 bundle 名时优先只隔离它。

### 3.4 修复决策阶梯（从轻到重，每级都验证）

```
L0 不介入          启动/运行健康
L1 运行期单行隔离    fiber失败 → 写 disabled 行(HMR ~1s生效)   ← 只在进程内做
L2 重启前隔离       启动失败且归因到具体 bundle → 写 disabled → 重启验证
L3 安全模式启动     归因不明/多插件互相作用 → dsh --profile safemode 启动,
                    用二分/逐批恢复把用户插件加回来(每次经 boot probe)
L4 profile 回滚     隔离无效 → 回滚 last-good 快照 + frozen install → boot probe
L5 修复模式(胶囊)    安全模式也起不来,或需要离线大修 → pinned 运行时+独立 home 的救援胶囊,
                    事务化修复(见下),修完 promote 回正常 profile
L6 DSH 本体回退     检测到刚升级且 L4 无效 → 回滚 DSH 安装快照(或 npm install -g 旧版) → 再验证
L7 人工兜底         以上全部失败 → 结构化报告 + 精确命令 + 取证包,绝不再自动折腾
```

关键规则：
- 每一级动作都带**验证门**（`--dump-config` 或 boot probe），验证失败自动撤销该级动作；
- 每启动一次最多自动执行一次回滚/隔离（防自激死循环）；
- 自动执行的上限止于“L1-L4 的确定性步骤 + 熔断内的重试”；L5/L6 的破坏性动作默认
  `--yes` 才做，无人值守时只准备候选；
- **预设与技能同样「隔离不删除」**：`preset-broken` 预设整体移入
  `quarantine/presets/`（Tier B 快照可回退），`agent-presets.default` 自动回退官方
  `standard`，一个坏预设不拖垮整个会话；`skill-broken` 条目从索引摘除并移目录，
  恢复走同一事务引擎。

### 3.5 安全模式（safe mode）与修复模式（repair mode）的正式定义

**安全模式 = 保证能启动的最小组合，目标是“先让我能管理现场”。**
- 独立 profile `safemode`（`dsh plugin --profile safemode add dsh-recovery` 自动初始化），
  bundles 白名单 = `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app` + 救援插件自身；
  patch 层为空模板；启动时由守卫强制写回白名单（借鉴 jinsiyu），运行期 fs.watch+轮询防漂移。
- **不挂载任何用户 agent-presets / skills**：安全模式只允许官方 system 预设
  （minimal/standard/code/cordis，借鉴 dsh-safe-tui），从根上排除坏预设/坏技能；救援页列出
  被隔离的用户预设，可单个恢复（恢复前跑 `standingKeyFor` 校验 + boot probe）。
- 保留：会话历史只读、模型配置只读镜像、设置只读。
- 功能：一键诊断（全量扫描）、隔离列表管理（恢复/追加）、逐批恢复用户插件（二分定位）、
  回滚到任意快照、导出报告。所有写操作走同一事务引擎。
- 进入条件：熔断触发 / Boot Gate 归因不明失败 / 用户显式 `dsh-recovery safemode`。

**修复模式 = 当安全模式也被破坏时的最后防线，目标是“在隔离沙箱里修主环境”。**
- Rescue Capsule：在 `~/.dsh-recovery-capsule/`（或机器本地固定目录）安装**钉死的** DSH
  版本 + 救援包，使用**隔离的 DSH_HOME**，与用户 profile 完全无关；只挂救援插件，
  loopback 端口 3081。
- 修的是“主 home 里的 profile 文件”，但运行环境与被修对象隔离——坏 overlay/坏 patch/坏
  session 都挡不住它（@linxin666/dsh-doctor 的胶囊思路，我们去掉其全家桶依赖）。
- 事务化修复协议：
  1. 读指纹 → 计划（有效期 5 分钟，含目标文件哈希）；
  2. pre-repair 快照；
  3. 应用候选到隔离副本（staged），在副本上跑 `--dump-config` + boot probe 健康门；
  4. 通过才 promote（原子替换，原件进 quarantine），不通过自动回滚；
  5. 写追加式 journal，可跨崩溃恢复。
- 胶囊自身也要能被重建：`dsh-recovery provision` 一键重装，版本钉死在用户快照里记录的
  版本（DSH 升级后胶囊跟着用户确认再升，避免胶囊自己被新 DSH 搞坏）。

### 3.6 升级兼容层（专门对付 developer preview 的破坏性变更）

- **版本指纹**：每次启动记录 `@deepseek-ai/dsh` 精确版本；每个快照/事故带该指纹。
- **pre-upgrade 快照**：检测版本变化即自动拍 Tier A+B+C（profile 组合层、用户预设/技能、
  会话索引）+ DSH 安装目录快照（全局 npm 时）。
- **升级后验证**：新版本首次启动强制走完整 Boot Gate；失败时：
  1. 若 DSH 本体可回退 → 自动回退本体（含 `npm install -g @deepseek-ai/dsh@<旧版>`，
     借鉴 SuCriss 的 recoverOnFailedRestart）；
  2. 若不可回退（npx 缓存、桌面壳）→ 用启动日志归因，隔离不适配插件，保留“哪些插件
     因新版本被禁用”清单，并在设置页给升级适配建议；
- **兼容性断言**：可选接入 `plugin_audit` 类静态规则（manifest 声明的 DSH 版本范围、
  生命周期脚本、patch 形状）；本地“版本 × 插件 × 冒烟结果”历史优先于通用规则。
- **对官方升级的自我修复**：救援组件只依赖官方文档化契约（profile 格式、patch 语义、
  `--dump-config`），并像 dsh-doctor 那样对未知 DSH 版本降级为只读保守模式。

### 3.7 意图对账（装上了 ≠ 挂载了）

采纳 Shizuku-keop/dsh-plugin-console 的五关模型，作为常驻检查项：
`plugins.intent.json`（期望集合）在 profile 外；boot 后实测 loader 树 vs intent；
发现层栈漏写（pnpm 失败跳过 reconcile 的经典坑）→ 幂等补写 `dsh.profile.bundles`；
node_modules 半安装/link 残留 → 给精确 `pnpm` 命令；inject 缺失（fiber 挂起）→ 报告缺
哪个服务。意图文件由本系统自动从“已确认成功的启动快照”生成，用户也可手编。

### 3.8 会话数据修复（可选挂载，按证据触发）

只集成**已知有官方讨论编号的确定性修复家族**：end-seed 对(#1497/#1586)、torn 尾帧截断、
空 tool-call id 链(#4365)、seq 连续性。统一约束：写前 `.bak`、修复后重新解码自检、
live 会话（10 秒内被写）跳过、无法判定的只隔离不重写。工具实现优先复用
MedicineKing/Zn-Dk/xiaoshenming 的既有算法，不重造。

---

## 4. 状态与数据布局（单一份，所有入口共享）

```
~/.dsh/recovery/
├── state.json                 # mode(normal|safe|repair), crash count, 熔断状态, last-good 指针
├── boot-state.json            # 启动标记(写于启动,清于正常退出)
├── plugins.intent.json        # 期望插件集合(profile 外!)
├── snapshots/
│   ├── composition/<ts>-<reason>/   # Tier A: profile 5+1 + 脱敏settings + storages + 预设/技能索引指纹
│   ├── usercode/<ts>-<reason>/      # Tier B: .agent-presets/** 与 skills/** 树(不含 node_modules)
│   └── data/<ts>-<reason>/          # Tier C: 会话索引/日志增量副本(可选)
├── vault/                     # 凭据原值(0600, 仅本机; 快照正文只存脱敏值+哈希)
├── dsh-snapshots/<version>/   # DSH 本体目录快照(可选,全局 npm 安装时)
├── quarantine/
│   ├── plugins/               # 隔离存根: {patch行原文, 恢复命令}
│   └── presets/               # 坏预设整目录移入(Tier B 快照可回退)
├── incidents/<ts>/            # 退出分类+日志签名+归因+修复计划(一律脱敏)
├── journal.log                # 追加式审计(所有写操作的 before/after 指纹)
└── config.json                # 阈值/白名单/保留份数/自动修复开关
```

原则：这份状态目录**只被救援系统写**，其他插件（含用户）写它会触发安全网告警；
profile 目录内不存任何修复状态（借鉴 Shizuku 的“修复清单不住在易碎区”）。

---

## 5. UI / 交互

| 场景 | 通道 |
|---|---|
| 一切正常 | 设置页卡片：状态/快照列表/一键检查/手动快照/自动修复开关；侧边栏版本徽章 |
| 页面能开但插件报错 | 失败页注入的最小救援条（借鉴 dsh-boot-guard）：跳过疑似插件→刷新；或右下角 🛟 |
| 引擎起不来 | 独立守护 `http://127.0.0.1:3081/`：自检→修复→启动→跳转；桌面“DSH救援”快捷方式 |
| 连守护都没有 | CLI：`dsh-recovery launch|safemode|repair|rollback|doctor --json`，输出人可执行的命令 |

模型侧：注册只读诊断工具（如 `recovery_doctor` / `recovery_incident`），让 agent 能在
会话里定位问题；**所有写动作默认仍走人类确认的 UI/CLI**，无人值守模式才允许自动执行。

---

## 6. 分阶段实施计划

**P0 — 手动可用的救援 CLI（先让“救得回来”，1-2 天）**
纯 Node 零依赖单包：`scan`（五关+F1/F5 诊断）、`snapshot`、`rollback`、`safemode enter|exit`
（生成/还原白名单 profile）、`boot-probe`（临时 home 真实验证）、`doctor --json`。
验收：在隔离 DSH_HOME 中人为制造 12 种故障（坏 patch、缺 bundle、重复 id、坏 session、
升级后不兼容、端口占用、pnpm 漏 reconcile、黑屏渲染错、**坏 agent.cordis.yml、坏 tool mjs、
坏 settings.yaml、坏 workspace.json**），每种都能在 2 条命令内恢复；坏预设场景还必须
验证 `agent-presets.default` 自动回退 standard 后会话可正常打开。

**P1 — 自动进入安全模式 + Boot Gate（核心价值，2-4 天）**
launcher 包装（`dsh-recovery launch` 透明转发）+ boot 标记 + 熔断 + 启动失败自动
「隔离→回滚→安全模式」阶梯 + 安全 profile 守卫。
验收：装上会崩的假插件，双击桌面图标 30 秒内自动进入安全模式并给出“该插件已隔离”报告；
恢复该插件可一键 undo。

**P2 — 进程内 watchdog + 设置页 UI + 意图对账（3-5 天）**
host 薄插件（fiber 失败→HMR 隔离、心跳、渲染探针上报、**预设 standingKeyFor 复核**）+
设置页状态卡 + intent 对账 + pre-install 快照 hook（Tier A+B）。验收：运行期插件崩溃自动
禁用且不重启进程；`dsh plugin add` 失败后重启，对账器自动补层栈；改坏一个自建预设后，
该预设被隔离且默认预设回退 standard，其余会话不受影响。

**P3 — 修复模式胶囊 + DSH 本体回退 + 会话修复集成（5-8 天）**
rescue capsule（pinned 运行时 + 独立 home + 3081 守护）、事务化修复协议、升级回退、
可选会话修复挂载。验收：把 profile 与家目录 patch 同时弄坏 + 安全 profile 也弄坏，
修复模式仍能打开、修好并 promote；模拟 DSH 升级破坏后一键回到旧版本。

每阶段结束都跑同一个“故障剧本”回归（剧本作为 CI fixture 保留），因为 developer preview
下这套东西自己也需要随版本持续验收。

---

## 7. 与现有社区方案的关系（能复用的直接复用）

| 能力 | 复用/借鉴 | 我们的取舍 |
|---|---|---|
| 快照语义、pre-install hook、boot 健康检查 | lxzy-7/dsh-plugin-guard、dsh-fuhuobi | 统一为三层快照目录 + DSH 版本指纹 + vault 脱敏 |
| 安全 profile 强制还原 | jinsiyu/dsh-safemode-profile | 作为 P1 的一部分，而不是独立产品 |
| 失败页注入救援条 | SaiSenBox/dsh-boot-guard | 薄客户端模块，仅安全模式/失败态挂载 |
| 救援胶囊/事务化修复/退出分类 | @linxin666/dsh-doctor | 只取协议思路，去掉全家桶与遥测，胶囊钉版本 |
| 意图对账/五关诊断 | Shizuku-keop/dsh-plugin-console | 直接采用 intent 文件格式思想 |
| 冒烟/崩溃标记 | aokamoaki/dsh-startup-guard | 作为 Boot Gate 的静态层 |
| 会话修复算法 | MedicineKing / Zn-Dk / xiaoshenming | 按证据挂载，写前备份约束统一 |
| 独立 3081 守护/救砖页 | nonentity303/dsh-plugin-manager-pro | 复刻入口形态 |
| DSH 本体快照回退 | SuCriss/dsh-version-update | 并入升级兼容层 |
| 静态兼容审计 | CMSKL/dsh-plugin-observatory | 作为预检可选信号 |

不采纳：[lanbaolu/dsh-fail-soft](https://github.com/lanbaolu/dsh-fail-soft) 的内核补丁
路线——能解决“挂载期隔离”但每次官方升级都要重适配补丁，与我们“只用文档化契约”的原则冲突；
其进程外包装器思路（解析崩溃→写隔离→退避重拉）则吸收进 Boot Gate。

---

## 8. 风险与边界（诚实清单）

1. **误判代价**：把端口占用/密钥失效误判成坏插件会“治好一个又弄坏一个”。对策：官方核心行
   禁写、环境类故障（F6）只报告、隔离前必须能归因到具体 bundle 或经 boot probe 证实。
2. **自动修复自身引入回归**：对策=一切经验证门；验证失败自动撤销；每次启动最多一次自动回退。
3. **救援组件被 DSH 升级破坏**：对策=胶囊钉版本 + 对未知 DSH 版本只读降级 + provision 重建。
4. **多恢复插件互踩**：我们只写带唯一标记的 patch 行、只用自己的状态目录；如果用户同时装了
   undo-savepoint / doctor 等，设置页明示“检测到其他恢复工具”并建议只保留一个。
5. **快照分层边界**：Tier A/B 是恢复系统的自留地；Tier C 只做可选增量副本，不是全量备份，
   工作区与完整会话备份交给已有方案（dsh-backup）或提醒用户另做。profile 回滚永远不碰
   会话数据。
6. **秘密泄露风险**：快照正文、事故报告、导出包一律脱敏 + vault 分离；导出加密默认关，
   打开时强提示。任何日志输出前过脱敏器（含启动日志转存）。
7. **预设回退的次生风险**：坏预设被隔离后会话自动改挂 standard，工具面与提示词会变，
   可能让正在进行的会话行为变化——因此默认只隔离“启动即坏”的预设，并在设置页明确提示
   回退原因，用户可一键恢复。
8. **无人值守红线**：不自动安装新版本、不自动执行 untrusted shell、不自动删除用户数据、
   不自动放宽沙箱；L5/L6 破坏性动作默认要确认。

---

## 9. 结论

调研证明“安全模式/修复模式/崩溃恢复”在 DSH 社区不是空白：每个子问题都有人做出了可用的
零件，其中 lxzy-7/dsh-plugin-guard、lire1131/dsh-undo-savepoint、@linxin666/dsh-doctor、
aokamoaki/dsh-startup-guard 已经分别验证了「守护启动自动回滚」「安全模式」「救援胶囊」「冒烟
隔离」四条关键路径。缺的是一个把它们统一起来的**决策引擎 + 单一状态层 + 分级阶梯**——
这正是本设计的核心增量：以进程外 Boot Gate 为主脑、安全模式 profile 与修复胶囊为两级后撤、
确定性修复与验证门为动作纪律，把“DSH 升级把自己搞坏”变成一条可自动走完的恢复路径。
建议从 P0 的 `dsh-recovery` CLI 起步，逐级验证 P1-P3，每个阶段都用同一套故障剧本回归。

---

## 10. 附：定稿红队修订记录（本轮）

红队问题：「快照/回滚只覆盖 profile 5+1 文件，是否还有一类文件——用户会改、启动流程会读、
坏了会让会话或预设出问题——被漏掉了？」

**确认有缺口，已补**。5+1 覆盖的是 profile 组合层；遗漏的是 **home 级状态与用户资产层**：
1. `$DSH_HOME/settings.yaml`（默认预设/沙箱策略/模型路由，坏了影响开机与会话挂载）与
   `storages/*.json`（工作区/会话注册表）→ 并入 Tier A，脱敏快照；
2. `$DSH_HOME/.agent-presets/**`（agent.cordis.yml / preset.yml / tool-*.mjs / 随预设
   skills）——用户会改、会话挂载时读取，坏了会话起不来 → 新增 Tier B 用户资产快照 +
   `preset-broken` 检测与隔离（隔离不删除，默认预设回退 standard）；
3. `$DSH_HOME/skills`、`~/.agents/skills`、项目 `.dsh` —— 会话装配时读取 → 纳入
   Tier B / 体检范围；
4. 会话数据（session.jsonl.zstd 等）→ 新增 Tier C 可选数据层快照，与 profile 回滚严格隔离；
5. 凭据（`.credentials.yaml`、settings 内密钥字段）→ vault 分离 + 全链路脱敏，
   settings 回滚用真实凭据回填，不写回脱敏占位；
6. 相应更新：故障模型 F1/F4/F6、Boot Gate 静态预检、修复阶梯关键规则、安全模式
   「不挂用户预设」、状态布局、P0/P2 验收剧本（8 → 12 种故障）、风险清单。

修订后的三层快照（Tier A 组合层 / Tier B 用户资产层 / Tier C 数据层）即本定稿的
快照与回滚边界。
