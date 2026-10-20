# USB 硬件键鼠（CH9329）测试与开发指南

> 状态：调研结论 + 测试/开发方案，**尚未实现**。硬件：单头 CH9329 + CH340G 模块（已购）。
> 协议细节来自 WCH 公开资料与社区实践，具体以模块附带的《CH9329 芯片串口通信协议》手册为准，上手先用第 4 节的脚本验证。

## 1. 背景与结论

识流（thiflow）售卖的“USB 机器人”（约 99 元）本质是一个**串口转 USB HID 键鼠**的硬件。软件仍然截图 + VLM 识别，只是把“移动鼠标 / 点击 / 按键”从系统 API 改成发串口指令，由硬件以真实 USB 键盘鼠标的身份输入。

| 问题 | 结论 |
| --- | --- |
| 技术可行性 | 可行，方案成熟（KVM、自动化测试常用），成本 10–40 元 |
| 能防什么 | Windows 下 `SendInput` / robotjs 产生的事件带 `LLMHF_INJECTED` / `LLKHF_INJECTED` 标记，可被低级钩子识别；硬件 HID 输入没有这个标记，设备枚举上也是普通键鼠 |
| 防不了什么 | 行为层风控：回复速度过快、24 小时在线、话术高度重复、短时间大量加好友/群发、账号环境（IP、设备）异常。这些和输入方式无关 |
| 云桌面 | **不适用**。云桌面没有物理 USB，键鼠来自远程协议，本身就是虚拟输入。要用硬件方案必须是物理 Windows 机 |
| 合规提醒 | 自动化操作微信违反微信软件许可协议，硬件方案只降低“被识别为模拟输入”的概率，不改变账号风险 |

最可能的技术栈：CH9329（HID）+ CH340G（USB 转串口）+ USB Hub 芯片合在一个插头里；PC 端软件通过串口发 CH9329 协议帧；中文输入用“写剪贴板 + 硬件 Ctrl+V”，绕开键盘无法直接打中文的问题。

## 2. 硬件说明

- **CH9329**：串口（UART）进，USB HID 键盘/鼠标出。PC 看到的是一个标准键鼠。
- **CH340G**：USB 转串口芯片，让 PC 能通过 USB 给 CH9329 发串口数据。
- **单头模块**：两颗芯片经内置 Hub 共用一个 USB 插头。插上后 PC 同时看到：1 个串口设备 + 1 个 HID 键鼠（部分模块是复合设备）。
- 对比：天猫上 12 元左右的是裸 CH9329 TTL 模块，需要另配 USB-TTL 转接板，占两个 USB 口，接线 TX↔RX 交叉、共地。

### 设备识别

| 系统 | 串口名 | 驱动 |
| --- | --- | --- |
| Windows | 设备管理器 → 端口 → `USB-SERIAL CH340 (COMx)` | Win10/11 多数自动装；没有就装 WCH 官方 CH341SER |
| macOS | `/dev/cu.wchusbserial*` 或 `/dev/cu.usbserial-*` | macOS 11+ 自带 |

macOS 查看：`ls /dev/cu.*`，插拔前后对比。

## 3. CH9329 串口协议速查

- 默认串口参数：**9600 bps，8N1**（可通过配置命令改，改后需重新上电）。
- 帧格式：

```
HEAD(2)   ADDR(1)  CMD(1)  LEN(1)  DATA(LEN)  SUM(1)
57 AB     00       xx      xx      ...        前面所有字节相加取低 8 位
```

- 芯片应答：CMD 为 `原 CMD | 0x80` 表示成功，`原 CMD | 0xC0` 表示出错。

| CMD | 用途 | DATA |
| --- | --- | --- |
| `0x01` | 读芯片信息（版本、USB 枚举状态、指示灯） | 无 |
| `0x02` | 普通键盘 | 8 字节：`修饰键, 00, k1..k6`（标准 HID 键码） |
| `0x03` | 多媒体键 | — |
| `0x04` | 绝对鼠标 | 7 字节：`02, 按键, X低, X高, Y低, Y高, 滚轮`；X/Y 范围 0–4095 |
| `0x05` | 相对鼠标 | 5 字节：`01, 按键, dx, dy, 滚轮`（有符号 -127..127） |
| `0x08` / `0x09` | 读 / 写参数配置（波特率、模式、USB 描述符等） | — |
| `0x0F` | 软复位 | 无 |

常用值：

- 修饰键位：`0x01` 左 Ctrl，`0x02` 左 Shift，`0x04` 左 Alt，`0x08` 左 Win/Cmd。
- 键码：`V = 0x19`，`Enter = 0x28`，`Backspace = 0x2A`，`A = 0x04`。
- 鼠标按键位：`0x01` 左键，`0x02` 右键，`0x04` 中键。
- **按下后必须发一帧全 0 表示松开**。键盘释放帧：`57 AB 00 02 08 00 00 00 00 00 00 00 00 0C`。

绝对坐标换算（推荐，用它点击最准）：

```
hidX = round(x / screenWidth  * 4095)
hidY = round(y / screenHeight * 4095)
```

注意 Windows 缩放（125%/150%）：截图坐标和 HID 坐标都按**物理分辨率**算，别混用逻辑像素。多显示器时绝对坐标通常映射到主屏，副屏上的微信需另行验证。

## 4. 测试步骤（拿到硬件后）

### 4.1 冒烟测试

1. 插上模块，确认串口出现（见第 2 节），且系统里多了一个 HID 键鼠。
2. 用串口调试工具（Windows：SSCOM / WCH 串口助手；Mac：CoolTerm）9600 8N1，十六进制发送：
   - 读信息：`57 AB 00 01 00 03`，应收到 `57 AB 00 81 ...` 开头的应答。
   - 打字母 a：先发 `57 AB 00 02 08 00 00 04 00 00 00 00 00 10`，再发释放帧。光标处应出现 `a`。
3. 都通过说明硬件、驱动、波特率没问题。

### 4.2 脚本测试（Node）

在仓库外建临时目录跑，避免污染依赖：

```bash
mkdir ~/ch9329-test && cd ~/ch9329-test && npm init -y && npm i serialport
```

`test.mjs`：

```js
import { SerialPort } from 'serialport'
const port = new SerialPort({ path: process.argv[2], baudRate: 9600 })
const frame = (cmd, data = []) => {
  const b = [0x57, 0xab, 0x00, cmd, data.length, ...data]
  return Buffer.from([...b, b.reduce((s, x) => s + x, 0) & 0xff])
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const key = async (mod, code) => {
  port.write(frame(0x02, [mod, 0, code, 0, 0, 0, 0, 0])); await sleep(40)
  port.write(frame(0x02, [0, 0, 0, 0, 0, 0, 0, 0])); await sleep(40)
}
const absMove = async (x, y, W, H, btn = 0) => {
  const hx = Math.round((x / W) * 4095), hy = Math.round((y / H) * 4095)
  port.write(frame(0x04, [0x02, btn, hx & 0xff, hx >> 8, hy & 0xff, hy >> 8, 0])); await sleep(30)
}
port.on('data', (d) => console.log('<<', d.toString('hex')))
port.on('open', async () => {
  port.write(frame(0x01)); await sleep(200)          // 读信息
  await absMove(960, 540, 1920, 1080)                 // 移到屏幕中心（按实际分辨率改）
  await absMove(960, 540, 1920, 1080, 0x01)           // 左键按下
  await absMove(960, 540, 1920, 1080, 0x00)           // 松开
  await key(0x01, 0x19)                               // Ctrl+V（Mac 用 0x08 = Cmd）
  await key(0x00, 0x28)                               // Enter
  port.close()
})
```

运行：`node test.mjs COM3`（Windows）或 `node test.mjs /dev/cu.wchusbserial110`（Mac）。

### 4.3 验收清单

- [ ] 读信息有应答，USB 状态为已枚举
- [ ] 绝对坐标点击误差 ≤ 2 像素（100% 和 150% 缩放各测一次）
- [ ] 剪贴板写入中文 + 硬件 Ctrl+V，微信输入框内容正确
- [ ] 连续发送 100 条无丢键、无“按键卡住”（每次都发了释放帧）
- [ ] 拔掉模块后软件能检测并回退或报错，不会误操作
- [ ] 用钩子工具确认事件不带 injected 标记（可选：写个 `SetWindowsHookEx(WH_MOUSE_LL)` 小程序看 `flags`）

## 5. 接入 SightFlow 的开发方案

### 现状

所有输入集中在 `src/core/rpa/input-utils.ts`，直接调用 `@hurdlegroup/robotjs`：

- `humanLikeMove` / `humanLikeClick`：拟人轨迹移动与点击（`robot.moveMouse`、`mouseToggle`）
- `sendReplyByCoordsAction` / `sendReplyAction`：点输入框 → 粘贴 → 回车
- `activeUnreadByClickAction` / `clickUnreadContactAction`：点未读会话

截图、识别仍走原流程，**只需替换输入层**。

### 改造步骤

1. **抽象输入接口** `src/core/rpa/input-driver.ts`：
   ```ts
   export interface InputDriver {
     getMousePos(): { x: number; y: number }
     moveMouse(x: number, y: number): Promise<void>
     mouseToggle(state: 'down' | 'up', button: 'left' | 'right'): Promise<void>
     keyTap(key: string, modifiers?: string[]): Promise<void>
   }
   ```
2. `RobotjsDriver`：包一层现有 robotjs 调用，行为不变。
3. `Ch9329Driver`：用 `serialport` 实现上面的帧；维护一个“当前鼠标位置”变量（硬件无法读回光标位置，`getMousePos` 可以用 robotjs 读，读操作不会产生注入事件）。
4. `input-utils.ts` 里的 `robot.*` 全部改为调用当前 driver。拟人轨迹逻辑保留，只是每一步改成发一帧绝对坐标。
5. 配置：设置页加“输入方式：软件模拟 / USB 硬件”和串口选择（`SerialPort.list()` 列出），存到现有配置；也可用环境变量 `SIGHTFLOW_INPUT_DRIVER=ch9329`、`SIGHTFLOW_CH9329_PORT=COM3` 先跑通。
6. 容错：串口打开失败或写入超时时，停止自动回复并提示，**不要静默回退到 robotjs**（否则用户以为在用硬件，实际在用软件注入）。

### 依赖与打包注意

- `serialport` 是原生模块，需按 Electron 39 的 ABI 重新编译：`npx electron-rebuild -f -w serialport`，并确认 `electron-builder` 的 `asarUnpack` 包含它的 `.node` 文件（robotjs 现在怎么处理就照着做）。
- 键盘布局：HID 键码是物理键位，非美式布局下字母可能不同；中文一律走剪贴板，避免依赖输入法状态。粘贴前确保输入法不会吞掉 Ctrl+V（一般没问题，测试时留意）。
- 节奏：每帧之间留 20–50 ms；9600 bps 下一帧 14 字节约 15 ms，不要连发过快。需要更快可把波特率改到 115200。

## 6. 风险与边界

- 硬件只解决“输入是否来自真实设备”，行为层风控仍需靠软件侧：随机延迟、工作时间段、频率上限、话术多样化、人工接管。
- 一台模块只能控制它插着的那台电脑，横向扩展意味着每个账号一台物理机 + 一个模块，成本和运维与云桌面方案差别很大，需按规模评估。
- 云桌面场景继续用软件输入，风控重点放在行为层。
