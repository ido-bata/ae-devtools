# native-sdk build probe — CAP037/CAP042 groundwork (Issues #17/#18)

> Status: **build-path evidence only.** This directory records that the
> locally supplied AE SDK builds on this machine. It is **not** plugin
> load evidence, not a transport, and not a shipped adapter. Plugin
> load/registration inside After Effects (CAP040/CAP042) requires a real
> AE session and remains gated; Windows is entirely UNVERIFIED.

## What is proven here

| Claim | Evidence level | Basis |
| --- | --- | --- |
| AE SDK 26.5 macOS distribution is obtainable and usable locally | `verified on real host` (build machine, not AE) | operator-supplied archive; sha256 in `inventories/sdk/generated/provenance.json`; never vendored |
| SDK sample plugins compile on macOS arm64 with Xcode 27.2 | `automated`-adjacent local build log | `build-macos.sh` + `EVIDENCE.md` |
| Plugin .load inside AE, command registration, crash/unload behaviour | **UNVERIFIED** | needs owned/dedicated AE session — not run |
| Windows SDK build | **UNVERIFIED** | no Windows host |

## Layout

```
experiments/native-sdk/
├── README.md            # this file
├── build-macos.sh       # xcodebuild probe: Sweetie (AEGP) + Checkout (Effect)
├── EVIDENCE.md          # build log summary + blocker list
└── build/               # gitignored output (logs + derived data)
```

## Usage

```sh
AE_SDK_ROOT=/path/to/AeSDK ./build-macos.sh [outdir]
```

`AE_SDK_ROOT` is the SDK distribution root (contains `Examples/`). The
script builds into `outdir/dd-<name>` and writes `outdir/<name>.build.log`.

## Known build blockers (measured 2026-11-14, macOS arm64, Xcode 27.2)

- `Effect/SDK_Invert_ProcAmp` **fails**: GPU kernel preprocessing needs
  `metal_common` (AE GPU SDK component, not in the base 26.5 distribution)
  and Boost headers (`BOOST_BASE_PATH` unset). CPU-only effect samples
  (e.g. `Checkout`) build fine. The SmartFX/MFR/GPU path (CAP043) is
  blocked on obtaining the GPU SDK addendum and/or Boost — recorded, not
  worked around.
- Plugins are ad-hoc signed (`Sign to Run Locally`) by the sample
  projects. Whether AE accepts ad-hoc-signed plug-ins on this macOS
  version is **UNVERIFIED** until a real load test (CAP040).

## License / redistribution boundary

The SDK archive ships no license text; 29 of 70 headers carry an
`ADOBE CONFIDENTIAL` no-reproduction notice (see
`inventories/sdk/generated/provenance.json`). Building plugins locally is
normal SDK use; **header-derived content is never committed** — this
directory contains scripts, logs and findings only, no SDK source.
