#!/usr/bin/env node
/**
 * 成片合成（宿主侧）端到端回归测试（dev-only）：
 * 在沙盒数据根里真造项目 + 真造片段视频 + 真调宿主 RPC（finalcutProbe / finalcutComposeStart /
 * finalcutJobGet）→ 校验：成片文件真的落盘、时长对、资产真的入库（assetsGet 能查到）。
 *
 * 为什么需要它：宿主侧的资产解析（rel/sha → 绝对路径）、时长探测、ffmpeg 调用、资产入库
 * 这四段，任何一段写错都只会在用户点「合成导出」时炸——静态审计抓不到。
 *
 * 运行：node scripts/test-finalcut-host.mjs   退出码 0 = 通过
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';
import { findBinary } from '../finalcut-compose.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ic-fchost-'));
const DATA_ROOT = path.join(SANDBOX, 'data');
process.env.DSH_IC_PROJECTS_DIR = path.join(SANDBOX, 'projects');
process.env.DSH_IC_CONFIG_PATH = path.join(SANDBOX, 'config.json');

const errs = [];
const ok = (cond, msg) => { if (!cond) errs.push(msg); };

const routes = [];
const fakeCtx = {
  effect(fn) { fn(); return () => {}; },
  get: () => undefined,
  webServer: { register: (r) => { routes.push(r); return () => {}; } },
  tools: { register: () => () => {} },
};
const mod = await import(pathToFileURL(path.join(ROOT, 'index.js')).href);
mod.apply(fakeCtx);
const rpcRoute = routes.find((r) => r.path === '/infinite-canvas/api/rpc');
if (!rpcRoute) { console.error('✗ 未注册 /infinite-canvas/api/rpc'); process.exit(1); }

function rpc(method, args) {
  return new Promise((resolve, reject) => {
    const req = {
      method: 'POST', url: '/infinite-canvas/api/rpc',
      headers: { host: '127.0.0.1:1', 'content-type': 'application/json' },
      async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ method, args: args || {} })); },
      on() {},
    };
    const res = { statusCode: 200, setHeader() {}, end(body) { resolve({ status: res.statusCode, body: String(body) }); } };
    Promise.resolve(rpcRoute.handler(req, res)).catch((e) => resolve({ status: 500, body: String(e && e.message) }));
  });
}
async function call(method, args) {
  const r = await rpc(method, args);
  let j = null;
  try { j = JSON.parse(r.body); } catch { /* 非 JSON */ }
  if (r.status !== 200) throw new Error(method + ' HTTP ' + r.status + '：' + r.body.slice(0, 300));
  if (j && j.error) throw new Error(method + '：' + j.error);
  return j;
}

try {
  // ---------- 准备数据根 ----------
  fs.mkdirSync(DATA_ROOT, { recursive: true });
  await call('dataRootSet', { root: DATA_ROOT });

  const pid = 'ptest001';
  await call('projectsPut', { id: pid, doc: { id: pid, name: '成片测试项目', nodes: {}, edges: [] } });

  // ---------- 探测宿主能力 ----------
  const probe = await call('finalcutProbe');
  ok(probe && probe.ok, 'finalcutProbe 未返回 ok');
  const ffmpeg = findBinary('ffmpeg');
  if (!ffmpeg || !probe.ffmpeg) {
    console.log('SKIP 宿主端到端：本机没有 ffmpeg（' + ((probe && probe.reason) || '未知') + '）');
  } else {
    // ---------- 造两段素材并登记成资产 ----------
    const mk = (color, dur, name) => {
      const r = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', `color=c=${color}:s=320x180:r=25:d=${dur}`,
        '-f', 'lavfi', '-i', `sine=frequency=440:duration=${dur}`,
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', path.join(SANDBOX, name)], { encoding: 'utf8' });
      if (r.status !== 0) throw new Error('造素材失败：' + r.stderr);
    };
    mk('gray', 3, 'a.mp4');
    mk('blue', 2, 'b.mp4');

    // 物理文件夹由宿主自己定（逻辑路径 projects/<pid>/… → 物理 projects/<项目名>/…）
    const folder = mod._internals.ensureProjectFolder(pid, '成片测试项目') || '成片测试项目';
    const videoDir = path.join(DATA_ROOT, 'projects', folder, 'video');
    fs.mkdirSync(videoDir, { recursive: true });
    ok(fs.existsSync(videoDir), '片段目录应可创建');
    const ids = [];
    for (const [i, file] of ['a.mp4', 'b.mp4'].entries()) {
      fs.copyFileSync(path.join(SANDBOX, file), path.join(videoDir, file));
      const id = 'atest' + i;
      ids.push(id);
      await call('assetCreate', {
        projectName: folder,
        asset: {
          id, projectId: pid, kind: 'video', mime: 'video/mp4', name: '片段' + i,
          createdAt: Date.now(), source: 'api', category: 'general',
          rel: `projects/${pid}/video/${file}`, size: fs.statSync(path.join(videoDir, file)).size,
        },
      });
    }
    const got = await call('assetsGet', { ids });
    ok(got && got.items && got.items.length === 2, '资产应可查回（assetsGet）');

    // ---------- 起任务并轮询 ----------
    const started = await call('finalcutComposeStart', {
      projectId: pid,
      name: '测试成片',
      segments: [
        { assetId: ids[0], label: '第一段', sub: '第一段字幕', dur: 2, ttsAssetId: null },
        { assetId: ids[1], label: '第二段', sub: '第二段字幕', dur: 1.5, ttsAssetId: null },
      ],
      width: 640, height: 360, transition: 'none', keepAudio: true, bitrate: 0,
    });
    ok(started && started.ok && started.jobId, 'finalcutComposeStart 应返回 jobId，实际 ' + JSON.stringify(started));
    let job = null;
    for (let i = 0; i < 120; i++) {
      const r = await call('finalcutJobGet', { jobId: started.jobId });
      job = r && r.job;
      if (job && (job.status === 'done' || job.status === 'error')) break;
      await new Promise((res) => setTimeout(res, 250));
    }
    ok(job && job.status === 'done', '合成任务未成功：' + JSON.stringify(job));
    if (job && job.status === 'done') {
      ok(!!job.assetId, '完成任务必须给出 assetId');
      ok(Math.abs((job.durationSec || 0) - 3.5) < 0.3, '成片时长应≈3.5s，实际 ' + job.durationSec);
      // 产物落盘 + 资产入库
      const listed = await call('assetsGet', { ids: [job.assetId] });
      const rec = listed && listed.items && listed.items[0];
      ok(!!rec, '成片资产应已入库（assetsGet 查得到）');
      if (rec) {
        const abs = path.join(DATA_ROOT, 'projects', folder, 'video', path.basename(rec.rel));
        ok(fs.existsSync(abs), '成片文件应落盘：' + abs);
        if (fs.existsSync(abs)) ok(fs.statSync(abs).size > 1000, '成片文件不应为空');
        ok(rec.category === 'finalcut', '成片资产分类应为 finalcut，实际 ' + rec.category);
      }
    }

    // ---------- 缺片段必须明确报错（不许静默出个空片） ----------
    const bad = await call('finalcutComposeStart', {
      projectId: pid,
      segments: [{ assetId: '不存在的资产', label: '坏片段', sub: '', dur: 1 }],
      width: 320, height: 180,
    });
    ok(bad && bad.ok, '坏任务也应先受理（错误在任务里报）');
    let badJob = null;
    for (let i = 0; i < 40; i++) {
      const r = await call('finalcutJobGet', { jobId: bad.jobId });
      badJob = r && r.job;
      if (badJob && (badJob.status === 'done' || badJob.status === 'error')) break;
      await new Promise((res) => setTimeout(res, 200));
    }
    ok(badJob && badJob.status === 'error', '片段文件缺失时任务应报错，实际 ' + JSON.stringify(badJob));
  }
} catch (e) {
  errs.push('宿主端到端异常：' + (e && e.stack ? e.stack : String(e)));
} finally {
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

if (errs.length) {
  console.error('✗ 成片合成（宿主端到端）测试未通过（' + errs.length + ' 项）：');
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('✓ 成片合成（宿主端到端）测试通过（能力探测/任务轮询/产物落盘/资产入库/缺片段报错）');
process.exit(0);
