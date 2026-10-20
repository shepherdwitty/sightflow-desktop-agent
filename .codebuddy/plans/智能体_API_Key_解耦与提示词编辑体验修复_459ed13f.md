---
name: 智能体 API Key 解耦与提示词编辑体验修复
overview: 修复智能体页每次改提示词被迫重填 API Key 的问题（required 校验 + 回填链 + 展开顺序 bug），并将豆包聊天密钥与视觉密钥解耦：chatProvider.config.apiKey 独立持久化，运行时留空则回退 vision.apiKey，保持老用户行为不变。
todos:
  - id: renderer-doubao-key-fix
    content: 修改 App.tsx：豆包 apiKey 改可选并补提示文案，修复 getProviderValues 展开顺序与 drafts 初始化回退链，persistProvider 保留 apiKey 于 config 不再写回 vision，校验改为 vision key 回退守卫
    status: completed
  - id: main-chatkey-decouple
    content: 修改 index.ts startEngineCore：chatKey 按 config.apiKey||vision.apiKey 解析，拆分 chat key 与 vision key 启动校验，移除强制覆盖逻辑
    status: completed
    dependencies:
      - renderer-doubao-key-fix
  - id: manifest-restore-apikey
    content: 修改 manifest.json 移除 apiKey 必填并补提示 title，provider-bundle.ts 移除 apiKey 剥离逻辑返回原始 manifest
    status: completed
    dependencies:
      - main-chatkey-decouple
  - id: build-verify
    content: 在项目根目录执行 npm run build 验证 typecheck 与 electron-vite 构建通过，失败则修复
    status: completed
    dependencies:
      - manifest-restore-apikey
---

## 需求概述

针对 sightflow-desktop-agent（Electron 桌面 RPA 客户端）设置页的两个已确认问题进行修复优化：

### 问题 1：修改智能体提示词被迫重填 API Key

- 内置豆包卡片的 apiKey 字段为必填（required: true），但保存时 key 被拆走只存 `vision.apiKey`，`chatProvider.config` 不留副本，每次进页面全靠回填链路，一旦断裂即报「缺少必填项: API Key」
- `getProviderValues` 存在展开顺序 bug：`apiKey: fallback` 写在 `...(drafts.doubao)` 之前，drafts 中一旦出现空字符串 apiKey 会永久覆盖 vision key 的回退，直到重新 mount

### 问题 2：聊天密钥与视觉密钥耦合

- 智能体页保存豆包配置时把 key 写回 `vision.apiKey`，运行时强制 `apiKey: settings.vision.apiKey` 覆盖，聊天 provider 无法使用独立密钥（不同账号/额度池）

### 目标行为（已确认方案）

- 豆包 apiKey 改为可选，placeholder/hint 提示「留空则使用基础配置密钥」
- `chatProvider.config.apiKey` 独立持久化，不再写回 vision
- 运行时取 `config.apiKey || vision.apiKey`：留空共享视觉密钥（老用户无感），填了则聊天走独立密钥（解耦）
- 兼容存量数据与第三方 provider 残留 key 的边缘情况
- 聊天 provider「截图进 → 文字出」的多模态契约不变；视觉链路（VLM 抓取、经验学习、测试连接）继续使用 `vision.apiKey`

## 技术栈

- 既有栈：Electron 39 + electron-vite + React 19 + TypeScript，`electron-store` 持久化，IPC（`settings:set/getAll`、`engine:start`）+ Skill HTTP Server 共用 `startEngineCore`
- 不引入新依赖、不改架构，仅修正配置解析/持久化/校验链路

## 实现方案

核心思路：把「聊天密钥」从 `vision.apiKey` 的镜像升级为 `chatProvider.config.apiKey` 的独立可选覆盖项，取值链统一为 `config.apiKey || vision.apiKey`，UI 必填校验与运行时启动校验同步调整。

### 修改点 1：渲染层 src/renderer/src/App.tsx

1. **`BUILTIN_PROVIDER_CATALOG` 豆包 apiKey 字段**（140-180 行）：`required: true → false`，placeholder 改「留空则使用基础配置中的视觉密钥」，增加 `hint` 同义提示（`ProviderFieldInput` 已支持 hint 渲染，App.tsx:1147）
2. **修复 `getProviderValues` 展开顺序**（1167-1187 行）：显式 `apiKey` 回退行移到 `...(drafts.doubao)` 之后；回退链改为 `drafts.doubao?.apiKey → (!installed 时 config.apiKey) → ''`（表单只展示聊天侧实际持久值，vision 回退由校验与运行时处理）
3. **`loadSettingsAndCatalog` drafts 初始化**（911-924 行）：`apiKey: prev.doubao?.apiKey || doubaoConfig.apiKey || ''`（不再用 vision key 预填，避免保存时把 vision key 意外复制进 config）
4. **`persistProvider` 豆包分支**（960-983 行）：

- 不再 `const { apiKey, ...providerConfig } = values` 拆 key，直接 `settings:set { chatProvider: { manifestUrl: '', installed: null, config: values } }`，**不写 vision**
- `values.apiKey`（含空串）显式落盘，借助 `settings:set` 的 config 浅合并覆盖曾启用第三方 provider 残留的旧 key
- 校验调整：`getMissingRequiredFields` 不再拦 apiKey（已非必填）；新增守卫——`!values.apiKey?.trim() && !currentSettings?.vision.apiKey` 时报「请填写 API Key，或在基础配置填写视觉密钥」（useCallback 依赖补 `currentSettings`）

### 修改点 2：主进程 src/main/index.ts `startEngineCore`（803-854 行）

1. 密钥解析改为：

- `isDoubaoPath = !installed || installed.id === BUILTIN_DOUBAO_PROVIDER_ID`
- `chatKey = isDoubaoPath ? (settings.chatProvider.config?.apiKey || settings.vision.apiKey) : null`

2. 启动校验拆分（替换原 812-819 行）：

- `isDoubaoPath && !chatKey` → 报「请填写智能体 API Key，或在基础配置填写视觉密钥」（reason: `no_chat_key`）
- `startupStrategy === 'vlm' && !settings.vision.apiKey` → 保留原 `no_vision_key` 报错（vision key 仅在 VLM 抓取策略下必需）

3. Provider 加载（823-853 行）：豆包两条路径统一 `{ ...config, apiKey: config.apiKey || settings.vision.apiKey }`，删除强制覆盖为 vision key 的逻辑；原 required 过滤中豁免 apiKey 的特判保留（防御性，manifest 改造后为空逻辑）
4. 其余 vision.apiKey 消费方（`memory:learnFromSession`、`engine:updateConfig`、`engine:testConnection`、`test:vlm-parallel`、`buildDevice`）一律不动

### 修改点 3：清单与 bundle 侧

1. **resources/providers/volcengine-ark/manifest.json**：`required: ["apiKey"] → []`，apiKey 字段保留（password 类型），title 可补「（留空使用基础配置密钥）」提示
2. **src/main/provider-bundle.ts `getBuiltinDoubaoManifestForUi`**（194-218 行）：删除 apiKey 剥离逻辑，直接返回原始 manifest（字段回归 UI 可见，但已非必填）；同步更新函数注释

### 兼容性说明

- 存量用户（vision.key 有值、config 无 key）：校验与运行时均回退 vision key，行为完全不变
- 曾装第三方 provider 的用户：豆包保存时 `config: values` 显式覆盖残留 apiKey
- `normalizeSettings` 的 legacy 顶层 apiKey 回填（1120-1150 行）保留不动

## 实施注意事项

- `settings:set`（index.ts:464-479）对 `chatProvider.config` 是浅合并，空字符串 apiKey 能覆盖旧值，无需改合并逻辑
- `persistProvider` 补 `currentSettings` 依赖后注意 useCallback 依赖数组正确性，避免闭包读到过期 settings
- 渲染层 `provider:getInstalled` 启动前校验（App.tsx:567-581）读的是 manifest.required，manifest 改为非必填后自动放行，无需改动
- Skill HTTP Server 与 IPC `engine:start` 共用 `startEngineCore`，只改一处
- 改动集中在配置解析纯函数与启动校验，无热路径性能影响

## 目录结构

```
sightflow-desktop-agent/
├── src/renderer/src/App.tsx        # [MODIFY] 豆包 apiKey 改可选+提示文案；修复 getProviderValues 展开顺序；drafts 初始化回退链；persistProvider 不再写回 vision、校验改回退守卫
├── src/main/index.ts                # [MODIFY] startEngineCore：chatKey 解析 config.apiKey||vision.apiKey；启动校验拆分 chat key / vision key 两条
├── src/main/provider-bundle.ts      # [MODIFY] getBuiltinDoubaoManifestForUi 移除 apiKey 剥离，返回原始 manifest
└── resources/providers/volcengine-ark/manifest.json  # [MODIFY] required 移除 apiKey，字段保留并补提示性 title
```

## 关键代码结构

`startEngineCore` 密钥解析（意图示意，非最终实现）：

```ts
const isDoubaoPath =
  !settings.chatProvider.installed ||
  settings.chatProvider.installed.id === BUILTIN_DOUBAO_PROVIDER_ID
const chatKey = isDoubaoPath
  ? (settings.chatProvider.config?.apiKey || settings.vision.apiKey)
  : null

if (isDoubaoPath && !chatKey) {
  return { ok: false, reason: 'no_chat_key', message: '请填写智能体 API Key，或在基础配置填写视觉密钥' }
}
if (startupStrategy === 'vlm' && !settings.vision.apiKey) {
  return { ok: false, reason: 'no_vision_key', message: '请先填写视觉接口密钥' }
}
// 豆包两条加载路径统一：
const effectiveConfig = { ...settings.chatProvider.config, apiKey: chatKey }
```