# 模型用量账本与缓存计费说明

> 核实日期：2026-10-20。价格与缓存规则均来自火山方舟官方文档（见文末「核实来源」）。官方调价或升级默认模型时，需同步本文与 `src/core/usage/usage-ledger.ts` 中的价格表。
>
> 本文描述的是**已实现行为**：`src/core/usage/usage-ledger.ts`（账本与计费）、`src/core/ai-client.ts`（调用与上报）、`src/main/provider-bundle.ts`（外部 Provider 上报桥）、`src/renderer/src/App.tsx` / `MemoryWindow.tsx`（展示）。

## 1. 结论速览

- 每次模型调用把 token 数与费用逐条追加到 `usage.jsonl`（`app.getPath('userData')/usage/`，设置页「用量与费用 → 打开账本文件夹」可直接打开）。
- 隐式（透明前缀）缓存由方舟**自动开启、无需开通任何服务、无法关闭**；本项目走 Chat API，命中即为缓存价。
- `doubao-seed-2.0-lite` 三档价格中，缓存命中价均为对应输入价的 **20%**，与代码常量 `CACHE_HIT_DISCOUNT = 0.2` 一致。
- 隐式缓存**不收取缓存存储费**；只有显式缓存（Context API）才需要开通「推理（缓存）定价」并按 `0.017 元/百万 token/小时` 计存储费，本项目不使用显式缓存，因此账本不建模该项。

## 2. 数据来源与落账字段

计费数据全部取自 `/chat/completions` 响应体：

| 来源字段 | 含义 | 对应账本字段 |
| --- | --- | --- |
| `usage.prompt_tokens` | 输入总量（**包含**缓存命中部分） | `inputTokens` |
| `usage.completion_tokens` | 输出总量 | `outputTokens` |
| `usage.total_tokens` | 总 token；缺失时按输入 + 输出计算 | `totalTokens` |
| `usage.prompt_tokens_details.cached_tokens` | 命中隐式缓存的输入 token（是 `prompt_tokens` 的子集） | `cachedTokens` |
| `id` / `model` | 请求 ID / 实际模型名 | `requestId` / `model` |

每条记录（`UsageRecord`）还包含：`ts`（ISO 时间）、`purpose`（调用用途）、`source`（`AIClient` 或 `provider:<id>`）、`tier`（计费档位）、`priced`（是否在计价表内）、`inputPrice` / `outputPrice`（元/百万 token）、`inputCost` / `outputCost` / `cost`（元）。

`purpose` 取值与含义：

| purpose | 场景 | 是否归属轨迹步骤 |
| --- | --- | --- |
| `reply` | 生成聊天回复 | 是 |
| `vision` | VLM 视觉定位 | 是 |
| `learn` | 轨迹经验学习 | 否（只入账本） |
| `test` | 连接测试 | 否（只入账本） |
| `text` | 其他纯文本调用 | 否（只入账本） |

归属规则：

- `reply` 进入进程级 `pending`。Provider 会在请求返回前先发出「正在分析」，这条轨迹先记在内存里，等回复 / 跳过 / 失败返回后再落盘，并显式 `claimPendingUsage`。这样费用挂在分析步，而不是后面的发送步，也不会被无关的截图步领走。
- `vision` 不进全局 `pending`。调用方用 `captureUsage()` 包住检测，把结果挂到紧接着的那条轨迹（布局测量、点击未读入口、打开未读会话）。没有后续轨迹的检测（未读轮询未命中、会话外的 VLM 测试）只写账本。
- `learn` / `test` / `text` 只写账本。
- 会话 `startSession` / `endSession` 会 `discardPendingUsage()`，避免没领走的回复算进下一次会话。

## 3. 官方价格表（doubao-seed-2.0-lite，非音频）

单位：元 / 百万 token。

| 输入长度（千 token） | 输入 | 缓存命中 | 输出 |
| --- | --- | --- | --- |
| [0, 32] | 0.6 | **0.12** | 3.6 |
| (32, 128] | 0.9 | **0.18** | 5.4 |
| (128, 256] | 1.8 | **0.36** | 10.8 |

补充说明：

- 官方表另有音频输入列（输入音频 9.0、缓存命中音频 1.8、输出同价），截图文本调用不涉及音频 token，账本不区分。
- 档位按**单次请求的输入长度**定档（千 token 口径），输出与缓存命中沿用同一档位。
- 官方只公布到 256k 档；超过 256k 的请求，代码按最高档计价（`priceFor` 的兜底行为）。

## 4. 计费逻辑

### 4.1 官方口径

官方在线推理费用公式（非音频部分）：

```text
费用 = 输入单价 × 输入token
     + 缓存命中单价 × 缓存命中token
     + 缓存存储单价 × 缓存存储token × 时长
     + 输出单价 × 输出token
```

### 4.2 代码实现

```text
档位          = priceFor(inputTokens, model)   // 非 lite 模型返回 null → 不计价
非缓存输入    = inputTokens - cachedTokens     // cachedTokens 已 clamp 到 [0, inputTokens]
输入费用      = (非缓存输入 × 档位输入价 + cachedTokens × 档位输入价 × 0.2) / 1,000,000
输出费用      = outputTokens × 档位输出价 / 1,000,000
```

- 与官方公式等价：`缓存命中单价 = 档位输入价 × 0.2`，且 `prompt_tokens` 包含缓存部分，故先做减法再分别计价。
- **缓存存储费不建模**：隐式缓存无存储费（官方原文：「与显式缓存相比，隐式缓存存储不计费」）。
- **非计价模型**：模型名不以 `doubao-seed-2-0-lite` 开头时不套用价格表，记录 `priced=false`、`tier='unknown'`、费用为 0；UI 明细显示「—（未计价）」，轨迹步骤行隐藏金额段，避免给出误导性费用。

### 4.3 算例

0-32k 档，单次输入 10,000 tokens、其中 8,000 命中缓存：

| | 计算 | 费用 |
| --- | --- | --- |
| 全额计价（修复前的旧逻辑） | 10,000 × 0.6 / 1e6 | ¥0.006000 |
| 当前逻辑 | 2,000 × 0.6 / 1e6 + 8,000 × 0.6 × 0.2 / 1e6 | ¥0.002160 |

## 5. 缓存机制：隐式 vs 显式

方舟的上下文缓存分两种模式（官方文档 `docs/ark/context-cache`）：

| | 隐式缓存（本项目使用） | 显式缓存（未使用） |
| --- | --- | --- |
| 开通 | **无需开通**，自动启用，无法关闭 | 需在方舟「开通管理」页开通模型的**「推理（缓存）定价」**能力 |
| 接入方式 | 无感：系统自动识别请求公共前缀 | 需主动创建：Context Create API，或请求带 `store: true` + `caching: {type: "enabled", prefix: true}` |
| 命中 | 系统判定，**不保证命中**；命中长度也可能不是最长前缀 | 确定性命中，可设缓存过期时间 |
| 成本 | 命中部分按缓存价（20%），无存储费 | 命中按缓存价，另收存储费 **0.017 元/百万 token/小时** |
| 支持的 API | Responses API、Chat API | Responses API（前缀缓存 / Session 缓存） |
| 模型支持 | doubao-seed-2.0 及之后系列在线推理（能力表：`doubao-seed-2-0-lite-260428` 隐式缓存支持 Responses API 与 Chat API） | 同左，能力表单独标注 |

对账本的影响：

- 本项目只走 Chat API 隐式缓存 → **不需要任何开通动作**，账本只需处理「缓存命中价」，存储费恒为 0。
- 若未来接入显式缓存，需要：① 在开通管理页开通「推理（缓存）定价」；② 账本补充 `缓存存储token × 0.017 × 时长` 计费项；③ 显式缓存请求的 `cached_tokens` 语义需重新核对（显式与隐式可能互斥，官方说明「当请求使用显式缓存时，隐式缓存不生效」）。

## 6. 命中条件与自查

官方对隐式缓存的说明要点：

- 「缓存命中条件：缓存块达到对应模型的最小门槛后，才可能会被系统识别并参与命中匹配」——前缀较短时命中率为 0 属正常。
- 提升命中率的官方手段：**保持前缀稳定**（固定角色设定、背景资料等放前部，当轮变量放后部）；以及使用 **Prompt Cache Key**（路由亲和）。

本项目的前缀结构：`system prompt（固定）+ 经验卡片段（随记忆变化）+ 用户消息（含截图）`。经验段变化会导致前缀偏移，命中与否以实测为准。

自查方法：

1. 设置页「用量与费用 → 打开账本文件夹」，打开 `usage.jsonl`。
2. 观察新记录的 `cachedTokens` 是否非 0；为 0 说明未命中（或被系统判定不划算）。
3. 控制台日志 `[Usage] reply in=... out=... tier=... cost=...` 同步可见。

可选优化（尚未实现）：在请求体加稳定的 `prompt_cache_key`（如固定字符串 `sightflow-reply`）。官方限制：同一 key 的请求流量建议控制在 **15 请求/分钟**以内；单机自动回复场景流量低，通常安全。

## 7. 维护清单：升级模型时必须同步的位置

模型名与价格在 7 处出现，其中只有 `DEFAULT_MODEL` 是代码内的单一常量源，其余为无法 import 的资源/文档/展示字符串：

| 位置 | 内容 | 是否可自动同步 |
| --- | --- | --- |
| `src/core/ai-client.ts` → `DEFAULT_MODEL` | 模型名（单一常量源） | 基准 |
| `src/main/index.ts` | 从 `ai-client` import `DEFAULT_MODEL` | 自动 |
| `src/core/usage/usage-ledger.ts` → `PRICED_MODEL_PREFIX`、`TIERS` | 计价前缀与三档价格 | 手动核对官方价格页 |
| `resources/providers/volcengine-ark/manifest.json` → `configSchema.model.default` | Provider 默认模型 | 手动 |
| `resources/providers/volcengine-ark/provider.bundle.js` → `DEFAULT_MODEL` | 内置 Provider 默认模型 | 手动 |
| `src/renderer/src/App.tsx` → 设置页「视觉模型」展示值 | 只读展示字符串 | 手动 |
| `README.md` / `README.zh-CN.md` | 文档中的模型名 | 手动 |

## 8. 已知限制

- **历史记录不追溯**：折扣逻辑上线前写入 `usage.jsonl` 的记录为全额计价，`purpose` 等字段也缺失 `priced` 标记（按已计价处理），「累计」费用会略偏高。
- **隐式缓存不保证命中**：命中率受前缀稳定性与服务端调度影响，`cachedTokens` 长期为 0 不代表实现有误。
- **价格表仅覆盖 doubao-seed-2.0-lite**：自定义 Provider 或换用其他模型时只记 token、不计费用（`priced=false`）。
- **账本文件不轮转**：`usage.jsonl` 持续追加，读取侧有 mtime + size 缓存（文件未变化时不重复解析），但文件本身无限增长；长期运行如需清理，直接归档/删除该文件即可（不影响 trace）。
- **缓存存储费未建模**：仅显式缓存才有此项，本项目不涉及。

## 9. 核实来源

- 模型价格（在线推理、缓存命中、缓存存储、精调等分表）：
  `https://docs.volcengine.com/docs/ark/model-pricing`（由 `https://www.volcengine.com/docs/82379/1099320` 跳转）
- 上下文缓存（隐式/显式模式、开通要求、计费说明、Prompt Cache Key）：
  `https://www.volcengine.com/docs/82379/1398933` → `https://docs.volcengine.com/docs/ark/context-cache`
- 模型列表 · 上下文缓存能力（`doubao-seed-2-0-lite-260428` 的隐式/显式缓存支持矩阵）：
  `https://ark.volcengine.com/region:cn-beijing/docs/model-list#ed095742`
