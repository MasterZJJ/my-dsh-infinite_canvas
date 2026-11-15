#!/usr/bin/env node
/**
 * 分镜整表 AI 补全回归（0.20.7-local.7）：「AI 补全全部分镜」按钮的补全口径。
 *
 * 断言五组：
 *   ① 音效硬清洗：任何镜头剥离背景音乐/配乐；**无台词镜再剥离一切人声**；
 *      画内声音（音乐盒/钢琴/钟铃）必须保留——那是拟音不是配乐。
 *   ② 合并保护：台词原文一字不改（AI 只补语气、绝不新增台词）、镜头时长与段类型不动
 *      （改了就打乱 4–10s 拆表与切段计划）、用户写过的标题保留、AI 没填的字段回落原值、
 *      数组字段不得降级成字符串。
 *   ③ 新字段落库：people（画面人数）/ blocking（人物占位）进归一化，不被清空。
 *   ④ 视频提示词：逐镜注入「画面人数」「人物占位」；无台词镜追加「不得出现任何人声」硬约束。
 *   ⑤ 提示词规则：AI 补全的 system 提示里必须同时含人数/占位/画面细节/音效四组规则（中文+英文）。
 *
 * 运行：node scripts/test-shot-ai-fill.mjs   退出码 0 = 通过；1 = 失败
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as HOST from '../shot-ai-fill.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(path.join(ROOT, 'client.js'), 'utf8');
const errs = [];
const ok = (c, m) => { if (!c) errs.push(m); };
const noop = () => {};

// ---------------- 假 React / DOM（与 test-combat-semantics 同套路） ----------------
function mkEl(type, props, ...kids) {
  return { __el: true, type, props: Object.assign({}, props || {}, { children: kids.length <= 1 ? kids[0] : kids }) };
}
const fakeReact = {
  createElement: mkEl,
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {}, useLayoutEffect: () => {}, useRef: (v) => ({ current: v }),
  useCallback: (f) => f, useMemo: (f) => f(),
};
const lsStub = {
  _m: new Map(),
  getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
  setItem(k, v) { this._m.set(k, String(v)); },
  removeItem(k) { this._m.delete(k); }, clear() { this._m.clear(); },
};
const sandbox = {
  window: {
    devicePixelRatio: 1, innerWidth: 1600, innerHeight: 900,
    addEventListener: noop, removeEventListener: noop,
    matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
    localStorage: lsStub, location: { href: 'http://localhost/' },
    AudioContext: undefined, webkitAudioContext: undefined, __DSH_IC_SMOKE__: true,
  },
  document: {
    createElement: () => ({ style: {}, dataset: {}, children: [], appendChild: noop, remove: noop, setAttribute: noop, addEventListener: noop, removeEventListener: noop, getBoundingClientRect: () => ({ left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }) }),
    addEventListener: noop, removeEventListener: noop, body: { appendChild: noop }, head: { appendChild: noop }, documentElement: { style: {} },
  },
  localStorage: lsStub, navigator: { language: 'zh-CN', userAgent: 'node' }, location: { href: 'http://localhost/' },
  setTimeout, clearTimeout, setInterval: (f) => setTimeout(f, 0), clearInterval: noop, queueMicrotask,
  fetch: () => Promise.reject(new Error('no-net')), console,
  performance: { now: () => Date.now() }, requestAnimationFrame: (f) => setTimeout(f, 0), cancelAnimationFrame: noop,
  TextEncoder, TextDecoder, URL, URLSearchParams, Promise, JSON, Math, Date, Number, String, Array, Object, Map, Set, Error, RegExp, parseInt, parseFloat, isNaN, isFinite, Buffer, Blob: class {},
};
sandbox.globalThis = sandbox;
sandbox.window.globalThis = sandbox.window;
vm.createContext(sandbox);
let mod = null;
sandbox.window.__ModuleLoader__ = { load(def) { mod = def; } };
try {
  vm.runInContext(src, sandbox, { filename: 'client.js' });
  const plugin = mod.factory((name) => { if (name === 'react') return fakeReact; throw new Error('意外 require: ' + name); });
  plugin.apply({ effect(fn) { fn(); }, locale: { register: noop, subscribe: () => () => {} }, slots: { inject(n, cb) { cb(); }, register: () => () => {} }, sidebarRightTabs: { register: () => () => {} } });
} catch (e) {
  console.error('✗ client.js 顶层执行失败：' + e.message);
  process.exit(1);
}
const FILL = sandbox.window.__DSH_IC_SHOTFILL__;
const PROMPT = sandbox.window.__DSH_IC_STORYBOARD_PROMPT__;
if (!FILL || typeof FILL.sanitizeSfx !== 'function') {
  console.error('✗ 未暴露 window.__DSH_IC_SHOTFILL__（分镜补全测试缝隙缺失）');
  process.exit(1);
}
const { sanitizeSfx, mergeFilledShot, normalizeEditedShot } = FILL;

// ---------------- ⑥ 漂移守卫：前端副本 vs 宿主模块必须逐字一致 ----------------
// 口径的单一事实源是 shot-ai-fill.js；client.js 里的副本由 scripts/sync-shot-ai-fill.mjs 注入。
// 两端漂移 = 用户点按钮和让 Agent 补全会得到不同的稿子——这是硬红线，测试必须红。
{
  // ⑥a 构建脚本自检：client.js 的注入区必须已是最新
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'sync-shot-ai-fill.mjs'), '--check'], { stdio: 'pipe' });
  } catch (e) {
    errs.push('漂移守卫：client.js 的分镜补全纯函数区与 shot-ai-fill.js 不一致（跑 node scripts/sync-shot-ai-fill.mjs）');
  }
  // ⑥b 行为一致：同一组 fixtures，两端输出必须逐字相同
  const shots = [
    {
      title: '镜1', duration: 4, seg: 'continuation', visual: '原文画面', motion: '原文动作',
      characters: ['苏妄'], scene: '老屋', props: ['手机'],
      dialogue: [{ role: '苏妄', line: '你终于来了' }], sfx: '风声',
    },
    {
      title: '场2 起身', duration: 2.5, seg: 'closeup', visual: '特写', motion: '推近',
      characters: ['苏妄', '王勃'], scene: '老屋', props: [],
      dialogue: [{ role: '苏妄', line: '你终于来了', tone: '低声' }], sfx: '雨声、背景音乐、人声',
    },
  ];
  const ai = {
    title: 'AI 标题', visual: '新画面', motion: '新动作', people: 2, blocking: '@苏妄@ 右侧前景',
    duration: 9, seg: 'scene_change', characters: [], scene: '', props: [],
    dialogue: [{ role: '苏妄', line: '你终于来了', tone: '低沉' }], sfx: '风声、背景音乐',
  };
  for (const zh of [true, false]) {
    const clientPrompt = FILL.buildFillPrompt({
      cur: shots[0], prev: null, next: shots[1], bibleText: HOST.bibleBlock({ worldview: '古代', characters: [{ name: '苏妄', desc: '青年' }] }),
      requirement: '不要露脸', nodeLabel: '场1 分镜表', zh,
    });
    const hostPrompt = HOST.buildFillPrompt({
      cur: shots[0], prev: null, next: shots[1], bibleText: HOST.bibleBlock({ worldview: '古代', characters: [{ name: '苏妄', desc: '青年' }] }),
      requirement: '不要露脸', nodeLabel: '场1 分镜表', zh,
    });
    ok(clientPrompt.system === hostPrompt.system, `漂移守卫：${zh ? '中文' : '英文'} system 提示词两端不一致`);
    ok(clientPrompt.user === hostPrompt.user, `漂移守卫：${zh ? '中文' : '英文'} user 提示词两端不一致`);
  }
  for (const [text, hasDlg] of [['雨打车顶、背景音乐、远处人声', false], ['音乐盒声、风声', true], ['配乐渐入', true]]) {
    ok(FILL.sanitizeSfx(text, hasDlg) === HOST.sanitizeSfx(text, hasDlg), '漂移守卫：音效清洗两端不一致（' + text + '）');
  }
  for (const [i, shot] of shots.entries()) {
    const a = FILL.mergeFilledShot(shot, ai, i, '镜');
    const b = HOST.mergeFilledShot(shot, ai, i, '镜');
    ok(JSON.stringify(a) === JSON.stringify(b), '漂移守卫：镜头合并两端不一致（' + shot.title + '）');
  }
  ok(FILL.isAutoTitle('镜3', '镜') === HOST.isAutoTitle('镜3', '镜'), '漂移守卫：自动标题判定两端不一致');
  ok(FILL.isAutoTitle('场2 起身', '镜') === HOST.isAutoTitle('场2 起身', '镜'), '漂移守卫：自动标题判定两端不一致（用户标题）');
}

// ---------------- ⑦ 宿主模块自测：JSON 解析 + 设定集块 ----------------
{
  const withFence = '```json\n{"title":"镜1","people":2}\n```';
  ok(HOST.parseShotJson(withFence).people === 2, '宿主解析：吃 ```json 围栏');
  ok(HOST.parseShotJson('好的，这是结果：{"title":"镜1"}').title === '镜1', '宿主解析：吃前后废话');
  ok(HOST.parseShotJson('{"a":{"b":1},"c":["x}"]}').c[0] === 'x}', '宿主解析：括号/字符串扫描正确');
  let threw = false;
  try { HOST.parseShotJson('完全不是 JSON'); } catch { threw = true; }
  ok(threw, '宿主解析：没有 JSON 时必须报错（不静默当空）');
  const bb = HOST.bibleBlock({ worldview: '古代', style: '写实', characters: [{ name: '苏妄', desc: '青年' }], scenes: [{ name: '老屋', desc: '木屋' }], props: [{ name: '手机', desc: '旧机' }] });
  ok(bb.includes('角色 苏妄：青年') && bb.includes('场景 老屋：木屋') && bb.includes('道具 手机：旧机'), '宿主：设定集块格式正确');
}

// ---------------- ① 音效硬清洗 ----------------
{
  ok(sanitizeSfx('雨打车顶、远处车流', true) === '雨打车顶、远处车流', '音效：有台词镜保留纯环境声');
  ok(!sanitizeSfx('雨打车顶、背景音乐舒缓', true).includes('背景音乐'), '音效：有台词镜也必须剥离背景音乐');
  ok(!sanitizeSfx('配乐渐入、风声', false).includes('配乐'), '音效：无台词镜剥离配乐');
  ok(!sanitizeSfx('远处人声交谈、空调嗡鸣', false).includes('人声'), '音效：无台词镜必须剥离人声');
  ok(sanitizeSfx('远处人声交谈、空调嗡鸣', true).includes('人声'), '音效：有台词镜的人声段不由清洗器删（交给提示词约束）');
  ok(sanitizeSfx('音乐盒声叮咚、鸟鸣', false).includes('音乐盒'), '音效：画内声音（音乐盒）必须保留，不是配乐');
  ok(sanitizeSfx('钢琴声、风声', false).includes('钢琴'), '音效：画内声音（钢琴）必须保留');
  ok(sanitizeSfx('bgm swell, wind', false).toLowerCase().indexOf('bgm') < 0, '音效：英文 BGM 也要剥离');
}

// ---------------- ② 合并保护 ----------------
{
  const orig = {
    title: '镜1', duration: 4, seg: 'continuation',
    visual: '原文画面', motion: '原文动作',
    characters: ['苏妄'], scene: '老屋', props: ['手机'],
    dialogue: [{ role: '苏妄', line: '你终于来了' }],
    sfx: '风声',
  };
  const ai = {
    title: 'AI 标题', visual: '新画面', motion: '新动作',
    people: 2, blocking: '@苏妄@ 右侧前景半身正面',
    duration: 9, seg: 'scene_change',
    characters: [], scene: '', props: [],
    dialogue: [{ role: '苏妄', line: '你终于来了', tone: '低沉压着气，尾音发虚' }, { role: '路人', line: 'AI 新编的台词' }],
    sfx: '风声、背景音乐',
  };
  const m = mergeFilledShot(orig, ai, 0);
  ok(m.duration === 4, '合并：镜头时长不动（AI 改 9 → 仍为 4），实际 ' + m.duration);
  ok(m.seg === 'continuation', '合并：段类型不动（AI 改 scene_change → 仍为 continuation）');
  ok(m.dialogue.length === 1, '合并：AI 新编的台词被丢弃，只留用户原文');
  ok(m.dialogue[0].line === '你终于来了', '合并：台词原文一字不改');
  ok(m.dialogue[0].tone === '低沉压着气，尾音发虚', '合并：AI 补的语气被吸收');
  ok(m.people === 2, '合并：人物人数取 AI 值');
  ok(String(m.blocking).includes('右侧前景'), '合并：人物占位取 AI 值');
  ok(!String(m.sfx).includes('背景音乐'), '合并：音效过清洗，背景音乐被剥离');
  ok(Array.isArray(m.characters) && m.characters.length === 1 && m.characters[0] === '苏妄', '合并：数组字段回落原值且不得降级成字符串');
  ok(Array.isArray(m.props) && m.props.length === 1, '合并：props 数组回落原值');
  ok(m.scene === '老屋', '合并：AI 没填的场景回落原值');
  // 用户写过的标题保留；自动标题（镜头N）允许被 AI 替换
  const named = mergeFilledShot({ ...orig, title: '场1 起身' }, ai, 0);
  ok(named.title === '场1 起身', '合并：用户写过的标题保留');
  const auto = mergeFilledShot(orig, ai, 0);
  ok(auto.title === 'AI 标题', '合并：自动标题允许被 AI 替换');
}

// ---------------- ③ 新字段落库 ----------------
{
  const n = normalizeEditedShot({ title: '镜1', duration: 3, visual: 'v', people: 2, blocking: '@A@ 左侧中景', characters: 'A、B' }, 0);
  ok(n.people === 2, '归一化：people 保留');
  ok(n.blocking === '@A@ 左侧中景', '归一化：blocking 保留');
  ok(Array.isArray(n.characters) && n.characters.length === 2, '归一化：characters 字符串仍拆成数组');
  const empty = normalizeEditedShot({ title: '镜1', duration: 3 }, 0);
  ok(empty.people === 0 && empty.blocking === '', '归一化：缺字段时为空，不臆造');
}

// ---------------- ④ 视频提示词注入 ----------------
if (PROMPT && typeof PROMPT.buildStoryboardVideoPrompt === 'function') {
  const sb = {
    data: {
      shots: [
        { title: '镜1', duration: 3, visual: '@苏妄@ 站在门口', motion: '推门', people: 2, blocking: '@苏妄@ 右侧前景；@王勃@ 左侧中景', dialogue: [{ role: '苏妄', line: '你终于来了', tone: '低声' }], sfx: '风声' },
        { title: '镜2', duration: 2, visual: '空荡的走廊', motion: '横移', people: 0, dialogue: [], sfx: '远处车流' },
      ],
    },
  };
  const p = PROMPT.buildStoryboardVideoPrompt(sb, null);
  ok(p.includes('画面人数：共 2 人'), '视频提示词：注入画面人数');
  ok(p.includes('人物占位：'), '视频提示词：注入人物占位');
  ok(p.includes('不得出现任何人声'), '视频提示词：无台词镜追加禁人声硬约束');
  ok(p.includes('严禁背景音乐'), '视频提示词：段级禁背景音乐仍在');
}

// ---------------- ⑤ 提示词规则 ----------------
{
  ok(src.includes('人数（必须）'), '提示词：人数规则存在');
  ok(src.includes('占位（必须）'), '提示词：占位规则存在');
  ok(src.includes('画面细节（必须）'), '提示词：画面细节规则存在');
  ok(src.includes('音效（硬性）'), '提示词：音效硬规则存在');
  ok(src.includes('绝不允许出现任何人的说话声'), '提示词：无台词镜禁人声规则存在');
  ok(src.includes('People (required)'), '提示词：英文人数规则存在');
  ok(src.includes('Blocking (required)'), '提示词：英文占位规则存在');
  ok(src.includes('"people":2'), '提示词：JSON 形状含 people');
  ok(src.includes('"blocking":"…"'), '提示词：JSON 形状含 blocking');
  ok(src.includes('AI 补全全部分镜'), '文案：按钮文案存在');
  ok(src.includes("'aiFillBoardHint'"), '文案：按钮提示存在');
}

if (errs.length) {
  console.error('✗ 分镜整表补全回归失败（' + errs.length + ' 条）：');
  for (const e of errs) console.error('  · ' + e);
  process.exit(1);
}
console.log('✓ 分镜整表 AI 补全回归通过（音效清洗 / 合并保护 / 新字段 / 提示词注入 / 规则文案）');
