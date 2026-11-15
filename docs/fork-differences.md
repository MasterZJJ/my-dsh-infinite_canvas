# 与上游的差异（fork 说明）

- 上游：[NINKCH/dsh-infinite_canvas](https://github.com/NINKCH/dsh-infinite_canvas)
- 本仓库基线：上游 **0.21.0**（2026-11 合入；`0.20.5 → 0.21.0` 的三路合并记录见 CHANGELOG 的 `[Unreleased]`）
- 本仓库版本：**0.21.0-local.1**（`package.json` 的 `-local.N` 后缀让插件自带的更新检查不再提示覆盖本地改造）
- 许可：Apache-2.0，与上游一致；`LICENSE` 保持上游原文，`NOTICE` 追加了本 fork 的修改声明

逐条明细见 [`CHANGELOG.md`](../CHANGELOG.md) 的 `[0.20.5-local.*]` 段落，这里是速览。

## 1. 4–10s 分镜表工作流（核心差异）

上游口径：一张分镜表 = 一次多镜头视频生成（表内切段）。
本 fork：**一张 4–10s 分镜表 = 一次视频生成，一场戏可以有多张表**。

- `planStoryboardBoards` / `splitStoryboardIntoBoards`：生成完成后按真实镜头边界自动拆表；
  原表保留为第 1 张，其余竖排在下方并以 `tail→prev` 串联，末张接出本场对下一场的 `tail` 边。
- 每张表带 `boardGroupId / boardIndex / boardCount / boardFrom / boardTo / boardSource / boardScript`。
- `boardScript` 是「本表范围·硬性」说明书：单表重生成只改本表，不会把整场再生成一遍。
- 自动创作免费段：按 `boardGroupId` 收回同场全部表逐张过 G2，第 2..N 张不过闸可单独重生成一次，
  下一场的 `prev` 接到末张。
- 拆出的表写 `targetDuration = null`（总时长走「按镜头节奏自动」），与上游 0.20.4 的总时长硬约束并存不冲突。

## 2. 分镜逐镜编辑器（上游没有）

全屏浮层：左镜头清单 / 右逐镜表单，可改标题、时长、画面、动作、时间节拍、机位、特效、负面、台词
（逐行 说话人+原文）、音效、角色、场景、道具、`seg`、`tail/cam/start`；支持新增/删除/上下移动镜头
与台词行；保存时按生成侧同一套上限归一化、重算 `boardScript` 与一致性告警。

## 3. 媒体节点上传本地素材

- 图片节点传图片、**视频节点传视频**；上传即写入资产库并直接成为该节点成图（进 8 张历史，
  可被下游当参考图 / 首帧 / 成片素材），不触发生成、不消耗模型额度。
- 节点框按素材实测比例自适应（图片 `createImageBitmap`、视频读元数据），视频时长记进 `data.assetDur`。
- 文件选择器点击时才创建，渲染树仍严格是「标题栏 / 预览区 / 操作栏」三段。

## 4. 「AI 完善提示词」= 资产设定图口径

图片节点生成面板里的按钮，**不是**普通画面描述，而是按 canvas-craft「二·五 资产设定图版式」产出：

1. AI 只解析 `{品类, 资产名, 外观}`（人说「道具：一根羽毛」即可；品类：人/动物→角色，空间/地点→场景，
   物件/器物/材质/生物残件→道具；外观必须写材质、配色色名、结构、尺寸参照、磨损状态）；
2. 版式交给画布既有的 `buildAssetSheetPrompt(kind, name, desc, bible)` 组装——与「自动建资产节点」
   同一份实现（角色六段式 / 道具「标题+45°主图+细节+侧视+色卡」/ 场景「主场景+环绕小图」）；
3. 技能注入：`canvas-craft` 章节切片（`## 二·五` + `## 三`）、画布技能包 `assets` 切片
   （导演/题材/规格/影调）、`buildShotLockText('assets', {medium:'image'})` 图片档风格锁；
4. 品类/名称向设定集对齐（设定集条目是最终权威），命中条目时外观以设定集为准、AI 只细化。

## 5. 分镜编辑器「AI 补全本镜」

以该镜表单现有内容为意图，结合上一镜 `tail/cam`、下一镜画面、设定集与本表额外要求补全整镜字段；
保护用户已写的标题与台词；保存后照旧重算一致性告警与范围说明书。

## 6. 宿主侧（index.js / production.js）

- 新增 4 个多画布工具：`canvas_create_canvas` / `canvas_rename_canvas` / `canvas_list_canvases` /
  `canvas_move_nodes`（节点与其内部边随迁；跨切口边剪断并记墓碑）。
- `canvas_write_node` / `canvas_update_node` 在改动 `shots`/`script` 后重算单表范围说明书；
  `canvas_node_status` 返回 board 系列字段。
- G2 把「每场至少 1 个大特写」降为**场级建议**（`warns`）——拆表后不能再要求每张 5 秒表都塞大特写；
  `state_jump` 纳入合法 `seg`。
- 请求体改为先攒 `Buffer` 再一次性 UTF-8 解码（修中文跨分片被切成 `U+FFFD`「�」）。

## 7. 前端（client.js）其他修复

- @提及允许全角括号、长名优先（`@林晚（医院）@` 不再被切成 `@林晚@（医院）@`）；
- 铺开分镜时资产命中顺序：设定集 `assetIds` 绑定 → 名称精确 → 包含 → 归属匹配；
- 设定集拉取保留本地未命名草稿行（`mergeBibleKeepDrafts`）；宿主不回传戳时本地兜底推进同步戳；
- Host 墓碑优先：已被 Host 删除的本地节点跟着删（修「子画布删节点删不掉」）；
- dsh-image-gen 桥接能力对齐：按对方 `describe` 对齐比例/清晰度/渠道，比例下拉只给支持档位；
- 旧数据归一：`dialogue` 字符串→数组、`characters/props/timeBeats` 字符串→数组、`duration` 字符串→数字；
- 资产导入落点跟随当前分类页签、MIME 为空按扩展名兜底、导入后回第 1 页并切到落点分类。

## 8. 与上游的分歧点（有意为之）

| 项 | 上游 0.21.0 | 本 fork |
|---|---|---|
| 分镜粒度 | 表内切段，一张表多次生成 | 拆成多张 4–10s 表，一张表一次生成 |
| 单段上限控件 | `targetDuration`（总时长硬约束） | 同上游；`segMaxSeconds` 已退役，由拆表 4–10s + 视频切段 15s 保证 |
| 大特写门禁 | `fails`（硬失败） | `warns`（场级建议） |
| `non_diegetic_music` | 无音乐时不输出该段 | 同上游（禁 BGM 写在 `overall_soundscape` 与负向清单里） |
| 切段规划器 | 贪心装填 | 视频切段同上游贪心；**拆表**走 DP 均衡（`strict` + `balance`） |
| 图片 AI 完善 | 无此功能 | 资产设定图口径（见 §4） |

## 9. 安装（DSH profile）

```bash
# 方式一：从 GitHub 装进 profile（走 pnpm）
cd ~/.dsh-v021/profiles/web
pnpm add github:MasterZJJ/my-dsh-infinite_canvas#v0.21.0-local.1

# 方式二：手动覆盖（与开发调试一致）
git clone git@github.com:MasterZJJ/my-dsh-infinite_canvas.git
cp -a my-dsh-infinite_canvas/. <profile>/node_modules/@ninkch/dsh-infinite-canvas/
```

装完需重启 DeepSeek Harness（宿主 `index.js` 只在启动时加载）；只改了 `client.js` 时刷新页面即可。

## 10. 跟进上游

**上游 GitHub 仓库从本机不可达**（`git clone` 报 SSL/HTTP 000），所以合并走 **npm 发布包三路合并**：
下载目标版本的 tarball 作为 `theirs`、上一版 tarball 作为 `base`、本仓库作为 `ours`，逐文件
`git merge-file` 后解冲突。tarball 不含 `scripts/`、`CHANGELOG.md` 等开发文件——那些是本仓库单边新增，
天然不会冲突。

```bash
# 1) 取上游两版
npm pack @ninkch/dsh-infinite-canvas@<目标版本>   # theirs
npm pack @ninkch/dsh-infinite-canvas@<基线版本>   # base
# 2) 三路合并（示例）
git merge-file -p ours/client.js base/client.js theirs/client.js > merged/client.js
# 3) 解冲突 → 跑回归 → 提交
node scripts/regress.mjs       # 96 项（含本 fork 的接线守卫）
```

**0.21.0 这次合并的冲突面（实测 9 处，全部已解）**：

| 文件 | 冲突 | 处理 |
|---|---|---|
| `index.js` | 3 | `NODE_PATCH_FIELDS` 取并集（+`assetId`）；`boardScript` 同步与 `assetId` 置 done 并存；收流保留本 fork 的 Buffer 修法 + 采用上游 16MB 上限 |
| `client.js` | 6 | 5 处「两边各加各的」取并集；**成片节点 = 唯一真语义冲突**（见下） |
| `package.json` | 1 | 版本号 |

**成片节点（唯一需要设计决策的冲突）**：上游 0.21.0 给成片加了 `audio` 输入口与 BGM/SFX 混音
（浏览器链路里解码成 AudioBuffer 播放），而本 fork 把成片合成搬到了宿主 ffmpeg。合并时**必须把
音频轨一起送进宿主**，否则宿主路径会静默丢掉 BGM——现有实现：客户端采集 `audioTracks`
（`assetId/start/offset/duration/gain/loop`）→ 宿主解析成磁盘文件 → ffmpeg 用
`-stream_loop -1`（循环）+ `atrim`（偏移/时长）+ `volume`（增益）+ `adelay`（起点）+
`amix normalize=0` 混入总音轨。回归用例：`test-finalcut-compose.mjs` 的 BGM 单元 + 端到端
（静音时间线 + BGM → 成片必须有声音，且不得把成片拉长）。

`scripts/test-local-ai-helpers.mjs` 是本 fork 的接线守卫：上游合并若把「AI 完善提示词走资产设定图」
「媒体节点上传走资产管道」「编辑器 AI 补全带上下镜上下文」弄丢，它会直接红。

## 11. 已跟上的上游 0.21.0 功能

合入后本 fork 与上游功能面一致，差异只剩 §1–§8 列的那些本地改造。0.21.0 带进来的：

- **音频节点 + TTS**（音色/情绪/语速/格式；OpenAI 同步与 lk888 异步两套协议）
- **成片音频轨**（BGM/SFX：静音/循环/增益/起点/偏移/时长）
- **批量执行**（选中/分组批量生成、并发、可停止、费用估算、批量下载）
- **创作台**（自动创作 + 批量执行统一面板；设置页只剩开关）
- **3D-BOX**（一句话搭预演：场景/风格/运镜预设；导演台入口并入 3D-BOX 库首页，支持多舞台）
- **角色库 / 素材库 DAM / 工作流 / 运镜预设 / 图片工具（放大·抠图·扩图·多角度·重打光）/ 视觉拉片**
- **视频前置体检 + 按秒单价**（`canvas_production_set_price`）
- **资产工具**（`canvas_import_asset` / `canvas_list_assets` / 节点 `assetId` 直挂）
- **宿主无关化**（核心只强依赖 3 个 ctx 成员；见 `docs/host-agnostic.md`）
