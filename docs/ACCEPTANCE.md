# dsh-recovery P0 验收清单

> 用途：在真实环境复核 P0。**破坏性场景请先在副本上演练**（本文件给出 copy 命令），
> 真机只做「快照 → 观察 → 回滚」式的轻量验证。所有命令可用 `--home <dir>` 或
> `DSH_HOME=<dir>` 指定目标；本文统一用 `REC` 指代 `node <repo>/bin/dsh-recovery.mjs`。

## 0. 前置与冒烟

- [ ] 环境：Node ≥20.16（zstd 会话解码要求 ≥22.15）；本机 dsh 安装可被定位
      （`--dsh <dir>` 或 `DSH_RECOVERY_DSH_DIR`，否则自动扫 `~/.npm/_npx/*`）。
- [ ] `REC help` 与 `REC version` 退出码 0，命令表完整。
- [ ] 先做一次全量体检：`REC doctor --json`，记录 baseline；真实 home 上应只有少量
      warning/info（如 `node-modules-missing`、`session-live`）。
- [ ] 建一份手动备份（快照不等于备份）：
      `REC snapshot --data --reason acceptance-baseline` 并确认 `REC list` 可见。

## 1. 12 个故障剧本（先在副本上演练，再按需真机复核）

副本演练模板：

```sh
TMP=$(mktemp -d) && cp -a ~/.dsh "$TMP/home"
DSH_HOME="$TMP/home" REC <命令…>      # 所有破坏性操作只作用于副本
```

| # | 故障 | 制造方式（副本内） | 期望检测 | P0 恢复路径 |
|---|---|---|---|---|
| 1 | 坏 patch | `printf -- '- id: [unclosed\n' > profiles/web/cordis.patch.yml` | `scan` → `patch-parse-failed`，退出码 1 | `snapshot` 后改坏 → `rollback --latest`，字节级还原 + 验证门通过 |
| 2 | 缺 bundle | 向 `package.json` 的 `dsh.profile.bundles` 追加不存在的包名 | `scan` → `bundle-unresolvable` | `rollback --latest`（或 `dsh plugin --profile web install`） |
| 3 | 重复 entry id | 在 patch 里再 `- insert:` 一个 `timer` 行 | `scan` → `duplicate-entry-id` | 手工删重复行或 `rollback --latest` |
| 4 | 坏 session | 向某个 `session.jsonl.zstd` 写入垃圾字节（先备份原件） | `scan` → `session-corrupt`（detail: zstd-decode / seq-gap） | 快照加 `--data` 后用 `rollback --types data`；或手工隔离该文件 |
| 5 | 升级后不兼容 | 模拟：先 `snapshot --reason pre-upgrade`，改坏 patch 模拟“升级后组合不合法” | `boot-probe --live` FAIL + 错误签名；manifest 含 DSH 版本指纹 | `rollback --good`（DSH 本体回退属 P3，P0 只给建议） |
| 6 | 端口占用 | 先占住一个端口再 `boot-probe --live`（probe 自选空闲端口，故先固定 `--port`？P0 probe 自选空闲端口，验证方式：另开进程占用后观察 dsh 自身报错分类） | probe 失败并给出可读尾部输出 | 释放端口重试（环境类故障只报告） |
| 7 | pnpm 漏 reconcile | 装一个声明 `dsh.bundle` 的包为 dependency 但不进 bundles（测试脚本可用 `test/` fixture 的 fake-bundle 思路） | `scan` → warning `bundle-not-in-layer` | `dsh plugin --profile web add <pkg>` 重新对账 |
| 8 | 黑屏渲染错 | 已知 P0 边界：live 门只验 HTTP 200 | `boot-probe --live` PASS ≠ 渲染健康 | 渲染探针在 P2 补；真机人工确认页面 |
| 9 | 坏 `agent.cordis.yml` | 把自建预设的组合文件改成非法 YAML | `scan` → `preset-broken`，退出码 1 | `rollback --types usercode`（**自动回退 default=standard 属 P2**，P0 需手动切默认预设） |
| 10 | 坏 tool mjs | 给预设里的 `.mjs` 写个语法错误 | `scan` → `preset-broken`（node --check 详情） | 同上 |
| 11 | 坏 `settings.yaml` | 改成非法 YAML | `scan` → `settings-parse-failed` | 用 `--include-settings` 的快照 `rollback --types composition`；确认脱敏快照**不会**覆盖密钥 |
| 12 | 坏 `workspace.json` | 写成非法 JSON | `scan` → `storages-corrupt` | `rollback --latest` |

验收判据：每个剧本的「期望检测」出现、恢复路径走通后 `REC scan --json` 的
`summary.errors === 0`，且 `boot-probe`（静态门）PASS。

## 2. 核心机制验收

- [ ] **脱敏**：`snapshot`（不带 `--include-settings`）后，在 `recovery/snapshots/`
      整树 `grep -r` 你的真实密钥字符串 → 必须 0 命中；`settings.redacted.json` 的
      secret 键值为 `***`；`.credentials.yaml` 内容未出现在任何快照文件里。
- [ ] **回滚可逆**：任一次 `rollback` 之后，`REC list` 里存在 `pre-rollback` 快照，
      且 `state.json` 的 `lastSnapshot` 仍指向真实快照（内部快照不顶替指针）。
- [ ] **验证门**：`rollback` 输出 `verify: … passed`（结构 scan + `dsh --dump-config`
      双门）；若故意留下错误，回滚必须报告 `verify failed`。
- [ ] **safemode**：`REC safemode enter` 后 `profiles/safemode/` 的 bundles 恰为
      `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app`、patch 为空数组模板；
      `state.json` 的 `safeMode.active === true`；`REC safemode exit --reset` 能把
      被改坏的 safemode patch 修回空模板并清掉 active 标记。
- [ ] **boot-probe 隔离**：`boot-probe --live` 运行前后，真实 home 的 mtime 集合不变
      （探针只写 `$TMPDIR` 下的临时 home；结束自动清理）。
- [ ] **无用户可见副作用**：live 探测期间不弹默认浏览器（spawn 参数含 `--no-open`，
      已由回归测试断言），不打印 URL/提示到终端，子进程环境已剥离
      `DSH_WEB_URL/DSH_WEB_MODE/DSH_SESSION_ID/DSH_SESSION_JSONL/DSH_SHELL`。
- [ ] **退出码**：`scan`/`doctor` 0=无错误、1=有错误、2=用法错误；`rollback` 失败为 1。

## 3. 真机轻量复核（不制造破坏）

- [ ] `REC scan --json` 对真实 home 0 错误（本机验证：0 errors，仅
      `node-modules-missing` warning + 进行中会话的 `session-live` info）。
- [ ] `REC snapshot --reason real-check` 成功且 composition ≥5 文件、usercode ≥1 文件。
- [ ] `REC boot-probe` 静态门 PASS（用真实 profile 配置、临时副本执行）。
- [ ] `REC doctor --json` 输出含 `state`、`snapshots`、`recommendations`，无密钥明文。
- [ ] 观察 `recovery/journal.log` 每步都有追加记录。

## 4. P0 明确不做（防止误判为缺陷）

- 渲染级白屏探针（P2）；坏预设自动回退 default=standard（P2 watchdog）；
- DSH 本体版本回退（P3）；会话文件的确定性重写修复（P3）；
- 自动隔离写 patch 行（P0 只有快照回滚与 safemode，隔离语义在 P1/P2）。

---

# P1 验收清单（launcher + boot 标记 + 熔断 + 恢复阶梯 + 安全 profile 守卫）

> P1 自测：34/34（新增 9 项）。真机复核仍遵守「破坏性剧本先上副本」。

## 新增命令

| 命令 | 作用 |
|---|---|
| `launch [--profile web] [-- dsh 参数…]` | 透明转发 dsh（argv/stdio/信号/退出码），写 boot 标记；启动失败自动走「隔离 → 回滚 → 安全模式」阶梯；熔断后自动进入安全模式 |
| `quarantine list` | 列出 dsh-recovery 写入的隔离行（带标记注释，不碰用户补丁） |
| `unquarantine --id X | --all` | 只移除我们自己标记的隔离行，一键恢复被隔离插件 |
| `guard [--once] [--poll-ms N]` | 安全 profile 守卫：启动时强制白名单还原 + fs.watch/轮询防漂移 |

launch 的自身参数全部可选；未知参数一律原样透传给 dsh（`--profile` 由 launcher 注入）。
配置：`recovery/config.json` 的 `boot.{failureWindowMs,failureThreshold,readyMs,
maxLadderRetries,autoLadder,autoSafeBoot,safemodePort}` 与 `guard.{pollMs,debounceMs}`。

## 验收剧本

1. **透明转发 + 干净退出**：`REC launch --profile web -- --port 3080` 等价于
   `dsh --profile web --port 3080`（stdio/信号/退出码透传）；Ctrl+C 后
   `recovery/boot-state.json` 被清除。
2. **崩溃证据**：launch 起来后 `kill -9` 子进程 → 标记残留；下一次 launch 记录
   `previousCrash` + incident；`scan --json` 出现 `boot-marker-present`。
3. **阶梯-隔离**（核心验收）：装一个启动即崩的第三方插件，`REC launch --profile web`
   → 首次失败被归因 → 自动向 `cordis.patch.yml` 写入带
   `# quarantined by dsh-recovery` 的 `disabled` 行 → 自动重启成功；`REC quarantine list`
   可见；`REC unquarantine --id <row>` 一键恢复。真机版本用副本演练（本仓库 E2E 已用真实
   dsh 走通：broken-plugin → 隔离 `broken-apply` → web 起 HTTP 200）。
4. **阶梯-回滚**：制造无法归因的启动失败 → 自动 `rollback --good` → 重启成功；
   pre-rollback 快照可查。
5. **熔断 → 安全模式**：窗口内（默认 10 分钟）失败 ≥3 次 → 下次 launch 直接
   `safemode enter` 并报告（`--auto-safe-boot` 默认还会自动拉起
   `dsh --profile safemode --port 3081`，`--no-auto-safe-boot` 只准备不动手）。
6. **守卫**：改坏 `profiles/safemode` 三个文件后 `REC launch --profile safemode`
   能先还原白名单再启动；`REC guard --poll-ms 200` 常驻时，运行期改坏也会在
   轮询周期内被还原（journal 记 `safemode-guard-repair`）。
7. **可观测**：`doctor --json` 增加 `bootFailures` 计数、`previousCrash`、
   `recentIncidents`；每次阶梯动作都有 journal + `recovery/incidents/*.json` 留痕。

## P1 明确边界

- 归因靠错误文本签名（`failed to apply loader entry <id> (<pkg>)` 取最内层匹配）；
  官方 `@deepseek-ai/*` 行**永不隔离**，核心失败走回滚/安全模式。
- 渲染级白屏探针仍属 P2；`readyMs` 窗口（默认 30s）用于区分 boot failure 与 runtime crash。
- 隔离只写 patch 行、不删包不删数据；`unquarantine` 只认自己的标记注释。
