# native-sdk build probe — CAP037/CAP038/CAP042 groundwork (Issues #17/#18)

> Status: **SDK build-path evidence only.** This directory records that
> the locally supplied AE SDK *compiles* on this machine and that our own
> minimal AEGP probe *links* into a `.plugin` bundle. It is **not**
> plugin load evidence, not execution evidence, not a transport, and not
> a shipped adapter. Plugin load/registration/execution inside After
> Effects (CAP040/CAP042) requires a real AE session and remains gated;
> Windows is entirely UNVERIFIED. Nothing here is `verified-real-host`
> catalog evidence — see the state table below.

## CAP037 — fixed SDK / ABI / toolchain / distribution facts

| Fact | Value |
| --- | --- |
| Target AE SDK | **After Effects SDK 26.5, macOS distribution** — operator-supplied archive, never vendored or committed |
| Archive integrity | sha256 `7b837d594696ca0ece1ddba5e15b0fd3bf1ee908a1c7be04d4627180aa7ece7e` (`inventories/sdk/generated/provenance.json`) |
| SDK layout on disk | `Examples/{Headers,Util,Resources,AEGP,Effect,...}` — headers live under `Examples/Headers` (+ `Headers/SP`, `Headers/adobesdk`) |
| ABI / arch | macOS arm64 only (`arm64` Mach-O bundle). x86_64/Universal and Windows are **UNVERIFIED** |
| Toolchain | Apple `clang`/`clang++` + `xcodebuild` (Xcode 27.2, macOS SDK), `Rez` for PiPL resources, ad-hoc `codesign --sign -` |
| Canonical sample set used here | `Examples/AEGP/Sweetie` (AEGP), `Examples/Effect/Checkout` (CPU-only Effect). `Effect/SDK_Invert_ProcAmp` (GPU) is build-blocked — see below |
| Distribution / license terms | The archive ships **no license text** (no EULA/readme/notice file; the two PDFs only redirect to public docs). 29 of 70 inventoried headers carry an `ADOBE CONFIDENTIAL` no-reproduction notice; the rest carry mixed copyright/restrictive terms (full breakdown in `inventories/sdk/generated/provenance.json`). Acquisition is **operator-supplied**; SDK headers and sample sources are **never committed** — this directory contains scripts, docs, logs summaries and our own original source only |

## Independent verification states

Build success, plugin load, plugin execution and Windows support are
**separate states** — progress on one never implies another, and none is
AE-host evidence:

| State | Scope | Status | Basis |
| --- | --- | --- | --- |
| SDK acquisition & integrity | AE SDK 26.5 macOS archive, operator-supplied | verified on **build host** (not AE) | sha256 in `inventories/sdk/generated/provenance.json`; never vendored |
| SDK sample **build** | `Sweetie` (AEGP), `Checkout` (Effect/CPU) compile via xcodebuild on macOS arm64 / Xcode 27.2 | **BUILD SUCCEEDED** (local build log) | `build-macos.sh` + `EVIDENCE.md` |
| Own-plugin **build** | `minimal-plugin/` → `NativeProbe.plugin` (AEGP, read-only) compiles, links, bundles, ad-hoc signs on macOS arm64 | **BUILD SUCCEEDED** (local build + artifact inspection) | `minimal-plugin/build.sh` + `EVIDENCE.md` |
| Own-plugin **mock-host tests** | `minimal-plugin/test/` runs the real `probe.cpp` against a fake SPBasicSuite/AEGP host | **776 checks, 0 failures** (automated test, fake host only — count grows as coverage is added; `EVIDENCE.md` is the per-run record) | `minimal-plugin/test/run_tests.sh` + `EVIDENCE.md` |
| Plugin **load** into AE | `.plugin` recognized/registered by After Effects | **UNVERIFIED** | needs owned/dedicated AE session — not run; ad-hoc signing acceptance unknown |
| Plugin **execution** | AEGP commands / effect render path / probe queries actually run in AE | **UNVERIFIED** | same gate; GPU path additionally blocked (below) |
| **Windows** SDK build | Win64 toolchain + samples | **UNVERIFIED** | no Windows host; agents never touch Windows (Issue #21) |

`Effect/SDK_Invert_ProcAmp` (GPU kernels) is **BUILD FAILED** on this
machine — `metal_common` (AE GPU SDK component, absent from the base 26.5
distribution) and Boost headers (`BOOST_BASE_PATH` unset). This blocks
only the SmartFX/MFR/GPU slice (CAP043/#18); the CPU `Checkout` build is
unaffected.

## Layout

```
experiments/native-sdk/
├── README.md            # this file
├── LOAD-PROOF.md        # gated procedure + fixtures + verification conditions for real-AE load proof
├── EVIDENCE.md          # build log summary + blocker list + artifact verification
├── build-macos.sh       # builds SDK samples (xcodebuild) + minimal-plugin (clang/Rez)
├── minimal-plugin/      # ae-a8n's own read-only AEGP probe (CAP038) — original source
│   ├── README.md        # lifecycle, per-call read-only justification, verification states
│   ├── REVIEW.md        # ABI / callback-lifetime / thread-affinity review vs SDK 26.5
│   ├── build.sh         # clang++ + Rez + codesign → NativeProbe.plugin
│   ├── src/probe.cpp    # registration-only entry point + idle-hook read-only queries
│   ├── ProbePiPL.r      # PiPL resource (Kind AEGx)
│   ├── plugin-Info.plist
│   └── test/            # mock-host unit tests (fake SPBasicSuite/AEGP, no AE)
└── build/               # gitignored output (logs + derived data + .plugin bundles)
```

## Reproducible build procedure (fresh operator)

Prerequisites: macOS with Xcode command-line tools (`xcodebuild`,
`clang`, `clang++`, `Rez`, `codesign`), and the AE SDK 26.5 macOS
archive obtained from Adobe and unpacked locally (operator-supplied;
verify sha256 against `inventories/sdk/generated/provenance.json`).

```sh
cd experiments/native-sdk
AE_SDK_ROOT=/path/to/AeSDK ./build-macos.sh ./build
```

`AE_SDK_ROOT` is the SDK distribution root (contains `Examples/`). The
script builds into `./build/`:

- `dd-Sweetie/` + `Sweetie.build.log` → `Sweetie.plugin` (xcodebuild)
- `dd-Checkout/` + `Checkout.build.log` → `Checkout.plugin` (xcodebuild)
- `minimal-plugin/` → `NativeProbe.plugin` + `NativeProbe.*.log`
  (direct clang/Rez; standalone: `minimal-plugin/build.sh [outdir]`)

To rebuild only the minimal plugin:

```sh
cd experiments/native-sdk/minimal-plugin
AE_SDK_ROOT=/path/to/AeSDK ./build.sh ./build
```

## Known build blockers (measured 2026-11-14/15, macOS arm64, Xcode 27.2)

- `Effect/SDK_Invert_ProcAmp` **fails**: GPU kernel preprocessing needs
  `metal_common` (AE GPU SDK component, not in the base 26.5 distribution)
  and Boost headers (`BOOST_BASE_PATH` unset). CPU-only effect samples
  (e.g. `Checkout`) build fine. The SmartFX/MFR/GPU path (CAP043) is
  blocked on obtaining the GPU SDK addendum and/or Boost — recorded, not
  worked around.
- Plugins are ad-hoc signed (`Sign to Run Locally`) by the sample
  projects and by `minimal-plugin/build.sh`. Whether AE accepts
  ad-hoc-signed plug-ins on this macOS version is **UNVERIFIED** until
  a real load test (CAP040).

## License / redistribution boundary

The SDK archive ships no license text; 29 of 70 headers carry an
`ADOBE CONFIDENTIAL` no-reproduction notice (see
`inventories/sdk/generated/provenance.json`). Building plugins locally is
normal SDK use; **header-derived content is never committed** — this
directory contains scripts, logs and findings only, plus our own
original plug-in source (`minimal-plugin/src/probe.cpp`,
`ProbePiPL.r`, `plugin-Info.plist`). SDK headers and sample sources are
used at build time only.
