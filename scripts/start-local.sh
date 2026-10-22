#!/bin/sh
set -eu
cd "$(dirname "$0")/.."

oa_node_binary=""
for oa_candidate in "${OA_NODE_BINARY:-}" "$(command -v node || true)" "$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"; do
  if [ -n "$oa_candidate" ] && [ -x "$oa_candidate" ] && "$oa_candidate" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' 2>/dev/null; then
    oa_node_binary="$oa_candidate"
    break
  fi
done
if [ -z "$oa_node_binary" ]; then
  echo '请安装 Node.js 22 或更新版本，或者通过 OA_NODE_BINARY 指定 Node 路径。'
  exit 1
fi
if [ ! -f node_modules/typescript/bin/tsc ]; then
  echo '请先使用 Node.js 22+ 执行 npm ci 安装项目依赖。'
  exit 1
fi
oa_node_version="$("$oa_node_binary" --version)"
echo "正在编译并启动本地工作台（Node ${oa_node_version}）…"
"$oa_node_binary" node_modules/typescript/bin/tsc
if [ "${1:-}" = "--connect" ]; then
  exec "$oa_node_binary" dist/connect.js
fi
if [ "${1:-}" = "--tasks" ]; then
  shift
  exec "$oa_node_binary" dist/tasks.js "$@"
fi
if [ "${1:-}" = "--open" ]; then
  shift
  exec "$oa_node_binary" dist/open.js "$@"
fi
if [ "${1:-}" = "--funds" ]; then
  shift
  exec "$oa_node_binary" dist/funds.js "$@"
fi
if [ "${1:-}" = "--budgets" ]; then
  shift
  exec "$oa_node_binary" dist/budgets.js "$@"
fi
exec "$oa_node_binary" dist/server/main.js
