#!/usr/bin/env node
/**
 * 「换 IP / 换设备 / 换浏览器 = 新来源 → 数据看起来没了」回归测试（dev-only）：
 *
 * 背景：localStorage 按**来源**（协议+主机+端口）隔离。本机换 IP 后浏览器是新来源 = 空仓，
 * 于是「供应商 / API Key / 星标模型 / 角色库 / 工作流」全部消失（项目与资产在宿主，不受影响）。
 * 用户看到的就是「换了 IP，无限画布的数据就没办法正常访问」。
 *
 * 本测试在一个**空 localStorage** 的假浏览器里，对「有数据」的假宿主跑真实代码：
 *   ① hydrateUiState：宿主侧的设置/角色库/工作流必须被回填进本地（loadSettings 立刻可用）
 *   ② hostSyncTick：项目列表必须从宿主拉回（画布数据不因换来源丢失）
 *   ③ 保存 → 防抖回写：saveSettings 之后宿主必须收到 uiStateSet（下次换来源还能读回）
 *   ④ 宿主 uiStateSet 的「落后写入拒收」语义（防旧副本覆盖新值）
 *
 * 运行：node scripts/test-origin-migration.mjs；退出码 0=通过
 */
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(path.join(ROOT, 'client.js'), 'utf8');
const errs = [];
const ok = (c, m) => { if (!c) errs.push(m); };
const noop = () => {};

function mkEl(type, props, ...kids) {
  return { __el: true, type, props: Object.assign({}, props || {}, { children: kids.length <= 1 ? kids[0] : kids }) };
}
const fakeReact = {
  createElement: mkEl,
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {}, useLayoutEffect: () => {}, useRef: (v) => ({ current: v }),
  useCallback: (f) => f, useMemo: (f) => f(),
};
function domEl(tag) {
  return {
    tagName: String(tag || 'div').toUpperCase(), style: {}, dataset: {}, children: [], textContent: '', innerHTML: '',
    value: '', className: '', id: '', width: 0, height: 0, firstChild: null, parentNode: null,
    appendChild: noop, removeChild: noop, remove: noop, click: noop, focus: noop, blur: noop, select: noop,
    setAttribute: noop, getAttribute: () => null, removeAttribute: noop, addEventListener: noop, removeEventListener: noop,
    querySelector: () => null, querySelectorAll: () => [],
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    getContext: () => new Proxy({}, { get: (t, p) => (p === 'measureText' ? () => ({ width: 10 }) : noop), set: () => true }),
    toDataURL: () => 'data:,',
    classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
  };
}

const HOST_SETTINGS = {
  textLlm: { provider: 'deepseek', model: 'deepseek-chat' },
  imageProviders: [{ id: 'p1', name: '中转站', baseUrl: 'https://api.example.com', apiKey: 'sk-test-123', models: [{ id: 'm1', model: 'gpt-image-1' }] }],
  imageStar: 'p1|m1',
  videoProviders: [{ id: 'v1', name: '视频站', url: 'https://v.example.com', apiKey: 'vk-9', models: [{ id: 'vm1', model: 'seedance' }] }],
  videoStar: 'v1|vm1',
  ttsProviders: [], ttsStar: '', lang: 'zh',
};
const HOST_SUBJECTS = [{ id: 's1', name: '林晚', kind: 'character', desc: '主角' }];
const HOST_WORKFLOWS = [{ id: 'w1', name: '口播一条龙', createdAt: 1, updatedAt: 2, steps: [] }];
const T = 1794000000000;

const calls = [];
let uiStateOnHost = { ok: true, found: true, updatedAt: T, state: { settings: HOST_SETTINGS, subjects: HOST_SUBJECTS, workflows: HOST_WORKFLOWS } };
const rpcStubFetch = async (url, opts) => {
  const u = String(url || '');
  if (u.includes('/artcraft/')) throw new Error('stub: artcraft offline');
  let body = {};
  try { body = JSON.parse((opts && opts.body) || '{}'); } catch { /* 忽略 */ }
  const method = body.method || '';
  calls.push({ method, args: body.args });
  let payload;
  if (method === 'uiStateGet') {
    payload = uiStateOnHost;
  } else if (method === 'uiStateSet') {
    uiStateOnHost = { ok: true, found: true, updatedAt: Date.now(), state: { ...(uiStateOnHost.state || {}), ...(body.args.state || {}) } };
    payload = { ok: true, savedAt: uiStateOnHost.updatedAt, state: uiStateOnHost.state };
  } else if (method === 'projectsSync') {
    payload = { projects: [{ id: 'ph1', name: '宿主项目', updatedAt: T, nodeIds: [], nodes: {}, tombstones: [], bibleUpdatedAt: 0 }] };
  } else if (method === 'projectsGet') {
    payload = { id: 'ph1', name: '宿主项目', nodes: { n1: { id: 'n1', type: 'text', x: 0, y: 0, w: 320, h: 120, data: { text: '来自宿主' } } }, edges: [], view: { x: 0, y: 0, scale: 1 }, bible: { worldview: '', style: '', characters: [], scenes: [], props: [] }, bibleUpdatedAt: 0 };
  } else {
    payload = { ok: true };
  }
  return { ok: true, status: 200, text: async () => JSON.stringify(payload), json: async () => payload };
};

// 空 localStorage = 新来源（换 IP 后浏览器就是这样）
const localStorageStub = { _m: new Map(), getItem(k) { return this._m.has(k) ? this._m.get(k) : null; }, setItem(k, v) { this._m.set(k, String(v)); }, removeItem(k) { this._m.delete(k); }, clear() { this._m.clear(); } };
const windowStub = { devicePixelRatio: 1, innerWidth: 1600, innerHeight: 900, addEventListener: noop, removeEventListener: noop, __DSH_IC_SMOKE__: true };
const sandbox = {
  window: windowStub,
  document: { createElement: (t) => domEl(t), createTextNode: (t) => ({ nodeValue: String(t) }), head: domEl('head'), body: domEl('body'), documentElement: domEl('html'), getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], elementFromPoint: () => null, activeElement: null, addEventListener: noop, removeEventListener: noop },
  localStorage: localStorageStub,
  navigator: { userAgent: 'smoke', clipboard: { writeText: async () => {} } },
  location: { href: 'http://10.0.0.9:3080/', reload: noop },
  fetch: rpcStubFetch,
  requestAnimationFrame: noop, cancelAnimationFrame: noop,
  setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
  console, performance, crypto, Blob, URL, AbortController, AbortSignal, structuredClone,
  Image: class { constructor() { this.src = ''; } }, Audio: class { constructor() { this.src = ''; } },
  CustomEvent: class { constructor(t, i) { this.type = t; this.detail = i && i.detail; } },
  Event: class { constructor(t) { this.type = t; } },
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
  matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
  indexedDB: { open: () => ({ set onupgradeneeded(v) { void v; }, set onsuccess(v) { void v; }, set onerror(v) { void v; } }) },
  alert: noop, confirm: () => false, prompt: () => null,
};
sandbox.window.localStorage = localStorageStub;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
let mod = null;
sandbox.window.__ModuleLoader__ = { load(def) { mod = def; } };
vm.runInContext(src, sandbox, { filename: 'client.js' });
const plugin = mod.factory((name) => (name === 'react' ? fakeReact : (() => { throw new Error('意外 require: ' + name); })()));
plugin.apply({
  effect(fn) { fn(); },
  locale: { register: noop, subscribe: () => () => {} },
  slots: { inject: (n, cb) => cb(), register: (m, C) => C },
});

const sync = windowStub.__DSH_IC_SYNC__;
if (!sync) { console.error('✗ 未找到 __DSH_IC_SYNC__'); process.exit(1); }

try {
  // ---------- 前置：新来源确实是空仓 ----------
  ok(localStorageStub.getItem('dsh-ic:settings') == null, '前置失败：测试没有从空 localStorage 起跑');

  // ---------- ① 设置/角色库/工作流从宿主回填 ----------
  const restored = await sync.hydrateUiState();
  ok(restored === true, 'hydrateUiState 应报告回填了数据（实际 ' + restored + '）');
  ok(localStorageStub.getItem('dsh-ic:settings') != null, '宿主侧设置未回填到本地（换 IP 后设置依然会丢）');
  const st = sync.loadSettings();
  ok((st.imageProviders || []).some((p) => p.apiKey === 'sk-test-123'), '回填后 loadSettings 读不到图片供应商密钥（生成会报未配置模型）');
  ok(st.imageStar === 'p1|m1', '回填后星标模型丢失');
  ok(st.videoStar === 'v1|vm1', '回填后视频星标丢失');
  ok(sync.loadSubjects().some((x) => x.id === 's1'), '回填后角色库为空');
  ok(sync.loadWorkflows().some((x) => x.id === 'w1'), '回填后工作流为空');

  // ---------- ② 项目列表从宿主拉回（画布数据不因换来源丢失） ----------
  // 启动链里的首个 tick 可能还在飞（hostSyncBusy 互斥）→ 轮询最多 1.5s
  let got = false;
  for (let i = 0; i < 15 && !got; i++) {
    await sync.hostSyncTick();
    got = sync.state().projects.includes('ph1');
    if (!got) await new Promise((r) => setTimeout(r, 100));
  }
  ok(got, '换来源后项目列表没有从宿主拉回（实际 ' + JSON.stringify(sync.state().projects) + '）');

  // ---------- ③ 保存后回写宿主（下次换来源还能读回） ----------
  const before = calls.filter((c) => c.method === 'uiStateSet').length;
  const next = sync.loadSettings();
  next.imageStar = 'p1|m1';
  sync.saveSettings(next);
  await sync.pushUiStateNow();
  const after = calls.filter((c) => c.method === 'uiStateSet').length;
  ok(after > before, 'saveSettings 后没有回写宿主（uiStateSet 未被调用）');
  const pushed = calls.filter((c) => c.method === 'uiStateSet').pop();
  ok(pushed && pushed.args && pushed.args.state && pushed.args.state.settings, '回写载荷缺 settings');
  ok(pushed && JSON.stringify(pushed.args.state.settings).includes('sk-test-123'), '回写载荷把密钥丢了');
  ok(pushed && Array.isArray(pushed.args.state.subjects) && pushed.args.state.subjects.length === 1, '回写载荷缺角色库');
} catch (e) {
  errs.push('测试异常：' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e)));
}

// ---------- ④ 宿主 uiStateSet 的落后写入拒收（防旧副本盖新值） ----------
try {
  const SANDBOX = mkdtempSync(path.join(os.tmpdir(), 'dsh-ic-uistate-'));
  process.env.DSH_IC_PROJECTS_DIR = path.join(SANDBOX, 'projects');
  process.env.DSH_IC_CONFIG_PATH = path.join(SANDBOX, 'config.json');
  const hostMod = await import(pathToFileURL(path.join(ROOT, 'index.js')).href + '?t=' + Date.now());
  const routes = [];
  hostMod.apply({ effect(fn) { fn(); return () => {}; }, get: () => undefined, webServer: { register: (r) => { routes.push(r); return () => {}; } }, tools: { register: () => () => {} } });
  const rpc = routes.find((r) => r.path === '/infinite-canvas/api/rpc');
  const call = (method, args) => new Promise((res) => {
    const out = { statusCode: 200, setHeader() {}, end(b) { res(JSON.parse(String(b))); } };
    Promise.resolve(rpc.handler({ method: 'POST', url: '/infinite-canvas/api/rpc', headers: {}, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ method, args: args || {} })); }, on() {} }, out));
  });
  const a = await call('uiStateGet');
  ok(a && a.ok && a.found === false, '宿主新装应返回 found:false（实际 ' + JSON.stringify(a) + '）');
  const w1 = await call('uiStateSet', { state: { settings: { imageStar: 'NEW' } }, updatedAt: 2000 });
  ok(w1 && w1.ok && !w1.stale, '首次写入应成功');
  const stale = await call('uiStateSet', { state: { settings: { imageStar: 'OLD' } }, updatedAt: 1000 });
  ok(stale && stale.stale === true, '落后时间戳的写入必须被拒收（否则旧副本会盖掉新设置）');
  const g = await call('uiStateGet');
  ok(g && g.state && g.state.settings && g.state.settings.imageStar === 'NEW', '拒收后宿主值应保持 NEW（实际 ' + JSON.stringify(g && g.state) + '）');
  const mode = (await import('node:fs')).statSync(path.join(SANDBOX, 'ui-state.json')).mode & 0o777;
  ok(mode === 0o600, 'ui-state.json 权限应为 0600（含密钥），实际 ' + mode.toString(8));
  rmSync(SANDBOX, { recursive: true, force: true });
} catch (e) {
  errs.push('宿主 uiState 异常：' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e)));
}

if (errs.length) {
  console.error('✗ 换来源（换 IP/设备/浏览器）恢复测试未通过（' + errs.length + ' 项）：');
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('✓ 换来源恢复测试通过（设置/密钥/角色库/工作流回填 + 项目从宿主拉回 + 保存回写 + 落后写入拒收 + 0600 权限）');
process.exit(0); // 沙箱里启了 3s 同步轮询，不显式退出会挂住
