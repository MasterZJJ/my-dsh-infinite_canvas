#!/usr/bin/env node
/**
 * 成片节点「宿主侧合成」客户端链路回归测试（dev-only）：
 * 在假浏览器里用**假宿主**跑 composeViaHost 的真实代码：探测 → 起任务 → 轮询 → 落资产，
 * 并断言宿主不可用时必须退回浏览器路径（而不是静默失败）。
 *
 * 为什么需要它：这条链路横跨 fetch/RPC、状态写回、进度回填——任一处写错都只会在用户点
 * 「合成导出」时炸；而且「宿主不可用 → 兜底」这个分支最容易写反（写成直接失败 = 用户看到报错）。
 *
 * 运行：node scripts/test-finalcut-client.mjs   退出码 0 = 通过
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(path.join(ROOT, 'client.js'), 'utf8');
const noop = () => {};
const errs = [];
const ok = (cond, msg) => { if (!cond) errs.push(msg); };

let nowMs = 0;
class MediaRecorderStub {
  static isTypeSupported() { return false; } // 走不到浏览器录制分支
}

const documentStub = {
  createElement: (tag) => {
    if (tag === 'video') return { duration: 2, videoWidth: 640, videoHeight: 360, muted: true, play: () => Promise.resolve(), pause: noop, addEventListener: noop };
    if (tag === 'canvas') return { width: 0, height: 0, getContext: () => ({ measureText: () => ({ width: 10 }), drawImage: noop, fillText: noop, fillRect: noop, save: noop, restore: noop }), captureStream: () => ({ addTrack: noop, getAudioTracks: () => [] }) };
    return { style: {}, dataset: {}, children: [], appendChild: noop, removeChild: noop, remove: noop, setAttribute: noop, addEventListener: noop, removeEventListener: noop, classList: { add: noop, remove: noop, toggle: noop }, textContent: '', id: '' };
  },
  head: { appendChild: noop, removeChild: noop, querySelector: () => null },
  body: { appendChild: noop, removeChild: noop },
  documentElement: { appendChild: noop, removeChild: noop },
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener: noop,
  removeEventListener: noop,
  activeElement: null,
  hidden: false,
};

/** 假宿主：按 method 返回预设响应；记录调用序列。 */
function makeFetch(handlers) {
  const calls = [];
  const fn = async (url, opts) => {
    let method = '', args = {};
    try { const body = JSON.parse((opts && opts.body) || '{}'); method = body.method; args = body.args || {}; } catch { /* 非 RPC */ }
    calls.push({ method, args });
    const h = handlers[method];
    const payload = typeof h === 'function' ? h(args, calls.length) : (h || {});
    return { ok: true, status: 200, text: async () => JSON.stringify(payload), json: async () => payload };
  };
  fn.calls = calls;
  return fn;
}

function buildSandbox(fetchImpl) {
  const sandbox = {
    window: { __DSH_IC_SMOKE__: true, addEventListener: noop, removeEventListener: noop, AudioContext: undefined, webkitAudioContext: undefined, devicePixelRatio: 1, innerWidth: 1600, innerHeight: 900, localStorage: { getItem: () => null, setItem: noop, removeItem: noop } },
    document: documentStub,
    navigator: { userAgent: 'test-finalcut-client', clipboard: { writeText: async () => {} } },
    location: { href: 'http://127.0.0.1:1/', reload: noop },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    fetch: fetchImpl,
    requestAnimationFrame: (cb) => setTimeout(() => cb(nowMs), 1),
    cancelAnimationFrame: noop,
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    performance: { now: () => nowMs },
    console,
    Blob, URL, AbortController, AbortSignal, structuredClone, crypto,
    Image: class { constructor() { this.src = ''; } },
    Audio: class { constructor() { this.src = ''; } },
    FileReader: class { readAsDataURL() {} readAsArrayBuffer() {} readAsText() {} },
    CustomEvent: class { constructor(t, i) { this.type = t; this.detail = i && i.detail; } },
    Event: class { constructor(t) { this.type = t; } },
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
    indexedDB: { open: () => ({ set onupgradeneeded(v) { void v; }, set onsuccess(v) { void v; }, set onerror(v) { void v; } }) },
    MediaRecorder: MediaRecorderStub,
    alert: noop, confirm: () => false, prompt: () => null,
  };
  sandbox.globalThis = sandbox;
  sandbox.window.MediaRecorder = MediaRecorderStub;
  vm.createContext(sandbox);
  let mod = null;
  sandbox.window.__ModuleLoader__ = { load(def) { mod = def; } };
  vm.runInContext(src, sandbox, { filename: 'client.js' });
  const fakeReact = {
    createElement: (type, props, ...kids) => ({ type, props, kids }),
    useState: (i) => [typeof i === 'function' ? i() : i, noop],
    useEffect: noop, useLayoutEffect: noop, useRef: (v) => ({ current: v }),
    useCallback: (f) => f, useMemo: (f) => f(), Fragment: 'fragment',
  };
  const plugin = mod.factory((name) => {
    if (name === 'react') return fakeReact;
    throw new Error('意外 require: ' + name);
  });
  plugin.apply({
    effect(fn) { fn(); },
    locale: { register: noop, subscribe: () => () => {} },
    slots: { inject(name, cb) { cb(); }, register() { return () => {}; } },
  });
  return sandbox;
}

const node = { id: 'n1', type: 'finalcut', x: 0, y: 0, w: 360, h: 360, data: { label: '成片', resolution: '720P', ratio: '16:9', transition: 'none', keepAudio: true } };
const items = [{ assetId: 'a1', label: '第一段', sub: '第一句', ttsAssetId: null, dur: 3 }];

async function main() {
  // ---------- 1) 宿主正常：探测 → 起任务 → 轮询 → 拿到 assetId ----------
  {
    let polls = 0;
    const fetchImpl = makeFetch({
      finalcutProbe: { ok: true, ffmpeg: true, ffprobe: true },
      finalcutComposeStart: { ok: true, jobId: 'job-1' },
      finalcutJobGet: () => {
        polls++;
        return { ok: true, job: polls < 2 ? { id: 'job-1', status: 'running', pct: 40, stage: '合成中' } : { id: 'job-1', status: 'done', pct: 100, assetId: 'asset-9', warnings: [] } };
      },
      projectsSync: { ok: true }, projectsPut: { ok: true }, assetsGet: { ok: true, items: [] },
    });
    const sandbox = buildSandbox(fetchImpl);
    const api = sandbox.window.__DSH_IC_COMPOSE__;
    ok(!!api && typeof api.composeViaHost === 'function', '未暴露 composeViaHost（客户端链路无法测）');
    if (api && api.composeViaHost) {
      const r = await api.composeViaHost(node, items);
      ok(r && r.ok === true, '宿主可用时应合成成功，实际 ' + JSON.stringify(r));
      ok(r && r.assetId === 'asset-9', '应回填宿主给出的 assetId，实际 ' + JSON.stringify(r));
      const methods = fetchImpl.calls.map((c) => c.method);
      ok(methods.includes('finalcutProbe'), '应先探测宿主能力');
      ok(methods.includes('finalcutComposeStart'), '应起合成任务');
      ok(methods.includes('finalcutJobGet'), '应轮询任务进度');
      const start = fetchImpl.calls.find((c) => c.method === 'finalcutComposeStart');
      ok(start && start.args && start.args.segments && start.args.segments.length === 1, '起任务必须带上片段清单');
      ok(start && start.args && start.args.segments[0].assetId === 'a1', '片段必须带 assetId');
      ok(start && start.args && start.args.width > 0 && start.args.height > 0, '起任务必须带画面尺寸');
    }
  }

  // ---------- 2) 宿主没有 ffmpeg：必须退回浏览器路径（skip），不得直接失败 ----------
  {
    const fetchImpl = makeFetch({ finalcutProbe: { ok: true, ffmpeg: false, reason: '系统未安装 ffmpeg' } });
    const sandbox = buildSandbox(fetchImpl);
    const api = sandbox.window.__DSH_IC_COMPOSE__;
    const r = await api.composeViaHost(node, items);
    ok(r && r.ok === false && r.skip === true, '宿主无 ffmpeg 时应标记 skip 走浏览器兜底，实际 ' + JSON.stringify(r));
    ok(r && /ffmpeg/.test(String(r.reason || '')), 'skip 必须带原因（让节点能说清为什么退回浏览器），实际 ' + JSON.stringify(r));
  }

  // ---------- 3) 宿主 RPC 报错：同样退回浏览器（skip），不得把网络抖动变成硬失败 ----------
  {
    const fetchImpl = makeFetch({});
    fetchImpl.calls.length = 0;
    const orig = fetchImpl;
    const wrapped = async (url, opts) => { throw new Error('network down'); };
    const sandbox = buildSandbox(wrapped);
    const api = sandbox.window.__DSH_IC_COMPOSE__;
    const r = await api.composeViaHost(node, items);
    ok(r && r.ok === false && r.skip === true, '宿主不可达时应退回浏览器兜底，实际 ' + JSON.stringify(r));
    void orig;
  }

  // ---------- 4) 宿主任务失败：必须把错误抛出来（不许静默改走浏览器） ----------
  {
    let polls = 0;
    const fetchImpl = makeFetch({
      finalcutProbe: { ok: true, ffmpeg: true },
      finalcutComposeStart: { ok: true, jobId: 'job-2' },
      finalcutJobGet: () => { polls++; return { ok: true, job: { id: 'job-2', status: 'error', error: 'ffmpeg 退出码 1' } }; },
    });
    const sandbox = buildSandbox(fetchImpl);
    const api = sandbox.window.__DSH_IC_COMPOSE__;
    let err = null;
    try { await api.composeViaHost(node, items); } catch (e) { err = e; }
    ok(err && /ffmpeg/.test(String(err.message)), '宿主任务失败必须抛错并带原因，实际 ' + (err && err.message));
  }
}

main().then(() => {
  if (errs.length) {
    console.error('✗ 成片合成（客户端宿主链路）测试未通过（' + errs.length + ' 项）：');
    for (const e of errs) console.error('  - ' + e);
    process.exit(1);
  }
  console.log('✓ 成片合成（客户端宿主链路）测试通过（探测/起任务/轮询/退回浏览器/失败抛错）');
  process.exit(0);
}).catch((e) => {
  console.error('✗ 客户端宿主链路测试异常：' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
