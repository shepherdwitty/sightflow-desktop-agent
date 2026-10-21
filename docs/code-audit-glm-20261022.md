# ChatBuddy 1.0 待提交代码审计报告

- 日期：2026-10-22
- 审计模型：GLM（由 CodeBuddy 调度，四个并行审计子代理 + 主代理交叉验证）
- 审计基准：`docs/prd-1.0.md`（ChatBuddy 1.0 产品需求文档，2026-10-21 版）
- 审计对象：工作区全部待提交变更（18 个修改文件，+673/-100；21 个新增源文件，约 4100 行），覆盖 `src/core/shift/`、`src/core/memory/`、`src/core/knowledge/`、`src/core/gateway/`、`src/main/duty-service.ts`、`src/main/commercial.ts`、`src/renderer/src/duty-ui.tsx` 及主进程/UI 集成改动
- 方法：按 PRD 模块划分四路并行审计（会话记忆与班报 / 闸门与转人工 / 节奏与知识包 / 网关与商业构建），主代理对 P0/P1 关键发现逐一读码复核
- 测试状态：`npm test` 51/51 通过（含 shift、memory、knowledge、gateway 新增测试）

---

## 一、总体结论

这批代码把 PRD M1/M2 的骨架搭得相当完整：会话键设计、闸门短路顺序、冷处理先于生成、Webhook 失败保持暂停、单会话隔离、回合队列串行、默认值全部落对（辅助模式、节奏开、每小时 30 条、群聊默认只回 @），「回合记忆与工作轨迹两种数据」的分离干净，测试意识良好。

但**合入前存在 1 个 P0 和 12 个 P1**，集中在三类风险：

1. **商业构建的两根支柱是虚的**：主进程商业开关是运行时环境变量而非编译期常量（P0），叠加模型名仍编译进 bundle、连接页留着网关地址输入框、多条错误路径未脱敏——PRD 3.3/8.10 的「编译开关去掉，而不是运行时藏起来」在真实商业包里大概率不生效。
2. **转人工触发器的作用域缺陷**：只看最后一条入站气泡（多气泡漏检）、「恢复自动」会被同一触发立即再触发（恢复在数学上不可能）、三个触发器不可关——PRD 8.4 的核心承诺在真实多气泡会话里打折。
3. **发送保真与输入边界**：分段算法会切半 emoji、中断后输入框残留导致跨条拼接误发、「需要事实」靠固定正则判定留有编造绕过面——违反 8.5「改正后的正文必须等于模型给出的正文」和 8.8「不生成猜测」。

建议先修 P0 与安全向 P1（skill-server 鉴权、IPC 白名单、网关地址校验），再修触发器作用域三连和发送保真两连，其余按 P2 清单排进 M1/M3 收尾。

---

## 二、P0（阻断级，1 项）

### P0-1 主进程「商业构建」开关是运行时环境变量，不是编译期开关

- 位置：`src/main/commercial.ts:3-5`、`electron.vite.config.ts:8-19`
- 现状：渲染层的 `RENDERER_VITE_COMMERCIAL` 由 vite `define` 在构建期注入（真实编译开关），但主进程的 `isCommercialBuild()` 读 `process.env`——打包后的应用里该值来自**用户机器的启动环境**，默认不存在。electron-vite 的 main 段没有任何 define，构建时设置的环境变量不会进 bundle。
- 后果：商业包里主进程按开源分支执行——`index.ts` 的许可证门禁失效、`duty-service.ts` 的 `sanitizeError` 走原始错误透传分支、「服务暂不可用」文案不生效；而渲染层却是 COMMERCIAL=true，两层行为分裂。
- 违反：PRD 3.3 / 8.10「商业构建用编译开关去掉，而不是运行时藏起来」。
- 建议：在 electron.vite.config 的 `main.define` 注入编译期常量，`commercial.ts` 改读该常量；`package.json` 增加显式 `build:commercial` 脚本（见 P2-24）。

---

## 三、P1（重要，12 项）

### 会话记忆与班报

**P1-1 恢复自动后，班报仍显示「已转人工」**
- 位置：`src/core/shift/store.ts:277-279`、`src/core/shift/report.ts:32-33`
- `resume()` 只清 `conv_state.handed_off` 不写事件，而班报完全按「当天最后一条事件」归类。班内转人工 → 点「恢复自动」→ 对方无新消息时，当晚班报仍显示「已转人工」直到次日。
- 违反：PRD 8.11「已转人工 = 8.4 已暂停」的当前状态语义；破坏 U3 验收「班报能指出必须亲自接的会话」的准确性。
- 建议：`resume()` 时补写一条事件，或班报构建时读取 `conv_state` 对已恢复会话做负向覆盖。

**P1-2 回合四要素缺「是否实际发出」与「人工」方向**
- 位置：`src/core/shift/store.ts:19-24`
- PRD 8.1 要求每条回合包含「时间、方向（对方/助手/人工）、正文、是否实际发出」。现状：`source` 枚举了 `'human'` 但全代码库无写入点，人工在微信手动打的消息与看屏读到的内容混在一起；「是否实际发出」被「只在发送成功后落库」的副作用取代，草稿丢弃/发送失败完全不落库，无法审计「生成过但没发出」的内容。
- 建议：turns 表增加 `delivered` 列（草稿生成即落 0，发送成功更新 1），并为人工路径补 `'human'` 写入点。

### 闸门与转人工

**P1-3 转人工词表 / 素材 / 知识判断只看「最后一条」入站气泡，多气泡场景触发器系统性失效**
- 位置：`src/core/shift/decide-turn.ts:90,115,191,202,215`（已主代理复核确认）
- `latestIncoming()` 只取屏幕最后一条 `in` 气泡。用户连发「我要」+「退款」两条时，触发词不在最后一条则漏检——不转人工、不走知识兜底，模型带着含「退款」的历史自答。「多少钱」后跟一条「急」同理。
- 违反：PRD 8.4 触发条件（P0 需求）、8.8「不生成猜测」。
- 建议：对全部**新增**入站气泡（或拼接文本）执行 `hitKeyword` / `matchMaterial` / `needsKnowledge`。

**P1-4 「恢复自动」会被同一触发条件立即再次触发，恢复形同虚设，且反复发 Webhook**
- 位置：`src/core/shift/decide-turn.ts:115,167`、`src/main/duty-service.ts:304-313`
- 两个机制叠加：(a) `repliesLooped` 读持久的最近两条 out，暂停期间不会更新——恢复后对方任一条新消息都再次命中「回复重复」→ 再次转人工 + 重发 Webhook；由于暂停期间 AI 无法产生新 out，该会话的自动恢复在数学上不可能。(b) 触发词（如「退款」）若仍是屏幕最后一条入站气泡，恢复后任一次看屏都会再次转人工。
- 违反：PRD 8.4「有『恢复自动』。恢复只影响这一会话」的可用性要求；造成通知风暴。
- 建议：转人工触发只针对「本轮新增」气泡（与 P1-3 合并解决）；触发后打「已消费」标记，`resume()` 时清掉触发基线。

**P1-5 「触发条件，全部可关」未满足；「知识库答不上」提前到 M1 生效**
- 位置：`src/core/shift/decide-turn.ts:167,215-225`、`src/core/shift/agents.ts:11-31`
- 「连续两轮重复」「连续两次点不行」「知识库答不上」三个触发器全部硬编码，无对应开关；只有词表可通过清空关闭。PRD 8.4 明文「触发条件，全部可关」，且「知识库答不上……这项从 M2 起生效」——当前 M1 代码已激活。
- 建议：`GateConfig` 增加 `handoffTriggers: { repetition, consecutiveBad, knowledgeMiss }`，默认值按里程碑设定（M1 中 knowledgeMiss 默认 false）。

### 节奏与知识包

**P1-6 40 字硬切会把 emoji（代理对）切成两半，发出乱码**
- 位置：`src/core/shift/pacing.ts:65-67`（已主代理复核确认）
- `piece.slice(index, index + 40)` 按 UTF-16 码元步进，边界落在 emoji 中间时前一条以孤立高代理结尾、下一条以孤立低代理开头。测试用 `parts.join('')` 校验恰好掩盖了该问题。
- 违反：8.5「改正后的正文必须等于模型给出的正文」。
- 建议：改用 `Array.from(piece)`（按码点）或 `Intl.Segmenter` 切分；补 emoji 测试用例。

**P1-7 中断后输入框残留文字，下一条会拼接误发**
- 位置：`src/core/rpa/input-utils.ts:162-169`
- `sendReplyByCoordsAction` 在 `paste` 之后、`enter` 之前中断时直接返回，已粘贴的半条文字留在输入框不清理。下次发送 `pasteText` 追加到残留之后，把上一条残句和这一条拼成一条发出——可能把 A 时刻的内容串进 B 时刻的回复。
- 违反：8.5 暂停/停止语义下「不发送」的可靠性底线。
- 建议：alive 失败的退出路径上执行全选删除清空输入框，失败时在班报记录「输入框可能有残留」。

**P1-8 「需要事实」由固定正则判定，未命中关键词的事实问题不查资料直接生成**
- 位置：`src/core/knowledge/search.ts:8`、`src/core/shift/decide-turn.ts:215-216`
- `needsKnowledge` 只认「多少钱/地址/营业/退款…」等硬编码词。「有几种口味」「明天有货吗」这类不含关键词的事实问题，`hits` 为空但不触发 handoff，在无任何知识约束下生成（连「资料里没有的不要编」护栏都不注入）。
- 违反：PRD 8.8「事实性回答只能使用命中的段落和会话记忆」「模型判断需要事实、但检索没有命中时，不生成猜测」。
- 建议：把「是否需要资料」交给模型输出结构化标记，或对无知识注入的回复做价格/地址/承诺类关键词的输出侧校验，可疑即转人工。

### 网关与商业构建

**P1-9 商业构建连接页仍展示可编辑的「网关地址」输入框，且无任何校验**
- 位置：`src/renderer/src/duty-ui.tsx:878-886`、`src/main/duty-service.ts:125-133`、`src/main/index.ts:1268-1287`
- PRD 8.10 明确「商业构建：设置页没有供应商、模型名、Base URL、API Key」——网关地址就是推理出口的 Base URL。且 `duty:setConnection` 对 URL 无 scheme/host 校验，主进程会把许可证码作为 Bearer、把当次截图 POST 到该地址：商业用户被诱导填入任意 URL 即可造成许可证与屏幕内容外流。
- 建议：商业构建删除该输入框，网关地址编译期固定；开源构建保留但校验 `https://` 前缀。

**P1-10 商业构建的渲染 bundle 与随包资源仍内嵌模型名/供应商名**
- 位置：`src/renderer/src/App.tsx:146-187, 774`、`src/renderer/src/i18n.ts:36`、`resources/providers/volcengine-ark/provider.bundle.js:1-2,16`
- COMMERCIAL 门控的只是「是否渲染」，依赖运行时 state，tree-shaking 无法消除 AgentPanel 及其引用的 `BUILTIN_PROVIDER_CATALOG`。商业包解 asar 或开 devtools 即见 `doubao-seed-2-0-lite-260428` 与 ark URL——效果上仍是「运行时藏起来」。
- 违反：PRD 3.3 / 8.10。对照：`MemoryWindow.tsx` 的编译常量门控是本次改动里**做对了的**范本。
- 建议：Provider 管理整块拆成动态 `import()` 并包在 `if (!COMMERCIAL)` 里，或为商业构建单独入口；i18n 文案按构建裁剪；CI 对商业产物断言不含 `doubao`/`volces.com` 字符串。

**P1-11 额度用尽只停「回复」，不停「看屏」：无限重试循环**
- 位置：`src/core/generic-channel-session.ts:266-273`
- 看屏失败返回 `skip + retry` → 5 秒后再 `observe_chat` → 再打一次注定失败的看屏请求，永不停止。对比回复路径在额度用尽时会 `stopSession('quota')`。
- 违反：PRD 8.10「额度用尽时停止新的看屏和回复」（本机记录只读可用这点满足：ShiftStore 不依赖引擎）。
- 建议：`handleTurn` 对 `action.reason` 同样判断额度/许可文案，命中即 `stopSession('quota')`；考虑对连续 N 次 vision_error 熔断。

**P1-12 skill-server 仍是全局暂停，未实现「按会话暂停」；且无鉴权、CORS 全开**
- 位置：`src/main/skill-server.ts:5-7, 62-67, 195-213`
- (a) 只有 `/skill/start`、`/skill/pause`（全局停引擎）、`/skill/status`，PRD 第 6 节缺口表明确要求「按会话暂停，而不只是全局暂停」；按会话的暂停目前只有进程内路径（coldCurrent、handoff），HTTP API 完全没有会话维度参数。
- (b) 所有响应带 `Access-Control-Allow-Origin: *`，POST 无 preflight、无 token/来源校验——用户浏览器里打开的任意恶意网页都可以 `fetch('http://127.0.0.1:12680/skill/start', {method:'POST'})` 直接启动会驱动键鼠、向微信发消息的引擎。仅监听 127.0.0.1 挡不住跨站请求。
- 建议：扩展 `/skill/pause` 接受可选会话 key（复用 ShiftStore 的 cold/handoff 机制）；启动时生成随机 token 校验 `Authorization` 头；CORS 收紧。

**P1-13 IPC 暴露面：preload 提供无白名单的通用 invoke/on/send**
- 位置：`src/preload/index.ts:3-13`
- 渲染层可调用任意主进程通道：`settings:getAll` 会把 `vision.apiKey`、`chatProvider.config`（含 apiKey 与 model 名）、`licenseCode` 整包返回给页面；`provider:getInstalled`、`engine:testConnection` 等同样裸露。商业构建下模型/供应商/密钥数据仍进渲染进程内存——3.3 的编译开关只做掉了 UI 层。
- 建议：preload 加通道白名单（按窗口类型细分更佳），`settings:getAll` 在商业构建剥离 apiKey/model/chatProvider。

**P1-14 商业构建下多条错误路径未过 sanitizeError，模型名可直通 UI 日志/toast**
- 位置：`src/core/generic-channel-session.ts:70`、`src/core/runtime-host.ts:55,165`、`src/main/index.ts:1034-1040, 763-771`
- 已脱敏的只有 duty-service 的 prepare catch 与 `provider.error` 分支。bootstrap 布局识别失败原文（含 `API request failed: 404 - model ... not found` 类文本）、队列异常、startEngineCore 兜底 catch、testConnection 都原样透传到主窗口日志面板与 toast。
- 违反：PRD 3.3「错误提示不出现模型商品名、供应商名字和模型 ID」。
- 建议：`log()` 汇入 `engine:log` 前统一过 sanitizeError（commercial 分支），兜底路径同样映射四态文案。

---

## 四、P2（应修，22 项）

### 会话记忆与班报

| # | 位置 | 问题 |
|---|---|---|
| P2-1 | `transcript-merge.ts:52-55` | 记录对不齐时冷处理命中不记「已读基线」，解除后与旧记录对不齐，只能进人工复核，违背 8.12「解除后下一轮可以再回复」的顺畅预期 |
| P2-2 | `store.ts:218-221` | `now + index` 时间戳跨批次乱序（快速连续两轮看屏或时钟回拨时），乱序后尾部对不齐 → 误报 reject → 会话卡进复核 |
| P2-3 | `store.ts:215-221` | vision 路径写入已规范化文本、`recordSent` 写发送原文，`turns.text` 两种形态并存，列表/防重复比较/导出拿到不一致数据 |
| P2-4 | `store.ts:38-69` | events 永久增长无清理、turns 每会话无上限、两表均无二级索引，`sentCountSince` 每轮看屏全表扫描 |
| P2-5 | `report.ts:72-80` | CSV 时间列用 UTC ISO 串（与本地自然日聚合差 8 小时）且无 BOM，Excel 打开中文列可能乱码 |
| P2-6 | `report.ts:59-66` | 昨天转人工、今天无新消息的会话以 `at: 0` 出现在班报，渲染成 1970-01-01 假时间 |
| P2-7 | `store.ts:101,192` | agents 表 `JSON.parse` 无容错，单行损坏会炸掉整个 DutyService 构造链，班报/回合/冷处理全部不可用 |
| P2-8 | `conversation-key.ts:13-17` | `normalizeTitle` 不剥离零宽空格/BOM/软连字符，看屏输出带不可见字符时同一会话被拆成两份记忆、两条冷处理键 |
| P2-9 | `duty-service.ts:486` | `keyOf` 手写 `window:` 键与 `windowConversationKey`（`window:unknown`）漂移，appType 为空时 `stillOn` 与 action.key 对不上导致发送中止 |
| P2-10 | `duty-service.ts:95-106` | 「冷处理当前会话」使用缓存的 lastIdentity 未验证「当前」，用户切换窗口后引擎未跑新一轮时会把上一个会话加进名单，违反 8.12「只有这一轮已经确认对方是谁时才能点」 |

### 闸门与转人工

| # | 位置 | 问题 |
|---|---|---|
| P2-11 | `decide-turn.ts:115` 早于 `gates.ts:34` | 转人工词检查先于黑名单：广告号说出「退款」会写转人工、发 Webhook。黑名单语义是「永不回复」的静默拦截。建议顺序调整为 cold → handedOff → blacklist → keyword |
| P2-12 | `gates.ts:57-64` | 上班时段对非法配置（如「9:99」入库）fail-open 全天放行，属「该停不停」方向。建议 fail-closed |
| P2-13 | `gates.ts:33-38` | 黑/白名单匹配不折叠大小写，`John`/`john` 不互匹配，黑名单可被大小写变体绕过 |
| P2-14 | `gates.ts:36-39` | 白名单模式不约束群聊与框选窗口（只对 `kind === 'single'` 生效），与 8.2「打开后只回复名单内的单聊」存在语义歧义 |
| P2-15 | `gates.ts:84-88` | 「高度重复」用完全相等实现（「好的」vs「好的。」不判重复），且 `recentOut` 不过滤 source，人工连发两条相同消息也触发转人工 |
| P2-16 | `duty-service.ts:277` | `noteBad` 里 `void this.finishHandoff(...)` 浮动 promise 吞异常，SQLite 异常时 handed_off 未落库且成为 unhandledRejection，下一轮继续自动回复 |
| P2-17 | `generic-channel-session.ts:424-460` | 发送前不复查冷处理/转人工状态：辅助模式草稿停留期间用户点了冷处理或已转人工，点「发送」时仍会发出，时间窗上穿透 8.12/8.4 |
| P2-18 | `webhook.ts:10-13`、`gates.ts:41-43` | Webhook 时间只有 HH:MM 无日期，跨天班次无法定位；群聊 skip 原因不区分「读不到 @ 关系」与「确实没 @」（PRD 8.2 明确要求记录原因） |
| P2-19 | `controller.ts:14-18` | 「这条有用」未实现（只有 send/discard/handoff/bad），8.3 只落了一半；`bad.reason` 类型上未收窄为四值枚举 |
| P2-20 | `gates.test.ts` | 黑名单、白名单、`groupReply='all'`、`hitKeyword`、`repliesLooped` 零用例——闸门表五行中两行无测试，恰是有匹配风险的行 |

### 节奏、知识包与商业

| # | 位置 | 问题 |
|---|---|---|
| P2-21 | `pacing.ts:57` | 分段 `part.trim()` 把换行剥掉，超 40 字的多行文本分段后换行丢失，拼接与原文不等 |
| P2-22 | `duty-service.ts:514-516`、`gates.ts:49-52` | 每小时上限用自然整点窗口，10:59 发满 30 条后 11:00 计数清零又可发 30 条，一分钟左右可发 60 条，违背 3.4「避免短时间大量发送」的意图。建议滚动 60 分钟窗口 |
| P2-23 | `knowledge/read-file.ts:22-27` | PDF 解析无解压后大小上限，畸形 PDF 可解出远超 10MB 的文本全量进内存并切块写 sqlite |
| P2-24 | `knowledge/search.ts:29-33` | Markdown 标题识别要求「独立成块」，「# 价格」换行紧跟正文的常见写法拿不到小标题，title 退化为文件名，影响 8.8「用户判断是否答非所问」 |
| P2-25 | `duty-ui.tsx:594-624` | 「阅读等待」「长文分段」在 UI 上没有独立开关（数据层有字段且默认正确），用户只能关总开关回到整段粘贴，与 8.5 M1 配置表不符 |
| P2-26 | `store.ts:158-168` | 停用启用中的智能体会隐式自动启用另一个，「停用」变成「换人接班」，被切到的智能体立刻接管自动回复而用户不知情 |
| P2-27 | `input-utils.ts:220-236` | `commitInput` 的 enter → ctrl/cmd+enter → backspace 键序列平台语义可疑：首个 enter 已发送时后续组合键可能触发换行或空消息 |
| P2-28 | `pacing.ts:29-33, 114-117` | 手速三档只作用于段间延迟，段内仍是整段一次粘贴，录屏中单条 40 字消息仍瞬间出现（M4 观感提前提示） |
| P2-29 | `input-utils.ts:253` | 图片发送的阅读等待硬编码 `slow ? 1400 : 800`，与 `SPEED_MS` 不一致（steady 档发图仍等 800ms） |
| P2-30 | `gateway/capability.ts:3-7` | 许可证激活是纯本地桩，任何 ≥8 位字符串都算「已激活」，无网关核对；叠加 P0-1 后商业门禁整体形同虚设 |
| P2-31 | `gateway/capability.ts:19-21` | 401 被映射为「额度用尽」，与许可证无效混淆，用户误以为要充值。建议 401 → 「请先激活许可证」，402/429 → 额度用尽 |
| P2-32 | `duty-service.ts:419-425` | 连接页「看屏/回复」状态只由配置推导（key/gateway 非空即「可用」），运行态的额度用尽/网络不可用不会回流 |
| P2-33 | `duty-ui.tsx:272-379` | 当班页缺「开始和暂停」按钮与当前智能体名（只在主窗口 BottomBar），与第 9 节当班页要素清单不符 |
| P2-34 | `duty-service.ts:57-60` | `materialRules.imagePath` 无主进程侧校验：被入侵的渲染层可写任意绝对路径，把本机任意图片文件发送进微信（外泄通道）。建议 pickImage 时登记白名单 |
| P2-35 | `package.json:14-32` | 无商业构建脚本，开关全靠手工环境变量，发商业包时容易漏设。建议加 `build:commercial` 并在 CI 断言产物不含模型名 |

---

## 五、P3（小项，列出备查）

- `agents.ts:61`：`typo: speed === 'slow' ? 'low' : 'low'` 恒等三元，疑似笔误。
- `gates.ts:46`：reason 文案「不在上班时段」与 PRD 8.5 原文「时段外未回复」不一致，班报/CSV 直接透出。
- `rpa/screenshot-utils.ts:21,198`：`screenshotPendingPromises` 只 set 从不 get，并发去重是死代码。
- `pacing.test.ts:38-41`：rng stub 两分支同值；缺 emoji、含换行长文两个关键用例（正对应 P1-6/P2-21）。
- `store.ts:344-352`：不同目录的同名知识文件按 `fileName` 互相覆盖，无提示。
- `mock-device.ts:68`：`sendMessage` 完全忽略节奏参数，节奏回归在 mock 链路上是盲区。
- `search.ts:8`：FACTUAL 词表偏宽（「课程」「包含」「退款」均触发），寒暄里带这些词会频繁转人工（安全方向的误伤，可调参）。
- `transcript-merge.ts:77`：`selectHistory` 下限 0，靠调用方 clamp(5,50) 兜底，导出 API 自身不设防。
- `transcript-merge.ts`：尾部对齐逻辑在 `mergeVisible` 与 `selectHistory` 各复制一份，易漏改。
- `decide-turn.ts:85`：「未绑定会话」只以措辞近似落轨迹（「没确认对方是谁」），无结构化标记，无法按 PRD 8.1 措辞检索统计（行为已满足且有测试）。
- `store.ts:4, 80-87`：依赖实验性 `node:sqlite` 且无 `close()`；`endOfLocalDay = start + 24h` 在 DST 切换日会偏一小时（验收平台无 DST，留注释即可）。
- `provider.bundle.js:79`：网关模式下请求体仍携带 `model` 字段，网关应服务端选型。
- `duty-service.ts:45,345`：`nameCheckPassed` 不随 appType 切换重置，换目标应用后自动发送仍放行。
- `duty-ui.tsx:103-120`：`hourlySent` 只在事件驱动时刷新，长时间空闲后小时计数滞留旧值。
- `duty-service.ts:236-245`：`stillOn` 每次发送前多打一次看屏请求，商业按次计费下成本翻倍，可考虑本地窗口标题校验替代。
- USB 后端：`usbReady` 硬编码 false，UI radio 已正确 disabled，但 `duty:setInputBackend` IPC 仍接受 'usb'，绕过 UI 可把设置写成 usb（接 CH9329 时记得补真实探测）。
- `duty-service.ts:360`：30 文件上限的检查与写入之间存在理论竞态（并发 invoke），模态对话框下概率极低，可不修。

---

## 六、PRD 符合性通过项（做对了的）

以下经逐条核对符合 PRD，列出以保持审计平衡：

- **会话键**（8.12）：kind 前缀 + 群人数剥离 + 空名称拒绝，与 PRD 逐条对应且有测试。
- **数据分离**（8.1）：回合记忆（shift.sqlite 的 turns）与工作轨迹（worktrace jsonl）两种数据分离干净；`<userData>/worktrace/` 本机存储符合第 10 节。
- **冷处理**（8.12）：检查在调用回复模型之前（decide-turn.ts:95 早于一切生成路径，有测试）；仅两种加入方式；解除不删回合；「记录对不齐时退款仍转人工」的排序是有意设计且注释清楚。
- **转人工安全侧**（8.4）：Webhook 失败保持暂停（先 setHandedOff 再通知）；只暂停单会话；通知内容仅名称/原因/时间，无聊天记录。
- **默认值**（8.2/8.3/8.5）：辅助模式、白名单默认关、群聊默认只回 @、词表默认投诉+退款、节奏开关默认开、阅读等待默认开、长文分段默认开、时段默认全天关、每小时 30 条——全部落对。
- **自动发送闸门**（8.3）：`duty:allowAuto` 强制先过 `nameCheckPassed`（核对当前窗口），辅助切自动有风险确认语，核对不写会话记忆。
- **经验卡片闭环**（8.3）：noteBad → addCards → 注入下次 system prompt，链路成立。
- **并发模型**：RuntimeHost 队列串行，无同会话并发回合；无正则注入面。
- **两项连接状态**（3.3）：DutyConnectionPage 恰好两行「看屏/回复」；`SHOW_TOKEN_COST` 商业强制 false 方向正确。
- **确认层六要素**（第 9 节）：草稿、命中资料标题、发送、丢弃、转人工、这条不行，齐备。
- **MemoryWindow**：模型名/费用展示用编译常量门控——本次改动里做对了的编译开关范本。
- **安全基本功**：无 `dangerouslySetInnerHTML`；`trace:getScreenshot` 有路径穿越校验；密钥未进日志；测试加载器（register-test.mjs/test-loader.mjs）干净无风险。
- **知识包骨架**（8.8）：本机关键词检索、命中段落注入、标题展示、无命中转人工、文件上限拒绝，均有实现和测试。

---

## 七、修复路线建议

**提交前必须修（阻断合入）**：
1. P0-1 商业开关编译期化 + P2-35 商业构建脚本
2. P1-3 / P1-4 / P1-5 转人工触发器作用域三连（同一根因，建议一并修）
3. P1-6 / P1-7 发送保真两连（emoji 切半、输入框残留）
4. 安全向：P1-12 skill-server 鉴权 + P1-9 网关地址校验

**M1 收口前修**：
P1-1 班报恢复状态、P1-2 回合四要素、P1-8 needsKnowledge、P1-11 看屏额度熔断、P1-13 IPC 白名单、P1-14 错误脱敏、P2-11 黑名单顺序、P2-16 浮动 promise、P2-17 发送前状态复查、P2-20 闸门测试补齐

**M3（网关切片）前批量收口**：
P1-10 模型名出 bundle、P2-30 许可证真校验、P2-31 状态码语义、P2-32 运行态回流、P2-5 CSV 时区

**随 M4 收口**：P2-21 分段换行、P2-22 滚动窗口、P2-28 段内打字粒度、P2-29 图片阅读等待

---

## 八、审计方法说明

- 四个并行审计子代理分别负责：①会话记忆与班报（8.1/8.11/8.12）②闸门与转人工（8.2/8.3/8.4）③节奏与知识包（8.5-8.8）④网关与商业构建（3.3/8.10/第 9 节/skill-server）。
- 主代理对 P0-1、P1-3、P1-6 三个最高严重度发现逐一读码复核，均属实。
- `npm test` 全量通过（51/51），说明问题主要在**测试未覆盖的边界**（emoji、多气泡、恢复回路、商业包运行时行为），而非已有用例失效。
- 部分子代理无终端权限，修改文件按工作区当前全文审计（改动 +100 行以内的文件全文与 diff 差异可控，结论不受影响）。
