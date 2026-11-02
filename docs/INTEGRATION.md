# 记忆星海 × QQ 机器人链路接入指南（AI 可直接执行）

> 本文档面向负责接入的 AI/开发者。读完即可把记忆层接进现有链路，无需再问上下文。
> 项目名：**记忆星海（mind-sea-memory）**，曾用名 dafenyu-memory / mind-sea，见到旧名一律等同本项目。

## 0. 链路拓扑与端口

```
QQ 客户端
   ⇅ OneBot v11（HTTP 3000 / WS 3001）
SnowLuma（NapCat 系协议端）
   ⇅
qq-bridge（控制台 3100，多协议适配层）
   ⇅
DSH / 大肥鱼（Harness，端口 3080，内含 DeepSeek 账号态模型 deepseek-flash）
   ⇅ MCP stdio ──────────────┐
                             ▼
              记忆星海记忆引擎（HTTP 8790，面板 /panel）
```

- 记忆引擎是**独立进程**，不侵入链路任何一环；挂了只会少记忆能力，机器人照常聊天。
- 机器上有**两个 DSH 家目录**：活的是 `E:\DSH-data\dot-dsh`（profiles/desktop，今天仍在写入），
  `C:\Users\xiazh\.dsh` 是 10-14 的旧壳不要动。

## 1. 三条接入路线（按优先级）

### 路线 A：MCP 进 DSH（主路线，✅ 已完成注册）

**已完成**：`E:\DSH-data\dot-dsh\profiles\desktop\cordis.patch.yml` 末尾已写入托管块
（`# === mind-sea-memory MCP BEGIN/END ===`，id `mcp-mind-sea-memory`，serverName `mind-sea-memory`，
stdio 启动 `E:\大肥鱼\dafenyu-memory-v3\mcp-server.mjs`，超时 120s）。

DSH 启动后会自动挂载 3 个工具，模型可直接调用：

| 工具 | 作用 | 典型调用 |
|---|---|---|
| `mcp__mind-sea-memory__mem_recall` | 召回相关记忆注入上下文 | `{query: "用户的猫叫什么"}` |
| `mcp__mind-sea-memory__mem_remember` | 把值得记的事实写入长期记忆 | `{text: "...", kind: "fact"}` |
| `mcp__mind-sea-memory__mem_stats` | 记忆库状态 | `{}` |

**让 DSH 生效的唯一步骤**：完整退出 DSH → 重新打开 → 在 DSH 里搜 `mcp__mind-sea-memory__` 确认工具出现。
**让机器人自动回复时真的用记忆**：MCP 工具是"模型可调用"，不是"服务端强制注入"。
必须在 DSH 的人格/系统提示（或工作区 `AGENTS.md`）里写明规则，否则模型可能整轮不调用工具。
现成规则块见 [docs/DSH_PERSONA_PROMPT.md](DSH_PERSONA_PROMPT.md)——粘贴到工作区 `AGENTS.md`
或 DSH 角色设定即可；更彻底的做法是把 DSH 模型请求指到 `/v1` 代理（服务端强制注入，不依赖模型自觉）。
若 DSH 提示用户问题（如"你养过什么宠物"），模型应先 `mem_recall` 再回答；回答完把新事实 `mem_remember`。
（如需系统提示词约束，把上面这句加进 DSH 的人格/系统提示即可。）

**幂等管理**（改了代码路径或要换端口时重跑）：

```bash
cd /d E:\大肥鱼\dafenyu-memory-v3
node scripts\register-dsh.mjs desktop --home "E:\DSH-data\dot-dsh"            # 注册（自动备份）
node scripts\register-dsh.mjs desktop --home "E:\DSH-data\dot-dsh" --remove   # 移除
node scripts\test-mcp-handshake.mjs                                           # MCP 全链路自检（应 5/5）
```

### 路线 B：HTTP REST 直连（给 qq-bridge / SnowLuma 侧插件用）

任何一层想直接用记忆（不经过 DSH 模型决策），调 `http://127.0.0.1:8790`：

```bash
# 写入
curl -X POST http://127.0.0.1:8790/remember -H "Content-Type: application/json" ^
  -d "{\"text\":\"用户喜欢蓝色\",\"kind\":\"preference\",\"user\":\"qq:10001\",\"channel\":\"private\"}"
# 召回
curl -X POST http://127.0.0.1:8790/recall -H "Content-Type: application/json" ^
  -d "{\"query\":\"他喜欢什么颜色\",\"user\":\"qq:10001\",\"channel\":\"private\",\"k\":5}"
```

- `user` 字段 = QQ 号（如 `qq:10001`）；群聊传 `channel:"group"` + `group:"群号"`。
- **owner/visibility 隔离是引擎级保证**：私聊记忆绝不会泄进群聊上下文。
- 单机器人图省事可在 `config.json` 设 `defaultUser`，调用方就不用传 user。
- `/recall` 的 `reinforce` 参数（2026-10-31 防自污染）：`light`=模型检索（默认，只计数不改新近度）、
  `full`=用户亲口再说（重置新近度）、`none`=纯只读。**机器人自动调用一律用默认 light**，
  只有确认是"用户原话再次提到"时才传 full。

## 1.5 永久规则层与到期提醒（借 ldo1um，2026-10-31）

**永久规则**（优先级高于一切记忆，不参与打分衰减，每次召回置顶注入）：

- 文件：`data/rules.md`，一条一行，`#` 开头为注释
- API：`GET /rules`（原文+解析）、`PUT /rules {text}`（整体保存）
- 面板：「管理」页签顶部可直接编辑保存
- 注入：召回块开头 `【永久规则（最高优先，必须遵守）】`，MCP mem_recall 工具描述已告知模型遵守

**纠错降权**：`/remember`（含 /v1 自动记忆）检测纠错话术（不对/错了/记错了/才对…），
自动对被纠旧记忆 `errors+1`（重要度×0.7、检索分×0.6^errors 上限3次），注入块标注
`（已被用户纠正×N，慎用）`，绝不删除、全程审计。

**L1 会话缓冲 + L4 状态层（v1.4，借 Diez 四层架构）**：

- **L1 会话缓冲**：只有闲聊式 `episode` 进缓冲；`fact/preference/relation/skill`
  等结构化记忆一律直通（保住 fact_key / confidence / relations）。闲聊进每 owner 的滚动缓冲，攒满
  （6 条或 900 字）用 LLM 压缩成一条带时间戳的会话摘要入库（`meta.summary=true`，
  原话始终在 episodes.jsonl 可溯源）；LLM 失败回退拼接摘要。pin/重要度≥0.6 的
  内容绕过缓冲立即入库。退出服务时自动冲刷，不丢缓冲。
- **L4 状态层**：每 owner 三个情绪维度（亲密/压力/精力，基线 0.3/0.2/0.7），
  交互时按时间回落（45 分钟半衰期）+ 文本刺激（单轮每维上限 ±0.2），输出情绪
  标签与行为倾向（话量/黏人度/主动性）。状态只做注入 hint，**不改记忆事实**；
  可查看（`GET /state?user=`）可重置（`DELETE /state`），全程审计。
  `/v1` 每轮自动把当前状态附在记忆块头部。

**开机包 `/boot`（v1.1）**：新会话/新话题开始时调一次，一次拿到分层记忆：

```bash
curl "http://127.0.0.1:8790/boot?user=qq:10001&maxChars=3000"
# 或 POST {"user":"qq:10001","channel":"private","maxChars":3000}
```

返回 11 个分层块：永久规则 → 身份层（pin）→ 洞察 → 技能 → 事实 → 偏好 → 关系 → 近期事件 →
原话层（带情绪原文）→ 未闭环承诺 → 待裁决冲突/状态。永久规则与身份层是 hard 块**永不裁剪**，
其余超预算按顺序丢弃（`dropped` 字段列出被丢的块）。MCP 侧对应工具 `mem_boot`。

**时间窗口召回（v1.1）**：查询里出现"昨天/昨晚/今天早上/刚才/上周/上个月/最近三天"等时间词
且没有其他实词时，直接按时间取该窗口的记忆与原始对话（`raw:true`），不做语义排序：

```bash
curl -X POST http://127.0.0.1:8790/recall -H "Content-Type: application/json" ^
  -d "{\"query\":\"昨天说了什么\",\"user\":\"qq:10001\"}"
# 响应多出 timeWindow:{label,start,end}；hits 里 byTime:true 表示按时间取的
```

有实词时（如"昨天面试的事"）则把候选限制进该窗口再做关键词/图谱打分。

**夜间治理可调项（v1.1，config.json → nightly）**：

```json
{
  "purgeDays": 180,            // 0 = 永不物理删除
  "freqWindowDays": 30,        // 频率感知窗口：常被想起的衰减更慢（最高减半）
  "archiveProtectDays": 30,    // 归档保护期：这段时间内被想起过且 importance≥0.05 不归档
  "protectNames": ["妈妈", "老王"],  // 核心人物地板：这些实体相关记忆不低于 protectFloor
  "protectFloor": 0.45,
  "kindCaps": { "fact": 3000, "skill": 500 },  // 按类上限，超出归档最不重要最旧的
  "autoConflict": true         // 规则自动冲突检测：共享实体+相似度+反义词对 → 待裁决队列
}
```

**意图账本自动闭环（v1.2）**：

- **自动认领**：写入记忆时（`/remember`、`/v1` 自动记忆、MCP `mem_remember`）检测承诺话术
  （别忘了/答应/说好/提醒我/待会…）或"时间+任务动词"（明天下午三点交报告），
  自动建意图并解析中文时间——支持 明天/后天/大后天/今晚/明早/周几/下周几/
  几月几号?/N小时后/N天后/几点半/中文数字（两点、十一点）。
  响应里 `intent` 字段会带新意图 id 与截止时间。
- **自动完成**：检测完成话术（搞定了/弄完了/发过去了/交了…，且排除"还没搞定"），
  按字符+bigram 匹配未闭环承诺并自动标记 fulfilled。
- **去重**：高度相似的承诺不会重复建。
- **MCP**：`mem_intents` 工具（action=list/add/done）让模型自己查账本、记承诺、标完成。

```bash
# 手动建承诺（文本里带中文时间会自动解析）
curl -X POST http://127.0.0.1:8790/intent -H "Content-Type: application/json" ^
  -d "{\"text\":\"提醒我下周三下午两点开会\",\"user\":\"qq:10001\"}"
```

**到期提醒**：承诺账本里的意图带 `due_at` 时，服务每 10 分钟自动扫描 24h 内到期/已逾期项：

- `GET /reminders/due` 查看未通知项；`POST /reminders/scan` 手动扫描
- `config.json` 配 `"reminders": {"webhook": "http://..."}` 后自动 POST
  `{type:'reminder_due', id, text, owner, due_at}` —— 接到 SnowLuma/bridge 发消息接口即可实现机器人主动提醒
- 未配 webhook 时仅打 `notified_at` 标记防重复；`mem_stats` 会向模型透出到期条数，模型可主动提醒

### 路线 C：OpenAI 兼容代理（可选，需上游 Key）

`http://127.0.0.1:8790/v1/chat/completions` 是 OpenAI 格式：自动召回→注入→转发上游→自动存新记忆。
把任何"DeepSeek API 地址"填成 `http://127.0.0.1:8790/v1` 即可。**前提**：`config.json` 的 `upstream`
段要配真实模型 Key（当前未配，调用会诚实报错）。有 DeepSeek 平台 Key 后填入即通。

## 2. 启动 / 验证速查

```bash
cd /d E:\大肥鱼\dafenyu-memory-v3
start /b node server.mjs                 # 启动记忆引擎（8790）
curl http://127.0.0.1:8790/health        # {"status":"ok","data":{...,"active":N}}
start http://127.0.0.1:8790/panel        # 3D 记忆星海面板
node scripts\test.mjs                    # 基础回归 14 项
node scripts\test-v2.mjs                 # v2 回归 11 项
node scripts\test-v3.mjs                 # v3 回归 27 项
node scripts\eval.mjs                    # 记忆能力评测 13 项（五维度）
node scripts\test-mcp-handshake.mjs      # MCP 自检 5 项
```

验收清单：health active>0 ✅ → MCP 自检 5/5 ✅ → DSH 重启后出现 mcp__mind-sea-memory__ 工具 ✅ →
对机器人说一件新事实→再问它，能答上 ✅

## 3. 已知坑（AI 接手必读）

1. **改代码后必须重启 8790 进程**（node 不热加载）：`netstat -ano | findstr :8790` 找 PID → `taskkill /F /PID` → 重启。
2. **config.json 不进仓库**（含 Key），仓库里只有 config.example.json；当前 `defaultUser: "qq:10001"`。
3. `config.json` 的 llm/upstream **未配 Key**：/reflect 与 /v1 会诚实报错属预期；/remember 自动回退规则抽取，不会挂。
4. 面板是单文件 `public/panel.html`，服务端每次请求都读盘——改完刷新浏览器即可，不用重启。
5. 推送用单根提交政策：`git add -A` → 仓库根放 COMMIT_MSG.txt → `node tools/push-v1.cjs`（Data API 强推）。
6. 仓库名已三改（dafenyu-memory→mind-sea→mind-sea-memory），旧地址 301；push 脚本里 REPO 常量已指向 mind-sea-memory。
7. GitHub 令牌走 `gh` keyring；任何旧明文 token 出现在文档/远程地址里都应删除并轮换。
