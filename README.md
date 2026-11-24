# dsh-pi-backend

在 dsh-tui 中浏览并续写 Pi 原生会话。Pi 负责运行模型、工具及会话存储，dsh-tui 负责输入和展示。

## 安装与使用

需要可用的 dsh-tui，以及 PATH 上的 `pi` 可执行文件。

```sh
dsh plugin --profile dsh-tui -- add github:suemi994/dsh-pi-backend
dsh-tui --backend pi
```

在 `/kernel` 选择 **pi**，或用 `dsh-tui --backend pi` 启动。进入 Pi 内核后，`/resume` 主会话列表会按工作区显示 Pi 原生会话。用左栏切换项目，右栏选择会话。也可以用 `dsh-tui --backend pi --resume <Pi会话ID>` 打开。等这一轮结束并退出 dsh-tui 后，在原项目目录用 `pi --session <Pi会话ID>` 或 `pi -r` 接手。两个前端使用同一个 Pi 会话 ID 和同一份 JSONL 文件。切换前端时应先退出当前前端，避免两个 Pi 进程同时写入一条会话。

会话目录默认取 `$PI_CODING_AGENT_DIR/sessions`，未设置时为 `~/.pi/agent/sessions`。如果 Pi 通过 `PI_CODING_AGENT_SESSION_DIR` 使用自定义目录，请为两端使用相同的环境变量。可选的 `PI_MODEL` 指定本插件调用 Pi 时的模型，省略时由 Pi 使用原会话或自己的默认配置。

打开或恢复会话时启动一个 `pi --mode rpc` 进程。后续消息、模型选择和中断通过这个进程处理，关闭会话时结束进程。支持文本续聊、逐段显示回复和思考，以及展示工具调用、实时输出和结果。Info 侧栏使用 Pi 上报的 token、缓存命中、会话花费和上下文窗口。会话浏览读取原文件，历史展示选取原生会话的当前分支。Pi 自己恢复实际模型上下文。

支持 PNG/JPEG 图片输入，单条消息最多 8 张、单图最多 8 MiB、合计最多 24 MiB，宽高均不得超过 2048 像素。历史回放会恢复 Pi 原生会话中的图片。图片进入 Pi 前会在宿主侧校验，所选模型不支持图片时会明确拒绝。

回合运行期间，Enter 将输入作为 steer 注入 Pi 的下一个工具边界，Tab 则排队为 follow-up，当前回合结束后继续执行。也可显式输入 `/steer <补充指令>`。Pi 的 Todo 和子代理状态分别显示在内置的 Todo 和 Agents 侧栏。应用宿主补丁后，`setStatus` 和 `setWidget` 文本会显示在信息面板。

Pi 扩展的 `confirm` 弹窗会显示为权限批准，可选择允许一次或拒绝。`select`、`input`、`editor` 会显示为 Question 交互，回答会按 Pi 的 RPC 协议送回扩展。Pi 的确认协议没有持久授权范围，因此不会显示“始终允许”。`setEditorText` 会追加到当前 dsh-tui 输入框，扩展设置的标题会同步到会话标题。Pi 的 RPC 模式本身不提供 `setWorkingMessage`、自定义 UI 和自定义编辑器组件，这些调用会继续按 Pi 的无操作行为处理。

在 Pi 会话中用 `/effort` 打开思考深度滑杆，或用 `/effort <档位>` 直接设置。可用档位由 Pi 根据当前模型提供。Pi 将选中的档位写入原生会话，从 Pi CLI 恢复时会沿用。

`/compact` 调用 Pi 自己的压缩：摘要和压缩检查点写进原生会话文件，之后用 Pi CLI 打开同一条会话也会看到同样的压缩结果。Pi 自动压缩时界面同样显示压缩进度。回合运行中执行 `/compact` 会被拒绝，等回合结束再执行。

- `/btw <问题>` 在侧栏或浮层回答旁路问题，`/recap` 生成摘要和可应用的标题。两者使用当前 Pi 模型和近期对话片段，在独立的无工具临时进程中运行，主会话和原生 JSONL 不受影响。只通过 Pi 扩展注册的模型可能无法在该进程中加载。
- 应用宿主补丁后，Pi 完成回复时会用当前模型发起一次独立请求，生成一条后续消息建议。输入框为空时会自动显示，按 Tab 填入草稿，按 Enter 发送。`/suggest` 可手动获取多条建议。输入 `/` 也会显示 Pi 暴露的扩展命令、提示模板和技能。已安装的 Plan、Goal 等扩展注册的命令（如 `/plan`、`/goal`）会原样交给 Pi 扩展执行，本插件不复制其状态机。
- Pi TUI 专属扩展命令（如 `sidebar`、`open-tui`、`tool-display`）在 RPC 模式下没有可用的界面，因此不会出现在 `/` 菜单；显式输入时会收到只能回到 Pi TUI 使用的提示。其他 TUI 插件的命令可用 `PI_HIDDEN_COMMANDS` 按名称追加隐藏，多个名称以逗号分隔。
- 安装 `pi install npm:@suemi994/pi-init@next` 并应用宿主补丁后，Pi 注册的 `/init` 会从命令菜单或输入框交给 Pi 执行。可用 `/init --dry-run` 预览项目说明，或用 `/init --check-only` 检查 `AGENTS.md` 和 `CLAUDE.md`。
- 应用宿主补丁后，Pi 内核下的 `/tree` 打开原生会话树。用 ↑↓ 选中消息，按 Enter 选择回退并编辑消息，或派生独立会话。派生后用界面显示的 `/resume <会话 ID>` 打开。`/tree <节点 ID>` 查看该节点的来路。`/fork` 派生当前分支，`/fork <节点 ID>` 从指定节点派生。旧的 `/pi-tree`、`/pi-fork`、`/pi-suggest` 仍可手动输入。
- `/rewind` 使用 DSH 的对话回退流程。Pi 扩展提供 `/restore` 或 `/rewind` 时，命令菜单会额外显示 `/restore`，由 Pi 扩展决定可恢复的检查点和范围。
- `/rename` 将标题写回 Pi 会话。`/context` 显示 Pi 最近一次有效的上下文测量，首次回复前及压缩后重新测量前可能没有数据。

## 宿主补丁

[dsh-tui 0.20.2 宿主补丁](patches/dsh-tui-0.20.2-pi-integration.patch) 通过 profile 的 pnpm `patchedDependencies` 应用到 `@deepseek-harness-tui/dsh-tui`。profile 已有同一个包的补丁时，把这些改动合入原补丁后重新安装。未应用补丁的宿主仍可用 `/pi-tree` 和 `/pi-fork` 访问 Pi 会话树及节点派生。

启动或恢复 Pi 会话时，如果已安装的 dsh-tui 缺少自动建议的宿主支持，界面会显示警告。此时仍可用 `/suggest` 手动获取建议。

### Codex 写锁提示

在 Node.js 22.19 或 24+ 上，可从本项目根目录启动 dsh-tui 0.20.2，并预载运行时补丁。它在进程内过滤重复的写锁提示，恢复失败仍会显示原始错误。

```sh
NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--import=\"$PWD/patches/codex-stderr-preload.js\"" \
  dsh-tui --backend codex --resume <会话ID>
```

## 验证

```sh
npm test
```

测试使用实际 Pi 二进制和临时目录，模型响应由环回 HTTP 服务提供。若设置 `PI_TUI_TEST_DSH_HOME` 为已安装本插件与 dsh-tui 的测试环境，则用 tmux 驱动真实 `/resume` 和回复界面，完成 Pi CLI → dsh-tui → Pi CLI 的交接。宿主禁止 loopback 监听时，真实回环会带原因跳过；运行 TUI 阶段仍需要 tmux 本地 socket。

源自 [dok4everak47/dsh-backends 的 Pi 后端](https://github.com/dok4everak47/dsh-backends/tree/acae5b2d36493e3b6846962659328cca5f256f45/pi-cli)，上游包声明 ISC。宿主扩展接口见 [dsh-tui 插件手册 · 接缝稳定性参考](https://github.com/ccch1mneyyy/dsh-TUI/blob/main/docs/plugins.md#接缝稳定性参考)。

## Pi Durable

上游的进程内 Pi Durable 后端保留在 [pi-durable/](pi-durable/)。仓库根目录的安装命令安装通过会话级 RPC 与 Pi 通信的 `pi` 后端。
