#!/usr/bin/env bash
# SPDX-License-Identifier: MPL-2.0
set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
session_name="${CU_WIKI_PLAYWRIGHT_SESSION:-cu_wiki_search_edge}"
cdp_endpoint="${CU_WIKI_CDP_ENDPOINT:-http://127.0.0.1:9222}"

if [[ $# -ne 1 ]]; then
  echo "用法：$0 <run-code 脚本>" >&2
  exit 2
fi

script_path="$1"
if [[ "$script_path" != /* ]]; then
  script_path="$project_dir/$script_path"
fi
if [[ ! -f "$script_path" ]]; then
  echo "Playwright 脚本不存在：$script_path" >&2
  exit 2
fi

cdp_ready=false
for _ in {1..20}; do
  if curl -fsS "$cdp_endpoint/json/version" --output /dev/null; then
    cdp_ready=true
    break
  fi
  sleep 0.25
done
if [[ "$cdp_ready" != true ]]; then
  echo "Windows Edge CDP 不可达：$cdp_endpoint；请在 Windows 侧启动 9222 Edge。" >&2
  exit 1
fi

detach() {
  playwright-cli -s="$session_name" detach >/dev/null 2>&1 || true
}
trap detach EXIT INT TERM

# 清理同名的陈旧 WSL 句柄；detach 不会关闭外部 Windows Edge。
detach
playwright-cli -s="$session_name" attach --cdp="$cdp_endpoint"
playwright-cli -s="$session_name" run-code --filename="$script_path"
