#!/usr/bin/env node
/**
 * 作用域守卫（0.20.6-local.2）：zh 语言开关未声明 = 画布前端运行时炸。
 *
 * 为什么存在：上游 0.20.5 在 genStoryboardNode() 里加了打斗几何校验
 * `validateCombatGeometry(sh, zh)`，但 `zh`（语言开关）在那个函数作用域里从来没声明过——
 * 只要分镜生成走到落盘前那段（combatMode 默认 auto），就抛 `ReferenceError: zh is not defined`，
 * 用户看到的是「分镜表直接失败、稿子一行没写」（2026-11-12 实机复现，见 CHANGELOG）。
 *
 * 这类 bug 静态 `node --check` 抓不到（语法合法），单元测试也抓不到（那条路径要真实生成才走到），
 * 但它的形状很固定：**在 A 函数里调用了一个吃 zh 的函数，而 A 里没有 zh**。
 * 本守卫就查这个形状：受检调用点的最近外围函数必须有 zh（声明或参数）。
 *
 * 覆盖范围是**策展清单**（不是全文件 lint）：全文件扫 zh 会命中大量嵌套箭头函数里合法的
 * 外层 zh 捕获，噪声不可用。清单里的函数是「必须显式拿到 zh 才能正确选语言」的那几个。
 *
 * 运行：node scripts/test-client-language-scope.mjs        退出码 0=通过 / 1=失败
 * 自证：把 client.js 换回上游 0.20.5 原版（去掉那条声明）→ 本测试必须变红。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = process.argv[2] || path.join(ROOT, 'client.js');
const lines = readFileSync(SRC, 'utf8').split('\n');

// 受检函数：调用时必须能拿到 zh（声明或同名参数）
const WATCH = ['validateCombatGeometry', 'combatContractAddendum', 'combatCausalityText'];

const fnStart = /^\s*(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(|^\s*(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?\(/;
const zhOK = /(?:\b(?:const|let|var)\s+zh\b)|(?:\([^)]*\bzh\b[^)]*\)\s*(?:=>|\{))|(?:function\s*[A-Za-z0-9_$]*\s*\([^)]*\bzh\b)/;

const errs = [];
const seen = [];

for (const name of WATCH) {
  const callRe = new RegExp('(?<![A-Za-z0-9_$.])' + name + '\\s*\\(', 'g');
  let sites = 0;
  lines.forEach((line, idx) => {
    // 跳过定义行与注释行
    if (/^\s*(?:async\s+)?function\s+/.test(line) && line.includes(name)) return;
    if (/^\s*\*/.test(line) || /^\s*\/\//.test(line)) return;
    callRe.lastIndex = 0;
    if (!callRe.test(line)) return;
    sites++;
    const callIndent = line.length - line.trimStart().length;
    // 由近及远收集缩进更小的候选签名（缩进 ≥ 调用行的签名是平级/内层，不是它的作用域）
    const chain = [];
    for (let j = idx; j >= 0; j--) {
      const m = fnStart.exec(lines[j]);
      if (!m) continue;
      const ind = lines[j].length - lines[j].trimStart().length;
      if (ind >= callIndent) continue;
      chain.push({ line: j, name: m[1] || m[2], arrow: !m[1] });
    }
    if (!chain.length) { errs.push(`L${idx + 1} ${name}() 调用找不到外围函数`); return; }
    // 最近一层就是它的作用域；但若最近一层是箭头函数（const x = (...) =>），
    // 箭头捕获外层 zh 是合法写法 → 向外取到最近的 function 声明为止。
    let ci = 0;
    while (chain[ci].arrow && ci + 1 < chain.length) ci++;
    const scope = chain[ci];
    const inner = chain[0].name;
    seen.push(`${inner}() → ${name}()`);
    if (!zhOK.test(lines.slice(scope.line, idx + 1).join('\n'))) {
      errs.push(`L${idx + 1} ${inner}() 调用 ${name}()，但 ${scope.name}() 作用域里没有 zh（会抛 ReferenceError: zh is not defined）`);
    }
  });
  // 调用点数不能为 0：防止守卫被"重构掉调用点"顺带失效
  if (name === 'validateCombatGeometry' && sites === 0) {
    errs.push('未找到 validateCombatGeometry() 的任何调用点（守卫失效：调用被删/改名了？）');
  }
}
if (errs.length) {
  console.error('✗ 作用域守卫未通过（' + errs.length + ' 项）：');
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('✓ 作用域守卫通过：' + [...new Set(seen)].join('；') + ' —— 每个受检调用点都能拿到 zh');
