# 能源管理终端 — 网关接口协议 v1

本文档定义了 RK3506 网关端与 Web Dashboard 之间通过 MQTT Broker
进行双向通信的 JSON 协议。网关端只需按此规范发布遥测数据、
订阅命令 topic 即可。

---

## 1. MQTT Topic 约定

`{prefix}` 默认为 `energy`，可在 dashboard MQTT 配置中调整。

| 方向 | Topic | QoS | 说明 |
|------|-------|-----|------|
| 网关 → Dashboard | `{prefix}/{device_id}/telemetry` | 1 | 遥测数据，周期性发布 |
| Dashboard → 网关 | `{prefix}/{device_id}/command` | 1 | 控制指令，下行命令 |

`{device_id}` 为网关唯一标识，例如 `rk3506-gateway-001`。

---

## 2. 遥测载荷 `telemetry`

网关周期性（建议 1-10Hz）发布到遥测 topic。

### 完整字段

```json
{
  "ts": 1751894400123,
  "vin": 55.23,
  "iin": 2.51,
  "pin": 138.6,
  "vout": 28.05,
  "iout": 4.55,
  "pout": 127.5,
  "efficiency": 92.0,
  "temp": 42.5,
  "pwmc": 180,
  "pwm": 220,
  "ppwm": 105,
  "buck_mode": "BUCK",
  "anti_backflow": true,
  "driver_enabled": true,
  "error_code": 0
}
```

### 字段说明

| 字段 | 类型 | 单位 | 必填 | 说明 |
|------|------|------|------|------|
| `ts` | number | ms | 否 | Unix 毫秒时间戳 |
| `vin` | number | V | 是 | 输入电压（光伏板端） |
| `iin` | number | A | 是 | 输入电流 |
| `pin` | number | W | 否 | 输入功率（留空自动计算 vin×iin） |
| `vout` | number | V | 是 | 输出电压（负载端） |
| `iout` | number | A | 是 | 输出电流 |
| `pout` | number | W | 否 | 输出功率（留空自动计算 vout×iout） |
| `efficiency` | number | % | 否 | 转换效率 |
| `temp` | number | °C | 否 | 设备温度 |
| `pwmc` | number | 0-255 | 否 | PWM 占空比 C 相 |
| `pwm` | number | 0-255 | 否 | PWM 占空比主路 |
| `ppwm` | number | 0-255 | 否 | PWM 占空比 P 相 |
| `buck_mode` | string | — | 否 | "BUCK" 或 "BOOST" |
| `anti_backflow` | bool | — | 否 | 防逆流状态 |
| `driver_enabled` | bool | — | 否 | 驱动使能 |
| `error_code` | number | — | 否 | 错误码（0=正常） |

### 最小载荷

只需发布核心字段即可，其余字段 dashboard 会自动填默认值：

```json
{
  "vin": 55.2,
  "vout": 28.0,
  "iin": 2.5,
  "iout": 4.5
}
```

### 兼容性提示

- 字段名支持多版本输入：`vin` / `Vin` / `VIN` 均被识别
- 未知字段直接忽略，不做报错

---

## 3. 命令载荷 `command`

Dashboard 下发指令时发布到命令 topic。

```json
{
  "cmd": "RESTART",
  "ts": 1751894400123
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `cmd` | string | 命令字符串 |
| `ts` | number | 发送时间戳 (ms) |

### 预定义命令

| 命令 | 说明 |
|------|------|
| `RESTART` | 重启网关 |
| `FWUPDATE` | 触发固件升级 |
| `INVD50.0` | 校准输入电压 50.0V |
| `OUTVD28.5` | 校准输出电压 28.5V |
| `RNFA0.002` | 设置输入采样电阻 0.002Ω |
| `RNFB0.002` | 设置输出采样电阻 0.002Ω |
| `INCD10.0` | 设置 ADS712 电流校准 10.0 |

### 自定义命令

除预定义命令外，网关可自行扩展。Dashboard 的自定义命令输入框
会原样透传到 `cmd` 字段。

---

## 4. RK3506 网关端实现要点

### 4.1 MQTT 客户端库

Python 推荐 `paho-mqtt`：

```bash
pip3 install paho-mqtt
```

C/C++ 推荐 Eclipse Paho Embedded C，或 mosquitto client lib。

### 4.2 连接示例 (Python)

```python
import paho.mqtt.client as mqtt
import json, time, ssl
from your_sensor_driver import read_power_data

BROKER = "broker.emqx.io"
PORT = 8883  # TLS
DEVICE_ID = "rk3506-gateway-001"
TELEMETRY_TOPIC = f"energy/{DEVICE_ID}/telemetry"
COMMAND_TOPIC = f"energy/{DEVICE_ID}/command"

def on_connect(client, userdata, flags, rc):
    print(f"Connected: {rc}")
    client.subscribe(COMMAND_TOPIC, qos=1)

def on_command(client, userdata, msg):
    payload = json.loads(msg.payload)
    cmd = payload.get("cmd", "")
    print(f"Received command: {cmd}")
    # 处理命令：判断是否 RESTART / FWUPDATE / CAL:* 等

client = mqtt.Client(client_id=DEVICE_ID)
client.tls_set(cert_reqs=ssl.CERT_REQUIRED)  # TLS 加密
client.on_connect = on_connect
client.on_message = on_command

client.connect(BROKER, PORT, keepalive=60)
client.loop_start()

# 主循环：周期性发布遥测
while True:
    data = read_power_data()  # 从 INA226 / ADC 读取
    client.publish(TELEMETRY_TOPIC, json.dumps(data), qos=1)
    time.sleep(0.2)  # 5Hz
```

### 4.3 4G 联网注意事项

- EC20 模组先拨号获取 IP：`AT+QNETDEVCTL=1,1,1` 或 PPP 拨号
- MQTT 走 TLS 8883 端口，运营商通常不会拦截
- 建议设 keepalive ≤ 60s，避免 NAT 会话超时
- `client_id` 使用设备唯一序列号（如 `/etc/machine-id` 或 IMEI）

---

## 5. Dashboard 对接步骤

1. 打开 Dashboard → **仪表盘** → 设备连接
2. 切换到 **MQTT 网关** 模式
3. 填写：
   - **Broker 地址**: `wss://broker.emqx.io:8084/mqtt`（示例，替换为实际 Broker）
   - **设备 ID**: `rk3506-gateway-001`（与网关端一致）
   - **用户名/密码**: 按 Broker 要求填写
4. 点击 **保存配置** → **连接设备** → **开始采集**
5. 收到遥测后，仪表盘自动更新指标卡和波形图

---

## 6. Broker 推荐

| Broker | WSS 地址 | 免费额度 |
|--------|---------|---------|
| EMQX Cloud Serverless | `wss://{host}:8084/mqtt` | 100 设备 |
| HiveMQ Cloud | `wss://{host}:8884/mqtt` | 100 设备 |
| 自建 Mosquitto | `wss://{your-ip}:8084` | 无限 |

> WSS 端口是关键——浏览器只能通过 WebSocket Secure 连接 MQTT。
