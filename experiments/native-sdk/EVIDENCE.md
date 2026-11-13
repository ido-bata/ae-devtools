# EVIDENCE — native-sdk build probe

Measured 2026-11-14 on the macOS development host. Build-machine evidence
only; **no After Effects process was launched** and no plugin was loaded.

## Environment

| Fact | Value |
| --- | --- |
| Host | macOS arm64 (Apple Silicon), operator's dev machine |
| Xcode | 27.2 (build 27B52), `xcode-select` → `/Applications/Xcode.app` |
| SDK | After Effects SDK 26.5 macOS, operator-supplied at `~/Documents/projects/adobe/AeSDK` (never vendored; archive sha256 in `inventories/sdk/generated/provenance.json`) |
| AE installed | After Effects 2026 (26.5.3) and 2027 (27.0.0) — **not launched for this probe** |

## Results

| Sample | Suite family | Command | Result |
| --- | --- | --- | --- |
| `AEGP/Sweetie` | AEGP (general plug-in) | `build-macos.sh` → xcodebuild Debug | **BUILD SUCCEEDED** → `Sweetie.plugin` (arm64, ad-hoc "Sign to Run Locally") |
| `Effect/Checkout` | Effect (PF, CPU path) | same | **BUILD SUCCEEDED** → `Checkout.plugin` |
| `Effect/SDK_Invert_ProcAmp` | Effect + GPU kernels | same | **BUILD FAILED** — see blockers |

Full logs: `build/<name>.build.log` (gitignored; regenerate with
`build-macos.sh`).

## Blockers recorded (real missing dependencies only)

1. **GPU kernel path (#18, CAP043 scope):** `SDK_Invert_ProcAmp` fails in
   the kernel-preprocessing build phase:
   - `metal_common` header not found — part of the AE GPU SDK component,
     not present in the base 26.5 distribution on this machine.
   - `boost/preprocessor/...` not found — `BOOST_BASE_PATH` unset; Boost is
     not vendored anywhere under `AeSDK/`.
   CPU-only effect samples are unaffected. Obtaining the GPU SDK addendum
   and/or Boost is a **real blocker** for SmartFX/MFR/GPU fixtures; it does
   not block the CPU effect vertical slice.
2. **Plugin load/registration:** unverified. Loading a `.plugin` requires
   launching After Effects; the operator's interactive AE session is
   off-limits for this work and no dedicated host exists yet. Ad-hoc
   signing acceptance by AE on this macOS version is unknown until then.
3. **Windows:** entirely UNVERIFIED — no Windows host, per Issue #21.

## Reproduce

```sh
cd experiments/native-sdk
AE_SDK_ROOT=/path/to/AeSDK ./build-macos.sh ./build
```

Expected: `Sweetie: BUILD SUCCEEDED`, `Checkout: BUILD SUCCEEDED`.
