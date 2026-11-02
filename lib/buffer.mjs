/* ============================================================
 * buffer.mjs —— L1 会话缓冲（借 Diez 四层架构的 L1 思想，原创重写）
 *
 * 解决：闲聊一条条直插长期库，把库堆成流水账。
 * 做法：每个 owner 一个内存滚动缓冲；攒满（条数/字数）或来了"重要记忆"时，
 *       用 LLM 把整批压缩成【一条】带时间戳的摘要记忆入库（标 meta.summary=true）。
 *       LLM 失败回退为拼接摘要；原始对话始终已在 episodes.jsonl（不丢内容）。
 * 高优直通：pin 或 importance≥0.6 的内容不进缓冲，立即入库（保证召回时效）。
 * 退出时 flushAll，不丢缓冲。
 * ============================================================ */
'use strict';

import * as store from './store.mjs';

const buffers = new Map();   // owner -> { items: [], chars, firstAt }
let CFG = { maxItems: 6, maxChars: 900, llm: null };

export function configBuffer(opts = {}) {
  CFG = { ...CFG, ...opts };
}

const bufOf = (owner) => {
  let b = buffers.get(owner);
  if (!b) { b = { items: [], chars: 0, firstAt: 0 }; buffers.set(owner, b); }
  return b;
};

/**
 * addBuffered({ owner, rec, episodeId, llm, now })
 *   rec: rememberConversation 里的抽取结果（text/kind/importance/entities/...）
 *   返回 { action: 'buffered' | 'flushed' | 'direct', memory? }
 *   pin/importance≥0.6 的内容返回 'direct'（调用方立即 insertMemory）。
 */
export async function addBuffered({ owner = 'global', rec, episodeId = null, llm = null, now = Date.now() }) {
  const imp = Number(rec.importance) || 0.4;
  /* 只有"闲聊式 episode"进缓冲；fact/preference/relation/skill 等结构化记忆直通，
     否则压缩成摘要会丢掉 fact_key / confidence / relations（冲突检测和语义索引会失效） */
  const structured = rec.kind && rec.kind !== 'episode';
  if (structured || rec.pin || imp >= 0.6) {
    await flushBuffer(owner, llm);          // 先把旧闲聊冲掉，保证重要内容立即可召回
    return { action: 'direct' };
  }
  const b = bufOf(owner);
  b.items.push({ ...rec, episodeId, at: now });
  b.chars += String(rec.text || '').length;
  if (!b.firstAt) b.firstAt = now;
  if (b.items.length >= CFG.maxItems || b.chars >= CFG.maxChars) {
    const mem = await flushBuffer(owner, llm, now);
    return { action: 'flushed', memory: mem };
  }
  return { action: 'buffered' };
}

/** 压缩缓冲：LLM 摘要优先，失败回退拼接。返回新插入的记忆（或 null 空缓冲）。 */
export async function flushBuffer(owner = 'global', llm = null, now = Date.now()) {
  const b = buffers.get(owner);
  if (!b || !b.items.length) return null;
  const items = b.items.splice(0, b.items.length);
  b.chars = 0; b.firstAt = 0;

  const texts = items.map((it) => `- ${it.text}`);
  let summary = '';
  if (llm && llm.apiKey) {
    try {
      const res = await fetch(String(llm.baseUrl).replace(/\/+$/, '') + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + llm.apiKey },
        body: JSON.stringify({
          model: llm.model || 'deepseek-chat',
          messages: [
            { role: 'system', content: '你是记忆压缩器。把一组对话要点合并成一条摘要，只输出 JSON。' },
            { role: 'user', content: `把以下要点合并成一条不超过 80 字的中文摘要（保留具体人名/事实，去掉寒暄）：\n${texts.join('\n')}\n\n只输出 JSON：{"summary":"..."}` },
          ],
          temperature: 0.2, max_tokens: 200,
          signal: AbortSignal.timeout(20000),
        }),
      });
      const out = await res.json();
      const raw = out?.choices?.[0]?.message?.content || '';
      const m = raw.match(/\{[\s\S]*\}/);
      if (m) summary = String((JSON.parse(m[0]).summary) || '').slice(0, 300);
    } catch { summary = ''; }
  }
  if (!summary) {
    summary = items.map((it) => it.text).join('；').slice(0, 780);
  }

  const lastEp = items.map((it) => it.episodeId).filter(Boolean).pop();
  const entities = [...new Set(items.flatMap((it) => it.entities || []))].slice(0, 12);
  const importance = Math.min(0.6, Math.max(...items.map((it) => Number(it.importance) || 0.4)) + 0.05);
  const hour = new Date(now).toISOString().slice(11, 16);
  const mem = store.insertMemory({
    text: `【${hour} 会话摘要】${summary}`,
    kind: 'episode',
    importance,
    entities,
    owner,
    visibility: owner.startsWith('g:') ? 'group' : 'private',
    source: 'buffer',
    evidence: lastEp ? { episode_id: lastEp, snippet: items[items.length - 1].text.slice(0, 80) } : null,
    meta: {
      summary: true,
      source_ids: items.map((it) => it.episodeId).filter(Boolean),
      item_count: items.length,
    },
  });
  store.audit('buffer_flushed', { owner, items: items.length, id: mem.id, llm: !!summary && !summary.startsWith('【会话摘要】') });
  return mem;
}

/** 退出时全部冲掉（异步版：SIGINT/SIGTERM 用） */
export async function flushAll(llm = null) {
  for (const owner of [...buffers.keys()]) {
    try { await flushBuffer(owner, llm); } catch { /* 退出时不阻断 */ }
  }
}

/** 退出兜底：同步把缓冲拼成摘要入库，不依赖网络/微任务（process 'exit' 用） */
export function flushAllSync(now = Date.now()) {
  for (const [owner, b] of [...buffers.entries()]) {
    if (!b.items.length) continue;
    const items = b.items.splice(0, b.items.length);
    b.chars = 0; b.firstAt = 0;
    try {
      const summary = items.map((it) => it.text).join('；').slice(0, 780);
      const lastEp = items.map((it) => it.episodeId).filter(Boolean).pop();
      store.insertMemory({
        text: `【${new Date(now).toISOString().slice(11, 16)} 会话摘要】${summary}`,
        kind: 'episode',
        importance: Math.min(0.6, Math.max(...items.map((it) => Number(it.importance) || 0.4)) + 0.05),
        entities: [...new Set(items.flatMap((it) => it.entities || []))].slice(0, 12),
        owner,
        visibility: owner.startsWith('g:') ? 'group' : 'private',
        source: 'buffer',
        evidence: lastEp ? { episode_id: lastEp, snippet: items[items.length - 1].text.slice(0, 80) } : null,
        meta: { summary: true, source_ids: items.map((it) => it.episodeId).filter(Boolean), item_count: items.length },
      });
    } catch { /* 退出路径不抛错 */ }
  }
}
export function pendingCount() {
  let n = 0;
  for (const b of buffers.values()) n += b.items.length;
  return n;
}
