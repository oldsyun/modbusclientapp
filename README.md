# Modbus 远程调试台

ESP32 485 远程协助的桌面端。输入现场提供的 7 位协助码，通过 MQTT over WebSocket 接入会话，查看现场状态和 RS485 报文，并在获得控制权后远程执行调试操作。

桌面端是远程客户端，不直接连接串口或 RS485 设备。实际通信由现场 ESP32 网关或现场手机代理完成。

## 功能

- **工具总览**：查看会话、现场链路和网关状态。
- **从站扫描**：扫描 1–247 站号并查看在线设备。
- **Modscan**：读取和轮询寄存器，支持 01/02/03/04 功能区、地址格式与数据格式设置。
- **串口直发**：以 HEX 或 ASCII 发送报文，支持 CRC16、追加 CR/LF、循环发送和快捷报文。
- **RTU 参数**：使用内置寄存器模板读取、修改设备参数并核对写入结果。模板地址和值仅为参考，操作前须按设备手册确认。
- **模块信息**：查看网关及 485 参数，并在现场链路允许时修改 UART 参数。
- **报文与操作记录**：查看 TX/RX 报文、字节统计和操作结果。
- **网页版本**：与桌面端共用业务代码，可构建为纯静态站点。

现场链路包括 ESP32 直连 MQTT、现场手机 BLE 代理，以及不具备网关能力时的现场页面镜像。可用功能取决于现场端和固件所支持的链路与命令。多个远程端可以同时加入；现场端决定控制权，旁看端需要请求接管后才能操作。

## 开始使用

1. 在现场端开启远程协助，取得 7 位协助码，并确认现场网关/代理处于可用状态。
2. 打开桌面应用，在顶部输入协助码并点击「接入」。
3. 确认 MQTT 和现场状态在线。若当前为旁看端，先请求接管，再执行需要写入或控制现场的操作。
4. 完成后断开会话。

连接前需要配置可访问的 MQTT Broker。若应用未预置 Broker 信息，可在「mqtt设置」中填写服务器和认证信息，或在构建时配置环境变量。

## 本地开发

需要 Node.js/npm。开发 Tauri 桌面应用还需要 Rust 工具链及当前操作系统对应的 Tauri 构建依赖。

```bash
npm install

# 浏览器开发，默认访问 http://localhost:5173
npm run dev

# Tauri 桌面应用开发
npm run tauri dev
```

### Broker 配置

复制仓库中的 `.env.example` 为 `.env`，再填写自己的配置：

```dotenv
VITE_MQTT_HOST=broker.example.com
VITE_MQTT_PORT=0
VITE_MQTT_PATH=/mqtt
VITE_MQTT_SECURE=true
VITE_MQTT_USERNAME=
VITE_MQTT_PASSWORD=
VITE_MQTT_KEEPALIVE=60
```

| 变量 | 含义 | 默认值 |
| --- | --- | --- |
| `VITE_MQTT_HOST` | Broker 主机名 | 空（未配置） |
| `VITE_MQTT_PORT` | WebSocket 端口；`0` 使用协议默认端口 | `0` |
| `VITE_MQTT_PATH` | WebSocket 路径 | `/mqtt` |
| `VITE_MQTT_SECURE` | 是否使用 TLS（`wss://`） | `true` |
| `VITE_MQTT_USERNAME` | Broker 用户名 | 空 |
| `VITE_MQTT_PASSWORD` | Broker 密码 | 空 |
| `VITE_MQTT_KEEPALIVE` | MQTT 心跳间隔（秒） | `60` |

生效顺序为：应用内「mqtt设置」> 构建期 `VITE_MQTT_*` > 空值/默认值。应用内配置保存在当前浏览器或 WebView 的本机 `localStorage` 中。

**安全提示：** `VITE_*` 值会被打包进前端产物，任何拿到产物的人都可以读取它们；不要在其中放置高权限或需要保密的长期凭据。使用权限受限、可轮换的 Broker 账号，并为 Broker 配置适当的认证和访问控制。应用内保存的凭据也不是加密密钥库。

## 构建

### 桌面应用

```bash
npm run build       # 构建 Vite 前端到 dist/
npm run tauri build # 构建当前平台的 Tauri 安装包
```

桌面壳由 Tauri 2 提供，Rust 部分负责应用窗口，业务逻辑主要位于 `src/`。

### 网页版

```bash
npm run build:web
npm run preview:web
```

静态文件输出到 `dist-web/`，可部署到静态 Web 服务器。HTTPS 站点应使用支持 TLS 的 `wss://` Broker；浏览器会阻止 HTTPS 页面连接不安全的 `ws://` 服务。网页版不会提供后端代理，浏览器需能直接访问 Broker。

## 测试与检查

```bash
npm test
npm run lint
```

`npm test` 运行 Node.js 单元测试、页面映射检查、网关与 BLE 代理端到端测试，并构建及冒烟检查网页版本。网页冒烟测试在本机找不到 Chromium/Chrome/Edge 时会跳过浏览器部分。真实 Broker 连通性检查可单独运行：

```bash
node tests/smoke.broker.mjs
```

该检查需要可用的 Broker 配置和网络连接。多远程端实时测试 `tests/e2e.multiremote.live.mjs` 也需要现场端/Broker 环境，不包含在 `npm test` 中。

## 项目结构

```text
.
├── index.html              # 应用页面骨架
├── src/
│   ├── main.js             # 工作台交互、视图及会话消息处理
│   ├── style.css           # 页面样式与主题
│   └── lib/
│       ├── addr.js         # Modbus 地址转换
│       ├── broker.js       # Broker 配置、会话码与 MQTT topic
│       ├── modbus.js       # CRC、RTU 帧组装与响应解析
│       ├── mqtt.js         # MQTT 3.1.1 WebSocket 客户端
│       ├── presets.js      # RTU 参数参考模板
│       ├── proto.js        # 会话协议与消息工具
│       └── session.js      # 会话、消息配对、心跳及重连
├── src-tauri/              # Tauri 2 桌面壳
├── tests/                  # 单元、映射及端到端测试
├── package.json
└── vite.config.js          # 桌面版与网页版本构建配置
```

## 操作注意事项

- 写寄存器、修改模块参数和串口发送会影响现场设备。请确认站号、地址、功能码、数据格式及接线参数后再操作。
- 写入命令不会自动重发，以避免超时后重复执行；部分寄存器写入会尝试读回校验。
- RTU 参考模板不是通用设备配置。务必依据目标设备手册核对寄存器地址、取值范围和编码。
- 远程操作依赖现场链路、现场授权和当前控制权；网络或代理中断时操作可能失败。
