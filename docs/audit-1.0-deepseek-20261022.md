# ChatBuddy 1.0 待提交代码审计报告

- 审计模型：deepseek（DeepSeek-V4.1-Flash）
- 审计日期：2026-10-22
- 对照基线：`docs/prd-1.0.md`（2026-10-21）
- 审计对象：工作区全部未提交改动（18 个已跟踪文件修改 `+673/-100`，25 个新增文件约 4,531 行）
- 结论：**不建议按现状合入 M1**。存在 7 个 P0，其中 3 个会让 PRD 的核心承诺在默认配置下直接失效。

---

## 0. 审计范围与实跑结果

### 0.1 改动清单

| 类别 | 内容 |
|---|---|
| 新增核心 | `src/core/shift/`（agents、gates、decide-turn、pacing、store、report、webhook、vision-parse、controller、turn-dispatch、screen-reader）、`src/core/memory/`（conversation-key、transcript-merge）、`src/core/knowledge/`（search、read-file）、`src/core/gateway/capability.ts` |
| 新增主进程 | `src/main/duty-service.ts`、`src/main/commercial.ts` |
| 新增前端 | `src/renderer/src/duty-ui.tsx`（919 行） |
| 修改 | `generic-channel-session.ts`、`rpa/input-utils.ts`、`rpa-device.ts`、`device.ts`、`box-select-device.ts`、`session-types.ts`、`main/index.ts`、`skill-server.ts`、`App.tsx`、`MemoryWindow.tsx`、`feature-flags.ts`、`electron.vite.config.ts` |
| 测试/脚本 | 14 个 `*.test.ts`、`scripts/register-test.mjs`、`scripts/test-loader.mjs` |

### 0.2 实跑验证（本机 macOS）

| 检查 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npm run typecheck` | 通过（node / web / tests 三段全绿） |
| 单元测试 | `npm test` | 通过，51 tests / 51 pass / 0 fail |
| 生产构建 | `npm run build` | 通过（含 typecheck + 三段 vite 构建） |

**重要**：三项全绿与功能是否达标无关。下述 P0 全部是"代码能编译、测试能过、行为不符合 PRD"。现有 51 条测试是 happy-path 快照，对本文 7 个 P0 无一条能拦住。

### 0.3 审计方法

按 PRD 章节切四组并行审计（记忆/闸门、节奏/输入、前端/主进程、知识/网关/测试），子代理结论逐条回到源码复核行号；所有 P0 与关键 P1 均由本报告作者用 `sed`/`grep` 二次确认，怀疑项已剔除。`npm test`/`typecheck`/`build` 由作者实跑。

---

## 1. 总体结论

| PRD 承诺 | 实际状态 |
|---|---|
| 3.4 / 8.5「默认不是瞬间粘贴」 | **不成立**（P0-3）：≤40 字回复仍是一次剪贴板粘贴 + 回车 |
| 8.1 会话记忆连续、不串话 | **会被打断**（P0-2）：分段发送后记录永久对不齐，会话冻结 |
| 8.8「事实只能来自命中段落」 | **不成立**（P0-1）：命中的段落从未进入模型 prompt |
| 8.3「两种模式都走记忆、闸门和节奏」 | **不成立**（P0-4）：无看屏 Key 时走 legacy 路径，全部旁路 |
| 3.3 / 8.10「商业构建不出现模型名、网关不暴露」 | **不成立**（P0-5、P0-6、P0-7） |
| 8.2 黑名单「永不回复」 | 可被空格绕过（P1-1） |
| 8.11 班报「当晚五分钟内指出该亲自接谁」 | 被历史暂停会话与 1970 时间戳污染（P1-14） |

M0/M1 的书面边界没有落到代码约束上；M2 的知识闭环在最后一步断了。

---

## 2. P0（合入前必须修）

### P0-1 知识命中段落从未进入回复模型，8.8 整条链路是断的

**现象**：`decide-turn.ts` 检索出命中段落，格式化成 `knowledgeText`，一路传到 provider，然后在 `local-provider.ts` 被丢弃。模型只看截图 + 经验卡片 + 固定系统提示词。

**证据**

`src/core/local-provider.ts:28`

```ts
const reply = await this.aiClient.getReply(input.screenshot, input.memoryCards)
```

- `src/core/shift/decide-turn.ts:234`：`knowledgeText: formatKnowledge(hits)`、`:235` `knowledgeTitles`
- `src/core/generic-channel-session.ts:394-400`：`runProvider({ ..., historyText, knowledgeText })`
- `src/core/session-types.ts:9-12`：`historyText` / `knowledgeText` 定义后**全仓无消费者**
- `src/core/ai-client.ts:69-74`：`getReply` 只接收 `screenshot` 与 `memoryCards`，prompt 里没有资料段

**PRD 偏差**：8.8「把命中的少量段落注入这一次回复」「事实性回答只能使用命中的段落和会话记忆里已经说过的话」；第 10 节「回复请求只携带本次命中的少量段落」。

**影响**：M2 的核心验收（「库里有的事实按库回答」）不可能通过。用户放进知识包的价目、地址、发货规则对模型完全不可见，模型仍然自由发挥；反过来"检索未命中就转人工"这道闸门反而在拦住本可以回答的问题。

**修复**：`getReply` 接收并拼装 `historyText` + `knowledgeText`（网关 provider 同改）。补一条**断言最终 prompt 内容**的测试——现有测试只断言 `action.knowledgeText` 这个中间值，看错了层。

---

### P0-2 分段发送后「回合记录」与屏幕气泡永久对不齐，该会话从此不再回复

**现象**：一条 >40 字的回复被拆成多个气泡发出，但记忆只落成一条合并回合。下一轮合并时尾部永远对不上，直接进入 `reject` → `review`，该会话此后既不写记忆、也不生成回复。

**证据**

`src/core/shift/pacing.ts:106-110`

```ts
actions.push(...typeChunk(chunk, policy, rng))
actions.push({ op: 'enter' })
```

- `src/core/rpa/input-utils.ts:162-169`：每个 chunk 执行 `paste` + 回车，屏幕上就是多个独立气泡
- `src/core/generic-channel-session.ts:367`：`recordSent(target.key, ..., text)` 把整段落成**一条** out 回合
- `src/core/memory/transcript-merge.ts:41-55`：`stored` 尾 `"前半。后半"` vs `incoming` 头 `"前半。"` 永不相等 → `matched === 0` → `containsSlice` 失败 → `reject`
- `src/core/shift/decide-turn.ts:126-134`：`reject` → `review`，`added: []`，不进闸门、不回复、不写记忆

**PRD 偏差**：8.1「按当前会话的对方名称保存文字回合」；8.5「长文分段 默认 开」（默认行为本身触发故障）；11「不串会话」「整段秒贴」两侧都不达标。

**影响**：默认配置下，**只要回复过一次长文，这个会话就永久瘫痪**。班报里只会显示"记录对不齐"，用户没有任何恢复手段（清空回合后会被同一路径再次冻结）。这是 M1「连续处理一个晚上的咨询」的直接阻断项。

**修复**：
1. `recordSent` 按 `splitMessage(text, pacing.segmentLong)` 逐片落库，与真实气泡数一致；
2. `mergeVisible` 增加「一个 stored out 回合可折叠匹配 N 个连续同向可见气泡」分支；
3. `reject` 连续 N 轮后做软重同步（以当前屏幕为准重建尾部并标记 stale），不要永久死锁。

---

### P0-3 默认节奏下，≤40 字的回复仍然是整段一次粘贴

**现象**：节奏开关默认打开，但切分入口有一个 40 字早退分支。门店模板本身要求"短句"，所以典型回复（20–40 字）走到的正是「一次剪贴板粘贴 + 回车」，用户唯一能观察到的动作是"阅读等待 → 整段瞬间出现"。

**证据**

`src/core/shift/pacing.ts:55`

```ts
if (!enabled || trimmed.length <= 40) return [trimmed]
```

- `src/core/shift/pacing.ts:15-21`：默认 `enabled: true`、`segmentLong: true`
- `src/core/rpa/input-utils.ts:210-218`：`pasteText` = `clipboard.writeText` + `Cmd/Ctrl+V`，全链路没有任何逐字符输入
- 节奏的全部动作 = 一次 `wait` + 一次 `paste` + 一次 `enter`

**PRD 偏差**：3.4「默认不是瞬间粘贴」；8.5「打字方式：逐段输入，默认不再一次把整段放进输入框」；7 节 M4「三四十个字的回复是分段、有停顿、偶发改字」；11 第 1 条「默认节奏下没有整段秒贴」。

**影响**：1.0 对用户最直观的那条承诺没有兑现，M4 验收（录屏）必然不过。这不是"开关没做"，而是"做了，但常态路径没走到"。

**修复**：删掉 `<= 40` 早退；把"单次放入不超过约一行（10–16 汉字）"做成策略字段，任何长度都至少切 2 片。

---

### P0-4 legacy 路径绕过记忆、闸门、知识、确认层与节奏，直接发送

**现象**：只要当前构建拿不到看屏客户端（未配 Key、Key 失效），`prepare` 返回 `legacy`，引擎退回旧主循环——旧主循环拿到 `reply_text` 就直接发送。

**证据**

`src/main/duty-service.ts:173-175`

```ts
const vision = this.visionClient()
if (!vision) return { type: 'legacy' }
```

`src/core/generic-channel-session.ts:121-124`

```ts
case 'provider.reply_text': {
  await this.device.sendMessage(event.content)
```

- `src/core/generic-channel-session.ts:255-257`：`plan.kind === 'legacy'` → `forwardProviderEvents`
- `sendMessage(event.content)` 不传 `pacing`、不传 `alive`；`pacing` 是可选参数，缺省即整段粘贴（`src/core/device.ts:84-85`）

**PRD 偏差**：8.3「两种模式都走记忆、闸门和节奏策略」；8.2 全部闸门；8.4 转人工；3.4 节奏。全部在这条路径上失效。

**影响**：一个没配好 Key 的用户，恰好得到"最不设防"的自动回复：无黑名单、无冷处理、无时段、无上限、无节奏、无确认。这是 1.0 的功能倒退入口，也是风险表里"账号被限制"最容易被触发的情形。

**修复**：`legacy` 只保留"看屏 + 只读日志"，禁止发送；或 UI 明确"看屏不可用，自动回复已停用"。同时把 `sendMessage` 的 `pacing` 改为必填。

---

### P0-5 商业构建仍可编辑网关地址，许可证被当作上游 Key 发往任意主机

**现象**：商业构建唯一的"连接"页把"网关地址"做成可自由输入的文本框（placeholder 就是 `https://你的网关/v1`）；主进程原样保存，然后把**许可证**当作 `apiKey` 发到该地址。

**证据**

- `src/renderer/src/duty-ui.tsx:878-886`：网关输入框，无 `COMMERCIAL` 判断
- `src/renderer/src/duty-ui.tsx:845-912`：`DutyConnectionPage` 是商业构建唯一连接页（`App.tsx:687-694`）
- `src/main/duty-service.ts:131`：`patchSettings({ licenseCode, gatewayUrl: input.gatewayUrl?.trim() || '' })`，无协议/域名校验
- `src/main/duty-service.ts:455-463`：`apiKey: licenseCode`、`baseURL: gateway`
- `src/main/index.ts:1268-1276`：`const key = license || chatKey`，`baseURL: gateway`

**PRD 偏差**：8.10「商业构建：设置页没有供应商、模型名、Base URL、API Key」；3.3「商业构建隐藏 Provider、模型、Key」；第 10 节「许可证…进入网关」。

**影响**：改一个输入框即可把许可证、系统提示词、命中知识段落、**每一轮屏幕截图**导到任意主机（含内网）。既是凭据外泄，也是 SSRF 面。商业包一旦发出，这就是可被利用的收费绕过通道。

**修复**：商业构建**编译期**删除该输入，主进程在商业构建下忽略 `settings.gatewayUrl`、固定常量网关；开源路径也强制 `https:` + 主机白名单。

---

### P0-6 商业构建仍把上游原始错误（含厂商/模型）送到界面

**现象**：`sanitizeError` 只覆盖了部分出口，另有三条出口直传原文。

**证据**

`src/core/ai-client.ts:205`

```ts
throw new Error(`API request failed: ${response.status} - ${errorText.slice(0, 200)}`)
```

- `src/core/generic-channel-session.ts:70`：`ctx.host.log('error', \`${result.error || '界面识别失败'}，引擎无法启动\`)`——同文件 `:156` 的 `provider.error` 走了 `sanitizeError`，这条没有
- `src/main/index.ts:1038 / 1056`：`message: error?.message || String(error)` → `App.tsx:600` 直接 toast
- `src/main/index.ts:968`：`mainWindow.webContents.send('engine:log', { type, content })`，`App.tsx:382-383` 原样渲染
- `src/core/rpa-device.ts:129-146`：`布局测量失败: ${errorMsg}` / `String(error)`

**PRD 偏差**：3.3「用户界面、通知、错误提示、确认卡里不出现模型商品名、供应商名字和模型 ID」；8.10「文案不出现上游厂商」；7 节 M0 验收「商业构建的界面清单上没有模型名」。

**影响**：M0 是书面收口切片，这条不过，后续所有商业验收都建在漏水的底上。上游 401/5xx 的响应体常带厂商域名与模型 ID。

**修复**：所有面向 renderer 的 log/toast 统一过一个出口；商业构建下返回固定四态文案；`startEngineCore` 的 `engine_failed` 单独处理。

---

### P0-7 主进程商业判定是运行时环境变量，与渲染层的编译期常量可分叉

**现象**：渲染层确实做到了编译期注入，主进程却是 `process.env` 运行时判断。同一个包以不同方式启动，界面是商业版、主进程走开源分支。

**证据**

`src/main/commercial.ts:3-4`

```ts
export function isCommercialBuild(): boolean {
  return process.env.SIGHTFLOW_COMMERCIAL === '1' || process.env.RENDERER_VITE_COMMERCIAL === 'true'
```

- 渲染层对照（正确做法）：`electron.vite.config.ts:5-6,27-29` 用 `define` 注入 `RENDERER_VITE_COMMERCIAL`；`src/renderer/src/feature-flags.ts:7` 读编译常量
- 分叉后果：`src/main/duty-service.ts:300` 的 `if (!isCommercialBuild() && ...) return message` 会把上游原文返回商业界面（放大 P0-6）；`index.ts:889` 的许可证强制校验也会被跳过

**PRD 偏差**：8.10 明确「商业构建用编译开关去掉，而不是运行时藏起来」。

**影响**：P0-5 / P0-6 的修复若只改 UI 分支，仍可通过环境变量绕过。这是"商业边界"的单点。

**修复**：主进程同样用构建期常量（`define` 注入 `__COMMERCIAL__`），删除 `process.env` 判据；`commercial.ts` 的注释声称"避免不一致"，与实现相反。

---

## 3. P1（M1/M2 验收必需，或安全/正确性硬伤）

### 3.1 记忆与闸门

| 编号 | 问题 | 证据 | 影响 / 修复 |
|---|---|---|---|
| P1-1 | `normalizeTitle` 只把空白折叠成一个空格，PRD 要求「去空白」。黑名单匹配因此可被"张 三"绕过，同一会话也会产生两把键 | `src/core/memory/conversation-key.ts:14`；`src/core/shift/gates.ts:32-34` | 本应"永不回复"的人收到回复；记忆被拆两条。改为去掉所有空白（含 `\u3000`、零宽字符）后再比对，展示用原样标题 |
| P1-2 | 群人数后缀规则与 `kind` 耦合：模型把群读成 `single` → 人数进键（同一群随人数拆成两条）；名字本身以括号数字结尾（`春季班(2)`）→ 被误剥（两个群共用一条记忆） | `conversation-key.ts:15-16`；`vision-parse.ts:23`；`duty-service.ts:82` | 错拆=记忆丢失，错并=真串话。键的构造应与 `kind` 抖动解耦；补 `(2024)`、`23人`、kind 抖动三类用例 |
| P1-3 | 名称"稳定"= 模型自报 `high`，代码侧无占位词表、无长度/字符集校验 | `vision-parse.ts:22-27,48-50`；`decide-turn.ts:252-255` | `single:微信`、`single:聊天信息` 会成为多个会话共享的记忆桶。加占位词黑名单 + 连续两次读到同一键才算 high |
| P1-4 | 记忆写入发生在两次独立截图之间（先气泡、后标题），写库前不复核 | `src/core/shift/screen-reader.ts:10-24`；`duty-service.ts:199-203` | 发送前有 `stillOn`，记忆写入没有 → "发对了人、记到了别人头上"。写入前复核标题 |
| P1-5 | 白名单只约束单聊，群与框选（`window`）完全绕过 | `gates.ts:36-39` | PRD 8.2「只回复名单内的单聊」，与"只"字冲突。白名单开启时 `kind !== 'single'` 一律拦下并记原因 |
| P1-6 | `allowAuto` 是一次性闩锁，不复位、不绑会话；风险确认只在渲染层 `window.confirm` | `duty-service.ts:44-45,315-356`；`duty-ui.tsx:186-192` | 引擎重启、切 appType、换会话后核对仍然有效。probe 结果应绑 `{appType, convKey, at}` + TTL；风险确认放主进程 `dialog` |
| P1-7 | `settings:set` 可整包覆写 `allowAuto`/`licenseCode`/`gatewayUrl`，绕过 `duty:allowAuto` 的服务端校验 | `src/main/index.ts:517-538` | 前端脚本一次 `invoke('settings:set', { allowAuto: true })` 即可跳过风险确认。键级白名单 |
| P1-8 | 冷处理只在 `prepare` 判定，草稿挂起期间不复核；`stillOn` 不查冷名单 | `duty-service.ts:236-245`；`store.ts:233-238`（`isCold` 仅测试在用） | 辅助模式下用户点了"冷处理"，挂着的草稿仍会发出。`stillOn` 追加 `!isCold(key)` |

### 3.2 节奏与输入

| 编号 | 问题 | 证据 | 影响 / 修复 |
|---|---|---|---|
| P1-9 | 切分只在 `。！？；` 与换行处断句，超过 40 字**按 40 字符硬切**，无边界保护 | `pacing.ts:57,65-67` | `2500 元` 被切成 `25`/`00 元`；URL 被切断。改为句末 → 逗号 → 空格 → 回退到非 `\d\w` 边界，命中金额/链接时不拆 |
| P1-10 | 「仅闲聊句不错字」没有句子类型判据，只有关键词黑名单；时间/地址词表不全 | `pacing.ts:48-50` | 反例：`明天上午我在店里等你` → `在`→`再`；`我们店在万达广场二楼` 同样命中不了。改为白名单（闲聊套话）才允许错字 |
| P1-11 | 「改正后正文必须等于原文」只靠构造保证；`previewTyped` 产品代码零调用；退格不校验；中断时错字可能残留 | `pacing.ts:129-133,137-150`；`input-utils.ts:166-168` | 存在"发出未改正错字"的路径。发送前断言 `previewTyped(actions).join('') === text`，不等则拒发 |
| P1-12 | 发送中途取消：不回车、不清空输入框、已发分片不记账 | `input-utils.ts:152-169`；`generic-channel-session.ts:445-454` | 残句留在 A 会话输入框；切到 B 会话后 `focusInput` 继续粘贴并回车 → **A 的半句话发进 B**；已发分片未记账 → 下一轮重复。取消时 `Cmd+A` + Delete 并落轨迹；分片逐条记账 |
| P1-13 | `stillOn` 只在 `sendComposed` 入口验一次；框选/布局坐标是绝对像素，`focusInput` 是盲点 | `generic-channel-session.ts:432-440`；`input-utils.ts:201-208,280`；`box-select-device.ts:187-190` | 窗口一挪，粘贴可能落到任意前台窗口（终端、编辑器）。每片回车前重验；坐标失效即中止 |
| P1-14 | 无"输入框已有内容"检测 | `input-utils.ts:201-208` | 用户草稿会被一起发出。发送前做空框校验，非空则转待处理 |
| P1-15 | USB 后端纯占位：只有枚举 + 一条日志 + 写死 disabled 的单选 + `usbReady: false` 常量 | `generic-channel-session.ts:441-443`；`duty-service.ts:412,440`；`duty-ui.tsx:373-375` | 节奏**策略**未写死平台（符合 PRD 第 124 行），但**执行层**与 robotjs/剪贴板硬耦合，没有可替换后端接口。按 PRD 8.6 可不阻塞发版，但需抽 `InputBackend` 接口，否则接入 USB 要改节奏执行层 |

### 3.3 知识、网关、班报

| 编号 | 问题 | 证据 | 影响 / 修复 |
|---|---|---|---|
| P1-16 | 「是否需要事实」由 20 词正则决定，不是模型判断；漏判即直接放行生成 | `knowledge/search.ts:8,11-13`；`decide-turn.ts:215-216` | 「有货吗」「能便宜点吗」「包邮吗」「能开发票吗」全部 `needsKnowledge=false` → 不检索、不转人工 → 编造。兜底方向应是"拿不准就检索，命中不足就转人工" |
| P1-17 | 检索阈值 0.12 是"查询 bigram 命中比例"，短查询只要 1 个 bigram 即过；无停用词/IDF | `knowledge/search.ts:56-67,85-90` | 查询"多少钱"（2 个 bigram）命中"多少"即 0.5。误命中等价于给模型一个错误的"唯一事实来源"。加绝对命中数下限 + 去停用词 |
| P1-18 | `splitLong` 按 400 字符硬切 | `knowledge/search.ts:49-54` | 命中段落里的价目/地址被截半，即使 P0-1 修好也会喂半句话。改按空行/句切 |
| P1-19 | Webhook 无协议、无主机、无私网校验，`fetch` 默认跟随重定向 | `webhook.ts:36-51`；`agents.ts:106`；`duty-ui.tsx:536-542` | 主进程带 JSON POST 打 `127.0.0.1`/内网/云元数据（SSRF）。白名单 `qyapi.weixin.qq.com` / `open.feishu.cn`，`redirect: 'manual'` |
| P1-20 | 401 / 402 / 429 一律映射"额度用尽"；且用中文文案字符串驱动 `stopSession` | `capability.ts:19-21`；`generic-channel-session.ts:167-170` | 许可证失效被说成缺额度（用户去充值）、429 被永久停机而非退避。401 → `inactive`；状态机读 `state` 不读 `text` |
| P1-21 | 班报把**全部历史上**暂停会话并入当日列表，缺事件时 `at: 0` | `report.ts:52-68`；`duty-service.ts:378-384`；`store.ts:281-285` | 上周转人工、今天一句话没说的联系人天天出现，导出时间为 `1970-01-01`。`listHandedOff` 需带时间并与当日事件求交集 |
| P1-22 | CSV 只转义引号，不中和 `= + - @`；无 BOM | `report.ts:75-90`；`duty-service.ts:394` | 昵称叫 `=cmd|'/c calc'!A0` 的联系人 → 用户双击 CSV 即执行；中文 Excel 乱码 |
| P1-23 | 确认层缺「这条有用」 | `duty-ui.tsx:243-265` | PRD 8.3 要求「可以标记这条有用或这条不行」，现只有"不行"。`noteBad` 有对称实现可参照 |
| P1-24 | `duty:confirm` 无参数校验、无草稿关联、无 pending 时静默成功；UI 失败也清空草稿 | `duty-service.ts:111-115`；`duty-ui.tsx:158-161` | 任意脚本可提交 `{action:'send', text:'任意文本'}`；用户草稿被静默丢弃且无提示 |
| P1-25 | 「连续两轮回复高度重复」只判完全相等 | `gates.ts:84-88` | 「在的，您说～」vs「在的，你说~」不触发，而近重复正是刷屏主形态。改 bigram Jaccard ≥ 0.8 |
| P1-26 | 当班页缺「当前智能体」与「开始/暂停」；`DutyShiftPage` 无本小时计数 | `duty-ui.tsx:303-377`；`duty-ui.tsx:206-211`（`DutyCard` 有计数但无智能体名） | PRD 第 9 节当班页清单五项，现缺三项（开始/暂停在 `App.tsx:612-624` 的底栏） |
| P1-27 | 商业构建下快照把**明文许可证**与网关地址回传渲染层 | `duty-service.ts:404-405,432-433`；`duty-ui.tsx:851-858` | 与 3.3「前端不持有凭据」相悖。只回传"已激活"布尔 + 掩码尾号 |

---

## 4. P2（正确性/体验偏差，可在 M1 后收口）

| 编号 | 问题 | 证据 |
|---|---|---|
| P2-1 | `mentionedMe` 为 `null`（读不到 @）与 `false`（确实没 @）共用同一原因文案，班报无法区分 | `gates.ts:41-43` |
| P2-2 | 每小时上限 `0` 语义是"不限制"，用户想"先别发"填 0 反而全放开；UI 文案固化了这个语义 | `gates.ts:49-52`；`agents.ts:111`；`duty-ui.tsx:565` |
| P2-3 | 上班时段结束分钟被算作"在班"（`<=`）；`start === end` 退化为仅一分钟；`parseClock` 失败时 fail-open 全天在班 | `gates.ts:57-63` |
| P2-4 | 清空会话后，下一轮把当前屏幕历史以 `vision` 重新写回，用户观感是"清空无效" | `store.ts:202-204`；`transcript-merge.ts:37-39` |
| P2-5 | 名称未绑定时 `skip` 无 key，events 表不落库，PRD 要求的"轨迹里记下未绑定会话"缺失 | `decide-turn.ts:83-86`；`duty-service.ts:204` |
| P2-6 | `selectHistory` 对 `NaN` 未校验，`slice(-NaN)` 等价返回全部历史 | `transcript-merge.ts:77-78` |
| P2-7 | 回合缺 PRD 要求的「是否实际发出」；方向「人工」零调用 | `store.ts:19-24` |
| P2-8 | `capabilityFromConfig` 把视觉 Key 当回复 Key，看屏/回复无法分两行独立说明 | `duty-service.ts:423`；`capability.ts:47-55` |
| P2-9 | 知识包无总量上限；每回合全量读库并对所有 chunk 重建 bigram 集合 | `duty-service.ts:195`；`store.ts:332-342`；`search.ts:63-67` |
| P2-10 | PDF 只限压缩前 10MB，解压后文本无上限、无页数限制、无 try/catch | `read-file.ts:22-27` |
| P2-11 | 非 UTF-8 / 二进制改扩展名后静默入库为乱码知识，界面只说"已加入" | `read-file.ts:18-21` |
| P2-12 | 注入知识无定界、无"资料非指令"声明、无总长度上限（P0-1 修好后即为注入面） | `search.ts:70-76` |
| P2-13 | Webhook 失败原因 `posted.error` 被丢弃，班报无法排查（暂停保持与写事件本身正确） | `duty-service.ts:309-311` |
| P2-14 | `sanitizeError` 在空 message + 无状态码时返回「可用」 | `capability.ts:28-29`；`generic-channel-session.ts:156` |
| P2-15 | 草稿广播给所有窗口（含 overlay / 工作记忆窗口） | `duty-service.ts:507-511,230` |
| P2-16 | 辅助模式"等确认"期间班报里没有该会话，与 8.11「待处理」定义不符 | `duty-service.ts:204-234` |
| P2-17 | 素材图片只做阅读等待，无条间停顿、无速度档位映射（硬编码 800/1400 与 `SPEED_MS` 重复） | `input-utils.ts:253` |
| P2-18 | 记录页点会话无请求序号，快速点两行会把 A 的回合贴到 B 标题下 | `duty-ui.tsx:794-802` |
| P2-19 | `useSnapshot` 无 `.catch`；十余处 async onClick 无 try/catch，点击失败无反馈 | `duty-ui.tsx:110-118,163-183,282-301,645-716` |
| P2-20 | 智能体页 `useEffect(..., [active])` 会在快照刷新时覆盖正在编辑的输入 | `duty-ui.tsx:390-392` |
| P2-21 | `readBeforeType` / `segmentLong` 无 UI 开关，只能吃默认 true | `duty-ui.tsx:593-624` |

---

## 5. P3（清理项）

- `src/core/shift/agents.ts:61`：`typo: speed === 'slow' ? 'low' : 'low'` —— 三元两侧相同，残留代码。
- `pacing.ts:57-68`：`split(...).map(trim)` 吃掉换行，多行原文会退化为两条消息且换行语义丢失（`previewTyped` 对多行不等于原文）。
- `pacing.ts`：五处魔法数字 `40`，与 PRD「约两行」无换算依据或注释。
- `turns` 无裁剪、`events` 无保留策略，长期单机运行会累积。
- `gates.ts:33`：黑名单条目用**当前会话的 kind** 归一化，单聊名 `张三(2)` 在群会话下会被剥成 `张三` 误命中。
- 黑名单命中仍会触发转人工词判定并下发 Webhook（`decide-turn.ts:115-125` 早于 `:136` 的闸门），产生通知噪音。
- `decide-turn.ts:249` 用 `windowConversationKey`，`duty-service.ts:486` 手写 `` `window:${appType}` ``，两处不一致。
- 渲染层 `i18n.ts:36,93` 的「输入火山方舟 API Key」不在任何 `COMMERCIAL` 分支内，会留在 asar；建议 CI 增加"商业产物 grep `doubao|volces|ark`"断言。
- 窗口 `sandbox: false`、无 `will-navigate` 拦截（`index.ts:228-231,270-273,316-319`）。
- `npm test` 硬编码文件白名单，新增目录下的测试会静默漏跑。
- `DutySnapshot.commercial/allowAuto/usbReady` 在 duty-ui 中未使用；`probe` 逻辑复制两份；内联样式同一文件重复 10+ 次。

---

## 6. PRD 切片对照

| 切片 | 状态 | 未过项 |
|---|---|---|
| M0 切口 | **未过** | 商业构建界面仍有网关地址输入（P0-5）；错误文案可透出上游（P0-6）；商业判定非编译期（P0-7） |
| M1 能离开屏幕的一班 | **未过** | 默认仍整段粘贴（P0-3）；分段后记忆冻结（P0-2）；legacy 旁路（P0-4）；黑名单可绕（P1-1）；自动门禁可绕（P1-6/P1-7）；班报污染（P1-21） |
| M2 本机脑子 | **未过** | 命中段落未进模型（P0-1）；事实判定用正则（P1-16）；无命中即编造 |
| M3 网关 | 部分 | 能力四态未做（P2-8）；401/429 混淆（P1-20）；网关地址可改（P0-5）；无许可证失效态 |
| M4 完整节奏和素材 | 部分 | 错字/手速/分段有实现但粒度与边界不合格（P0-3、P1-9~11）；USB 纯占位（P1-15）；素材图片半个节奏（P2-17） |
| M5 班报 | 部分 | 三态判定基本正确；历史会话污染与 `at:0`（P1-21）；CSV 注入/编码（P1-22）；等确认不进待处理（P2-16） |

---

## 7. 已确认符合 PRD 的部分（避免误改）

- 冷处理**判定位置正确**（在转人工词、素材、检索、模型之前）、已读基线落实、原因落库、解除后回合保留：`decide-turn.ts:91-104`、`turn-dispatch.ts:26-31`、`generic-channel-session.ts:463-467`、`store.ts:261-263`。
- 未稳定名称不写记忆、不生成回复、UI 提示「还没确认当前会话是谁」：`decide-turn.ts:83-86,252`、`duty-ui.tsx:206`。
- 每会话条数默认 20、范围 5–50，双重钳制：`agents.ts:60,109`、`transcript-merge.ts:77`。
- 清空回合只影响单会话：`store.ts:202-204`（`store.test.ts` 有覆盖）。
- 数据全部落本机 SQLite（`app.getPath('userData')/worktrace/shift.sqlite`），知识/回合/名单均不上传；全仓 `fetch` 仅 4 处，其中 `webhook.ts` 只发名称/原因/时间，符合 8.4。
- 辅助/自动的**后端**判定确实串了三重条件：`decide-turn.ts:258-265`（`mode && allowAuto && nameCheckPassed`）+ `duty-service.ts:229`。
- 「核对当前窗口」不写入会话记忆：`duty-service.ts:315-356` 只读屏 + 置标记。
- 「这条不行」四个原因齐全，连续两次自动转人工：`duty-ui.tsx:97`、`duty-service.ts:266-278`。
- 节奏**策略**类型未写死平台（`pacing.ts` 无 `process.platform`），符合 PRD 第 124 行。
- `mapUpstreamFailure` 在商业构建下不透出上游原文（靠 `capability.ts:25` 的短路顺序，建议显式化）。
- `npm run build` 通过，`unpdf` 已正确列入 dependencies。

---

## 8. 修复顺序建议

1. **P0-7 先把商业判定改成编译期常量**（其它商业项都依赖这个单点）。
2. **P0-5 + P0-6 + P1-27 一起收口商业边界**：删网关输入、错误统一出口、快照不回传明文。
3. **P0-4 关掉 legacy 发送**，把 `pacing` 改为必填参数——这一步同时堵住"无节奏旁路"。
4. **P0-2 + P1-12 重做分段与记账**：逐片落库、取消时清空输入框、`reject` 加软重同步。这是 M1「一个晚上连续处理」的硬前提。
5. **P0-3 调整切分粒度并补 P1-9 的边界保护**，然后录屏验收 M4 第一条。
6. **P0-1 接通知识注入**，紧接着补 P1-16 的兜底方向（拿不准就检索、命中不足就转人工）。
7. **P1-1~P1-8 记忆与闸门语义**，每项补一条回归测试（尤其"张 三"、kind 抖动、白名单、`allowAuto` 复检）。
8. 其余 P1 按切片顺序收口；P2/P3 进下一刀。

---

## 9. 审计局限

- 只做静态审计 + 单元测试/构建实跑，未在真实微信窗口上跑端到端验收（需要 macOS 图形会话与账号）。因此 P0-3、P1-13 的"实际观感"仍需录屏确认。
- `src/preload/index.ts` 的无白名单通用 `invoke/send/on` 是**既有基线代码**，本次未修改；但新增的 18 个 `duty:*` 通道把可利用面显著放大（P1-7 即由它放大）。本报告未将其计入 P0，建议单独立项收口。
- 行号对应当前工作区文件内容，若后续改动请以符号名定位。
