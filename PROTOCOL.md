# 能源管理终端 — 网关接口协议 v2

RK3506 网关与 Web Dashboard 双向 MQTT 通信协议。
Topic 按 `设备 → 节点 → 方向` 分层。

---

## 1. 物理拓扑

```
                         RK3506 + EC20 4G
                              │
              ┌──────────┬────┴────┬──────────┐
              │ I2C bus  │  GPIO   │  UART    │
              ▼          ▼         ▼          ▼
          ┌──────┐  ┌──────┐  ┌──────┐  ┌──────┐
          │MPPT+ │  │通道 A │  │通道 B │  │通道 C │
          │电池  │  │可调输出│  │可调输出│  │可调输出│
          │INA226│  │INA226 │  │INA226 │  │INA226 │
          └──────┘  └──────┘  └──────┘  └──────┘
          节点 0     节点 1     节点 2     节点 3
```

---

## 2. MQTT Topic 树

`{prefix}` 默认 `energy`，`{id}` 为设备 ID（如 `rk3506`）。

```
{prefix}/{id}/
├── mppt/
│   ├── telemetry        ← RK3506 → Dashboard (1Hz)
│   ├── command          ← Dashboard → RK3506
│   └── config           ← 参数同步 (采样电阻、校准值)
│
├── channel/a/
│   ├── telemetry        ← 通道 A 实时数据
│   ├── command          ← 设电压、开关
│   └── protocol         ← 通信协议参数
│
├── channel/b/
│   ├── telemetry
│   ├── command
│   └── protocol
│
├── channel/c/
│   ├── telemetry
│   ├── command
│   └── protocol
│
├── system/
│   ├── status           ← 网关 CPU/内存/4G 信号
│   ├── voice/event      ← 语音识别事件
│   └── command          ← 重启/升级
│
└── aggregate            ← 全节点聚合摘要 (0.1Hz)
```

### 订阅表

| 方向 | Topic 模式 | QoS |
|------|-----------|-----|
| Dashboard 订阅 | `energy/{id}/mppt/telemetry` | 1 |
| | `energy/{id}/channel/+/telemetry` | 1 |
| | `energy/{id}/system/status` | 1 |
| | `energy/{id}/system/voice/event` | 1 |
| | `energy/{id}/aggregate` | 1 |
| Dashboard 发布 | `energy/{id}/mppt/command` | 1 |
| | `energy/{id}/channel/+/command` | 1 |
| | `energy/{id}/system/command` | 1 |

---

## 3. 遥测载荷

### 3.1 MPPT + 电池 `energy/{id}/mppt/telemetry`

```json
{
  "ts": 1751894400123,
  "solar_voltage": 18.3,
  "solar_current": 1.85,
  "solar_power": 33.9,
  "battery_voltage": 15.48,
  "battery_current": 2.05,
  "battery_power": 31.7,
  "battery_soc": 72.0,
  "battery_temp": 28.6,
  "charge_mode": "MPPT",
  "pwm_duty": 168,
  "efficiency": 91.8,
  "error_code": 0,
  "today_wh": 384,
  "total_wh": 12760
}
```

| 字段 | 类型 | 单位 | 说明 |
|------|------|------|------|
| `solar_voltage` | number | V | 光伏输入电压 |
| `solar_current` | number | A | 光伏输入电流 |
| `solar_power` | number | W | 光伏输入功率 |
| `battery_voltage` | number | V | 电池端电压 |
| `battery_current` | number | A | 充电电流 (+) / 放电 (-) |
| `battery_soc` | number | % | 电池荷电状态 0-100 |
| `battery_temp` | number | °C | 电池温度 |
| `charge_mode` | string | — | MPPT / FLOAT / OFF |
| `pwm_duty` | number | 0-255 | PWM 占空比 |
| `efficiency` | number | % | 转换效率 |
| `error_code` | number | — | 0 正常 |
| `today_wh` | number | Wh | 今日累计发电量 |
| `total_wh` | number | Wh | 总累计发电量 |

### 3.2 通道 `energy/{id}/channel/{a|b|c}/telemetry`

```json
{
  "ts": 1751894400123,
  "enabled": true,
  "label": "直流电源A",
  "type": "dc_supply",
  "set_voltage": 12.0,
  "set_current": 1.8,
  "current_limit": 1.8,
  "actual_voltage": 12.05,
  "actual_current": 1.25,
  "actual_power": 15.06,
  "temperature": 38.5,
  "range": { "voltage_max": 30.0, "current_max": 5.0 },
  "error_code": 0
}
```

| 字段 | 类型 | 单位 | 说明 |
|------|------|------|------|
| `enabled` | bool | — | 输出开关 |
| `label` | string | — | 用户自定义名（语音可设） |
| `type` | string | — | `dc_supply` / `ac_switch` |
| `set_voltage` | number | V | 设定的目标电压 |
| `set_current` | number | A | 设定的限流值 |
| `current_limit` | number | A | 限流状态回传，通常等于 `set_current` |
| `actual_voltage` | number | V | 实际输出电压 |
| `actual_current` | number | A | 实际输出电流 |
| `actual_power` | number | W | 实际输出功率 |
| `temperature` | number | °C | 节点温度 |
| `range` | object | — | 可选，直流通道输出范围 |
| `error_code` | number | — | 0 正常 |

### 3.3 系统状态 `energy/{id}/system/status`

```json
{
  "ts": 1751894400123,
  "cpu_pct": 23.5,
  "mem_mb": 128,
  "disk_mb": 512,
  "signal_dbm": -75,
  "network_type": "LTE",
  "uptime_s": 36000
}
```

### 3.4 语音事件 `energy/{id}/system/voice/event`

```json
{
  "ts": 1751894400123,
  "text": "打开通道一设为12伏",
  "intent": "set_channel_voltage",
  "params": { "channel": "a", "value": 12.0 },
  "confidence": 0.95,
  "executed": true
}
```

### 3.5 聚合摘要 `energy/{id}/aggregate`

低频 (0.1Hz) 发布的全局快照，所有节点关键值在一包里，适合数据页存档。

```json
{
  "ts": 1751894400123,
  "mppt": { "solar_power": 33.9, "battery_soc": 72.0, "battery_voltage": 15.48 },
  "channel_a": { "enabled": true, "actual_voltage": 12.05, "actual_power": 15.06 },
  "channel_b": { "enabled": true, "actual_voltage": 23.9, "actual_power": 21.5 },
  "channel_c": { "enabled": true, "actual_voltage": 220, "actual_power": 136.4 },
  "total_output_power": 172.96,
  "system": { "signal_dbm": -75, "uptime_s": 36000 }
}
```

---

## 4. 命令载荷

### 4.1 通道控制 `energy/{id}/channel/{a|b|c}/command`

```json
// 设置目标电压
{ "cmd": "set_voltage", "value": 12.0 }

// 设置限流
{ "cmd": "set_current", "value": 1.8 }

// 开关通道
{ "cmd": "set_enabled", "value": true }

// 设置显示标签（语音友好）
{ "cmd": "set_label", "value": "12V 路由器" }

// 配置通信协议参数
{ "cmd": "set_protocol", "value": { "type": "uart", "baud": 115200, "data_bits": 8, "parity": "none" } }
```

### 4.2 MPPT 控制 `energy/{id}/mppt/command`

```json
{ "cmd": "set_charge_mode", "value": "MPPT" }
{ "cmd": "set_charge_mode", "value": "FLOAT" }
{ "cmd": "set_charge_mode", "value": "OFF" }
{ "cmd": "set_sample_resistor_input", "value": 0.002 }
{ "cmd": "set_sample_resistor_output", "value": 0.002 }
{ "cmd": "calibrate_voltage_in", "value": 55.0 }
{ "cmd": "calibrate_voltage_out", "value": 28.0 }
```

### 4.3 系统命令 `energy/{id}/system/command`

```json
{ "cmd": "restart" }
{ "cmd": "restart_voice" }
{ "cmd": "firmware_update" }
{ "cmd": "get_config" }
```

---

## 5. Dashboard 节点面板

```
┌─────────────────────────────────────────────┐
│  ● MQTT · rk3506                      [▶]  │
├──────────────┬──────────────────────────────┤
│ ☀ MPPT 电池   │  ════ 波形图 ════           │
│ 光伏 55.2V   │                              │
│ 电池 24.3V   │  点击节点卡片切换波形数据源    │
│ SOC ████░78% │                              │
│              │                              │
│ A 通道 ○12V  │                              │
│ 已开启 12.05V│                              │
│ 1.25A 15.1W │                              │
│ [关] [设值]  │                              │
│              │                              │
│ B 通道 ○5V   │                              │
│ 已关闭       │                              │
│ [开] [设值]  │                              │
│              │                              │
│ C 通道 ○24V  │                              │
│ 已开启 24.1V │                              │
│ 0.52A 12.5W │                              │
│ [关] [设值]  │                              │
└──────────────┴──────────────────────────────┘
```

---

## 6. 语音助手集成

```
用户: "打开通道一，设为 12 伏"
  │
  ▼
RK3506 本地唤醒 → ASR → NLU
  │
  intent: set_channel_voltage
  channel: a, value: 12.0
  │
  ├── I2C/DAC → 设电压
  ├── MQTT publish → energy/rk3506/channel/a/telemetry  (状态更新)
  └── MQTT publish → energy/rk3506/system/voice/event    (事件日志)
```

Dashboard 实时收到更新，无需轮询。

---

## 7. Broker 部署

RK3506 网关和 Web Dashboard 必须连接到同一个 EMQX broker：

- RK3506 网关：MQTT TCP `mqtt://<broker-ip>:1883`
- Web Dashboard：浏览器 MQTT over WebSocket `ws://<broker-ip>:8083/mqtt`，HTTPS 页面使用 `wss://<broker-domain>:8084/mqtt`

本地联调默认：

| 项 | 值 |
|----|-----|
| TCP 地址 | `mqtt://192.168.137.1:1883` |
| WebSocket 地址 | `ws://192.168.137.1:8083/mqtt` |
| 默认设备 | `rk3506` |

云端部署可使用 **EMQX Cloud 国内版（深圳）**。

| 项 | 值 |
|----|-----|
| WSS 地址 | `wss://w0378faf.ala.cn-shenzhen.emqxsl.cn:8084/mqtt` |
| MQTTS 地址 | `mqtts://w0378faf.ala.cn-shenzhen.emqxsl.cn:8883` |
| API 地址 | `https://w0378faf.ala.cn-shenzhen.emqxsl.cn:8443/api/v5` |
| 默认设备 | `rk3506` |

### 阶段 A：EMQX Cloud Serverless（当前）

免费额度 100 设备/月 1GB。Dashboard 填 WSS 地址即可。

### 阶段 B：自建 Docker（后续）

`broker/` 目录已备好 `docker-compose.yml` 和 `broker-setup.sh`，一键迁移。
