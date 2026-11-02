# dafenyu-memory 1.0.0 —— 分层遗忘 · 冲突待裁决 · 双通道召回 · 承诺账本 · 记忆体检

> 本文档只记录本仓库自己的实现。调研中参考的他人项目只借鉴思路、全部代码原创重写；
> 凡许可未核实或为 AGPL 的项目，一律不复制代码进本 MIT 仓库。厂商自述的基准数字
> （如某项目 README 里的 Recall@k、token 节省率）一律不引用为本仓库实测结果。

## 新增（相对 v2）

| 能力 | 落法 | 关键约束 |
| --- | --- | --- |
| 分层遗忘 | `lib/viewmodel.mjs`：fact / preference / relation 半衰期 30 天，episode / skill / hypothesis 14 天，pin / digest 永不衰减 | 只改留存计算，不改已存 importance；夜巡衰减率仍为全局 ×0.995 |
| 三态淡忘 | `stateOf()`：留存 ≥0.45 清晰，≥0.2 模糊，<0.2 折叠 | 只算状态、不删数据；模糊/折叠在面板上明确标出 |
| 事实键冲突待裁决 | `fact_key`（同 owner + 同键）新事实到达时挂入 `conflicts` pending 队列 | 裁决前旧条继续生效；`keep_new` / `keep_old` / `mark_only` 三种裁决，裁决只标记 superseded，绝不物理删除 |
| 审计日志 | `data/audit.jsonl`：supersede、冲突创建/裁决、意图创建/裁决、夜巡计数 | 只追加，不改写历史；审计写失败不阻断主流程 |
| 召回解释 | `/recall`（`explain:true`）返回 `rejected`，原因只有三种：`dedup` / `over_budget_k` / `below_minScore` | 被取代/归档的记忆不在 active 召回中，故不在 rejected 里 |
| 双通道注入 | 核心事实（pin / fact / preference / digest）走 `coreK`（默认 3），事件类走 `k`（默认 5） | 两通道互不挤占；返回的 `channels` 给出两通道的 id 列表 |
| 承诺 / 意图账本 | `POST /intent`、`GET /intents`、`POST /intent/:id/resolve`（fulfilled / missed + 证据） | 逾期只在读取时计算，不改写原记录；无证据不结清为 fulfilled 是调用方的责任，接口只记录证据文本 |
| 记忆体检 | `GET /healthcheck`，纯函数只读 | 计数 + 上限 20 条短标签；快淡忘、快固化、同键多条活跃事实、待裁决冲突、未兑现/已逾期承诺 |
| 面板 | `public/panel-v3.html`，`/panel`；v2 面板移到 `/panel-v2`，旧版仍在 `/panel-legacy` | 新增 召回解释 / 承诺账本 / 记忆体检 三个页签；热力仍标注为近似，模拟衰减仍标注为预览 |

## 新增接口

```bash
# 事实键写入（冲突时返回 conflict_ids）
curl -X POST http://127.0.0.1:8790/remember -H "Content-Type: application/json" \
  -d '{"text":"他住在上海","kind":"fact","fact_key":"home.city","user":"qq:10001"}'

# 裁决冲突
curl -X POST http://127.0.0.1:8790/conflict/c000001/resolve -H "Content-Type: application/json" \
  -d '{"choice":"keep_new","note":"搬家确认"}'

# 召回解释
curl -X POST http://127.0.0.1:8790/recall -H "Content-Type: application/json" \
  -d '{"query":"团子","user":"qq:10001","explain":true}'

# 承诺账本
curl -X POST http://127.0.0.1:8790/intent -H "Content-Type: application/json" \
  -d '{"text":"周五晚上陪你开黑","user":"qq:10001"}'
curl http://127.0.0.1:8790/intents
curl -X POST http://127.0.0.1:8790/intent/i000001/resolve -H "Content-Type: application/json" \
  -d '{"outcome":"fulfilled","evidence":"周五已开黑"}'

# 体检（只读）
curl http://127.0.0.1:8790/healthcheck
```

## 研究来源（思路级，非代码复用）

- 通用记忆层：mem0（Apache-2.0，事实层 + 显式取代）、Letta（Apache-2.0，分层 + 闲时整理）、
  Graphiti（Apache-2.0，时间有效性 + 取代不删除）、LangMem（MIT，语义/情景/程序三类）。
- DSH / AstrBot 伴侣场景：多家 DSH 记忆插件的公开 README 思路——按层差异化遗忘、
  事实键取代、断言 + 出处、冲突待人工裁决、两级读取、夜巡 dry-run、模拟曲线明示。
- 红线：LivingMemory、memory-brain 为 AGPL，只借鉴思路；Yuuyuko 等自定义许可或许可未核实
  的项目只借鉴思路，不复制代码；未给仓库链接的视频宣称一律不列为可用实现。

## 诚实边界（仍未做）

- 没有 SQLite / FTS5 迁移：仍是 JSON 全量加载，~10 万条以上会变慢，属已知上限。
- 没有逐日召回日志：热力图仍是 `created_at` / `last_hit` 的近似，面板与接口均已标注。
- 没有模型自动改写人格核心：核心（pin）只能由写入方显式设置，模型不擅自改人设。
- 没有把厂商基准数字写进本仓库：所有“效果”以本仓库自测（`scripts/test*.mjs`）为准。
- 模拟衰减、体检预测均不写库；演示数据一律标注。

## 自测

```bash
node scripts/test.mjs      # 旧 14 项
node scripts/test-v2.mjs   # v2 11 项
node scripts/test-v3.mjs   # 新增（分层衰减、三态、冲突三裁决、审计、召回解释、双通道、承诺账本、体检只读、面板、导出导入兼容）
```
