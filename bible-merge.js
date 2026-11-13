/**
 * 设定集三方合并（宿主侧纯函数，无副作用，便于单测）。
 *
 * 为什么需要：设定集同时被两个端改写——画布页面（手动编辑 → 推送）与对话侧
 * （`canvas_update_bible` → 直接写宿主）。页面推送一份「基于旧副本」的设定集时，
 * 若宿主机照单全收，就会把对话侧刚补的新版本整份盖回去，并且还会盖上一个
 * `bibleUpdatedAt = Date.now()`（于是旧内容反而成了"最新"，两端再也拉不回来）。
 *
 * 语义：只在「客户端基线时间戳落后于宿主」时调用。三方分别是
 *   prev = 宿主当前值（权威，含对话侧/另一端的新改动）
 *   base = 客户端上次与宿主对齐时的那份（它这次改动是从哪一份开始的）
 *   next = 客户端这次要写入的值
 * 规则：
 *   - 客户端相对 base 没动过的部分 → 保留宿主的新版本（不覆盖）；
 *   - 客户端真改过 / 新增 / 删除的条目 → 按客户端（用户的编辑不丢）；
 *   - 条目按名称（忽略大小写与首尾空白）对齐；宿主新增的条目无条件保留。
 */

const SCALARS = ['worldview', 'style', 'styleAnchor'];
const LISTS = ['characters', 'scenes', 'props'];

const keyOf = (e) => String((e && e.name) || '').trim().toLowerCase();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const asList = (v) => (Array.isArray(v) ? v : []);
/** 条目的"内容"（名称之外的字段）：名称只比对齐后的 key，避免仅空格/大小写不同被当成编辑。 */
const payloadOf = (e) => JSON.stringify({
  desc: String((e && e.desc) || ''),
  assetIds: Array.isArray(e && e.assetIds) ? e.assetIds : [],
});
const sameEntry = (a, b) => keyOf(a) === keyOf(b) && payloadOf(a) === payloadOf(b);

/** 某一类（角色/场景/道具）的三方合并。 */
function mergeList(prev, base, next) {
  const p = asList(prev);
  const b = asList(base);
  const n = asList(next);
  const bm = new Map();
  for (const e of b) { const k = keyOf(e); if (k && !bm.has(k)) bm.set(k, e); }
  const nm = new Map();
  for (const e of n) { const k = keyOf(e); if (k && !nm.has(k)) nm.set(k, e); }
  const out = [];
  const seen = new Set();
  const take = (e) => {
    const k = keyOf(e);
    if (!k || seen.has(k)) return;
    seen.add(k);
    out.push(e);
  };
  // ① 宿主顺序为骨架：客户端没动过的条目用宿主的新值
  for (const e of p) {
    const k = keyOf(e);
    if (!k || seen.has(k)) continue;
    if (!nm.has(k)) {
      // 客户端这份里没有：只有「base 里本来有」才算客户端删除，否则是宿主新增
      if (bm.has(k)) continue;
      take(e);
      continue;
    }
    const changedByClient = !(bm.has(k) && sameEntry(nm.get(k), bm.get(k)));
    take(changedByClient ? nm.get(k) : e);
  }
  // ② 客户端新增的（base 里没有）
  for (const e of n) {
    const k = keyOf(e);
    if (!k || seen.has(k)) continue;
    if (!bm.has(k)) take(e);
  }
  return out;
}

/**
 * @param {object} prev 宿主当前的设定集（权威）
 * @param {object} base 客户端上次对齐时的设定集
 * @param {object} next 客户端这次推送的设定集
 * @returns {object} 合并结果（结构与设定集一致）
 */
export function mergeBibleThreeWay(prev, base, next) {
  const P = prev || {};
  const B = base || {};
  const N = next || {};
  const out = {};
  for (const k of SCALARS) {
    // 客户端改过才采用客户端；没改就保留宿主（含对话侧刚写的新内容）
    out[k] = same(N[k], B[k]) ? String(P[k] || '') : String(N[k] || '');
  }
  for (const k of LISTS) out[k] = mergeList(P[k], B[k], N[k]);
  return out;
}
