#!/usr/bin/env node
/**
 * 本地构建（0.20.5-local.x）的接线守卫：防止跟上游合并时把本地三件交互悄悄丢掉。
 *
 * 断言（源码级，零副作用）：
 *   1  「AI 完善提示词」必须走**无限画布技能**：canvas-craft 章节切片 + 技能包切片 + 图片档风格锁；
 *      退回通用模板（只剩 bibleBlock）会在这里红。
 *   2  图片/视频节点的本地上传必须落到同一套资产管道（saveAssetRecord → commitGenResult），
 *      并且文件选择器是**点击时创建**（渲染树里只有 标题栏/预览区/操作栏 三段，见 test-node-layout）。
 *   3  分镜编辑器「AI 补全本镜」必须以当前表单 + 上下镜为输入，并保护用户已写的台词。
 *   4  新增的 i18n 键在中英两份字典里都存在。
 *
 * 运行：node scripts/test-local-ai-helpers.mjs（退出码 0=通过）
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(path.join(ROOT, 'client.js'), 'utf8');
const errs = [];
const ok = (c, m) => { if (!c) errs.push(m); };

// 取一个函数的源码块（从签名到下一个顶层 `    /**` 注释或函数声明）
function fnBlock(sig) {
  const i = src.indexOf(sig);
  if (i < 0) return '';
  const rest = src.slice(i);
  const end = rest.search(/\n    (?:\/\*\*|\/\*|(?:async )?function |const )/);
  return end > 0 ? rest.slice(0, end) : rest.slice(0, 8000);
}

// ---------- 1) AI 完善提示词 = 画布技能 ----------
{
  const b = fnBlock('async function aiPolishImagePrompt(');
  ok(!!b, '找不到 aiPolishImagePrompt（本地功能被移除？）');
  ok(/buildExpertContext\(kind/.test(b), 'AI 完善提示词没有取画布技能包切片（buildExpertContext）');
  ok(/buildShotLockText\(kind, \{ medium: 'image' \}\)/.test(b), 'AI 完善提示词没有取「图片档」技能包风格锁（buildShotLockText medium:image）');
  ok(/hostRpc\('readSkill', \{ name: CRAFT_SKILL \}\)/.test(b), 'AI 完善提示词没有读 canvas-craft 技能正文');
  ok(/skillSections\(/.test(b), 'AI 完善提示词没有按章节切片技能正文（整本 47KB 塞进一次请求）');
  ok(/'assets' : 'prompt'/.test(b) || /isSheet \? 'assets' : 'prompt'/.test(b), '设定图 / 普通画面没有分能力切片（assets / prompt）');
  const ss = fnBlock('function skillSections(');
  ok(!!ss, '缺少 skillSections（技能章节切片）');
  ok(/split\(\/\\n\(\?=## \)\//.test(ss), 'skillSections 没有按 `## ` 标题切分');
}

// ---------- 2) 节点上传 = 同一套资产管道 ----------
{
  const b = fnBlock('const doUpload = async (file) => {');
  ok(!!b, '找不到 doUpload（媒体节点本地上传）');
  ok(/saveAssetRecord\(S\.activeId/.test(b), '上传没有走 saveAssetRecord（资产不会入库）');
  ok(/commitGenResult\(n\.id, rec\.id, false/.test(b), '上传结果没有写成节点成图（commitGenResult）');
  ok(/probeVideoMeta\(/.test(b), '视频上传没有读元数据（比例/时长不会校正）');
  ok(/recordMediaDims\(/.test(b), '上传没有记录实测尺寸（节点框比例不会收敛）');
  const pick = fnBlock('const pickUploadFile = () => {');
  ok(!!pick, '缺少 pickUploadFile');
  ok(/document\.createElement\('input'\)/.test(pick), '文件选择器没有在点击时创建（会破坏 body 三段结构门禁）');
  ok(!/h\('input', \{\s*key: 'upload-file'/.test(src), '渲染树里仍残留上传用的 <input>（body 结构门禁会红）');
}

// ---------- 3) 分镜编辑器 AI 补全 ----------
{
  const b = fnBlock('const aiFillThisShot = async () => {');
  ok(!!b, '找不到 aiFillThisShot（分镜编辑器 AI 补全）');
  ok(/prev: idx > 0 \? shots\[idx - 1\] : null/.test(b), 'AI 补全没有把上一镜作为上下文');
  ok(/next: idx < shots\.length - 1 \? shots\[idx \+ 1\] : null/.test(b), 'AI 补全没有把下一镜作为上下文');
  ok(/aiCompleteShot\(\{/.test(b), 'AI 补全没有调用 aiCompleteShot');
  ok(/normalizeEditedShot\(/.test(b), 'AI 补全结果没有经过字段归一（会绕过容量/长度约束）');
  ok(/if \(userDlg\.length\) filled\.dialogue = userDlg/.test(b), 'AI 补全会覆盖用户已写的台词（应保护）');
}

// ---------- 4) i18n 键（中英各一份） ----------
{
  const keys = ['aiUploadImage', 'aiUploadVideo', 'aiUploadShort', 'aiUploadHint', 'aiUploadReplace', 'aiUploading',
    'aiUploaded', 'aiUploadFail', 'aiUploadType', 'aiPolish', 'aiPolishHint', 'aiPolishing', 'aiPolishDone',
    'aiPolishFail', 'aiFillShot', 'aiFillShotHint', 'aiFilling', 'aiFillDone', 'aiFillFail'];
  for (const k of keys) {
    const n = (src.match(new RegExp("'" + k + "':", 'g')) || []).length;
    ok(n >= 2, 'i18n 键缺一份（中/英）：' + k + '（出现 ' + n + ' 次）');
  }
}

if (errs.length) {
  console.error('✗ 本地交互接线守卫未通过（' + errs.length + ' 项）：');
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('✓ 本地交互接线守卫通过（AI 完善提示词走 canvas-craft 章节+技能包+图片档风格锁；上传走资产管道且渲染树三段不变；编辑器 AI 补全带上下镜上下文并保护台词）');
process.exit(0);
