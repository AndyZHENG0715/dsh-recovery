# dsh-recovery

DeepSeek Harness 自恢复系统：一个 **纯 Node、零运行时依赖** 的 CLI + 进程内 watchdog bundle，用于在 DSH 的配置、插件、预设、会话或升级损坏时，按「诊断 → 快照 → 回滚 → 安全模式 → 启动验证」的阶梯恢复到可用状态。

## Current status

- **P0**：CLI recovery flow — 已实现
- **P1**：launcher 与自动恢复阶梯 — 已实现
- **P2**：进程内 watchdog bundle — 已实现
- **P3**：修复模式胶囊 / DSH 本体回退 / 会话修复 — 待实现

## Commands

| 命令 | 作用 |
|---|---|
| `scan` | 扫描 profile、settings、storages、用户预设、会话等常见损坏点 |
| `snapshot` | 创建恢复快照；支持组合层、用户资产、可选数据层 |
| `rollback` | 回滚到 `--latest` / `--good` / `--id <id>` |
| `safemode enter|exit` | 进入/退出安全模式 profile |
| `boot-probe` | 在临时 DSH_HOME 中做静态 + 真实启动验证 |
| `doctor` | 聚合 scan、状态、快照清单和修复建议 |
| `list` | 列出快照 |
| `launch` | 启动包装器：透明转发 + boot 标记 + 自动恢复阶梯 |
| `quarantine` | 隔离行管理 |
| `unquarantine` | 恢复被隔离的行 |
| `guard` | 安全 profile 守卫 |

常用参数：

- `--home <dir>`：默认 `$DSH_HOME` / `~/.dsh`
- `--profile web`：默认 profile
- `--dsh <dir>`：默认 `$DSH_RECOVERY_DSH_DIR`
- `--json`：输出机器可读结果

退出码：

- `0`：通过
- `1`：有错误 / 探针失败
- `2`：用法错误

## Run

```sh
node bin/dsh-recovery.mjs scan --json
node bin/dsh-recovery.mjs snapshot --reason before-upgrade
node bin/dsh-recovery.mjs boot-probe --live --mark-good
node bin/dsh-recovery.mjs rollback --good
DSH_HOME=~/.dsh node bin/dsh-recovery.mjs safemode enter
node bin/dsh-recovery.mjs launch --profile web -- --port 3080
```

如果没有 pnpm，`--install` 会给出明确告警；可用 `--pnpm <bin>` 或 `DSH_RECOVERY_PNPM` 指定。

## Safety model

- 快照正文 **永不** 包含密钥：
  - `settings.yaml` 默认只存脱敏结构（secret 键 → `***`）+ 原文 sha256
  - `.credentials.yaml` 只存指纹，不复制内容
  - `--include-settings` 才会保存 settings 原文
- 回滚前会自动创建 pre-rollback 快照，回滚本身可逆
- `boot-probe` 只读写 `$TMPDIR` 下的临时 home，真实 home 零写入
- `boot-probe` 的 live 阶段显式传 `--no-open`，不会弹默认浏览器
- 快照清单（manifest）记录 DSH 版本与文件 sha256，便于升级归因
- 所有诊断与事故记录尽量先过脱敏

## P1 launcher and recovery ladder

```sh
# 替代直接 dsh 启动：透传 + boot 标记 + 启动失败自动恢复
node bin/dsh-recovery.mjs launch --profile web -- --port 3080

# 隔离行管理与一键恢复
node bin/dsh-recovery.mjs quarantine list
node bin/dsh-recovery.mjs unquarantine --id <row-id>

# 安全 profile 守卫
node bin/dsh-recovery.mjs guard --once
node bin/dsh-recovery.mjs guard --poll-ms 30000
```

启动阶梯会记录到 `recovery/journal.log` 和 `recovery/incidents/`：

1. 崩溃证据：boot 标记正常退出即清除，异常退出保留作为下次启动证据
2. 归因隔离：非核心第三方行失败时，写入带标记的 `disabled` 行并重启
3. 回滚：无法归因或核心行失败时，回滚到 `--good` 快照
4. 熔断：窗口内失败达到阈值后自动进入 `safemode`

阈值位于 `recovery/config.json` 的 `boot.*` / `guard.*`，可覆盖。`launch` 也接受：

- `--retries`
- `--ready-ms`
- `--threshold`
- `--window-ms`
- `--no-ladder`
- `--no-auto-safe-boot`

## P2 in-process watchdog bundle

`packages/dsh-recovery-watchdog` 是一个可安装的 dsh bundle：

```sh
dsh plugin --profile web add link:/abs/path/dsh-recovery/packages/dsh-recovery-watchdog
```

它负责：

- fiber 失败后自动隔离非核心行
- 写入 / 清理 boot marker 和 heartbeat
- 在插件安装前自动落 Tier A+B 快照
- 对已安装但未写入 bundles layer 的依赖做意图对账
- 自动隔离损坏的用户预设，并把默认预设回退到 `standard`
- 运行时复核用户预设挂载健康状态
- 提供 loopback-only 的状态与 render report 路由
- 在设置页注册恢复状态卡

## Tests

```sh
npm test        # node --test；全部在隔离的 DSH_HOME 副本上运行，不碰真实 ~/.dsh
```

目前测试覆盖：

- YAML 子集解析器单测
- 损坏检测
- 三层快照与脱敏
- 回滚还原与验证门
- safemode 进出
- boot-probe 静态门 + HTTP 200 门
- doctor 聚合
- P2 watchdog 的 unit / E2E 路径

## Notes

- 已在 `@deepseek-ai/dsh@0.1.1-rc.2`、Node 24 上验证
- zstd 会话解码需要 Node ≥ 22.15
- `boot-probe` 和 `launch` 的行为依赖可用的 DSH 安装
- 真实验收步骤见 `docs/ACCEPTANCE.md`

## Roadmap

### P3
- 修复模式胶囊
- DSH 本体回退
- 会话修复

## Project docs

- `docs/dsh-recovery-design.md`
- `docs/dsh-recovery-research.md`
- `docs/ACCEPTANCE.md`
