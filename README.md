# dsh-pi

在 dsh-tui 中浏览并续写 Pi 原生会话。Pi 负责运行模型、工具及会话存储，dsh-tui 负责输入和展示。

## 安装与使用

需要可用的 dsh-tui 和 PATH 上的 Pi CLI。

```sh
dsh plugin --profile dsh-tui -- add github:suemi994/dsh-pi
dsh-tui --backend pi-cli
```

在 `/kernel` 选择 **Pi (CLI)**，或用 `dsh-tui --backend pi-cli` 启动。进入 Pi 内核后，`/resume` 主会话列表会按工作区显示 Pi 原生会话。用左栏切换项目，右栏选择会话。DSH 内核下 `/resume` 的来源标签用于历史迁移。也可以用 `dsh-tui --backend pi-cli --resume <Pi会话ID>` 打开。等这一轮结束并退出 dsh-tui 后，在原项目目录用 `pi --session <Pi会话ID>` 或 `pi -r` 接手。两个前端使用同一个 Pi 会话 ID 和同一份 JSONL 文件。切换前端时应先退出当前前端，避免两个 Pi 进程同时写入一条会话。

会话目录默认取 `$PI_CODING_AGENT_DIR/sessions`，未设置时为 `~/.pi/agent/sessions`。如果 Pi 通过 `PI_CODING_AGENT_SESSION_DIR` 使用自定义目录，请为两端使用相同的环境变量。可选的 `PI_MODEL` 指定本插件调用 Pi 时的模型，省略时由 Pi 使用原会话或自己的默认配置。

打开或恢复会话时启动一个 `pi --mode rpc` 进程。后续消息、模型选择和中断通过这个进程处理，关闭会话时结束进程。支持文本续聊和工具事件展示。Pi 专用的交互式扩展界面、图片输入和运行中插话未接入。会话浏览读取原文件，历史展示选取原生会话的当前分支。Pi 自己恢复实际模型上下文。

在 Pi 会话中用 `/effort` 打开思考深度滑杆，或用 `/effort <档位>` 直接设置。可用档位由 Pi 根据当前模型提供。Pi 将选中的档位写入原生会话，从 Pi CLI 恢复时会沿用。

`/compact` 调用 Pi 自己的压缩：摘要和压缩检查点写进原生会话文件，之后用 Pi CLI 打开同一条会话也会看到同样的压缩结果。Pi 自动压缩时界面同样显示压缩进度。回合运行中执行 `/compact` 会被拒绝，等回合结束再执行。

## 在 DSH 内核导入 Pi 会话（社区插件）

导入走社区插件 `dsh-unified-context`，不改 dsh-tui 本体：

```sh
dsh plugin --profile dsh-tui -- add dsh-unified-context@0.5.0
```

它 0.5.0 与 DSH 0.2.2-rc.1 有一处不兼容：`assistant/message` 缺少读取器要求的 `stream` 字段，导入后打开会报 `invalid settlement fields`。用仓库里的一行补丁修掉：

```sh
cd "$DSH_HOME/profiles/dsh-tui"
pnpm patch dsh-unified-context@0.5.0 --edit-dir /tmp/uc-patch
cd /tmp/uc-patch && patch -p1 < /path/to/repo/pi-agent/dsh-backend-pi-cli/community/dsh-unified-context@0.5.0-stream.patch
cd "$DSH_HOME/profiles/dsh-tui" && pnpm patch-commit /tmp/uc-patch
```

之后重启 dsh-tui，在 DSH 内核用 `/import-pi`（可加 `--limit N`、`--project <子串>`）。导入的会话以普通 DSH 会话出现在 `/resume`，标题带 `[pi]`；没有 Pi 来源标签。导入是快照：之后 Pi 侧的变化不会同步，重复导入会跳过。

补丁只改 `lib/convert.mjs`。升级插件版本后补丁会失效，重新打一次；上游修复后删掉补丁即可。

### 可选：Pi 来源标签（需要改 dsh-tui）

`migrate/apply.mjs` 仍保留旧方案：通过 pnpm patch 给 dsh-tui 增加 Pi 迁移适配器，效果是 `/resume` 多一个 **Pi** 标签、可单条点选导入，以及 `dsh-tui migrate pi`。它需要修改 dsh-tui 本体，`dsh-tui update` 后要重跑；`--revert` 可撤销。当前未启用。

## 验证

```sh
node --test pi-agent/dsh-backend-pi-cli/test/*.test.js
```

测试使用实际 Pi 二进制和临时目录，模型响应由环回 HTTP 服务提供。若设置 `PI_TUI_TEST_DSH_HOME` 为已安装本插件与 dsh-tui 的测试环境，则用 tmux 驱动真实 `/resume` 和回复界面，完成 Pi CLI → dsh-tui → Pi CLI 的交接。迁移适配器的测试会读取 `DSH_TUI_PACKAGE`（默认当前 profile 里的 dsh-tui）；未打 patch 时自动跳过。

源自 [dok4everak47/dsh-backends 的 pi-cli 插件](https://github.com/dok4everak47/dsh-backends/tree/acae5b2d36493e3b6846962659328cca5f256f45/pi-cli)，上游包声明 ISC。宿主扩展接口见 [dsh-tui 插件手册 · 接缝稳定性参考](https://github.com/ccch1mneyyy/dsh-TUI/blob/main/docs/plugins.md#接缝稳定性参考)。

## Pi Durable

上游的进程内 Pi Durable 后端保留在 [pi-durable/](pi-durable/)。仓库根目录的安装命令安装 Pi CLI 后端。
