// 分镜 AI 补全的**单一事实源**（0.20.7-local.7）。
//
// 这份文件是纯函数模块，宿主 index.js 直接 import 它；前端 client.js 里有一段**逐字相同**的副本
// （由 scripts/sync-shot-ai-fill.mjs 注入，标记 <<<SHOT_AI_FILL_BEGIN>>> … <<<SHOT_AI_FILL_END>>>），
// scripts/test-shot-ai-fill.mjs 断言两端逐字一致——两端漂移 = 按钮口径和对话口径分叉，测试必须红。
//
// 为什么必须是纯函数：补全口径（人数/占位/语气/画面细节/音效）要同时在
//   ① 前端按钮「AI 补全全部分镜」
//   ② 对话侧工具 canvas_ai_fill_board
// 生效，两边必须一字不差，否则用户点按钮和让 Agent 补全会得到不同的稿子。

// <<<SHOT_AI_FILL_PURE_BEGIN>>>
/** 自动标题前缀（前端 T('shotPrefix') 的同源常量）：中文「镜 N」，英文「Shot N」。 */
export const SHOT_PREFIX_ZH = '镜';
export const SHOT_PREFIX_EN = 'Shot ';

/** 自动标题判定：形如「镜3」/「Shot 3」= 没写过标题（AI 可替换）；其余 = 用户写过，必须保留。 */
export function isAutoTitle(title, shotPrefix) {
  const raw = String(title || '').trim();
  if (!raw) return true;
  const prefix = String(shotPrefix || SHOT_PREFIX_ZH);
  try {
    return new RegExp('^(' + prefix + '|Shot)\\s*\\d+$', 'i').test(raw);
  } catch {
    return false;
  }
}

/**
 * 分镜单镜补全的提示词构建（唯一口径）。
 * 输入：当前镜头（用户已填，作为意图）、上一镜、下一镜、项目设定集文本、本表额外要求、表名。
 * 输出：{ system, user } —— 直接喂 LLM。
 *
 * 五项硬要求（用户口径）：
 *   ① 人物人数 people  ② 人物占位 blocking  ③ 台词语气 tone
 *   ④ 画面细节 visual  ⑤ 环境音效 sfx（无台词镜禁人声、任何镜头禁背景音乐）
 */
export function buildFillPrompt({ cur, prev, next, bibleText, requirement, nodeLabel, zh }) {
  const jsonShape = '{"title":"…","visual":"…","motion":"…","timeBeats":["0s …","中段 …","结尾 …"],"camera":"…","vfx":"…","negative":"…","tail":"…","cam":"…","start":"…","seg":"continuation","characters":["…"],"people":2,"blocking":"…","scene":"…","props":["…"],"duration":3,"dialogue":[{"role":"…","line":"…","tone":"…"}],"sfx":"…"}';
  const system = [
    zh ? '你是短剧分镜师。只输出一个 JSON 对象，不要解释、不要 Markdown 围栏。' : 'You are a short-drama storyboard artist. Output ONE JSON object only, no prose, no fences.',
    (zh ? 'JSON 结构：' : 'JSON shape: ') + jsonShape,
    zh ? 'visual 写画面（景别/人物/场景/光线/色调），motion 写动作与运镜，timeBeats 三拍写可见状态（起势→发力→落点），camera 写机位+焦段光圈+运镜起止，vfx 写可见特效，tail 写本镜最后一刻的接点尾态（动作进行中），cam 写留给下一镜的运镜延续。'
      : 'visual = frame; motion = action & camera; timeBeats = three visible beats; camera = position + lens + move start/end; vfx = visible effects; tail = state at the last frame (mid-action); cam = camera carry-over for the next shot.',
    zh ? '角色/场景/道具名称必须来自设定集，visual/motion 里用 @名称@ 引用；不得新增设定集里没有的实体。'
      : 'Names must come from the bible; reference them as @Name@ inside visual/motion; never invent entities.',
    zh ? '必须承接上一镜的 tail/cam（若无上一镜则开场建立空间），并为下一镜留可接的 tail/cam。'
      : 'Continue the previous shot tail/cam (or establish the space when first), and leave a tail/cam the next shot can pick up.',
    zh ? 'dialogue 只填用户已给的台词原文，不得新写；sfx 只写环境声/拟音，绝不写音乐/配乐/BGM。'
      : 'dialogue only carries lines the user already gave; sfx is ambience/foley only — never music/score/BGM.',
    // ——【人数 / 占位 / 声音硬规则】这一组是「人物多出来、站位乱、背景冒人声」的直接解药 ——
    zh ? '人数（必须）：people 写这一镜画面里**实际出现的人数**（整数；只露背影/半身/手部的也算；空镜写 0）；people 必须与 visual 里出现的人物数量一致——多写一个人模型就会多生一张脸。'
      : 'People (required): people is the integer count of people ACTUALLY visible (a back, a silhouette or just hands still count; 0 for an empty frame); it must match the people described in visual — one extra count makes the model grow an extra face.',
    zh ? '占位（必须）：blocking 写每个出场人物在画幅里的位置与朝向，用「@名称@ 位置+景别+朝向」的写法，如「@林晚@ 右侧前景半身正面；@王勃@ 左侧中景侧身背对镜头」；同一轴线，跨镜不得左右互换（上一镜在左的人本镜仍在左，除非画面明确调度）。'
      : 'Blocking (required): blocking states where each visible character stands in frame and which way they face, as "@Name@ position+framing+orientation" (e.g. "@Lin Wan@ right foreground, half body, facing camera; @Wang Bo@ left midground, side-on, back to camera"); stay on one screen axis — a character on the left stays on the left unless the staging says otherwise.',
    zh ? '音效（硬性）：sfx 只写环境声与拟音（如「雨打车顶」「远处车流」「布料摩擦」）；**任何镜头都不许出现背景音乐/配乐/BGM/旋律/鼓点**；本镜没有台词时，**绝不允许出现任何人的说话声、人声、旁白、画外音、对白**——只留环境声与拟音。'
      : 'Sound (hard): sfx is ambience and foley ONLY (e.g. "rain on the roof", "distant traffic", "fabric rustle"); NEVER background music/score/BGM/melody/drum groove in any shot; and when the shot has NO dialogue, absolutely NO human voice may appear (no speaking, no voice-over, no off-screen speech) — ambience and foley only.',
    zh ? '画面细节（必须）：visual 除了景别/人物/场景/光线/色调，还要写可拍的环境细节（前景遮挡物、材质质感、光斑/反射、空气中的尘埃雨雾、背景层次与虚实），不要只写「他在房间里」。'
      : 'Picture detail (required): besides framing, people, location, light and palette, visual must carry filmable environment detail (foreground occluders, material texture, highlights/reflections, dust/rain/haze in the air, background layers and depth of field) — not just "he is in a room".',
    zh ? '表情（必须）：每个有角色的镜，visual 必须写可拍的肌肉级表情——眉/眼睑/鼻翼/下颌/吞咽/屏息/呼吸起伏的具体状态（如「眉心压出竖纹、眼睑半垂、下颌线绷紧」），并承接上一镜尾态的表情余势；禁止形容词（愤怒/悲伤/紧张/凶狠）和「表情复杂/意味深长」这类空话；motion 可写一次微表情变化（眼珠移向、喉结滚动、嘴角向下压）。'
      : 'Expression (required): every shot with a character must give filmable muscular-level expression in visual - specific states of brow / eyelids / nostrils / jaw / swallowing / held breath / breathing (e.g. "vertical crease between brows, eyelids half lowered, jaw line tight"), carrying the previous shot\'s tail expression forward; no adjectives (angry/sad/tense) and no vague filler; motion may carry one micro-change (eyes flick, throat bobs, mouth corner pulls down).',
    zh ? '语气（必须）：dialogue 每条除原文 line 外必须给 tone——可执行的发声指令：音量、气声/实声、语速、尾音、情绪落点（如「低声压着气、尾音发虚、几乎气声」）；line 原文一字不改，不得新增或改写台词；用户没写语气时你负责补。'
      : 'Tone (required): besides the verbatim line, every dialogue entry must carry tone - executable vocal direction: volume, breathy vs chest voice, pace, tail-off, emotional landing (e.g. "low and held-in, tail fading, almost whispered"); never alter or invent the line text; fill the tone when the user left it empty.',
    zh ? 'duration 按节奏给一位小数（快切 0.3–0.8s，对白 2–4s，情绪长镜 ≥5s）；seg 只能是 opening/continuation/scene_change/new_character/closeup/state_jump。'
      : 'duration in seconds (one decimal, pacing-aware); seg must be opening/continuation/scene_change/new_character/closeup/state_jump.',
  ].join('\n');
  const brief = (shot, tag) => {
    if (!shot) return '';
    const parts = [
      (zh ? '标题：' : 'title: ') + String(shot.title || ''),
      (zh ? '画面：' : 'visual: ') + String(shot.visual || ''),
      (zh ? '动作：' : 'motion: ') + String(shot.motion || ''),
      (zh ? '时长：' : 'duration: ') + String(shot.duration || ''),
      (zh ? '段落：' : 'seg: ') + String(shot.seg || ''),
      (zh ? '尾态：' : 'tail: ') + String(shot.tail || ''),
      (zh ? '运镜：' : 'cam: ') + String(shot.cam || ''),
      (zh ? '台词：' : 'dialogue: ') + (Array.isArray(shot.dialogue) ? shot.dialogue.map((d) => String((d && d.role) || '') + (String((d && d.tone) || '').trim() ? '（' + String(d.tone).trim() + '）' : '') + '：' + String((d && d.line) || '')).join('；') : ''),
      (zh ? '音效：' : 'sfx: ') + String(shot.sfx || ''),
    ].filter((x) => !/[:：]\s*$/.test(x));
    return (zh ? '【' : '[') + tag + (zh ? '】' : '] ') + '\n' + parts.join('\n');
  };
  const user = [
    (zh ? '分镜表：' : 'Storyboard: ') + String(nodeLabel || ''),
    String(bibleText || '').trim() ? (zh ? '项目设定集：\n' : 'Series bible:\n') + String(bibleText).trim() : '',
    String(requirement || '').trim() ? (zh ? '本表额外要求：\n' : 'Board requirements:\n') + String(requirement).trim() : '',
    brief(prev, zh ? '上一镜' : 'previous shot'),
    brief(cur, zh ? '本镜（用户已填，作为意图输入，可补全/改写）' : 'this shot (user input — complete or rewrite)'),
    brief(next, zh ? '下一镜' : 'next shot'),
    zh ? '请输出补全后的本镜 JSON。' : 'Output the completed shot JSON now.',
  ].filter(Boolean).join('\n\n');
  return { system, user };
}

/**
 * 音效硬清洗（用户口径）：任何镜头都不得出现背景音乐/配乐；没有台词的镜头连人声都不许有。
 * 分镜音效只允许环境声与拟音——模型默认爱给"电影感"铺配乐，也爱在空镜里塞旁白。
 */
export function sanitizeSfx(text, hasDialogue) {
  const segs = String(text || '').split(/[、，,;；]/).map((x) => x.trim()).filter(Boolean);
  const musicRe = /(背景音乐|配乐|音乐|BGM|bgm|乐章|旋律|片头曲|片尾曲|插曲|ost|soundtrack|\bscore\b|\bmusic\b)/i;
  // 道具本身发出的声音（音乐盒、钢琴、钟铃……）是**画内**声音，不是配乐，必须留下。
  const diegeticRe = /(音乐盒|八音盒|钢琴|琴声|吉他|古筝|二胡|箫|笛|锣|铃|钟|唱机|收音机|电视|闹钟|扩音器)/i;
  const voiceRe = /(人声|说话声|对白|旁白|画外音|交谈|聊天|议论|喊|呼|笑声|说话|voice|speaking|dialogue|narration|chatter|off-screen)/i;
  const keep = segs.filter((s) => {
    if (musicRe.test(s) && !diegeticRe.test(s)) return false;
    if (!hasDialogue && voiceRe.test(s)) return false;
    return true;
  });
  return keep.join('、').slice(0, 120);
}

/**
 * 整表补全的合并口径：台词原文一字不改（只补语气）、时长与段类型不动、用户写过的标题保留；
 * AI 没填的字段回落到原值（不拿空白覆盖用户已写的内容）。
 */
export function mergeFilledShot(orig, ai, i, shotPrefix) {
  const o = orig || {};
  const a = ai || {};
  const keepTitle = !isAutoTitle(o.title, shotPrefix);
  const pick = (k) => {
    const v = a[k];
    if (Array.isArray(v)) return v.length ? v : (Array.isArray(o[k]) ? o[k] : []);
    // 数组字段（characters/props/timeBeats）：AI 没给就整段回落，绝不降级成字符串。
    if (Array.isArray(o[k]) && !(v && String(v).trim())) return o[k];
    const s = String(v == null ? '' : v).trim();
    return s ? s : String(o[k] == null ? '' : o[k]).trim();
  };
  // 台词：只认用户已经写好的原文；AI 只能补语气（没语气就补），绝不新增台词。
  const userDlg = (Array.isArray(o.dialogue) ? o.dialogue : []).filter((d) => d && String(d.role || '').trim() && String(d.line || '').trim());
  const aiDlg = Array.isArray(a.dialogue) ? a.dialogue : [];
  const dialogue = userDlg.map((d) => {
    const hit = aiDlg.find((x) => String(x && x.role || '').trim() === String(d.role || '').trim()
      && String(x && x.line || '').trim() === String(d.line || '').trim());
    return {
      role: String(d.role || '').trim().slice(0, 24),
      line: String(d.line || '').trim().slice(0, 200),
      tone: String(d.tone || (hit && hit.tone) || '').trim().slice(0, 40),
    };
  });
  const peopleRaw = Number(a.people);
  const people = Number.isFinite(peopleRaw) && String(a.people).trim() !== ''
    ? Math.max(0, Math.round(peopleRaw))
    : (Number(o.people) || 0);
  const prefix = String(shotPrefix || SHOT_PREFIX_ZH);
  return {
    title: keepTitle ? o.title : (pick('title') || (prefix + (i + 1))),
    visual: pick('visual'),
    motion: pick('motion'),
    timeBeats: (Array.isArray(a.timeBeats) && a.timeBeats.length ? a.timeBeats : (Array.isArray(o.timeBeats) ? o.timeBeats : [])),
    camera: pick('camera'),
    vfx: pick('vfx'),
    negative: pick('negative'),
    tail: pick('tail'),
    cam: pick('cam'),
    start: pick('start'),
    // 时长与段类型不动：改了就打乱 4–10s 拆表与切段计划。
    duration: Math.max(0.3, Math.round((Number(o.duration) || Number(a.duration) || 3) * 10) / 10),
    seg: String(o.seg || a.seg || 'continuation'),
    characters: pick('characters'),
    people,
    blocking: pick('blocking').slice(0, 200),
    scene: pick('scene'),
    props: pick('props'),
    dialogue,
    sfx: sanitizeSfx(pick('sfx'), dialogue.length > 0),
  };
}
// <<<SHOT_AI_FILL_PURE_END>>>

/**
 * 从模型输出里抠出一个 JSON 对象（平衡括号扫描，能吃 ```json 围栏与前后废话）。
 * 与前端 parseJsonBalanced 同口径：先剥围栏，再从第一个 { 扫到配对的 }。
 * 失败时把原始输出的一小截带进错误信息——否则「没输出 JSON」永远是黑箱。
 */
export function parseShotJson(raw) {
  const text0 = String(raw == null ? '' : raw);
  const snippet = (s) => {
    const flat = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    return flat ? flat.slice(0, 160) : '（空输出）';
  };
  let text = text0.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fence) text = String(fence[1] || '').trim();
  const start = text.indexOf('{');
  if (start < 0) throw new Error('模型输出里没有 JSON 对象（输出片段：' + snippet(text0) + '）');
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return JSON.parse(text.slice(start, i + 1));
    }
  }
  throw new Error('模型输出的 JSON 不完整（输出片段：' + snippet(text0) + '）');
}

/** 设定集 → 补全提示词用的文本块（世界观/风格/角色/场景/道具）。 */
export function bibleBlock(b) {
  if (!b) return '';
  const lines = [];
  if ((b.worldview || '').trim()) lines.push('世界观/核心设定：' + b.worldview.trim());
  if ((b.style || '').trim()) lines.push('风格基调：' + b.style.trim());
  for (const c of b.characters || []) if ((c.name || '').trim()) lines.push(`角色 ${c.name.trim()}：${(c.desc || '').trim()}`);
  for (const c of b.scenes || []) if ((c.name || '').trim()) lines.push(`场景 ${c.name.trim()}：${(c.desc || '').trim()}`);
  for (const c of b.props || []) if ((c.name || '').trim()) lines.push(`道具 ${c.name.trim()}：${(c.desc || '').trim()}`);
  return lines.join('\n');
}
