/* ============================================================
 * intent.mjs —— 意图账本闭环（借 memory-brain 的提醒解析/工作记忆思路，原创重写）
 *
 * 解决两个旧缺口：
 *   ① 承诺必须手动建 → 从对话里自动认领（"别忘了…""答应…""明天要交…"）
 *   ② 做完了要手动标 → 自动检测完成词并闭环（"搞定了""发过去了"）
 * 中文时间解析：明天/后天/大后天/今晚/明早/周几/下周几/几点半/N小时后/N天后…
 * 解析不到时间也会建"无截止"待办，只是不参与到期提醒。
 * ============================================================ */
'use strict';

import * as store from './store.mjs';

const DAY = 86400000;
const WEEKDAYS = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 };

function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
function atHour(dayStart, h, m = 0) {
  return dayStart + h * 3600e3 + m * 60e3;
}

/**
 * parseChineseTime(text, now) → { at, label } | null
 * 只解析"未来"的时间；解析不到返回 null。
 */
export function parseChineseTime(text, now = Date.now()) {
  const s = String(text || '');
  const today = startOfDay(now);
  let dayStart = null;
  let label = '';
  let isWeekday = false;
  const partOfDay = /(凌晨|早上|早晨|上午)/.test(s) ? 'am'
    : /(中午)/.test(s) ? 'noon'
    : /(下午|傍晚)/.test(s) ? 'pm'
    : /(晚上|今晚|夜里)/.test(s) ? 'eve' : '';

  /* 相对时间优先：N 分钟后 / N 小时后 / N 天后 */
  let m = s.match(/(\d{1,3})\s*(分钟|分|小时|钟头|天|周|个?星期)\s*(?:之?后|以后)/);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2];
    const ms = /分钟|分/.test(unit) ? n * 60e3
      : /小时|钟头/.test(unit) ? n * 3600e3
        : /天/.test(unit) ? n * DAY
          : n * 7 * DAY;
    return { at: now + ms, label: `${n}${unit}后` };
  }

  /* 日期词 */
  if (/(大后天)/.test(s)) { dayStart = today + 3 * DAY; label = '大后天'; }
  else if (/(后天)/.test(s)) { dayStart = today + 2 * DAY; label = '后天'; }
  else if (/(明天|明日)/.test(s)) { dayStart = today + DAY; label = '明天'; }
  else if (/(今晚)/.test(s)) { dayStart = today; label = '今晚'; }
  else if (/(今天|今日)/.test(s)) { dayStart = today; label = '今天'; }
  else {
    /* 周几 / 下周几 */
    const w = s.match(/(下)?(?:周|星期|礼拜)([一二三四五六日天])/);
    if (w) {
      const target = WEEKDAYS[w[2]];
      const todayDow = new Date(today).getDay();
      let delta = (target - todayDow + 7) % 7;
      if (w[1]) delta += delta === 0 ? 7 : 7;   // 下周X：至少 7 天后
      dayStart = today + delta * DAY;
      isWeekday = true;
      label = (w[1] ? '下' : '') + '周' + w[2];
    }
  }
  if (dayStart == null) return null;

  /* 具体钟点：8点 / 8点半 / 8点30分 / 两点 / 十一点 */
  const CN_NUM = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12 };
  const hm = s.match(/(\d{1,2}|十[一二]?|[一二两三四五六七八九])\s*[点時时](?:\s*(半|(\d{1,2})\s*分?))?/);
  let hour = null, minute = 0;
  if (hm) {
    hour = /^\d+$/.test(hm[1]) ? Number(hm[1]) : (CN_NUM[hm[1]] ?? null);
    if (hour == null) { hour = null; }
    if (hm[2] === '半') minute = 30;
    else if (hm[3]) minute = Number(hm[3]);
    if (partOfDay === 'pm' && hour < 12) hour += 12;
    if (partOfDay === 'eve' && hour < 12) hour += 12;
    if (partOfDay === 'noon' && hour < 11) hour += 12;
    if (hour >= 24) hour = hour % 24;
    label += `${hour}点${minute ? minute + '分' : ''}`;
  } else {
    hour = partOfDay === 'am' ? 9
      : partOfDay === 'noon' ? 12
        : partOfDay === 'pm' ? 15
          : partOfDay === 'eve' ? 20
            : 9;   // 只有日期：默认当天 9 点
    label += (partOfDay && !/(今晚)/.test(s) ? '' : '') + `${hour}点`;
  }
  let at = atHour(dayStart, hour, minute);
  /* 解析到过去的时间（如"今天8点"已过）→ 顺延。周几要顺延整整一周，
     否则"周三"在周三下午会被推成周四（Bug 修复 2026-11-01） */
  if (at <= now) at += isWeekday ? 7 * DAY : DAY;
  return { at, label };
}

/* ---------------- 承诺认领 ---------------- */
/* 强承诺标记：出现这些词基本就是在交代"以后要做的事" */
const PROMISE_MARK = /(别忘了|别忘记|记得帮我|帮我记|提醒我|答应|说好|说好了|待会|待会儿|回头|马上要|得去|要去|要交|得交|要写|得写|要买|得买|要订|得订|要约|得约|要还|得还|要做完|得做完)/;
/* 时间 + 任务动词的组合也算承诺（"明天下午三点交报告"） */
const TASK_VERB = /(交|做|去|见|开会|面试|发|买|订|约|还|写|准备|复习|体检|考试|生日|报名|付款|转账|取|送|接)/;
/* 过去回忆不算承诺（"我记得你爱吃香菜"） */
const PAST_RECALL = /^(我)?(还)?记得|^我印象|^上次|^之前|^以前/;

/** detectPromise(text, now) → { text, due_at, due_label } | null */
export function detectPromise(text, now = Date.now()) {
  const s = String(text || '').trim();
  if (!s || s.length < 4) return null;
  const hasMark = PROMISE_MARK.test(s);
  const t = parseChineseTime(s, now);
  const hasTaskTime = !!t && TASK_VERB.test(s);
  if (!hasMark && !hasTaskTime) return null;
  if (!hasMark && PAST_RECALL.test(s)) return null;
  return {
    text: s.slice(0, 300),
    due_at: t ? t.at : null,
    due_label: t ? t.label : '',
  };
}

/* ---------------- 完成检测 ---------------- */
const DONE_MARK = /(好了|弄好了|弄完了|搞定了|搞完|办好了|完成了|做完了|发过去了|发了|交了|考完了|已经做完|已经弄好|搞定了|ok了|OK了)/;

export function detectCompletion(text) {
  const s = String(text || '');
  if (!DONE_MARK.test(s)) return false;
  /* "还没做完/没搞定/没交" 不算完成 */
  if (/(还没|没有|没|未)(弄|做|搞|办|发|交|完成)|差一点|没搞定/.test(s)) return false;
  return true;
}

/* ---------------- 简单相似度（bigram Jaccard） ---------------- */
function grams(t) {
  const s = String(t || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const out = new Set();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}
function sim(a, b) {
  const ga = grams(a), gb = grams(b);
  if (!ga.size || !gb.size) return 0;
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter++;
  return inter / Math.min(ga.size, gb.size);
}
/* 字符级相似度：用于"完成检测"——"报告交了"对"明天三点交报告"这种改写，
   bigram 太严（只共享"报告"），字符级能抓住 报/告/交 */
function charSim(a, b) {
  const strip = (t) => String(t || '').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .replace(/[的了呢啊呀吗吧哦嗯我已你他她它都也还就]/g, '');
  const A = new Set([...strip(a)]), B = new Set([...strip(b)]);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const c of A) if (B.has(c)) inter++;
  return inter / Math.min(A.size, B.size);
}

/**
 * linkIntent({ owner, text, now }) —— 写入记忆时顺带维护意图账本
 *   完成词命中 + 有相似的未闭环承诺 → 标记 fulfilled
 *   承诺标记命中 + 无重复 → 新建意图（能解析出时间就带 due_at）
 */
export function linkIntent({ owner = 'global', text = '', now = Date.now() } = {}) {
  const s = store.load();
  const open = (s.intents || []).filter((t) => t.owner === owner && t.status !== 'resolved');

  if (detectCompletion(text)) {
    /* 匹配完成对象：字符相似度 + 内容 bigram 交集（"报告搞定了"对"明天交报告"要能对上） */
    const gt = grams(text);
    const hit = open.map((t) => {
      const gs = grams(t.text);
      let inter = 0;
      for (const g of gs) if (gt.has(g)) inter++;
      return { t, inter, sim: charSim(t.text, text) };
    })
      .filter((x) => (x.inter >= 1 && x.sim >= 0.25) || x.sim >= 0.5)
      .sort((a, b) => b.sim - a.sim || b.inter - a.inter)[0];
    if (hit) {
      const r = store.resolveIntent(hit.t.id, 'fulfilled', String(text).slice(0, 200));
      return { action: 'resolved', intent: r, sim: +hit.sim.toFixed(2) };
    }
  }

  const p = detectPromise(text, now);
  if (!p) return { action: 'none' };
  const dup = open.find((t) => sim(t.text, p.text) >= 0.7);
  if (dup) return { action: 'duplicate', intent: dup };
  const intent = store.addIntent({
    text: p.text,
    owner,
    due_at: p.due_at,
    evidence_hint: p.due_label,
  });
  return { action: 'created', intent };
}
