#!/usr/bin/env node
/**
 * 把 shot-ai-fill.js 的纯函数区注入 client.js（单一事实源的前端副本）。
 *
 * 为什么：分镜 AI 补全的口径（人数/占位/语气/画面细节/音效）必须**前端按钮**与**对话侧工具**
 * 逐字一致。两份手抄迟早漂移 = 用户点按钮和让 Agent 补全会得到不同的稿子。
 * 所以：shot-ai-fill.js 是唯一手写处，client.js 的 <<<SHOT_AI_FILL_BEGIN>>> 区由本脚本生成。
 *
 * 用法：node scripts/sync-shot-ai-fill.mjs          # 写入并校验
 *       node scripts/sync-shot-ai-fill.mjs --check  # 只校验（CI/回归用；不一致 → 退出码 1）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODULE = path.join(ROOT, 'shot-ai-fill.js');
const CLIENT = path.join(ROOT, 'client.js');
const BEGIN = '// <<<SHOT_AI_FILL_BEGIN>>>';
const END = '// <<<SHOT_AI_FILL_END>>>';
const PURE_BEGIN = '// <<<SHOT_AI_FILL_PURE_BEGIN>>>';
const PURE_END = '// <<<SHOT_AI_FILL_PURE_END>>>';
const checkOnly = process.argv.includes('--check');

const modSrc = fs.readFileSync(MODULE, 'utf8');
const pStart = modSrc.indexOf(PURE_BEGIN);
const pEnd = modSrc.indexOf(PURE_END);
if (pStart < 0 || pEnd < 0) {
  console.error('✗ shot-ai-fill.js 缺少纯函数区标记');
  process.exit(1);
}
const pure = modSrc
  .slice(pStart + PURE_BEGIN.length, pEnd)
  .replace(/^export /gm, '')
  .replace(/\n+$/, '')
  .split('\n')
  .map((line) => (line.trim() ? '    ' + line : line))
  .join('\n');

const clientSrc = fs.readFileSync(CLIENT, 'utf8');
const bIdx = clientSrc.indexOf(BEGIN);
const eIdx = clientSrc.indexOf(END);
if (bIdx < 0 || eIdx < 0 || eIdx < bIdx) {
  console.error('✗ client.js 缺少 <<<SHOT_AI_FILL_BEGIN>>>/<<<SHOT_AI_FILL_END>>> 标记');
  process.exit(1);
}
const head = clientSrc.slice(0, bIdx + BEGIN.length);
const tail = clientSrc.slice(eIdx);
const next = head + '\n' + pure + '\n    ' + tail;

if (next === clientSrc) {
  console.log('✓ client.js 的分镜补全纯函数区已是最新');
  process.exit(0);
}
if (checkOnly) {
  console.error('✗ client.js 的分镜补全纯函数区与 shot-ai-fill.js 不一致——跑 node scripts/sync-shot-ai-fill.mjs');
  process.exit(1);
}
fs.writeFileSync(CLIENT, next);
console.log('✓ 已把 shot-ai-fill.js 的纯函数区同步进 client.js（' + pure.split('\n').length + ' 行）');
