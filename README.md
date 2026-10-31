# Modbus Remote Bench（桌面远程端）

这是一个基于 MQTT + WebSocket 的 Modbus 现场远程调试桌面端，目标是复刻小程序现场端的远程协助链路：

- 现场端（local）通过 MQTT 上报状态、报文和页面快照
- 桌面端（remote）通过 MQTT 下发命令、读取状态和同步页面
- 支持网关模式和 BLE 代理模式
- 适用于 Windows / macOS / Linux 桌面环境

本仓库只包含桌面端源码；现场端的协议真源在配套小程序 / 固件项目里。本仓库与现场端按协议逐字节对齐，关键逻辑位于：

- `src/lib/broker.js`：MQTT broker 配置与 topic 定义
- `src/lib/session.js`：会话层、心跳、ACK / RESULT 处理
- `src/lib/proto.js`：协议信封、会话码、错误码
- `src/lib/mqtt.js`：MQTT 3.1.1 WebSocket 客户端
- `src/lib/modbus.js`：Modbus CRC / 组帧 / 解析

## 1. 当前 MQTT 主题

桌面端与现场端通过下面四个主题进行通信，主题生成代码位于 `src/lib/broker.js`：

```js
export function getAssistTopics(sid) {
  return {
    data: 'assist/' + sid + '/data',
    cmd: 'assist/' + sid + '/cmd',
    status: 'assist/' + sid + '/status',
    state: 'assist/' + sid + '/state'
  };
}
```

### 1.1 `assist/{sid}/cmd`

桌面端向现场端发命令，QoS 1。

典型样例：

```json
{
  "v": 1,
  "sid": "ABC1234",
  "from": "remote",
  "type": "raw.tx",
  "ts": 1728000000000,
  "payload": {
    "hex": "010300010002C5C9",
    "expectLen": 2
  },
  "reqId": "r4f2k9.2m8",
  "seq": 1,
  "cid": "assist_remote_ABC1234_1728000000",
  "kind": "desktop"
}
```

说明：

- `type` 是命令类型，例如 `raw.tx`、`serial.send`、`scan.start`、`uart.set`
- `reqId` 用于 ACK / RESULT 对应
- `seq` 用于去重
- `kind: "desktop"` 表示当前命令来自桌面端，网关场景下会优先接管

### 1.2 `assist/{sid}/state`

现场端向桌面端上报状态和回执，QoS 1。

典型样例：

1) ACK（命令已受理）

```json
{
  "v": 1,
  "sid": "ABC1234",
  "from": "local",
  "type": "ack",
  "ts": 1728000000100,
  "payload": {
    "reqId": "r4f2k9.2m8",
    "ok": true,
    "code": 200,
    "msg": "",
    "data": null
  },
  "seq": 5
}
```

2) RESULT（命令执行完成）

```json
{
  "v": 1,
  "sid": "ABC1234",
  "from": "local",
  "type": "result",
  "ts": 1728000000200,
  "payload": {
    "reqId": "r4f2k9.2m8",
    "ok": true,
    "code": 200,
    "msg": "",
    "data": {
      "values": [123, 456],
      "slave": 1
    }
  },
  "seq": 6
}
```

3) 视图同步 / 页面状态

```json
{
  "v": 1,
  "sid": "ABC1234",
  "from": "local",
  "type": "view",
  "ts": 1728000000300,
  "payload": {
    "page": "modscan",
    "data": {
      "slave": 1,
      "start": 0,
      "count": 10
    }
  },
  "seq": 7
}
```

### 1.3 `assist/{sid}/data`

现场端或桌面端上报原始报文流和日志，用于实时监控，QoS 0。

典型样例：

```json
{
  "v": 1,
  "sid": "ABC1234",
  "from": "local",
  "type": "log",
  "ts": 1728000000400,
  "payload": {
    "dir": "rx",
    "hex": "010300010002C5C9",
    "len": 8,
    "ts": 1728000000
  },
  "seq": 8
}
```

说明：

- 这里的 `payload` 是可以丢失的流数据，不保证可靠传输
- 典型使用场景包括 RTU 报文采样、串口透传日志、Modscan 报文记录

### 1.4 `assist/{sid}/status`

在线状态与心跳消息，QoS 1，状态消息例子：

```json
{
  "action": "join",
  "role": "remote",
  "tool": "desktop",
  "ver": 1,
  "ts": 1728000000500,
  "cid": "assist_remote_ABC1234_1728000000",
  "kind": "desktop"
}
```

```json
{
  "action": "heartbeat",
  "role": "local",
  "tool": "gateway",
  "ver": 1,
  "ts": 1728000000600,
  "cid": "assist_local_ABC1234_1728000000"
}
```

```json
{
  "action": "leave",
  "role": "local",
  "ts": 1728000000700
}
```

说明：

- `join`：加入会话
- `heartbeat`：保活
- `leave`：离开 / 断开
- `LWT`（Last Will）也按该格式发送，`role` 会标识离开的角色

## 2. 协议信封结构

所有消息都遵循统一信封格式：

```js
export function envelope(sid, from, type, payload, reqId) {
  var o = {
    v: VERSION,
    sid: sid,
    from: from,
    type: type,
    ts: Date.now(),
    payload: payload || {}
  };
  if (reqId) o.reqId = reqId;
  return o;
}
```

核心字段：

- `v`：协议版本，当前 `1`
- `sid`：会话码，7 位字符
- `from`：消息来源，`local` 或 `remote`
- `type`：消息类型，如 `cmd`、`ack`、`result`、`view`、`log`
- `payload`：实际内容
- `ts`：时间戳（毫秒）
- `reqId`：请求 ID，命令和回执匹配用
- `seq`：递增序号，用于去重
- `cid`：客户端 ID
- `kind`：链路来源，`desktop` / `gateway` / `ble` 等

## 3. 关键行为规范

### 3.1 会话码

会话码长度固定 7 位，字符集为：

```js
'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
```

不包含容易混淆的 `0 O 1 I`。

### 3.2 命令与回执

- `cmd` 发送命令，使用 `sendCmd()`
- 命令等待 `ack` 或 `result`
- 若现场需要确认，则先回 `ack` + `code: 202`，后续再发送 `result`
- 超时与重试规则：
  - 普通命令允许补发一次
  - 写类命令不自动补发
  - 超时后抛出 `TIMEOUT`

### 3.3 去重

同一 `from + seq` 只处理一次，借助 `Deduper` 在 `session.js` 中实现，避免重复消息造成重复执行。

### 3.4 连接与心跳

- `HEARTBEAT_MS = 15000`
- `PEER_TIMEOUT_MS = 30000`
- 本地和远程都会通过 `status` 主题发送 `join` / `heartbeat` / `leave`
- 如果 30 秒内没有收到对端心跳，则视为对端离线

## 4. 实际通道示意

```text
现场端(local)                    MQTT Broker                       桌面端(remote)
   │
   │  publish status / state / data   ───▶  assist/{sid}/status
   │                                     ├─ assist/{sid}/state
   │                                     └─ assist/{sid}/data
   │
   │  ◀──── subscribe / receive ──────  assist/{sid}/cmd
   │
   │  publish ack / result ───────────▶ assist/{sid}/state
   │
   └─────────────────────────────────────────────────────────────────────┘
```

## 5. 项目结构

```text
modbusclientapp/
├── README.md
├── index.html
├── package.json
├── src/
│   ├── main.js
│   ├── style.css
│   └── lib/
│       ├── broker.js
│       ├── mqtt.js
│       ├── modbus.js
│       ├── proto.js
│       ├── session.js
│       ├── addr.js
│       └── presets.js
├── src-tauri/
├── tests/
└── vite.config.js
```

## 6. 配置说明

源码中不写真实 broker 地址，全部通过构建期环境变量注入：

| 变量 | 含义 |
| --- | --- |
| `VITE_MQTT_HOST` | Broker 主机名 |
| `VITE_MQTT_PORT` | WebSocket 端口 |
| `VITE_MQTT_PATH` | WebSocket 路径，默认 `/mqtt` |
| `VITE_MQTT_SECURE` | 是否使用 `wss://` |
| `VITE_MQTT_USERNAME` | 账号 |
| `VITE_MQTT_PASSWORD` | 密码 |
| `VITE_MQTT_KEEPALIVE` | 心跳秒数 |

本地开发示例：

```bash
cp .env.example .env
# 然后填入自己的 MQTT 信息
```

或者临时设置：

```bash
VITE_MQTT_HOST=broker.example.com \
VITE_MQTT_USERNAME=user \
VITE_MQTT_PASSWORD=pass \
npm run build
```

## 7. 开发命令

```bash
npm install
npm test
npm run dev
npm run tauri dev
```

- `npm test`：运行协议与页面同步相关测试
- `npm run dev`：浏览器开发模式
- `npm run tauri dev`：桌面端 electron / webview 运行模式

## 8. 说明

- 本项目与小程序现场端的协议保持一致，关键逻辑以现场端真实实现为准
- MQTT topic 与 JSON 信封均按当前代码实际实现为准，不依赖文档口径歧义
- 若需要扩展命令类型，请同时更新：
  - `src/lib/session.js` 的 `sendCmd` / `_onState`
  - `src/lib/proto.js` 的类型/错误定义
  - 现场端配套实现的对应逻辑

## 9. 许可证

本仓库当前采用项目默认许可证配置；如需明确授权信息，请查看仓库根目录中的许可证文件。
