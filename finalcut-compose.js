/**
 * 成片合成（宿主侧 ffmpeg）——纯逻辑 + 执行器，与浏览器录制链路互为备份。
 *
 * 为什么要有宿主侧：
 *   浏览器录制链路（canvas.captureStream + MediaRecorder）是**实时**的：成片多长就要录多久，
 *   而且录制的推进靠 requestAnimationFrame——页面切后台/被遮挡时 rAF 直接停摆，
 *   于是整条合成链卡住，最后只能被看门狗判成「成片合成超时」。
 *   宿主侧 ffmpeg 不依赖浏览器、不依赖实时、不受前台状态影响，且比实时快得多。
 *
 * 本模块只负责「算出 ffmpeg 该怎么做」与「把 ffmpeg 跑起来」；
 * 资产落盘/入库由 index.js 负责（那是数据面的唯一事实源）。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** 字幕字体候选（按优先级）：必须覆盖中日韩，否则中文烧录成方块。 */
export const SUBTITLE_FONT_CANDIDATES = [
  '/system/fonts/NotoSansCJK-Regular.ttc',        // Android
  '/system/fonts/NotoSerifCJK-Regular.ttc',
  '/data/data/com.termux/files/usr/share/fonts/TTF/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf',
  '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc',
  'C:/Windows/Fonts/msyh.ttc',
  'C:/Windows/Fonts/simhei.ttf',
  '/System/Library/Fonts/PingFang.ttc',
  '/Library/Fonts/Arial Unicode.ttf',
];

/** 找一个可用的中文字体；找不到返回 null（调用方据此关闭字幕烧录并给出可见告警）。 */
export function pickSubtitleFont(existsFn = (p) => { try { return fs.existsSync(p); } catch { return false; } }) {
  for (const p of SUBTITLE_FONT_CANDIDATES) {
    try { if (existsFn(p)) return p; } catch { /* 忽略 */ }
  }
  return null;
}

/**
 * 字幕换行（与浏览器 drawSubtitle 同口径）：CJK 逐字断行、拉丁按词断行，最多 maxLines 行。
 * 返回行数组（空数组 = 无字幕）。
 */
export function wrapSubtitleLines(text, opts = {}) {
  const t = String(text || '').trim();
  if (!t) return [];
  const maxChars = Math.max(4, Number(opts.maxChars) || 18);
  const maxLines = Math.max(1, Number(opts.maxLines) || 3);
  const tokens = t.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]|[^\s\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]+|\s/g) || [t];
  const lines = [];
  let line = '';
  for (const tk of tokens) {
    const cand = line + tk;
    // 宽度按「字符数」估算：CJK 记 1、拉丁记 0.55
    const widthOf = (s) => {
      let w = 0;
      for (const ch of s) w += /[\u2e80-\u9fff\uff00-\uffef]/.test(ch) ? 1 : 0.55;
      return w;
    };
    if (widthOf(cand) > maxChars && line) {
      lines.push(line.trim());
      line = /\S/.test(tk) ? tk : '';
      if (lines.length >= maxLines) break;
    } else {
      line = cand;
    }
  }
  if (line && lines.length < maxLines) lines.push(line.trim());
  if (!lines.length) return [];
  if (lines.length >= maxLines) lines[maxLines - 1] += '…';
  return lines;
}

/** 字幕字号：随画面高度走（与浏览器 fs = max(14, H*0.042) 同口径）。 */
export function subtitleFontSize(height) {
  return Math.max(14, Math.round(Number(height) * 0.042));
}

/**
 * 组装 ffmpeg 参数。
 * segments: [{ file, dur(秒,裁剪后), sub(字幕文本), ttsFile(string|null), hasAudio(bool) }]
 * 返回 { args, warnings, totalDur }；args 是 ffmpeg 的完整参数数组（不含可执行名）。
 */
export function buildFfmpegArgs(opts = {}) {
  const segments = Array.isArray(opts.segments) ? opts.segments : [];
  if (!segments.length) throw new Error('没有可合成的片段');
  const width = Math.max(2, Math.round((Number(opts.width) || 1280) / 2) * 2);
  const height = Math.max(2, Math.round((Number(opts.height) || 720) / 2) * 2);
  const transition = ['none', 'fade', 'black'].includes(String(opts.transition || '')) ? String(opts.transition) : 'none';
  const keepAudio = opts.keepAudio !== false;
  const fontFile = opts.fontFile || null;
  const subDir = opts.subDir || '.';
  const outFile = opts.outFile || 'out.mp4';
  const fadeSec = 0.6;
  const blackSec = 0.35;
  const warnings = [];

  const args = ['-hide_banner', '-loglevel', 'error', '-y'];
  const timelineDur = segments.reduce((a, s) => a + Math.max(0.04, Number(s.dur) || 0), 0);
  let inputCount = 0;            // 已声明的输入个数（= 下一个输入的序号）
  for (const s of segments) { args.push('-i', s.file); inputCount++; }
  const ttsIndexes = [];          // 每个片段的 TTS 输入序号（没有则 null）
  for (const s of segments) {
    if (s.ttsFile) { args.push('-i', s.ttsFile); ttsIndexes.push(inputCount); inputCount++; }
    else ttsIndexes.push(null);
  }
  // 成片音频轨（BGM/SFX）：起点晚于成片总长的轨没有意义，直接跳过并留告警（不静默）
  const atInputs = [];
  for (const tr of (Array.isArray(opts.audioTracks) ? opts.audioTracks : [])) {
    if (!tr || !tr.file) continue;
    const start = Math.max(0, Number(tr.start) || 0);
    if (start >= timelineDur) { warnings.push('音频轨「' + (tr.name || 'audio') + '」起点 ' + start.toFixed(1) + 's 超过成片时长，已跳过'); continue; }
    if (tr.loop) args.push('-stream_loop', '-1');
    args.push('-i', tr.file);
    atInputs.push({ idx: inputCount, tr, start });
    inputCount++;
  }

  const chains = [];
  const videoLabels = [];
  const audioLabels = [];
  let totalDur = 0;

  segments.forEach((s, i) => {
    const dur = Math.max(0.04, Number(s.dur) || 0);
    totalDur += dur;
    const fontPx = subtitleFontSize(height);
    const vf = [
      `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`,
      'setsar=1',
      'fps=30',
      `trim=duration=${dur.toFixed(3)}`,
      'setpts=PTS-STARTPTS',
    ].join(',');
    const hasSub = !!String(s.sub || '').trim();
    if (hasSub && !fontFile) warnings.push(`片段 ${i + 1} 的字幕未烧录（系统缺中文字体）`);
    const vlabel = `v${i}`;
    let vchain = `[${i}:v]${vf}`;
    if (hasSub && fontFile) {
      const subPath = path.join(subDir, `sub${i}.txt`);
      const maxChars = Math.max(6, Math.floor((width * 0.88) / (fontPx * 0.62)));
      const lines = wrapSubtitleLines(s.sub, { maxChars, maxLines: 3 });
      if (lines.length) {
        // 字幕文本走 textfile：drawtext 的 text= 需要转义一堆字符，textfile 天然免疫
        if (opts.writeSubs !== false) {
          try { fs.writeFileSync(subPath, lines.join('\n'), 'utf8'); }
          catch (e) { throw new Error('字幕文件写入失败：' + String((e && e.message) || e)); }
        }
        vchain += `,drawtext=fontfile=${escapeFilterValue(fontFile)}:textfile=${escapeFilterValue(subPath)}`
          + `:fontsize=${fontPx}:fontcolor=white:box=1:boxcolor=black@0.5:boxborderw=${Math.round(fontPx * 0.35)}`
          + `:x=(w-text_w)/2:y=h-text_h-${Math.round(height * 0.05)}`;
      }
    }
    vchain += `[${vlabel}]`;
    chains.push(vchain);
    videoLabels.push(vlabel);

    // 音频：片段原声（有则用）+ TTS 配音（可叠加）→ 统一采样率/声道
    const alabel = `a${i}`;
    const afmt = 'aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo';
    const ttsIdx = ttsIndexes[i];
    const parts = [];
    if (keepAudio && s.hasAudio) {
      parts.push(`[${i}:a]atrim=duration=${dur.toFixed(3)},asetpts=N/SR/TB,${afmt}[a${i}m]`);
    }
    if (keepAudio && ttsIdx != null) {
      parts.push(`[${ttsIdx}:a]atrim=duration=${dur.toFixed(3)},asetpts=N/SR/TB,${afmt}[a${i}t]`);
    }
    if (parts.length === 0) {
      chains.push(`anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=${dur.toFixed(3)},asetpts=N/SR/TB[${alabel}]`);
    } else if (parts.length === 1) {
      chains.push(parts[0].replace(/\[a\d+[mt]\]$/, `[${alabel}]`));
    } else {
      chains.push(parts[0]);
      chains.push(parts[1]);
      chains.push(`[a${i}m][a${i}t]amix=inputs=2:duration=first:dropout_transition=0,${afmt}[${alabel}]`);
    }
    audioLabels.push(alabel);
  });

  let vout = 'vout';
  let aout = 'aout';
  if (transition === 'fade' && segments.length > 1) {
    // 叠化：xfade 串行链 + acrossfade 音频链（偏移 = 累积时长 - 每次重叠）
    // acc 起点是第 0 段时长：第 i 次叠化的起点 = 前 i 段总长 - 叠化时长
    let acc = Math.max(0, Number(segments[0].dur) || 0);
    let cur = videoLabels[0];
    for (let i = 1; i < segments.length; i++) {
      const offset = Math.max(0, acc - fadeSec);
      const next = i === segments.length - 1 ? 'vout' : `vx${i}`;
      chains.push(`[${cur}][${videoLabels[i]}]xfade=transition=fade:duration=${fadeSec}:offset=${offset.toFixed(3)}[${next}]`);
      acc += Number(segments[i].dur) || 0;
      cur = next;
    }
    let acur = audioLabels[0];
    for (let i = 1; i < segments.length; i++) {
      const next = i === segments.length - 1 ? 'aout' : `ax${i}`;
      chains.push(`[${acur}][${audioLabels[i]}]acrossfade=d=${fadeSec}:c1=tri:c2=tri[${next}]`);
      acur = next;
    }
    totalDur = Math.max(0, totalDur - fadeSec * (segments.length - 1));
  } else if (transition === 'black' && segments.length > 1) {
    // 黑场：在片段之间插一段黑画面（音频同步静音）
    // concat 的输入必须**按段交错**：[v0][a0][v1][a1]…（不是先全部视频再全部音频）
    const pairs = [];
    for (let i = 0; i < segments.length; i++) {
      pairs.push(`[${videoLabels[i]}][${audioLabels[i]}]`);
      if (i < segments.length - 1) {
        const bl = `blk${i}`;
        chains.push(`color=c=black:s=${width}x${height}:r=30:d=${blackSec}[${bl}]`);
        chains.push(`anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=${blackSec},asetpts=N/SR/TB[bla${i}]`);
        pairs.push(`[${bl}][bla${i}]`);
        totalDur += blackSec;
      }
    }
    chains.push(`${pairs.join('')}concat=n=${pairs.length}:v=1:a=1[vout][aout]`);
  } else {
    // concat 的输入必须**按段交错**：[v0][a0][v1][a1]…
    const pairs = [];
    for (let i = 0; i < segments.length; i++) pairs.push(`[${videoLabels[i]}][${audioLabels[i]}]`);
    chains.push(`${pairs.join('')}concat=n=${segments.length}:v=1:a=1[vout][aout]`);
  }

  // BGM/SFX 与成片总音轨混音：amix normalize=0 保持各自增益（默认归一化会把 BGM 压没）
  let aoutLabel = 'aout';
  if (atInputs.length) {
    const atLabels = [];
    atInputs.forEach((it, k) => {
      const tr = it.tr;
      const offset = Math.max(0, Number(tr.offset) || 0);
      const gain = Number.isFinite(Number(tr.gain)) && Number(tr.gain) >= 0 ? Math.min(2, Number(tr.gain)) : 1;
      const room = Math.max(0.04, timelineDur - it.start);
      const dur = Number(tr.duration) > 0 ? Math.min(Number(tr.duration), room) : room;
      const label = `at${k}`;
      let chain = `[${it.idx}:a]`;
      chain += `atrim=start=${offset.toFixed(3)}:duration=${dur.toFixed(3)}`;
      chain += ',asetpts=PTS-STARTPTS';
      if (Math.abs(gain - 1) > 0.001) chain += `,volume=${gain.toFixed(3)}`;
      const delayMs = Math.round(it.start * 1000);
      if (delayMs > 0) chain += `,adelay=${delayMs}|${delayMs}`;
      chain += `,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[${label}]`;
      chains.push(chain);
      atLabels.push(label);
    });
    if (atLabels.length) {
      chains.push(`[aout]${atLabels.map((l) => '[' + l + ']').join('')}`
        + `amix=inputs=${atLabels.length + 1}:duration=first:normalize=0[amixout]`);
      aoutLabel = 'amixout';
    }
  }
  args.push('-filter_complex', chains.join(';'));
  args.push('-map', '[vout]', '-map', `[${aoutLabel}]`);
  args.push('-c:v', 'libx264', '-preset', opts.preset || 'veryfast', '-pix_fmt', 'yuv420p');
  if (opts.bitrate) args.push('-b:v', String(Math.max(200000, Number(opts.bitrate))));
  args.push('-c:a', 'aac', '-b:a', '128k');
  args.push('-movflags', '+faststart');
  args.push(outFile);
  return { args, warnings, totalDur };
}

/** filter_complex 的值里 ':' 与 '\' 要转义；路径里的 '/' 不用动。 */
export function escapeFilterValue(v) {
  return String(v).replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

/** 跑 ffmpeg：返回 { code, stderr }；失败抛错（错误信息带 stderr 尾巴，便于定位）。 */
export function runFfmpeg(bin, args, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs) || 20 * 60 * 1000;
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, { cwd: opts.cwd || process.cwd(), windowsHide: true });
    } catch (e) {
      reject(new Error('ffmpeg 启动失败：' + String((e && e.message) || e)));
      return;
    }
    const err = [];
    let out = '';
    child.stderr?.setEncoding('utf8');
    child.stdout?.setEncoding('utf8');
    child.stderr?.on('data', (d) => {
      err.push(d);
      if (err.length > 200) err.shift();
    });
    child.stdout?.on('data', (d) => { out += d; if (opts.onOut) opts.onOut(d); });
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* 忽略 */ }
      reject(new Error('ffmpeg 执行超时（' + Math.round(timeoutMs / 1000) + 's）'));
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error('ffmpeg 启动失败：' + String((e && e.message) || e)));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const stderr = err.join('');
      if (code === 0) resolve({ code, stderr, stdout: out });
      else reject(new Error('ffmpeg 退出码 ' + code + (stderr ? '：' + stderr.slice(-800) : '')));
    });
  });
}

/** ffprobe 探测：返回 { duration, hasVideo, hasAudio }；失败返回 null（调用方决定怎么报）。 */
export function probeMedia(bin, file, opts = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { windowsHide: true });
    } catch { resolve(null); return; }
    let out = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (d) => { out += d; });
    child.on('error', () => resolve(null));
    child.on('close', () => {
      try {
        const j = JSON.parse(out || '{}');
        const streams = Array.isArray(j.streams) ? j.streams : [];
        const dur = Number(j.format && j.format.duration) || 0;
        resolve({
          duration: dur,
          hasVideo: streams.some((s) => s.codec_type === 'video'),
          hasAudio: streams.some((s) => s.codec_type === 'audio'),
        });
      } catch { resolve(null); }
    });
  });
}

/** 找 ffmpeg/ffprobe 可执行文件：优先 PATH，再按平台常见安装位置。 */
export function findBinary(name, extraDirs = []) {
  const pathEnv = String(process.env.PATH || '');
  const dirs = pathEnv.split(path.delimiter).filter(Boolean).concat(extraDirs);
  for (const d of dirs) {
    const p = path.join(d, name + (process.platform === 'win32' ? '.exe' : ''));
    try { if (fs.existsSync(p)) return p; } catch { /* 忽略 */ }
  }
  return null;
}
