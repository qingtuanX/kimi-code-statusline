# kimi-code 状态栏：会话花费 + key 余额

在 [kimi-code](https://github.com/MoonshotAI/kimi-code) 输入框下方的 footer 第一行显示：

```
DeepSeek V4.1 Flash  ·  本次会话 ¥1.17  ·  key 余额 ¥16.40
```

- **本次会话花费**：汇总当前会话全部 agent（含子代理）的 token 用量 × 单价（单价可配置）
- **key 余额**：调用 OpenAI 兼容 provider 的余额接口（默认 DeepSeek `GET /user/balance`），后台定时刷新，不阻塞界面
- 片段可自由增删排序：`model` / `mode` / `cwd` / `git` / `cost` / `balance`

## 安装

1. 把 `statusline.js`、`statusline-refresh.js`、`statusline.config.json`、`statusline.cmd`
   放进 `~/.kimi-code/`（Windows：`C:\Users\<你>\.kimi-code\`）

2. 编辑 `~/.kimi-code/tui.toml`，加入：

   ```toml
   [status_line]
   command = 'C:\Users\<你>\.kimi-code\statusline.cmd'
   ```

   > Windows 下把命令包进 `.cmd` 是刻意为之：kimi-code 目前用 `cmd /s` 解析该命令，
   > 命令里出现引号会失败（官方 issue [#3505](https://github.com/MoonshotAI/kimi-code/issues/3505)、
   > [#2332](https://github.com/MoonshotAI/kimi-code/issues/2332)）。`statusline.cmd` 只有一行调用，天然避开这个坑。

3. 在 kimi-code 里执行 `/reload-tui`（或重启）。

需要 Node.js（只用内置模块，无第三方依赖）。

## 配置 `statusline.config.json`

```jsonc
{
  "currency": "¥",                 // 显示符号
  "balance_refresh_seconds": 90,   // 余额后台刷新间隔
  "segments": ["model", "cost", "balance"],   // footer 行内容与顺序
  "prices_per_million_tokens": {   // 每百万 token 单价（默认按 DeepSeek 公开标准价）
    "_default": { "cache_hit": 0.2, "cache_miss": 2.0, "output": 3.0 },
    "deepseek/deepseek-flash": { "cache_hit": 0.2, "cache_miss": 2.0, "output": 3.0 }
  }
}
```

- 单价的 key 是会话里记录的模型名（如 `deepseek/deepseek-flash`），没列出的模型用 `_default`
- `cache_hit` = 缓存命中的输入，`cache_miss` = 未命中的输入，`output` = 输出

## 原理

kimi-code 会以子进程运行 `status_line.command`：把 JSON 快照写到 stdin
（v2.0.1 实测字段：`model` / `cwd` / `gitBranch` / `permissionMode` / `planMode` /
`contextUsage` / `contextTokens` / `maxContextTokens` / `sessionId` / `version`），
取 stdout 第一行作为 footer 第一行，**超时 300ms，刷新最快每秒一次**。

因此本方案：

1. `statusline.js` 在 300ms 内只做本地文件 IO 并输出一行（实测约 90ms）
2. 花费 = 会话目录 `agents/*/wire.jsonl` 中 `usage.record` 事件累计的 token 数 × 单价；
   采用增量读取（记录文件偏移），不重复扫全量日志
3. 余额查询放进后台进程 `statusline-refresh.js`（网络请求塞不进 300ms 预算），
   结果写到 `statusline-cache/balance.json`；前台只读缓存
4. 刷新失败时保留上一次的余额并标 `*`；查询成功后自动恢复

> 为什么要自己解析 `wire.jsonl`：kimi-code 的 payload 目前不包含 token 用量，
> 已向官方提交 feature request 希望直接透出（见仓库 Issues）。

## 已知限制

- 花费是**估算**：按 `statusline.config.json` 里的单价计算，单价与实际不符则数字不准
- 余额接口目前只对接 DeepSeek 风格的 `/user/balance`；其他 provider 可自行修改 `statusline-refresh.js`
- footer 第一行会**整行替换**内置槽位（model / cwd / git / mode），所以默认把 `model` 放进 `segments` 里补回来

## English

Shows **session cost + API-key balance** in the kimi-code footer, under the input box:

```
DeepSeek V4.1 Flash  ·  session ¥1.17  ·  key balance ¥16.40
```

- Session cost is computed from the session's own `wire.jsonl` usage records × configurable per-model
  prices (incremental scan, ~90 ms per refresh, well under the 300 ms budget kimi-code allows).
- Balance is fetched from the provider's OpenAI-compatible balance endpoint (DeepSeek `/user/balance`)
  by a detached background process; the foreground script only reads a cache file.
- Install: drop the files into `~/.kimi-code/`, add a `[status_line] command` pointing at
  `statusline.cmd` in `tui.toml`, then `/reload-tui`. The `.cmd` wrapper is required because kimi-code
  currently mangles quoted commands on Windows (upstream issues #3505 / #2332).

## License

MIT
