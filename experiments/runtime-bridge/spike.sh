#!/usr/bin/env bash
#
# spike.sh — one-line reproducer for the runtime-bridge probes.
#
# CANNOT RUN IN THIS ENVIRONMENT.
#
# This script:
#   1. Symlinks the cep-panel/ folder into a CEP extension folder
#      under %USERPROFILE%\AppData\Roaming\Adobe\CEP\extensions\.
#      (Windows-only; uses `cmd //c mklink /J` for a directory
#      junction.)
#   2. Generates a 256-bit AE_BRIDGE_TOKEN.
#   3. Starts the node-server daemon in the background, bound to
#      127.0.0.1:7000.
#   4. Prints the curl invocations that exercise each probe.
#
# Prereqs:
#   - Windows host with After Effects 25.x installed.
#   - Node.js 18+ on PATH.
#   - PlayerDebugMode=1 in
#     HKEY_CURRENT_USER\Software\Adobe\CSXS.12.
#   - curl on PATH.
#
# The script does NOT open After Effects; the user must launch AE
# manually and open Window > Extensions > ae-devtools-bridge.
#
# On Linux (this environment): no AE; this script cannot run.
# See ../EXPERIMENT-LOG.md Probe 10 for what CAN run here
# (the node-server stub on its own).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PANEL_DIR="${REPO_ROOT}/cep-panel"
EXT_NAME="ae-devtools-bridge"
# Windows junction target: %USERPROFILE%\AppData\Roaming\Adobe\CEP\extensions\<name>
# We construct the absolute Windows path and use cmd //c mklink /J.
WIN_EXT_ROOT='%USERPROFILE%\AppData\Roaming\Adobe\CEP\extensions'
WIN_EXT_DIR="${WIN_EXT_ROOT}\\${EXT_NAME}"

echo "=== runtime-bridge spike ==="
echo "Repo: ${REPO_ROOT}"
echo "Panel: ${PANEL_DIR}"
echo "Target (Windows): ${WIN_EXT_DIR}"
echo ""

if [[ "${OS:-}" != "Windows_NT" ]] && ! command -v cmd >/dev/null 2>&1; then
  echo "ERROR: This spike requires a Windows host (or WSL with cmd.exe)."
  echo "       Cannot run in this environment (Linux on WSL2 with no AE)."
  echo ""
  echo "What you can do here instead:"
  echo "  cd node-server"
  echo "  AE_BRIDGE_TOKEN=\$(node -e 'console.log(require(\"crypto\").randomBytes(32).toString(\"hex\"))') \\"
  echo "    PORT=7000 node server.js"
  echo "  # In another shell:"
  echo "  curl -sS -i http://127.0.0.1:7000/healthz"
  exit 2
fi

echo "Step 1: junction ${PANEL_DIR} -> ${WIN_EXT_DIR}"
cmd //c mklink /J "${WIN_EXT_DIR}" "${PANEL_DIR}"

echo ""
echo "Step 2: generate AE_BRIDGE_TOKEN and start the daemon in the background"
TOKEN="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
echo "${TOKEN}" > "${REPO_ROOT}/.ae-bridge-token"
export AE_BRIDGE_TOKEN="${TOKEN}"
( cd "${REPO_ROOT}/node-server" && PORT=7000 node server.js & ) >/dev/null 2>&1

echo ""
echo "Step 3: print the curl invocations (run from another shell)"
cat <<EOF

# Health:
curl -sS -i http://127.0.0.1:7000/healthz

# Probe 01 (version):
curl -sS -X POST http://127.0.0.1:7000/eval \\
  -H "X-AE-Bridge-Token: ${TOKEN}" \\
  -H "Content-Type: application/json" \\
  -d '{"id":"probe-01","source":"return JSON.stringify({version: app.version});"}'

EOF

echo "Step 4: open After Effects manually, then Window > Extensions > ${EXT_NAME}"
echo "        Click the buttons in the panel to fire each ExtendScript probe."
echo ""
echo "Token written to: ${REPO_ROOT}/.ae-bridge-token (delete after run)."
