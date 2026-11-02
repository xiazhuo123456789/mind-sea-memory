/* ============================================================
 * state.mjs —— L4 实时状态层（借 Diez 激素思想 + memory-brain P1-5 的最小闭环，原创重写）
 *
 * 三个维度（0-1）：intimacy 亲密 / stress 压力 / energy 精力
 *   · 每次交互（tick）：按流逝时间向基线回落（半衰期 45 分钟），再叠加文本刺激
 *   · 刺激来自规则词命中，单轮每维最多 ±0.2，绝不主导判断
 *   · 输出：情绪标签 + 3 个行为倾向（话量/黏人度/主动性）——只做注入 hint，
 *     不改记忆事实（情绪不否决记忆）
 * 每个 owner 独立一份（关系是按人的）；可查看、可重置，全程审计。
 * ============================================================ */
'use strict';

import * as store from './store.mjs';

const BASE = { intimacy: 0.3, stress: 0.2, energy: 0.7 };
const HALF_LIFE_MS = 45 * 60e3;          // 回落半衰期 45 分钟
const MAX_STEP = 0.2;                    // 单轮每维最大变化

const STIMULUS = [
  { dim: 'stress', re: /(烦|压力|焦虑|忙|赶工|加班|吵架|生气| deadline|催|deadline|崩溃|难受)/gi, k: 0.1 },
  { dim: 'intimacy', re: /(想你|爱你|抱抱|亲亲|喜欢你|陪你|在一起|开心|哈哈|谢谢)/gi, k: 0.08 },
  { dim: 'energy', re: /(困|累|熬夜|瞌睡|深夜|撑不住)/gi, k: -0.12 },
  { dim: 'energy', re: /(睡醒|休息好了|精神|周末|放假)/gi, k: 0.1 },
];

const clamp01 = (v) => Math.max(0, Math.min(1, v));

/** owner 归一化：调用方可能传 qq:10001 / u:qq:10001 / g:888 / global，统一成一种键 */
function normOwner(o) {
  const v = String(o || '').trim();
  if (!v) return 'global';
  if (v === 'global' || v.startsWith('u:') || v.startsWith('g:')) return v;
  return 'u:' + v;
}

function moodMap() {
  const s = store.load();
  if (!s.moods || typeof s.moods !== 'object') s.moods = {};
  return s.moods;
}

function decay(dims, elapsed) {
  const halves = elapsed / HALF_LIFE_MS;
  for (const k of Object.keys(BASE)) {
    const d = dims[k] - BASE[k];
    dims[k] = +clamp01(dims[k] - d * (1 - Math.pow(0.5, halves))).toFixed(4);
  }
}

function applyStimulus(dims, text) {
  let hit = 0;
  const s = String(text || '');
  for (const st of STIMULUS) {
    const m = s.match(st.re);
    if (!m) continue;
    hit++;
    const delta = Math.max(-MAX_STEP, Math.min(MAX_STEP, st.k));
    dims[st.dim] = clamp01(dims[st.dim] + delta);
  }
  return hit;
}

export function emotionLabel(d) {
  if (d.stress >= 0.6) return '紧绷';
  if (d.energy < 0.3) return '倦';
  if (d.stress >= 0.4) return '有些压力';
  if (d.intimacy >= 0.6) return '亲昵';
  if (d.intimacy >= 0.45) return '亲近';
  if (d.energy >= 0.8) return '精神';
  return '平稳';
}

export function tendencies(d) {
  return {
    话量: +(0.4 + 0.4 * d.energy + 0.2 * (1 - d.stress)).toFixed(2),
    黏人度: +(0.1 + 0.8 * d.intimacy).toFixed(2),
    主动性: +(d.energy * (1 - d.stress * 0.5)).toFixed(2),
  };
}

/** 交互时调用：回落 + 叠加刺激 + 持久化。返回当前状态。 */
export function tickState(owner = 'global', text = '', now = Date.now()) {
  owner = normOwner(owner);
  const moods = moodMap();
  const cur = moods[owner] || { dims: { ...BASE }, updatedAt: now };
  decay(cur.dims, Math.max(0, now - (cur.updatedAt || now)));
  applyStimulus(cur.dims, text);
  cur.updatedAt = now;
  moods[owner] = cur;
  store.save();
  store.audit('state_tick', { owner, dims: cur.dims, label: emotionLabel(cur.dims) });
  return view(owner, now);
}

/** 只读：回落到当前时刻并返回，不叠加刺激、不写审计 */
export function view(owner = 'global', now = Date.now()) {
  owner = normOwner(owner);
  const moods = moodMap();
  const cur = moods[owner] || { dims: { ...BASE }, updatedAt: now };
  decay(cur.dims, Math.max(0, now - (cur.updatedAt || now)));
  cur.updatedAt = now;
  return {
    owner,
    dims: { ...cur.dims },
    label: emotionLabel(cur.dims),
    tendencies: tendencies(cur.dims),
    updatedAt: cur.updatedAt,
  };
}

export function resetState(owner = 'global', now = Date.now()) {
  owner = normOwner(owner);
  const moods = moodMap();
  moods[owner] = { dims: { ...BASE }, updatedAt: now };
  store.save();
  store.audit('state_reset', { owner });
  return view(owner, now);
}
