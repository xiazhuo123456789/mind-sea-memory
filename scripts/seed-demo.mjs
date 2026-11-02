#!/usr/bin/env node
/* ============================================================
 * seed-demo.mjs —— 演示数据生成器（先"看看效果"用）
 *
 *   node scripts/seed-demo.mjs 3000      生成 3000 条记忆（默认 3000）
 *   node scripts/seed-demo.mjs 800       小一点
 *
 * 直接写 data/brain.json（与 store 的 schema 完全一致），需要重启服务生效。
 * 特点：
 *   · created_at 分布在过去 365 天（留存度有层次，星海有明暗）
 *   · owners 混合：主人私聊 / 两个群 / 全局
 *   · 实体成簇（团子、小美、三体、开黑…），星海会自然聚成星团
 *   · 内置 3 组事实冲突（记忆体检有待裁决项）+ 8 条承诺（2 条逾期）
 *   · 少量 pin / digest / archived
 * 使用确定性随机（固定种子），每次生成的数据一致。
 * ============================================================ */
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.MEMORY_DATA_DIR
  ? path.resolve(process.env.MEMORY_DATA_DIR)
  : path.join(path.dirname(HERE), 'data');

/* 确定性随机 */
let seed = 20261031;
function rng() {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
}
const ri = (a, b) => a + Math.floor(rng() * (b - a + 1));
const pick = (a) => a[Math.floor(rng() * a.length)];
const chance = (p) => rng() < p;

const NOW = Date.now();
const DAY = 86400000;

const NAMES = ['小美', '老王', '阿杰', '小雨', '大壮', '琳琳', 'Kevin', '芳姐', '小鹿', '老K'];
const PETS = ['团子', '煤球', '雪球', '奥利奥', '年糕'];
const ANIMALS = ['橘猫', '英短', '柯基', '金毛', '鹦鹉'];
const CITIES = ['杭州', '上海', '成都', '广州', '北京', '深圳', '武汉'];
const BOOKS = ['《三体》', '《活着》', '《百年孤独》', '《小王子》', '《月亮与六便士》'];
const GAMES = ['王者荣耀', '原神', 'CS2', '双人成行', '塞尔达'];
const FOODS = ['火锅', '烧烤', '日料', '麻辣烫', '螺蛳粉', '粤式早茶'];
const HOBBIES = ['吉他', '摄影', '滑雪', '篮球', '骑行', '钓鱼', '桌游', '天文观测'];
const PLACES = ['西湖', '外滩', '春熙路', '白云山', '后海', ' frequencies'];
const TOPICS = ['AI', '股票', '健身', '考研', '婚礼', '装修', '旅行', '播客'];

const KINDS = [
  { kind: 'episode', w: 0.34 },
  { kind: 'fact', w: 0.26 },
  { kind: 'preference', w: 0.14 },
  { kind: 'relation', w: 0.08 },
  { kind: 'skill', w: 0.06 },
  { kind: 'hypothesis', w: 0.07 },
  { kind: 'digest', w: 0.05 },
];

function genText(kind) {
  const name = pick(NAMES);
  const pet = pick(PETS);
  const animal = pick(ANIMALS);
  const city = pick(CITIES);
  const book = pick(BOOKS);
  const game = pick(GAMES);
  const food = pick(FOODS);
  const hobby = pick(HOBBIES);
  const n = ri(2, 40);
  switch (kind) {
    case 'fact': return pick([
      `${name}养了一只叫${pet}的${animal}，${chance(.5) ? '很粘人' : '特别闹腾'}`,
      `${name}住在${city}${pick(['，离地铁很近', '，老小区没电梯', '，窗外就是江景', ''])}`,
      `${name}最近在读${book}，读到第${n > 20 ? '三' : '二'}部了`,
      `${name}在${pick(['一家游戏公司', '银行', '自己创业', '一家设计工作室'])}上班，${pick(['经常加班', '最近在赶项目', '准备跳槽'])}`,
      `${name}${chance(.5) ? '周三' : '周六'}都要去${pick(['打球', '游泳', '爬山'])}`,
    ]);
    case 'preference': return pick([
      `${name}不吃${pick(['香菜', '芹菜', '榴莲', '苦瓜'])}，闻到就难受`,
      `${name}更喜欢${pick(['拿铁', '美式', '茶'])}，不太喝果汁`,
      `${name}说${pick(['恐怖片', '恋爱综艺', '足球直播'])}最无聊，从来不看`,
      `${name}喜欢${pick(['蓝色', '绿色', '暖黄色'])}系的东西`,
    ]);
    case 'relation': return pick([
      `${name}和${pick(NAMES)}是大学室友，关系很铁`,
      `${pick(NAMES)}是${name}的表妹，在${city}读高中`,
      `${name}和${pick(NAMES)}是同事，一个组做项目的`,
    ]);
    case 'skill': return pick([
      `${name}说"困了"的时候，应该劝他睡觉而不是继续聊`,
      `${name}不喜欢被催，提醒事情要一次说完`,
      `群里的老K擅长修电脑，电脑问题可以@他`,
      `他喜欢的歌应该存到歌单，而不是每次都问`,
    ]);
    case 'hypothesis': return pick([
      `我猜${name}最近压力大，语气比平时冲`,
      `他可能要换工作了，最近总提到面试`,
      `${name}和${pick(NAMES)}好像闹矛盾了，三天没互动`,
    ]);
    case 'digest': return `【昨日三件事】${name}聊了${pick(GAMES)}新版本；群里约了周末${pick(['爬山', '桌游', '聚餐'])}；${pick(['有人在找合租室友', '老王晒了新车', '群里讨论了新番'])}。`;
    default: return pick([
      `${n}月${ri(1, 28)}日和${name}在${city}吃了${food}，聊到打烊`,
      `周五晚上九点和${name}他们约好一起打${game}`,
      `${name}把${pick(['猫粮', '快递', '合同', '充电器'])}落在${pick(['公司', '出租车', '我家'])}了`,
      `群里讨论了${pick(TOPICS)}，${name}观点很犀利`,
      `${name}${pick(['生日', '入职纪念日', '搬新家'])}快到了，记得${pick(['准备礼物', '发个祝福', '订个蛋糕'])}`,
      `和${name}在${pick(PLACES)}散步，聊了很多${pick(['工作', '未来', '往事'])}`,
      `${name}说${pick(['最近在学' + hobby, '打算入手' + hobby + '装备', '周末去' + pick(['漫展', '音乐节', '市集'])])}`,
    ]);
  }
}

function genEntities(kind, text) {
  const out = [];
  for (const n of NAMES) if (text.includes(n)) out.push(n);
  for (const p of PETS) if (text.includes(p)) out.push(p);
  for (const b of BOOKS) if (text.includes(b)) out.push(b.replace(/[《》]/g, ''));
  for (const g of GAMES) if (text.includes(g)) out.push(g);
  for (const f of FOODS) if (text.includes(f)) out.push(f);
  for (const c of CITIES) if (text.includes(c)) out.push(c);
  for (const h of HOBBIES) if (text.includes(h)) out.push(h);
  if (!out.length) out.push(pick(['日常', '群聊', '心情']));
  return [...new Set(out)].slice(0, 4);
}

function main() {
  const target = Math.max(100, Math.min(8000, Number(process.argv[2]) || 3000));
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const memories = [];
  let seq = 0;
  const owners = [
    { owner: 'u:qq:10001', visibility: 'private', w: 0.5 },
    { owner: 'g:888', visibility: 'group', w: 0.22 },
    { owner: 'g:777', visibility: 'group', w: 0.10 },
    { owner: 'global', visibility: 'public', w: 0.18 },
  ];
  const pickOwner = () => {
    const r = rng();
    let acc = 0;
    for (const o of owners) { acc += o.w; if (r <= acc) return o; }
    return owners[0];
  };

  const byKindAcc = {};
  for (let i = 0; i < target; i++) {
    /* kind 按权重 */
    const r = rng();
    let acc = 0, kind = 'episode';
    for (const k of KINDS) { acc += k.w; if (r <= acc) { kind = k.kind; break; } }
    byKindAcc[kind] = (byKindAcc[kind] || 0) + 1;

    const who = pickOwner();
    const text = genText(kind);
    const created = NOW - Math.floor(Math.pow(rng(), 1.4) * 365 * DAY) - ri(0, DAY / 2);
    const hits = chance(0.35) ? ri(1, 14) : 0;
    const lastHit = hits ? created + Math.floor(rng() * (NOW - created)) : created;
    const pin = chance(0.012);
    seq += 1;
    memories.push({
      id: 'm' + String(seq).padStart(6, '0'),
      owner: who.owner,
      visibility: who.visibility,
      kind,
      text,
      importance: +(pin ? 1 : 0.2 + rng() * 0.7).toFixed(3),
      valence: +((rng() * 2 - 1) * 0.7).toFixed(3),
      arousal: +(rng() * 0.6).toFixed(3),
      entities: genEntities(kind, text),
      pin,
      status: chance(0.06) ? 'archived' : 'active',
      source: chance(0.85) ? 'auto' : 'manual',
      created_at: created,
      last_hit: lastHit,
      hits,
      meta: {},
      archived_at: 0,
    });
  }

  /* 三组事实冲突（记忆体检的"待裁决"有东西可看） */
  const conflictGroups = [
    { key: 'home.city', old: '他住在杭州，公司也在杭州', neo: '他搬到上海了，上周刚安顿好', owner: 'u:qq:10001', vis: 'private' },
    { key: 'pet.name', old: '他的猫叫团子', neo: '他的猫改名了，现在叫煤球', owner: 'global', vis: 'public' },
    { key: 'game.main', old: '他主玩王者荣耀', neo: '他现在主玩CS2，王者退坑了', owner: 'g:888', vis: 'group' },
  ];
  let conflictSeq = 0;
  const conflicts = [];
  for (const g of conflictGroups) {
    const oldId = 'm' + String(++seq).padStart(6, '0');
    const newId = 'm' + String(++seq).padStart(6, '0');
    memories.push({
      id: oldId, owner: g.owner, visibility: g.vis, kind: 'fact', text: g.old,
      importance: 0.7, valence: 0, arousal: 0, entities: [], pin: false,
      status: 'active', source: 'auto', created_at: NOW - 200 * DAY,
      last_hit: NOW - 60 * DAY, hits: 3, meta: { fact_key: g.key }, archived_at: 0,
    });
    memories.push({
      id: newId, owner: g.owner, visibility: g.vis, kind: 'fact', text: g.neo,
      importance: 0.75, valence: 0.1, arousal: 0.2, entities: [], pin: false,
      status: 'active', source: 'auto', created_at: NOW - 10 * DAY,
      last_hit: NOW - 2 * DAY, hits: 1, meta: { fact_key: g.key }, archived_at: 0,
    });
    conflicts.push({
      id: 'c' + String(++conflictSeq).padStart(3, '0'),
      fact_key: g.key, owner: g.owner,
      old_id: oldId, new_id: newId,
      status: 'pending', created_at: NOW - 2 * DAY,
    });
  }

  /* 承诺账本：8 条，2 条逾期，1 条已完成 */
  const intents = [
    { id: 'i001', text: '周五晚九点组织开黑', due_at: NOW + 2 * DAY, status: 'open', created_at: NOW - 3 * DAY, meta: {} },
    { id: 'i002', text: '帮老王查餐厅评价', due_at: NOW - 1 * DAY, status: 'open', created_at: NOW - 2 * DAY, meta: {} },
    { id: 'i003', text: '把团子的照片发给小美', due_at: NOW - 4 * DAY, status: 'open', created_at: NOW - 5 * DAY, meta: {} },
    { id: 'i004', text: '提醒小美还书', due_at: NOW + 5 * DAY, status: 'open', created_at: NOW - 1 * DAY, meta: {} },
    { id: 'i005', text: '群里发周末爬山接龙', due_at: null, status: 'open', created_at: NOW - 6 * DAY, meta: {} },
    { id: 'i006', text: '记下老K的生日', due_at: null, status: 'open', created_at: NOW - 8 * DAY, meta: {} },
    { id: 'i007', text: '把上周的账单算清楚', due_at: NOW - 3 * DAY, status: 'resolved', outcome: 'done', created_at: NOW - 9 * DAY, meta: {} },
    { id: 'i008', text: '给小美推荐播客', due_at: null, status: 'resolved', outcome: 'done', created_at: NOW - 12 * DAY, meta: {} },
  ];

  /* 实体聚合 */
  const entities = {};
  for (const m of memories) {
    for (const e of m.entities) {
      const key = String(e);
      const en = entities[key] || (entities[key] = { type: 'thing', count: 0, first: m.created_at, last: m.created_at, aliases: [] });
      en.count += 1;
      en.last = Math.max(en.last, m.created_at);
      if (NAMES.includes(key)) en.type = 'person';
    }
  }

  /* 汇总统计 */
  const active = memories.filter((m) => m.status === 'active');
  const state = {
    version: 1,
    createdAt: new Date(NOW - 400 * DAY).toISOString(),
    seq,
    memories,
    entities,
    relations: [],
    conflicts,
    intents,
    stats: {
      added: memories.length,
      hits: memories.reduce((a, m) => a + m.hits, 0),
      archived: memories.length - active.length,
      merged: 0, purged: 0, forgotten: 0,
    },
  };

  fs.writeFileSync(path.join(DATA_DIR, 'brain.json'), JSON.stringify(state));
  for (const f of ['episodes.jsonl', 'digests.jsonl']) {
    try { fs.rmSync(path.join(DATA_DIR, f)); } catch { /* 忽略 */ }
  }

  const byKind = {}, byOwner = {};
  for (const m of memories) {
    byKind[m.kind] = (byKind[m.kind] || 0) + 1;
    byOwner[m.owner] = (byOwner[m.owner] || 0) + 1;
  }
  console.log('✅ 演示数据已生成 →', path.join(DATA_DIR, 'brain.json'));
  console.log('   记忆:', memories.length, '条（活跃', active.length, '/ 归档', memories.length - active.length, '）');
  console.log('   实体:', Object.keys(entities).length, '· 冲突组:', conflicts.length, '· 承诺:', intents.length);
  console.log('   分布:', JSON.stringify({ byKind, byOwner }));
  console.log('   重启服务后生效：node server.mjs');
}

main();
