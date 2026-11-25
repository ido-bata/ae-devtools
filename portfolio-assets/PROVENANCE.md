# Portfolio assets — provenance

## ae-devtools-main.png (main image, 1920x1080 PNG)

Composed evidence board built from **real runs of the published**
`@ido-bata/ae-devtools-cli@0.8.0` npm package (repo `main` @ `a6304b1`,
the `release-0-8-0` merge — the released state; ae-a8n dependency
`@ido-bata/ae-a8n@0.6.0` resolved from npm).

Two evidence sources, both from 2026-11-25 on macOS arm64 against an
**owned** After Effects session pinned to the AE 2026 install
(`26.5.3x9`). The user's running AE 2027 instance was never touched;
each owned session verified `ownership: "owned"` and closed cleanly.

1. CLI surface — real `ae-devtools` run records (`ae-devtools.cli.run/v1`
   JSON written with `--out`):
   - `doctor` — environment probe ok (ae-a8n 0.6.0 contractOk, both AE
     installs discovered, no AE contacted).
   - `discover` — 97 registry ops with honest evidence levels.
   - `execute read.projectSummary --session a8n` — COMPLETED on owned
     AE 26.5.3x9.
   - `execute project.new` — REFUSED `DESTRUCTIVE_CONFIRMATION_REQUIRED`
     with an `ae-devtools.diagnostics/v1` record (the consent/gate
     path, shown verbatim).
   - `execute item.addComp` — COMPLETED (`PortfolioDemo` id=1); cleanup
     honestly recorded `session.close refused: unsaved changes`.
   - `execute layer.addText --session a8n-attached` — REFUSED
     `PROJECT_GUARD_UNAVAILABLE` (attached mutations require a saved,
     attested project).
2. Dev-loop pipeline — a capture driver in the worker sandbox calls the
   same published modules the shipped `jsx-toolchain/real-run.mjs`
   driver uses: `jsx-toolchain buildFile` (scene.ts → ES3 JSX +
   sourcemap), `dev-loop/real-run-session.openRealRunSession` (owned
   a8n session), `devtools-cli/real-run-kit.createEvalDispatch`
   (consent-bound trusted eval). Steps, all `ok`:
   `session.launch → build.scene (1355 B JSX) → dispatch.scene
   COMPLETED ("PortfolioDemo|2 layers|frame0.png") → dispatch.readback
   COMPLETED ("ae-devtools|Backdrop @ 3 items") → build.runtime-error →
   dispatch.runtime-error FAILED (host ReferenceError, host line 4) →
   sourcemap.to-source → runtime-error.ts:4:38 → session.close`.
   The scene created comp `PortfolioDemo` 640x360@30 with a solid
   backdrop and text layer "ae-devtools", wrote `frame0.png` via
   `comp.saveFrameToPng`, and saved `portfolio-demo.aep`.

- Verification level: **verified on real host** (real AE 26.5.3, owned
  session, published npm packages). No fake-host evidence is pictured
  as real-host.
- alt: `ae-devtools のポートフォリオ主画像。TypeScript を jsx-toolchain で ExtendScript ES3 JSX にビルドし、trusted eval 経由で実機 After Effects 26.5 にディスパッチしてコンポ作成・テキスト追加・フレーム PNG 出力を完了させた証跡と、実行時エラーをソースマップで TS 行へ逆引きする結果、CLI の consent/guard による REFUSED 記録を並べた図。`
- caption: `@ido-bata/ae-devtools-cli@0.8.0 — TS→ES3 JSX ビルドから trusted eval ディスパッチ、エラー→TS ソース行へのソースマップ復元までの開発ループを実機 AE で実証。`
- Dimensions: main 1920x1080; supplement 640x360.
- Rights: project-owned composite; code, run JSON and rendered frame
  are self-produced demo data. No third-party or private content.

## ae-devtools-frame0.png (supplement, 640x360 PNG)

Real `comp.saveFrameToPng(0)` output written inside the owned AE 26.5.3
session by the dispatched `scene.jsx`: comp `PortfolioDemo`, solid
backdrop + text layer "ae-devtools". RGBA PNG.

## Reproduction

```
npm init -y && npm install @ido-bata/ae-devtools-cli@0.8.0
npx ae-devtools doctor
npx ae-devtools discover
npx ae-devtools execute read.projectSummary --session a8n \
  --install-dir "/Applications/Adobe After Effects 2026" --consent grant
# dev-loop: node capture.mjs  (published-module pipeline, see sandbox)
```

The capture sandbox (`sandbox/` under the worker workspace
`/Users/rebui/work/p1225-assets/ae-devtools/`) contains `capture.mjs`,
`src/scene.ts`, `src/runtime-error.ts`, `out/jsx/scene.jsx(.map)`,
`out/frame0.png`, `evidence.json`, `portfolio-demo.aep`, and the
`runs/*.json` CLI records referenced above. It is capture tooling, not
shipped product code.
