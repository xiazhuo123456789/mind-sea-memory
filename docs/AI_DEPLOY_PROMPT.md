# 给 AI 的部署提示词（整段复制）

> 用法：把本文件**从下面「=== 提示词开始 ===」到结尾**整段复制，发给任意能操作本地文件的 AI
> （ZCode / Claude Code / DSH 自己 / 带终端的 ChatGPT）。
> 它会按步骤部署「记忆星海 mind-sea-memory」，最后给你一份验收报告。
> 如果 AI 不能操作本地文件，只能给命令——那就让它把命令按顺序列给你，你逐条执行。

---

=== 提示词开始 ===

你现在的任务是：帮我在本机部署「记忆星海（mind-sea-memory）」——一个给 AI 机器人用的
跨会话长期记忆服务（Node 零依赖）。仓库地址：
`https://github.com/xiazhuo123456789/mind-sea-memory`

## 硬性规则

1. **先读文档再动手**：读仓库里的 `docs/DEPLOY.md` 和 `README.md`，不要凭记忆发明命令。
2. **先 dry-run**：执行 `node scripts/install.mjs --dry-run`，把计划（端口/配置/DSH 注册/演示数据/启动）
   用中文列给我确认，再执行真正的安装。
3. **不要擅自决定这几项**，必须问我（每项给默认值）：
   - 监听端口（默认 8790）
   - DeepSeek API Key（可留空；留空则只用规则抽取，不影响记忆存取）
   - 是否注册进 DSH（我的 DSH 数据目录在哪；如果检测不到就问我）
   - 是否灌演示数据（**会覆盖 data/brain.json**，默认不灌）
   - 是否现在后台启动（默认启动）
4. **安全红线**：
   - 绝不把 API Key 写进任何会被 git 跟踪的文件、提交信息、日志或聊天记录里；
   - `config.json` 与 `data/` 已在 .gitignore，不要把它们加入 git；
   - 不要把服务监听从 127.0.0.1 改成 0.0.0.0，除非我明确要求并且你同时设置了 token。
5. **每步都要验证**，不要假设成功。失败时先读报错，再查 `docs/DEPLOY.md` 第 7 节故障排查。
6. 不要修改仓库里的业务代码（`server.mjs` / `lib/*` / `public/*` / `scripts/*`），
   本次任务只做部署与配置。

## 执行步骤

### 第 1 步：拿到仓库
如果目录已存在就 `cd` 进去并 `git pull --ff-only`；否则 `git clone` 上面的地址。
确认 `package.json` 里的 `name` 是 `mind-sea-memory`。

### 第 2 步：环境检查
`node -v` 必须 ≥ 18。不满足就停下来告诉我怎么升级，不要继续。

### 第 3 步：dry-run 并向我确认
`node scripts/install.mjs --dry-run`
把输出整理成中文清单发我，并逐项问上面「硬性规则 3」的五项。

### 第 4 步：正式安装
根据我的回答执行，例如：

```bash
node scripts/install.mjs --yes --port 8790 \
  --key "sk-我给你的key" \
  --register-dsh --dsh-home "我的DSH数据目录" \
  --no-seed
```

（灌演示数据时加 `--seed 3000`；不启动时加 `--no-start`。）

### 第 5 步：部署体检
`node scripts/install.mjs --check`
要求核心项全部通过（Node / config / 数据目录 / MCP 握手）。
服务和 DSH 注册是警告项——如果服务没起，按提示重启。

### 第 6 步：真人验收（可选但强烈建议）
告诉我：
1. 打开 `http://127.0.0.1:<端口>/panel` 能否看到星海面板；
2. 在 DSH 里搜 `mcp__mind-sea-memory__` 是否出现 5 个工具
   （`mem_recall` / `mem_remember` / `mem_boot` / `mem_intents` / `mem_stats`）；
3. 在机器人对话里说「记住，我的游戏ID是夜风」，再问「我的游戏ID是什么」，能否答对。

### 第 7 步：出报告
用这个模板回复我：

```
✅ 部署完成
- 仓库：<路径>
- 服务：http://127.0.0.1:<端口>（版本 <version>，活跃记忆 <N> 条）
- LLM：已配置 / 未配置（未配置影响 /reflect 与智能抽取）
- DSH：已注册 <profile> @ <home> / 未注册
- 体检：<通过项>/<总项>
- 下一步：<1-3 条>
⚠️ 需要你知道的：<没有就写"无">
```

## 常见失败与处理

- `node: command not found` → 先装 Node 18+，别继续。
- `EADDRINUSE` → 端口被占：`netstat -ano | findstr :<端口>` 找 PID，问我是否换端口。
- DSH 注册后工具不出现 → 必须**完整退出并重开 DSH**；再不行检查
  `cordis.patch.yml` 里是否有 `# === mind-sea-memory MCP BEGIN ===` 托管块。
- Key 返回 401 → 平台 Key 无效（DSH 账号登录态不是 API Key），让用户去
  platform.deepseek.com 重新建一个。
- 任何一步失败且 15 分钟内解决不了 → 停下来，把完整报错贴给我，不要反复重试。

=== 提示词结束 ===
