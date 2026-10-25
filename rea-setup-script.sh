#!/bin/bash
# REA (https://github.com/morluto/rea) をクラウド環境の全セッションで使うためのセットアップスクリプト
set -euo pipefail

NODE_MAJOR=24
NODE_DIR=/opt/node${NODE_MAJOR}

# REA が要求する Node.js 24 系の最新版を公式サイトから取得（チェックサム検証あり）
if [ ! -x "$NODE_DIR/bin/node" ]; then
  V=$(curl -fsSL https://nodejs.org/dist/index.json \
    | python3 -c "import json,sys;print([r['version'] for r in json.load(sys.stdin) if r['version'].startswith('v${NODE_MAJOR}.')][0])")
  TMP=$(mktemp -d)
  curl -fsSL -o "$TMP/node.tar.xz" "https://nodejs.org/dist/$V/node-$V-linux-x64.tar.xz"
  echo "$(curl -fsSL "https://nodejs.org/dist/$V/SHASUMS256.txt" | grep " node-$V-linux-x64.tar.xz\$" | cut -d' ' -f1)  $TMP/node.tar.xz" | sha256sum -c -
  mkdir -p "$NODE_DIR"
  tar -xJf "$TMP/node.tar.xz" -C "$NODE_DIR" --strip-components=1
  rm -rf "$TMP"
fi

# REA を Node 24 側にインストール（システムの Node 22 には触らない）
PATH="$NODE_DIR/bin:$PATH" npm install --global --prefix "$NODE_DIR" rea-agents@latest

# どこから呼ばれても Node 24 で動く rea コマンドを用意
rm -f /usr/local/bin/rea
cat > /usr/local/bin/rea <<EOF
#!/bin/sh
PATH="$NODE_DIR/bin:\$PATH" exec "$NODE_DIR/bin/node" "$NODE_DIR/lib/node_modules/rea-agents/scripts/rea.mjs" "\$@"
EOF
chmod +x /usr/local/bin/rea

# Claude Code 用のスキルを入れ、MCP サーバーを rea コマンド経由で登録する
rea setup --yes --skill-client claude_code --json > /tmp/rea-setup.json || true
claude mcp remove --scope user rea >/dev/null 2>&1 || true
claude mcp add --scope user rea -- /usr/local/bin/rea mcp

rea --version
