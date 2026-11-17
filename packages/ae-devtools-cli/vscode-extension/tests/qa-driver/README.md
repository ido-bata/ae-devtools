# qa-driver — isolated VSCode acceptance driver (test tooling, not shipped behavior)

Minimal VSCode extension used to drive `ae-devtools.*` commands inside an
**isolated** VSCode instance (`--extensions-dir` / `--user-data-dir` outside
the repo) and record settlement evidence to JSON. It is acceptance
tooling, not part of the product surface.

## Layout contract

The driver reads its workspace dir from `AE_QA_DIR` (default
`/tmp/vscode-iso`):

- `mode.txt` — command lane: `auto` (default: discover → debug.setup →
  debug.attach + diagnostics snapshot), `inspect`, `execute`, `verify`.
- `qa-results.json` — written incrementally; the evidence artifact.

Commands that open QuickInput / consent modals are settled externally
(e.g. AppleScript AX input) — the driver only triggers and observes
settlement; it never answers consent prompts itself.

## Usage sketch

```sh
# 1. install the packaged extension into the isolated instance
code --extensions-dir "$QA_EXT" --user-data-dir "$QA_USER" \
  --install-extension /path/to/ae-devtools-vscode-extension-<ver>.vsix

# 2. copy this folder into the isolated extensions dir (it is a plain
#    extension folder, not a vsix) and open the QA workspace; results
#    land in $AE_QA_DIR/qa-results.json
```

Committed evidence: `../evidence/vscode-iso-verify-4a06639.json`
(extension host activation, all six commands, packaged-runtime fake
dev-loop; **fake-level only** — no real AE dispatch was driven through
the editor).
