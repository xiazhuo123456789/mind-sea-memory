# 记忆星海 · 部署手册

> 目标读者：想给自己 AI 机器人装长期记忆的人，以及**替人部署的 AI**。
> 本手册每一步都可复制粘贴执行；所有命令都在仓库根目录运行。
> 零第三方依赖，只需要 Node ≥ 18。

---

## 0. 三分钟速通

```bash
git clone https://github.com/xiazhuo123456789/mind-sea-memory.git
cd mind-sea-memory
node scripts/install.mjs
```

安装器会**逐项提问**（端口 / DeepSeek Key / 是否注册进 DSH / 是否灌演示数据 / 是否启动），
答完自动完成配置、注册、启动与验收。

想全程不问？用非交互模式：

```bash
node scripts/install.mjs --yes
# 或带参数：
node scripts/install.mjs --yes --key sk-xxxx --register-dsh --dsh-home "E:\DSH-data\dot-dsh" --seed 3000
```

装完打开：

- 服务：<http://127.0.0.1:8790/health>
- 3D 星海面板：<http://127.0.0.1:8790/panel>
- 部署体检：`node scripts/install.mjs --check`

---

## 1. 四种部署方式，挑一个

### 方式 A：一键（非交互，适合脚本 / 批量）

```bash
node scripts/install.mjs --yes
```

默认行为：端口 8790、不填 Key、自动探测 DSH 并注册、不灌演示数据、后台启动。

### 方式 B：提问式（推荐个人用户）

```bash
node scripts/install.mjs
```

逐项询问，回车即用默认值。适合第一次装、想自己选端口和 Key 的人。

### 方式 C：AI 自动部署（把活交给 AI）

把 **[docs/AI_DEPLOY_PROMPT.md](AI_DEPLOY_PROMPT.md)** 整段复制给任意 AI（ZCode / Claude / ChatGPT + 本地工具 / DSH 自己），
它会按提示词里的步骤先 dry-run、再问必要的问题、执行、自检、出报告。
提示词已内置边界：不把 Key 写进 git、不擅自改端口、失败时回滚建议。

### 方式 D：手动（不想跑安装器）

```bash
cp config.example.json config.json     # 改端口 / Key / defaultUser
node server.mjs                        # 前台启动，Ctrl+C 停止
node scripts/register-dsh.mjs desktop --home "<你的 DSH 数据目录>"
```

Windows 后台启动：

```powershell
Start-Process node -ArgumentList 'server.mjs' -WorkingDirectory "<仓库绝对路径>" -WindowStyle Hidden
```

Linux / macOS 后台：

```bash
nohup node server.mjs > memory.log 2>&1 &
```

---

## 2. 安装器到底做了什么

按顺序六步，每步都可单独重跑（幂等）：

| 步骤 | 行为 | 失败时 |
|---|---|---|
| 0 环境检查 | 校验 Node ≥ 18 | 直接退出并提示升级 |
| 1 配置 | 不存在则从 `config.example.json` 复制；只补缺项，**不覆盖已有 Key** | 报错退出 |
| 2 演示数据（可选） | `--seed N` 灌 N 条示例记忆（**会覆盖 data/brain.json**） | 警告，不阻断 |
| 3 DSH 注册（可选） | 写入 `cordis.patch.yml` 托管块（带备份） | 警告，打印手动命令 |
| 4 启动 | 后台拉起 `server.mjs` 并等 `/health` 通过（15s） | 报错，提示手动启动看日志 |
| 5 验收 | 打印健康 / 面板 / LLM / DSH 四项状态 | — |

`--dry-run` 只打印计划；`--check` 只跑体检（`scripts/doctor.mjs`）。

---

## 3. 配置参考（`config.json`）

最小配置只需要 `port`；其余按需。

```jsonc
{
  "port": 8790,
  "host": "127.0.0.1",          // 只监听本机；改 0.0.0.0 前先设 token
  "token": "",                  // 非空则所有写接口要求 Authorization: Bearer <token>

  "llm": {                      // 记忆抽取 + /reflect 反思用（可留空，退回规则）
    "baseUrl": "https://api.deepseek.com",
    "apiKey": "",
    "model": "deepseek-chat"
  },
  "upstream": {                 // /v1 OpenAI 兼容代理的上游（可留空，留空则 /v1 返回 503）
    "baseUrl": "https://api.deepseek.com",
    "apiKey": "",
    "model": "deepseek-chat"
  },
  "embed": {                    // 可选：本地 Ollama 语义向量
    "baseUrl": "",              // 如 http://127.0.0.1:11434/api/embeddings
    "model": "bge-m3"
  },

  "recall": { "k": 5, "minScore": 0.35, "maxBytes": 1400, "maxItems": 5 },
  "remember": { "enabled": true, "minChars": 6, "importance": 0.4 },
  "defaultUser": "qq:10001",    // 单机器人场景兜底：调用方不传 user 时用它

  "reminders": {
    "webhook": "",              // 到点提醒 POST 到这个地址（接 SnowLuma/bridge 发消息）
    "intervalMin": 10
  },
  "nightly": {
    "purgeDays": 180,           // 0 = 永不物理删除
    "freqWindowDays": 30,       // 频率感知衰减窗口
    "archiveProtectDays": 30,   // 归档保护期
    "protectNames": ["妈妈", "老王"],   // 核心人物地板
    "protectFloor": 0.45,
    "kindCaps": { "fact": 3000, "skill": 500 },
    "autoConflict": true        // 规则自动冲突检测
  }
}
```

> **`config.json` 已在 `.gitignore` 里**——填了 Key 也绝不会被提交。
> 部署后想改配置：编辑文件 → 重启服务（`server.mjs` 启动时读一次）。

环境变量可覆盖同名配置（便于容器化）：
`MEMORY_PORT` `MEMORY_HOST` `MEMORY_TOKEN` `MEMORY_LLM_BASE/KEY/MODEL`
`MEMORY_UPSTREAM_BASE/KEY/MODEL` `MEMORY_EMBED_URL/MODEL` `MEMORY_DEFAULT_USER`
`MEMORY_REMINDER_WEBHOOK` `MEMORY_DATA_DIR` `DSH_HOME`。

---

## 4. 接进你的机器人

### 4.1 DSH（MCP，推荐）

```bash
node scripts/register-dsh.mjs desktop --home "<DSH 数据目录>"
```

- DSH 数据目录通常是 `~/.dsh`（Windows：`C:\Users\<你>\.dsh`）。若是便携版，
  可能是 `E:\DSH-data\dot-dsh`；两者若是 Junction/软链，指向同一个地方。
- 注册是**托管块**（`# === mind-sea-memory MCP BEGIN/END ===`），不会动你已有的其他 MCP，
  每次写入前自动备份 `cordis.patch.yml`。
- **必须完整退出并重开 DSH** 才生效；之后在 DSH 里搜 `mcp__mind-sea-memory__` 能看到 5 个工具：
  `mem_recall` / `mem_remember` / `mem_boot` / `mem_intents` / `mem_stats`。
- 移除：`node scripts/register-dsh.mjs desktop --home "<dir>" --remove`

### 4.2 任意 OpenAI 客户端（`/v1` 代理）

把客户端 `base_url` 指向 `http://127.0.0.1:8790/v1`，请求带 `user`（如 `"qq:10001"`）。
群聊再加 header `x-channel: group`、`x-group: 群号`。
留空 `upstream` 时 `/v1` 不可用，但 `/recall` `/remember` 正常。

### 4.3 HTTP 直连（bridge / 自写插件）

```bash
curl -X POST http://127.0.0.1:8790/remember -H "Content-Type: application/json" ^
  -d "{\"text\":\"用户养了只叫团子的橘猫\",\"kind\":\"fact\",\"user\":\"qq:10001\",\"channel\":\"private\"}"

curl -X POST http://127.0.0.1:8790/recall -H "Content-Type: application/json" ^
  -d "{\"query\":\"我猫叫什么\",\"user\":\"qq:10001\",\"channel\":\"private\"}"
```

完整接口清单见 [INTEGRATION.md](INTEGRATION.md)。

---

## 5. 部署后验收（四项）

1. `node scripts/install.mjs --check` → 「体检通过」
2. 浏览器打开 `/panel` → 能看到星海（没数据时是空海）
3. DSH 重启后搜 `mcp__mind-sea-memory__` → 5 个工具
4. **真人测试**：对机器人说「记住，我的游戏ID是夜风」→ 再问「我的游戏ID是什么」→ 答对

第 4 步过了，才算真正部署完成。

---

## 6. 运维

### 启动 / 停止 / 重启

```bash
# 查看端口占用（Windows）
netstat -ano | findstr :8790
taskkill /F /PID <PID>

# 启动（Windows）
Start-Process node -ArgumentList 'server.mjs' -WorkingDirectory "<仓库>" -WindowStyle Hidden

# Linux / macOS
pkill -f "node server.mjs" ; nohup node server.mjs > memory.log 2>&1 &
```

### 开机自启（可选）

**Windows 任务计划**：创建基本任务 → 触发器「登录时」→ 操作「启动程序」
程序 `node.exe`，参数 `server.mjs`，起始于仓库目录。

**Linux systemd**（`/etc/systemd/system/mind-sea.service`）：

```ini
[Unit]
Description=mind-sea-memory
After=network.target
[Service]
WorkingDirectory=/opt/mind-sea-memory
ExecStart=/usr/bin/node server.mjs
Restart=always
[Install]
WantedBy=multi-user.target
```

### 备份 / 迁移

全部数据都在 `data/` 目录，**拷走即迁移**：

- `brain.json`（记忆主库）
- `episodes.jsonl`（原始对话，可溯源）
- `audit.jsonl`（审计）
- `rules.md`（手写永久规则）

面板「管理」页也能一键导出全部 JSON。

### 升级

```bash
git pull --ff-only
node scripts/install.mjs --check   # 确认配置兼容
# 重启服务
```

数据自动迁移（`schemaVersion`），不会丢记忆。

### 卸载

```bash
node scripts/register-dsh.mjs desktop --home "<DSH 数据目录>" --remove
# 停掉进程，删除仓库目录即可；data/ 里是你的记忆，删前自行备份
```

---

## 7. 故障排查

| 现象 | 原因 / 处理 |
|---|---|
| 启动报 `EADDRINUSE` | 8790 被占：换端口或杀掉旧进程（见上） |
| `/v1` 返回 503 | `upstream.baseUrl` 没配，属于预期；只做记忆用 `/recall` `/remember` |
| `/reflect` 返回 400 | `llm.apiKey` 没配；无 Key 时规则兜底，不影响存取 |
| Key 填了却 401 | Key 无效或不是 platform.deepseek.com 的平台 Key（账号登录态 ≠ API Key） |
| DSH 里搜不到 `mcp__mind-sea-memory__` | ① 没完整重启 DSH ② `cordis.patch.yml` 里没有托管块 ③ serverName 写错——跑 `--check` 看注册项 |
| 面板空白 | 浏览器控制台看报错；服务端静态文件每次请求读盘，改完刷新即可 |
| 群聊召回私聊内容 | 不可能：owner+visibility 是引擎级过滤；检查调用方是否传了 `channel:"group"` |
| 记忆不增长 | 提问不会被记（设计如此）；说陈述句；看 `/remember` 响应与 `data/episodes.jsonl` |
| 数据越滚越大 | 调 `nightly.purgeDays`；或设置 `kindCaps`；或用面板归档 |

---

## 8. 安全须知

1. **默认只监听 127.0.0.1**。要对外必须先设 `token`，并放在反向代理后。
   开了 `token` 后：API 调用需带 `Authorization: Bearer <token>`；MCP 会读 `config.json` 的 token 自动带上；
   面板首次加载会弹一次输入框，输入后存浏览器 localStorage（只在本机浏览器里）。
2. **不要把 `config.json`、`data/` 提交到 Git**（`.gitignore` 已覆盖）。
3. 记忆是明文 JSON；备份文件请自行加密保管。
4. 机器人调用时的 `user` 字段就是隔离边界，不要让它来自不可信输入（例如让群成员自报他人 QQ 号）。
5. 提醒 webhook 会把承诺内容 POST 出去；只填你自己控制的地址。

---

## 9. 目录结构

```
mind-sea-memory/
├── server.mjs               HTTP 服务 + /v1 代理（27+ 端点）
├── mcp-server.mjs           MCP stdio 网关（5 个工具）
├── lib/
│   ├── store.mjs            存储（JSON + JSONL + 审计 + 规则）
│   ├── engine.mjs           召回打分 / 夜间治理 / 开机包 / 时间窗口
│   ├── extract.mjs          记忆抽取（LLM + 规则兜底）
│   ├── intent.mjs           中文时间解析 / 承诺认领 / 完成检测
│   └── viewmodel.mjs        面板数据 / 体检
├── public/panel.html        3D 记忆星海面板
├── scripts/
│   ├── install.mjs          一键 / 提问式部署
│   ├── doctor.mjs           部署体检
│   ├── register-dsh.mjs     DSH MCP 注册
│   ├── seed-demo.mjs        演示数据生成
│   └── test*.mjs / eval.mjs 回归与评测
├── docs/                    部署 / 接入 / 研究文档
├── data/                    你的记忆（运行时生成，勿提交）
└── config.json              你的配置（运行时生成，勿提交）
```

---

## 10. 一句话给 AI

如果你是被要求"帮我把这个部署好"的 AI：先读
**[docs/AI_DEPLOY_PROMPT.md](AI_DEPLOY_PROMPT.md)**，按里面的步骤执行，不要自己发明流程。
