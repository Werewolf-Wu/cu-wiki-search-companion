#!/usr/bin/env bash
# SPDX-License-Identifier: MPL-2.0
set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
served_file="$(mktemp)"
server_host="${CU_WIKI_DEV_SERVER_HOST:-127.0.0.1}"
server_port="${CU_WIKI_DEV_SERVER_PORT:-8788}"
server_url="${CU_WIKI_USERSCRIPT_URL:-http://${server_host}:${server_port}/cu-wiki-local-search.user.js}"
server_unit="${CU_WIKI_DEV_SERVER_UNIT:-cu-wiki-search-dev-server}"

cleanup() {
  rm -f "$served_file"
}
trap cleanup EXIT INT TERM

cd "$project_dir"
npm run build

if ! curl --fail --silent --show-error "$server_url" --output "$served_file" 2>/dev/null; then
  # 这是开发期供 Tampermonkey 重装复用的常驻服务。它只监听 WSL loopback，
  # 安装脚本退出时不终止；Playwright 会话仍由包装脚本在 trap 中 detach。
  python_bin="$(command -v python3)"
  if systemctl --user is-system-running >/dev/null 2>&1; then
    systemd-run --user --quiet --collect --unit="$server_unit" \
      --property=Restart=on-failure --property=RestartSec=1s \
      "$python_bin" -m http.server "$server_port" --bind "$server_host" \
      --directory "$project_dir/dist"
    echo "已启动常驻 dist 服务：$server_url（user unit $server_unit）"
  else
    nohup setsid "$python_bin" -m http.server "$server_port" --bind "$server_host" \
      --directory "$project_dir/dist" </dev/null \
      >/dev/null 2>&1 &
    echo "已启动常驻 dist 服务：$server_url（PID $!）"
  fi
  for _ in {1..50}; do
    if curl --fail --silent --show-error \
      "$server_url" --output "$served_file" 2>/dev/null; then
      break
    fi
    sleep 0.1
  done
fi

if [[ ! -s "$served_file" ]]; then
  echo "开发服务未能提供 userscript 构建产物：$server_url" >&2
  exit 1
fi
if ! cmp --silent "$served_file" "$project_dir/dist/cu-wiki-local-search.user.js"; then
  echo "开发服务返回内容不是当前 dist/cu-wiki-local-search.user.js：$server_url" >&2
  exit 1
fi

export CU_WIKI_USERSCRIPT_URL="$server_url"
bash "$project_dir/scripts/run-edge-playwright.sh" \
  "$project_dir/scripts/install-userscript.playwright.js"
