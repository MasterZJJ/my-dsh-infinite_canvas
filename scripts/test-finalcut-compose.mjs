#!/usr/bin/env node
/**
 * 成片合成回归测试（宿主侧 ffmpeg + 客户端接线）：
 *   ① 纯函数：字幕换行 / ffmpeg 参数组装（concat 交错、叠化偏移、黑场插入、TTS 混音、缺字体告警）
 *   ② 端到端：真造两段素材 → 真跑 ffmpeg → 校验产物时长、画面顺序、字幕确实烧进画面
 *   ③ 接线：宿主 RPC 方法在位、客户端成片节点优先走宿主路径
 *
 * 运行：node scripts/test-finalcut-compose.mjs   退出码 0 = 通过
 * 无 ffmpeg 的机器：② 跳过（打印 SKIP），① ③ 仍然跑。
 */
import { readFileSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  wrapSubtitleLines, subtitleFontSize, buildFfmpegArgs, escapeFilterValue,
  pickSubtitleFont, findBinary, runFfmpeg, probeMedia,
} from '../finalcut-compose.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const errs = [];
const ok = (cond, msg) => { if (!cond) errs.push(msg); };
const eq = (a, b, msg) => { if (JSON.stringify(a) !== JSON.stringify(b)) errs.push(msg + '\n    期望 ' + JSON.stringify(b) + '\n    实际 ' + JSON.stringify(a)); };

// ---------------------------------------------------------------- ① 纯函数
function unitTests() {
  // 字幕换行：CJK 逐字断行
  eq(wrapSubtitleLines('', {}), [], '空字幕应返回空数组');
  eq(wrapSubtitleLines('   ', {}), [], '纯空白字幕应返回空数组');
  const lines = wrapSubtitleLines('一二三四五六七八九十', { maxChars: 4, maxLines: 3 });
  ok(lines.length === 3, 'CJK 换行行数应为 3，实际 ' + lines.length);
  eq(lines[0], '一二三四', 'CJK 第一行应为 4 字，实际 ' + lines[0]);
  ok(/…$/.test(lines[2]), '超出行数上限时末行应带省略号，实际 ' + lines[2]);
  // 拉丁按词断行（不把单词劈开）
  const en = wrapSubtitleLines('hello world again', { maxChars: 12, maxLines: 3 });
  ok(en.join(' ').includes('hello'), '拉丁换行不应劈开单词，实际 ' + JSON.stringify(en));
  // 字号随画面高度
  ok(subtitleFontSize(720) === 30, '720p 字号应为 30，实际 ' + subtitleFontSize(720));
  ok(subtitleFontSize(100) === 14, '过小画面字号兜底 14，实际 ' + subtitleFontSize(100));

  // filter 值转义
  eq(escapeFilterValue('/a/b:c.txt'), '/a/b\\:c.txt', 'filter 值里的冒号应转义');

  const segs = [
    { file: '/tmp/a.mp4', dur: 3, sub: '第一段', hasAudio: true },
    { file: '/tmp/b.mp4', dur: 2, sub: '第二段', hasAudio: true, ttsFile: '/tmp/t.mp3' },
  ];
  const font = pickSubtitleFont(() => true);
  const none = buildFfmpegArgs({ segments: segs, width: 1280, height: 720, transition: 'none', fontFile: font, subDir: '/tmp', outFile: '/tmp/o.mp4', writeSubs: false });
  const fc = none.args[none.args.indexOf('-filter_complex') + 1];
  ok(/\[v0\]\[a0\]\[v1\]\[a1\]concat=n=2:v=1:a=1/.test(fc), 'concat 的输入必须按段交错 [v0][a0][v1][a1]，实际：\n' + fc);
  ok(/drawtext=/.test(fc), '有字体时字幕必须走 drawtext 烧录');
  ok(!existsSync(path.join('/tmp', 'sub0.txt')), 'writeSubs=false 时不应写字幕文件');
  eq(none.totalDur, 5, 'none 转场总时长应为 5s');

  const fade = buildFfmpegArgs({ segments: segs, width: 1280, height: 720, transition: 'fade', fontFile: font, subDir: '/tmp', outFile: '/tmp/o.mp4', writeSubs: false });
  const ffc = fade.args[fade.args.indexOf('-filter_complex') + 1];
  ok(/xfade=transition=fade:duration=0.6:offset=2.4/.test(ffc), '叠化起点应为 首段时长-叠化时长=2.4，实际：\n' + ffc);
  ok(/acrossfade=d=0.6/.test(ffc), '叠化必须同步做音频交叉淡化');
  ok(Math.abs(fade.totalDur - 4.4) < 0.01, '叠化后总时长应为 4.4s，实际 ' + fade.totalDur);

  const black = buildFfmpegArgs({ segments: segs, width: 1280, height: 720, transition: 'black', fontFile: font, subDir: '/tmp', outFile: '/tmp/o.mp4', writeSubs: false });
  const bfc = black.args[black.args.indexOf('-filter_complex') + 1];
  ok(/color=c=black/.test(bfc), '黑场转场应插入黑画面源');
  ok(/concat=n=3/.test(bfc), '黑场转场应为 3 段拼接（v a 黑 v a）');

  // TTS 混音：amix 必须出现
  ok(/amix=inputs=2/.test(ffc), '带 TTS 的片段应与原声 amix 混音');

  // 缺中文字体 → 明确告警，且不烧字幕（不许静默丢字幕）
  const noFont = buildFfmpegArgs({ segments: segs, width: 1280, height: 720, transition: 'none', fontFile: null, subDir: '/tmp', outFile: '/tmp/o.mp4', writeSubs: false });
  ok(noFont.warnings.length > 0, '缺字体时必须有可见告警');
  const nfc = noFont.args[noFont.args.indexOf('-filter_complex') + 1];
  ok(!/drawtext/.test(nfc), '缺字体时不应挂 drawtext（会直接报错）');

  // 空片段必须抛错
  let threw = false;
  try { buildFfmpegArgs({ segments: [] }); } catch { threw = true; }
  ok(threw, '空片段列表应抛错');

  // 成片音频轨（BGM/SFX）：loop → -stream_loop；起点 → adelay；增益 → volume；与总音轨 amix normalize=0
  const withBgm = buildFfmpegArgs({
    segments: segs, width: 640, height: 360, transition: 'none', fontFile: font,
    subDir: '/tmp', outFile: '/tmp/o.mp4', writeSubs: false,
    audioTracks: [
      { file: '/tmp/bgm.mp3', name: 'BGM', start: 0.5, offset: 0, duration: 1.5, gain: 0.5, loop: true },
    ],
  });
  const bargs = withBgm.args.join(' ');
  const bfc2 = withBgm.args[withBgm.args.indexOf('-filter_complex') + 1];
  ok(/-stream_loop -1/.test(bargs), '循环音频轨必须用 -stream_loop -1（输入级循环）');
  ok(/adelay=500\|500/.test(bfc2), '音频轨起点 0.5s 应转成 adelay=500|500，实际：\n' + bfc2);
  ok(/volume=0\.500/.test(bfc2), '音频轨增益 0.5 应转成 volume=0.500，实际：\n' + bfc2);
  ok(/amix=inputs=2:duration=first:normalize=0/.test(bfc2), '总音轨与 BGM 必须 amix 且 normalize=0（归一化会把 BGM 压没），实际：\n' + bfc2);
  ok(/-map \[vout\] -map \[amixout\]/.test(bargs), '混音后必须映射 [amixout]，实际：\n' + bargs);

  // 起点超过成片时长：跳过并告警（不许静默丢轨）
  const lateBgm = buildFfmpegArgs({
    segments: segs, width: 640, height: 360, transition: 'none', fontFile: font,
    subDir: '/tmp', outFile: '/tmp/o.mp4', writeSubs: false,
    audioTracks: [{ file: '/tmp/bgm.mp3', name: '迟到BGM', start: 99, duration: 1, gain: 1, loop: false }],
  });
  ok(lateBgm.warnings.some((w) => /迟到BGM/.test(w)), '起点晚于成片时长的音频轨必须有可见告警');
  ok(!/amixout/.test(lateBgm.args.join(' ')), '被跳过的音频轨不应出现在混音链里');
}

// ---------------------------------------------------------------- ② 端到端
function run(cmd, args, opts = {}) {
  // 不设 encoding：stdout 可能是原始像素（二进制），utf8 会把字节解成乱码
  const r = spawnSync(cmd, args, { maxBuffer: 64 * 1024 * 1024, ...opts });
  r.stderrText = r.stderr ? r.stderr.toString('utf8') : '';
  return r;
}

/** 取一帧灰度原始像素，返回 { w, h, data } */
function grayFrame(ffmpeg, file, atSec, w, h) {
  const r = run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-ss', String(atSec), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-']);
  if (r.status !== 0 || !r.stdout || r.stdout.length < w * h) return null;
  return { w, h, data: r.stdout };
}

function regionMean(frame, x0, x1, y0, y1) {
  let sum = 0, n = 0;
  for (let y = Math.max(0, y0); y < Math.min(frame.h, y1); y++) {
    const row = y * frame.w;
    for (let x = Math.max(0, x0); x < Math.min(frame.w, x1); x++) { sum += frame.data[row + x]; n++; }
  }
  return n ? sum / n : 0;
}

async function e2e() {
  const ffmpeg = findBinary('ffmpeg');
  const ffprobe = findBinary('ffprobe');
  if (!ffmpeg || !ffprobe) { console.log('SKIP 端到端：本机没有 ffmpeg/ffprobe'); return; }
  const dir = path.join(os.tmpdir(), 'dsh-finalcut-e2e');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  try {
    // 两段素材：灰底（3s）+ 蓝底（2s），各带一路正弦音频
    const mk = (color, dur, name) => {
      const r = run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', `color=c=${color}:s=640x360:r=25:d=${dur}`,
        '-f', 'lavfi', '-i', `sine=frequency=440:duration=${dur}`,
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', path.join(dir, name)]);
      if (r.status !== 0) throw new Error('造素材失败：' + r.stderrText);
    };
    mk('gray', 4, 'a.mp4');
    mk('blue', 3, 'b.mp4');
    // 一路 TTS（正弦代替人声）
    run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=2', path.join(dir, 'tts.mp3')]);

    const font = pickSubtitleFont();
    const out = path.join(dir, 'out.mp4');
    const plan = buildFfmpegArgs({
      segments: [
        { file: path.join(dir, 'a.mp4'), dur: 3, sub: '第一段中文字幕', hasAudio: true },
        { file: path.join(dir, 'b.mp4'), dur: 2, sub: '第二段中文字幕', hasAudio: true, ttsFile: path.join(dir, 'tts.mp3') },
      ],
      width: 640, height: 360, transition: 'none', fontFile: font, subDir: dir, outFile: out,
    });
    try {
      await runFfmpeg(ffmpeg, plan.args, { timeoutMs: 120000 });
    } catch (e) {
      errs.push('ffmpeg 合成失败：' + (e && e.message));
      return;
    }
    ok(existsSync(out) && statSync(out).size > 1000, '合成产物缺失或为空');
    if (!existsSync(out)) return;
    const probe = await probeMedia(ffprobe, out);
    ok(probe && Math.abs(probe.duration - 5) < 0.35, '成片时长应≈5s，实际 ' + (probe && probe.duration));
    ok(probe && probe.hasVideo && probe.hasAudio, '成片应同时含画面与声音');

    // 画面顺序：第 1 秒是灰底、第 4 秒是蓝底（灰=等值，蓝=B 通道高）
    const f1 = grayFrame(ffmpeg, out, 1, 640, 360);
    ok(!!f1, '取第 1 秒画面失败');
    if (f1) {
      const r = run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-ss', '1', '-i', out, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
      const d = r.stdout;
      const px = (x, y) => { const o = (y * 640 + x) * 3; return [d[o], d[o + 1], d[o + 2]]; };
      const mid = px(320, 120);
      ok(mid[0] === mid[1] && mid[1] === mid[2], '第 1 秒应是灰底（R=G=B），实际 ' + mid);
      // 字幕黑框：画面底部中央（字幕所在）必须比同一行左侧背景更暗
      const subBox = regionMean(f1, Math.floor(640 * 0.35), Math.floor(640 * 0.65), Math.floor(360 * 0.88), Math.floor(360 * 0.97));
      const sideBg = regionMean(f1, Math.floor(640 * 0.02), Math.floor(640 * 0.14), Math.floor(360 * 0.88), Math.floor(360 * 0.97));
      ok(subBox < sideBg - 8, '字幕未烧进画面（底部中央应被字幕黑框压暗）：sub=' + subBox.toFixed(1) + ' side=' + sideBg.toFixed(1));
    }
    // 成片音频轨：时间线本身是静音（片段无音轨 + keepAudio:false），只有 BGM → 成片必须有声音
    {
      const silent = path.join(dir, 'silent.mp4');
      const r0 = run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'color=c=gray:s=320x180:r=25:d=2',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', silent]);
      if (r0.status !== 0) throw new Error('造静音素材失败：' + r0.stderrText);
      const bgmFile = path.join(dir, 'bgm.wav');
      run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=3', bgmFile]);
      const outBgm = path.join(dir, 'out_bgm.mp4');
      const planB = buildFfmpegArgs({
        segments: [{ file: silent, dur: 2, sub: '', hasAudio: false }],
        width: 320, height: 180, transition: 'none', fontFile: font, subDir: dir, outFile: outBgm,
        keepAudio: false,
        audioTracks: [{ file: bgmFile, name: 'BGM', start: 0.3, offset: 0, duration: 1.2, gain: 0.8, loop: false }],
      });
      try { await runFfmpeg(ffmpeg, planB.args, { timeoutMs: 120000 }); }
      catch (e) { errs.push('BGM 合成失败：' + (e && e.message)); }
      if (existsSync(outBgm)) {
        const vol = run(ffmpeg, ['-hide_banner', '-nostats', '-i', outBgm, '-af', 'volumedetect', '-f', 'null', '-']);
        const txt = vol.stderrText || '';
        const mean = /mean_volume:\s*(-?[0-9.]+) dB/.exec(txt);
        ok(!!mean, 'BGM 成片读不到音量统计');
        ok(mean && Number(mean[1]) > -50, '静音时间线 + BGM 的成片应有声音（BGM 未混入？mean_volume=' + (mean && mean[1]) + ' dB）');
        const pr = await probeMedia(ffprobe, outBgm);
        ok(pr && Math.abs(pr.duration - 2) < 0.35, 'BGM 成片时长应≈2s（BGM 不得把成片拉长），实际 ' + (pr && pr.duration));
      }
    }

    const f2 = grayFrame(ffmpeg, out, 4, 640, 360);
    ok(!!f2, '取第 4 秒画面失败');
    if (f2) {
      const r = run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-ss', '4', '-i', out, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
      const d = r.stdout;
      const o = (180 * 640 + 320) * 3;
      const b = [d[o], d[o + 1], d[o + 2]];
      ok(b[2] > b[0] + 20, '第 4 秒应是蓝底（B≫R），实际 ' + b);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- ③ 接线
function wiringTests() {
  const host = readFileSync(path.join(ROOT, 'index.js'), 'utf8');
  const client = readFileSync(path.join(ROOT, 'client.js'), 'utf8');
  ok(/async finalcutProbe\(\)/.test(host), '宿主缺 finalcutProbe RPC');
  ok(/async finalcutComposeStart\(/.test(host), '宿主缺 finalcutComposeStart RPC');
  ok(/async finalcutJobGet\(/.test(host), '宿主缺 finalcutJobGet RPC');
  ok(/runFinalcutJob/.test(host), '宿主缺合成任务主体');
  ok(/from '\.\/finalcut-compose\.js'/.test(host), '宿主未引入 finalcut-compose 模块');
  ok(/finalcutComposeStart/.test(client), '客户端未调用 finalcutComposeStart');
  ok(/finalcutJobGet/.test(client), '客户端未轮询 finalcutJobGet');
  ok(/finalcutProbe/.test(client), '客户端未探测宿主合成能力');
  // 客户端必须「先宿主、后浏览器」：宿主调用点在 composeFinalCut 之前
  const iHost = client.indexOf('composeViaHost(n, items');
  const iBrowser = client.indexOf('await composeFinalCut(metas');
  ok(iHost > 0 && iBrowser > 0 && iHost < iBrowser, '客户端必须先走宿主合成、再退回浏览器录制');
}

unitTests();
wiringTests();
await e2e();

if (errs.length) {
  console.error('✗ 成片合成（宿主侧）测试未通过（' + errs.length + ' 项）：');
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('✓ 成片合成（宿主侧 ffmpeg）测试全部通过（参数组装/转场/TTS 混音/端到端产物/字幕烧录/接线）');
process.exit(0);
