// 设定集三方合并单测：宿主只在「客户端基线落后」时用它，核心口径是
// 「客户端没动过的部分保留宿主的新版本，客户端真改过的部分不丢」。
// 背景事故：页面推一份基于旧副本的设定集，宿主整份采用并盖上新的 bibleUpdatedAt，
// 于是对话侧刚补的新版本被旧内容覆盖，两端再也拉不回来（用户看到「设定集改了又变回去」）。
import { readFileSync } from 'node:fs';
import { mergeBibleThreeWay } from '../bible-merge.js';

const errs = [];
const eq = (a, b, label) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    errs.push(`${label}\n    期望 ${JSON.stringify(b)}\n    实际 ${JSON.stringify(a)}`);
  }
};

// 宿主当前值（prev）：对话侧刚把「医院病房」的 desc 改成了新的，并新增了一个场景
const prev = {
  worldview: '双重时空',
  style: '3D 国漫',
  styleAnchor: '暖金体积光',
  characters: [{ name: '林晚', desc: '旧外观' }],
  scenes: [
    { name: '医院病房', desc: '新描述：单人病房、两张床、窗外银杏金黄。' },
    { name: '江边长堤', desc: '宿主新增的场景' },
  ],
  props: [],
};
// 客户端基线（base）：它上次对齐时看到的宿主旧版
const base = {
  worldview: '双重时空',
  style: '3D 国漫',
  styleAnchor: '暖金体积光',
  characters: [{ name: '林晚', desc: '旧外观' }],
  scenes: [{ name: '医院病房', desc: '旧描述：白色病房。' }],
  props: [],
};

// ① 客户端这次只改了角色（没碰场景）→ 场景必须是宿主的新版本，角色用客户端的
{
  const next = {
    ...base,
    characters: [{ name: '林晚', desc: '客户端新外观：唐装' }],
    scenes: base.scenes, // 旧副本原样带回
  };
  const out = mergeBibleThreeWay(prev, base, next);
  eq(out.characters[0].desc, '客户端新外观：唐装', '客户端真改过的条目要保留');
  eq(out.scenes.find((s) => s.name === '医院病房').desc, prev.scenes[0].desc, '客户端没动过的场景不能覆盖宿主的新版本');
  eq(out.scenes.some((s) => s.name === '江边长堤'), true, '宿主新增的条目要保留');
}

// ② 客户端改了场景 → 用客户端的，同时宿主新增的另一条仍在
{
  const next = {
    ...base,
    scenes: [{ name: '医院病房', desc: '客户端又改了：夜里的病房。' }],
  };
  const out = mergeBibleThreeWay(prev, base, next);
  eq(out.scenes.find((s) => s.name === '医院病房').desc, '客户端又改了：夜里的病房。', '客户端改过的场景以客户端为准');
  eq(out.scenes.some((s) => s.name === '江边长堤'), true, '合并后宿主新增条目仍在');
}

// ③ 客户端删除条目（基线里有、这次没有）→ 删除；宿主新增条目不受影响
{
  const next = { ...base, characters: [] };
  const out = mergeBibleThreeWay(prev, base, next);
  eq(out.characters.length, 0, '客户端删除的条目要删掉');
  eq(out.scenes.length, prev.scenes.length, '删除角色不影响场景');
}

// ④ 客户端新增条目（基线里没有）→ 保留
{
  const next = { ...base, props: [{ name: '油灯', desc: '陶制小油灯' }] };
  const out = mergeBibleThreeWay(prev, base, next);
  eq(out.props.length, 1, '客户端新增的条目要保留');
  eq(out.props[0].name, '油灯', '新增条目名称');
}

// ⑤ 标量字段：没改过用宿主，改过用客户端
{
  const next = { ...base, worldview: '双重时空（客户端改）', style: base.style };
  const out = mergeBibleThreeWay(prev, base, next);
  eq(out.worldview, '双重时空（客户端改）', '客户端改过的标量以客户端为准');
  eq(out.style, prev.style, '客户端没改的标量保留宿主值');
  // 宿主侧标量被对话侧改过、客户端没动 → 用宿主
  const prev2 = { ...prev, style: '宿主新风格' };
  eq(mergeBibleThreeWay(prev2, base, next).style, '宿主新风格', '宿主改过的标量不能被旧副本盖回');
}

// ⑥ 名称对齐：大小写/首尾空白不同视为同一条
{
  const p = { scenes: [{ name: 'Hospital', desc: 'host new' }] };
  const b = { scenes: [{ name: ' hospital ', desc: 'old' }] };
  const n = { scenes: [{ name: 'Hospital', desc: 'old' }] };
  eq(mergeBibleThreeWay(p, b, n).scenes[0].desc, 'host new', '名称忽略大小写与空白后对齐');
}

// ⑦ 空/缺字段不崩、保持空结构
{
  const out = mergeBibleThreeWay(null, null, null);
  eq(out.scenes, [], '全空输入返回空列表');
  eq(out.worldview, '', '全空输入返回空标量');
  const out2 = mergeBibleThreeWay({}, {}, { props: [{ name: 'a', desc: 'b' }] });
  eq(out2.props.length, 1, 'base 为空时客户端条目算新增');
}

// ⑧ 接线守卫：光有合并函数不算修好——客户端必须带基线、宿主必须真的用它，
//    任何一端被改回去（或上游覆盖丢字段），这条防线都会静默失效。
{
  const idx = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const cli = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
  if (!/mergeBibleThreeWay\(/.test(idx)) errs.push('宿主 projectsPut 没有调用 mergeBibleThreeWay（旧副本会整份覆盖新版本）');
  if (!/bibleBaseAt/.test(idx) || !/bibleStale\(/.test(idx)) errs.push('宿主没有读取/判定客户端基线 bibleBaseAt');
  if (!/bibleMergedOut/.test(idx)) errs.push('宿主合并后没有回传生效设定集（客户端会缺宿主那份的新条目）');
  if (!/bibleBaseAt: baseAt/.test(cli)) errs.push('客户端推送没有带基线时间戳 bibleBaseAt');
  if (!/bibleBase: base/.test(cli)) errs.push('客户端推送没有带基线内容 bibleBase（宿主无法三方合并）');
  if (!/function commitBiblePush\(/.test(cli) || !/function adoptHostBible\(/.test(cli)) errs.push('客户端缺少 commitBiblePush/adoptHostBible（同步戳与基线不会一起推进）');
}

if (errs.length) {
  console.error('✗ 设定集三方合并测试未通过（' + errs.length + ' 项）：');
  for (const e of errs) console.error('  - ' + e);
  process.exit(1);
}
console.log('✓ 设定集三方合并测试通过（未改动的保留宿主新值 / 改过的以客户端为准 / 增删与标量/名称对齐）');
