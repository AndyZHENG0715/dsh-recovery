# dsh-recovery (P0)

DeepSeek Harness 自恢复 CLI：**纯 Node、零运行时依赖**。针对 DSH 目前 fail-loud 的启动模型
（坏一个插件/配置文件 = 整个 `dsh web` 起不来），提供「诊断 → 快照 → 回滚 → 安全模式 →
真实启动验证」的最小闭环。设计文档见上级目录 `dsh-recovery-design.md`。

## 命令

| 命令 | 作用 |
|---|---|
| `scan` | 五道加载关卡 + F1/F5 诊断（profile 组合层、settings/storages、用户预设、技能、会话 zstd/seq） |
| `snapshot` | 三层快照：Tier A 组合层（profile 5+1、脱敏 settings、storages、预设组合内容）+ Tier B 用户资产（.agent-presets/、skills）+ Tier C（`--data`，sessions） |
| `rollback` | 恢复到 `--latest` / `--good` / `--id <id>`；自动 pre-rollback 快照；`--install` 跑 `pnpm install --frozen-lockfile`；事后 scan + `dsh --dump-config` 双重验证门 |
| `safemode enter|exit` | 维护 `profiles/safemode` 白名单 profile（核心 bundles + 空 patch），enter 前自动快照 |
| `boot-probe` | 在**一次性临时 DSH_HOME 副本**里跑官方 `--dump-config` 静态门 + 可选 `--live` 真实启动 + HTTP 200 门（不写真实 home；live 阶段带 `--no-open`，并清掉调用方的 DSH_WEB_URL/DSH_SESSION_* 等会话环境变量，绝不弹浏览器、绝不触碰真实会话句柄） |
| `doctor` | scan + 状态 + 快照清单 + 按错误码给修复建议；`--json` 机器可读 |
| `list` | 快照清单 |

常用参数：`--home <dir>`（默认 `$DSH_HOME`/`~/.dsh`）、`--profile web`、
`--dsh <dir>`（默认 `$DSH_RECOVERY_DSH_DIR` → npx 缓存里版本最高的安装）、`--json`。
退出码：0 通过；1 有错误/探针失败；2 用法错误。

## 运行

```sh
node bin/dsh-recovery.mjs scan --json
node bin/dsh-recovery.mjs snapshot --reason before-upgrade
node bin/dsh-recovery.mjs boot-probe --live --mark-good
node bin/dsh-recovery.mjs rollback --good
DSH_HOME=~/.dsh node bin/dsh-recovery.mjs safemode enter
```

无 pnpm 时 `--install` 会给出明确告警；可用 `--pnpm <bin>` 或 `DSH_RECOVERY_PNPM` 指定。

## 安全约定

- 快照正文**永不**包含密钥：`settings.yaml` 默认只存脱敏结构（secret 键 → `***`）+
  原文 sha256；`.credentials.yaml` 只存指纹，内容从不复制。`--include-settings` 才存
  settings 原文（0600），回滚仅从 verbatim 快照还原 settings，脱敏快照永不覆盖现网密钥。
- 回滚前自动 pre-rollback 快照，回滚本身可逆；Tier B/C 回滚是 overlay（不删快照后新增的文件）。
- `boot-probe` 只读写 `$TMPDIR` 下的临时 home，真实 home 零写入；live 子进程显式传 `--no-open` 且剥离会话环境变量，不会弹默认浏览器，也不读取真实会话句柄。
- 快照清单（manifest）记录 DSH 版本与每个文件 sha256，便于升级归因。

## 已知 P0 边界（对应设计文档的后续阶段）

- 渲染级白屏探针（浏览器端）→ P2；P0 的 live 门只验证 HTTP 200。
- 坏预设的「自动回退 default=standard」→ P2 watchdog；P0 通过 Tier B 回滚恢复预设。
- DSH 本体版本回退 → P3；P0 只记录版本指纹并给出建议。
- 会话修复只做诊断（zstd 全量解码 + seq 连续性），确定性重写 → P3。
- 快照恢复的 pnpm 精确重装需要本机 pnpm（发现链：`--pnpm` → `DSH_RECOVERY_PNPM` → PATH）。
- YAML 子集解析器只用于诊断，永不回写 YAML（写操作全部走整文件快照恢复/模板，避免破坏
  `!!js` 表达式与注释）。

## 测试

```sh
npm test        # node --test；全部在 $TMPDIR 的隔离 DSH_HOME 副本上运行，不碰真实 ~/.dsh
```

25 项：YAML 子集解析器单测、11 种损坏检测、快照三层/脱敏、回滚字节级还原与验证门、
safemode 进出、boot-probe 静态门 + 真实 HTTP-200 门、doctor 聚合。真实验收步骤见
`docs/ACCEPTANCE.md`。

已在 `@deepseek-ai/dsh@0.1.1-rc.2`、Node 24 上验证；zstd 会话解码需要 Node ≥22.15
（DSH 自身的 Node 要求范围内）。

## P1：launcher 与自动恢复阶梯

```sh
# 替代直接 dsh 启动：透传 + boot 标记 + 启动失败自动「隔离 → 回滚 → 安全模式」
node bin/dsh-recovery.mjs launch --profile web -- --port 3080

# 隔离行管理与一键恢复
node bin/dsh-recovery.mjs quarantine list
node bin/dsh-recovery.mjs unquarantine --id <row-id>

# 安全 profile 守卫（启动强制还原 + fs.watch/轮询防漂移）
node bin/dsh-recovery.mjs guard --once
node bin/dsh-recovery.mjs guard --poll-ms 30000
```

阶梯语义（全部留痕于 `recovery/journal.log` 与 `recovery/incidents/`）：
1. 崩溃证据：boot 标记正常退出即清除，异常退出留作下次启动的崩溃证据；
2. 归因隔离：`failed to apply loader entry <id> (<pkg>)` 且非 `@deepseek-ai/*` →
   写带标记的 `disabled` 行并重启（`unquarantine` 一键撤销）；
3. 回滚：无法归因/核心行失败 → `rollback --good` 再试；
4. 熔断：窗口内失败 ≥3 次 → 自动 `safemode enter`（默认顺带拉起
   `dsh --profile safemode --port 3081`）。

阈值在 `recovery/config.json` 的 `boot.*` / `guard.*`，全部可覆盖（`launch` 也接受
`--retries/--ready-ms/--threshold/--window-ms/--no-ladder/--no-auto-safe-boot`）。

## P2：进程内 watchdog bundle（`packages/dsh-recovery-plugin`）

一个可安装的 dsh bundle（`dsh.bundle` + `dsh.client`）：

```sh
dsh plugin --profile web add link:/abs/path/dsh-recovery/packages/dsh-recovery-plugin
```

- **fiber 失败 → 隔离**：监听 `internal/status`（global），第三方行 FAILED →
  写带标记的 `disabled` 行并直接经 loader API 推给 root include，运行期卸载、
  进程不重启；`unquarantine` 恢复。
- **心跳 / boot 标记**：不经 launcher 的裸 `dsh web` 也由插件补写与清理。
- **pre-install 快照**：`tools.guard` 同步拦截 `dsh plugin add/remove/update`，
  执行前落 Tier A+B 快照（脱敏）。
- **意图对账**：启动即把「已装但漏写 bundles 层」的 bundle 型依赖补回 layer；
  `plugins.intent.json` 漂移只报告、不自动安装。
- **坏预设隔离**：broken 的自建预设整目录移入 `recovery/quarantine/presets/`，
  `agent-presets.default` 行级回退 `standard`（settings 先备份）。
- **渲染探针**：页面 3s 上报 ok、window error/unhandledrejection 上报失败，
  落入 `state.json.clientRender` + incident；loopback-only 路由
  `GET /api/dsh-recovery/status`、`POST /api/dsh-recovery/report-render`。
- **设置页状态卡**：`settings.section` 注册 `dsh-recovery` 页，展示恢复状态。

宿主半区只消费服务、不发布服务（plane 合规）；全部状态走 `~/.dsh/recovery/`
单一状态层。完整验收剧本见 `docs/ACCEPTANCE.md` 的 P2 章节。
