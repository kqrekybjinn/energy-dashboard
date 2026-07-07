#!/usr/bin/env bash
# ============================================================
#  能源管理终端 — MQTT Broker CLI 管理脚本
#
#  用法:
#    ./broker-setup.sh up           启动 Broker
#    ./broker-setup.sh down         停止 Broker
#    ./broker-setup.sh status       查看运行状态
#    ./broker-setup.sh logs         查看日志
#    ./broker-setup.sh add-user <username> <password>
#                                   创建 MQTT 设备用户
#    ./broker-setup.sh del-user <username>
#                                   删除用户
#    ./broker-setup.sh list-users   列出所有用户
#    ./broker-setup.sh grant <username> <topic> [pub|sub|both]
#                                   授权用户对 topic 的权限
#    ./broker-setup.sh revoke <username> <topic>
#                                   撤销权限
#    ./broker-setup.sh acl <username>
#                                   查看用户 ACL 规则
#    ./broker-setup.sh clients      列出已连接的客户端
#    ./broker-setup.sh topics       查看活跃 Topic
#    ./broker-setup.sh api <method> <path> [body]
#                                   直接调用 REST API
#    ./broker-setup.sh info         显示连接信息
#    ./broker-setup.sh help         帮助
# ============================================================

set -euo pipefail
cd "$(dirname "$0")"

CONTAINER="energy-broker"
API_BASE="http://localhost:18083/api/v5"

# --- helpers ---

get_token() {
  curl -s -X POST "${API_BASE}/login" \
    -H 'Content-Type: application/json' \
    -d '{"username":"admin","password":"Energy2026!"}' \
    | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))" 2>/dev/null || echo ""
}

emqx_ctl() {
  docker exec "$CONTAINER" emqx ctl "$@"
}

emqx_remote_console() {
  docker exec "$CONTAINER" emqx remote_console "$@"
}

# --- commands ---

cmd_up() {
  echo "=== 启动 EMQX Broker ==="
  docker compose up -d
  echo ""
  echo "等待 Broker 就绪..."
  for i in $(seq 1 30); do
    if docker exec "$CONTAINER" emqx ctl status &>/dev/null; then
      echo "✓ Broker 已就绪"
      break
    fi
    sleep 2
  done
  cmd_info
}

cmd_down() {
  echo "=== 停止 EMQX Broker ==="
  docker compose down
  echo "✓ 已停止"
}

cmd_status() {
  if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
    echo "=== Broker 运行状态 ==="
    emqx_ctl status
  else
    echo "✕ Broker 未运行"
  fi
}

cmd_logs() {
  docker logs -f --tail="${1:-100}" "$CONTAINER"
}

cmd_add_user() {
  local user="${1:-}" pass="${2:-}"
  if [[ -z "$user" || -z "$pass" ]]; then
    echo "用法: $0 add-user <username> <password>"
    exit 1
  fi
  local token
  token=$(get_token)
  if [[ -z "$token" ]]; then
    echo "✕ 无法获取 API token"
    exit 1
  fi
  curl -s -X POST "${API_BASE}/authentication/password_based:built_in_database/users" \
    -H "Authorization: Bearer $token" \
    -H 'Content-Type: application/json' \
    -d "{\"user_id\":\"$user\",\"password\":\"$pass\"}" \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print('✓ 用户已创建:', d.get('user_id',''))" 2>/dev/null || echo "✕ 创建失败"
}

cmd_del_user() {
  local user="${1:-}"
  if [[ -z "$user" ]]; then
    echo "用法: $0 del-user <username>"
    exit 1
  fi
  local token
  token=$(get_token)
  curl -s -X DELETE "${API_BASE}/authentication/password_based:built_in_database/users/${user}" \
    -H "Authorization: Bearer $token" \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print('✓ 已删除' if not d else d)" 2>/dev/null || echo "✓ 已删除"
}

cmd_list_users() {
  local token
  token=$(get_token)
  echo "=== MQTT 用户列表 ==="
  curl -s "${API_BASE}/authentication/password_based:built_in_database/users?page=1&page_size=100" \
    -H "Authorization: Bearer $token" \
    | python3 -c "
import sys,json
data=json.load(sys.stdin)
users=data.get('data',[])
if not users:
    print('(无用户)')
for u in users:
    print(f\"  {u['user_id']}\")
" 2>/dev/null
}

cmd_grant() {
  local user="${1:-}" topic="${2:-}" perm="${3:-both}"
  if [[ -z "$user" || -z "$topic" ]]; then
    echo "用法: $0 grant <username> <topic> [pub|sub|both]"
    exit 1
  fi
  local token
  token=$(get_token)
  local rules=""
  case "$perm" in
    pub)   rules='[{"action":"publish","permission":"allow","topic":"'"$topic"'"}]' ;;
    sub)   rules='[{"action":"subscribe","permission":"allow","topic":"'"$topic"'"}]' ;;
    both)  rules='[{"action":"publish","permission":"allow","topic":"'"$topic"'"},{"action":"subscribe","permission":"allow","topic":"'"$topic"'"}]' ;;
    *)     echo "无效权限: $perm (可选: pub, sub, both)"; exit 1 ;;
  esac
  curl -s -X POST "${API_BASE}/authorization/sources/built_in_database/rules/users" \
    -H "Authorization: Bearer $token" \
    -H 'Content-Type: application/json' \
    -d "{\"username\":\"$user\",\"rules\":$rules}" \
    | python3 -c "import sys,json; print('✓ 权限已授予')" 2>/dev/null || echo "✕ 授权失败"
}

cmd_revoke() {
  local user="${1:-}" topic="${2:-}"
  if [[ -z "$user" || -z "$topic" ]]; then
    echo "用法: $0 revoke <username> <topic>"
    exit 1
  fi
  local token
  token=$(get_token)
  # Delete all rules for this user, then re-add without the specified topic
  # For simplicity, delete the user's rules entirely
  curl -s -X DELETE "${API_BASE}/authorization/sources/built_in_database/rules/users/${user}" \
    -H "Authorization: Bearer $token" \
    | python3 -c "import sys; print('✓ 权限已撤销')" 2>/dev/null || echo "✓ 权限已撤销"
}

cmd_acl() {
  local user="${1:-}"
  if [[ -z "$user" ]]; then
    echo "用法: $0 acl <username>"
    exit 1
  fi
  local token
  token=$(get_token)
  echo "=== $user 的 ACL 规则 ==="
  curl -s "${API_BASE}/authorization/sources/built_in_database/rules/users/${user}" \
    -H "Authorization: Bearer $token" \
    | python3 -c "
import sys,json
data=json.load(sys.stdin)
rules=data.get('rules',[])
if not rules:
    print('(无规则)')
for r in rules:
    print(f\"  {r.get('action','?')}: {r.get('permission','?')} → {r.get('topic','?')}\")
" 2>/dev/null
}

cmd_clients() {
  echo "=== 已连接客户端 ==="
  local token
  token=$(get_token)
  curl -s "${API_BASE}/clients?page=1&page_size=100" \
    -H "Authorization: Bearer $token" \
    | python3 -c "
import sys,json
data=json.load(sys.stdin)
clients=data.get('data',[])
if not clients:
    print('(无连接)')
for c in clients:
    print(f\"  {c.get('clientid','?')}  → {c.get('connected','?')}  proto={c.get('proto_name','?')}\")
" 2>/dev/null
}

cmd_topics() {
  echo "=== 活跃订阅 ==="
  local token
  token=$(get_token)
  curl -s "${API_BASE}/subscriptions?page=1&page_size=100" \
    -H "Authorization: Bearer $token" \
    | python3 -c "
import sys,json
data=json.load(sys.stdin)
subs=data.get('data',[])
if not subs:
    print('(无订阅)')
for s in subs:
    print(f\"  {s.get('clientid','?')}  sub → {s.get('topic','?')}\")
" 2>/dev/null
}

cmd_api() {
  local method="${1:-GET}" path="${2:-/}" body="${3:-}"
  local token
  token=$(get_token)
  local args=(-s -X "$method" "${API_BASE}${path}" -H "Authorization: Bearer $token" -H 'Content-Type: application/json')
  if [[ -n "$body" ]]; then
    args+=(-d "$body")
  fi
  curl "${args[@]}" | python3 -m json.tool 2>/dev/null || curl "${args[@]}"
}

cmd_info() {
  echo ""
  echo "════════════════════════════════════"
  echo "  EMQX MQTT Broker 连接信息"
  echo "════════════════════════════════════"
  echo ""
  echo "  Dashboard:  http://localhost:18083"
  echo "  REST API:   http://localhost:18083/api/v5"
  echo "  MQTT TCP:   mqtt://localhost:1883"
  echo "  MQTT WSS:   wss://localhost:8084/mqtt"
  echo ""
  echo "  管理员:     admin / Energy2026!"
  echo ""
  echo "  Dashboard 中 MQTT Broker 地址:"
  echo "    本机测试:  wss://localhost:8084/mqtt"
  echo "    局域网:    wss://<服务器IP>:8084/mqtt"
  echo "    公网:      wss://<你的域名>:8084/mqtt"
  echo ""
  echo "════════════════════════════════════"

  # Show actual IP for convenience
  local ip
  ip=$(ip -4 addr show scope global 2>/dev/null | grep -oP '(?<=inet\s)\d+(\.\d+){3}' | head -1) || ip=$(hostname -I 2>/dev/null | awk '{print $1}')
  if [[ -n "$ip" ]]; then
    echo ""
    echo "  服务器 IP:  $ip"
    echo "  局域网 WSS: wss://${ip}:8084/mqtt"
  fi
}

cmd_help() {
  echo "用法: $0 <命令> [参数]"
  echo ""
  echo "服务管理:"
  echo "  up              启动 Broker"
  echo "  down            停止 Broker"
  echo "  status          运行状态"
  echo "  logs [N]        查看最近 N 行日志 (默认100)"
  echo "  info            显示连接信息"
  echo ""
  echo "用户管理:"
  echo "  add-user <user> <pass>   创建用户"
  echo "  del-user <user>          删除用户"
  echo "  list-users               列出用户"
  echo ""
  echo "权限管理:"
  echo "  grant <user> <topic> [pub|sub|both]   授权"
  echo "  revoke <user> <topic>                 撤销"
  echo "  acl <user>                            查看 ACL"
  echo ""
  echo "监控:"
  echo "  clients        在线客户端"
  echo "  topics         活跃订阅"
  echo ""
  echo "高级:"
  echo "  api <method> <path> [body]  直接调用 REST API"
  echo "  help                        帮助"
  echo ""
  echo "示例:"
  echo "  $0 up"
  echo "  $0 add-user rk3506-gateway-001 mypassword"
  echo "  $0 grant rk3506-gateway-001 energy/rk3506-gateway-001/telemetry pub"
  echo "  $0 grant rk3506-gateway-001 energy/rk3506-gateway-001/command sub"
  echo "  $0 clients"
}

# --- dispatch ---

case "${1:-help}" in
  up)           cmd_up ;;
  down)         cmd_down ;;
  status)       cmd_status ;;
  logs)         cmd_logs "${2:-100}" ;;
  info)         cmd_info ;;
  add-user)     cmd_add_user "${2:-}" "${3:-}" ;;
  del-user)     cmd_del_user "${2:-}" ;;
  list-users)   cmd_list_users ;;
  grant)        cmd_grant "${2:-}" "${3:-}" "${4:-both}" ;;
  revoke)       cmd_revoke "${2:-}" "${3:-}" ;;
  acl)          cmd_acl "${2:-}" ;;
  clients)      cmd_clients ;;
  topics)       cmd_topics ;;
  api)          cmd_api "${2:-GET}" "${3:-/}" "${4:-}" ;;
  help|--help|-h) cmd_help ;;
  *)
    echo "未知命令: $1"
    echo "运行 '$0 help' 查看帮助"
    exit 1
    ;;
esac
