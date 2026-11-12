# Implementation plan — complete AE operation reachability

- Status: **Proposed**, architecture alternatives gated by evidence.
- Epic: [#6](https://github.com/ido-bata/ae-devtools/issues/6)
- Spec: [spec.md](spec.md); [research.md](research.md); [tasks.md](tasks.md); [catalog contract](contracts/capability-catalog.md).
- This plan creates work units and acceptance obligations, **not a commitment that every SDK function can be remotely invoked**.

## 1. Canonical responsibilities

| Authority | Owns | Does not own |
| --- | --- | --- |
| **ae-devtools** | API/tool inventory, canonical capability IDs and coverage denominator, generated metadata/types, shared developer core, VSCode/MCP inspect/execute/verify surface, native SDK adapter research | AE session ownership/security policy duplicated from ae-a8n, ae-test assertions, farm queue |
| **ae-a8n** | Public AE automation API, static named extension/ES3 host dispatch, execution transports, target/ownership, local/remote consent and fail-closed outcomes | Canonical SDK/public scripting symbol denominator, IDE/MCP UX |
| **ae-test** | Fixtures, conformance, snapshots, result/trace/artifact evidence, fake-vs-real separation | Reimplementing AE automation transport |
| **ae-farm** | Future dedicated-host queue/worker/isolation/artifact transport and capability-aware scheduling | Reimplementing AE API or claiming shared dependency before an ADR |
| **Ae_LayerNote** | Optional downstream CEP consumer compatibility fixture | Canonical runtime or SDK schema |

**Contract sharing is not implementation sharing.** A small versioned manifest and generated client types can be consumed without linking the entire ae-devtools daemon or replacing ae-a8n's public API. This resolves the current ae-farm README's separate-axis statement until an explicit owner decision changes it.

## 2. Proposed logical layers (not yet an Accepted architecture)

```text
        VSCode / MCP / CLI developer-loop clients
                       |
     ae-devtools shared core: discovery, metadata, source map,
           inspection, execution orchestration, evidence
                       |
        versioned capability contract / adapters
          /             |                 \
  Scripting adapter   Native SDK adapter   Tool/CLI adapter
    ES3/CEP/in-AE      AEGP/Effect/IO       aerender/OS where
    selected transport host plugin lifecycle justified by evidence
          \             |                 /
                After Effects host
                       |
     ae-a8n: session/ownership/transport + static extensions
                       |
       ae-test real-host conformance → ae-farm future worker
```

This diagram is a **responsibility map**, not a demand that every invocation route through ae-a8n or that a plug-in callback waits for Node. Actual IPC, core language, CEP/UXP/native plugin packaging and process ownership remain ADR decisions. The existing ae-a8n transport and host script remain in place until #97–#99 proof/release gates permit changes.

## 3. Execution classes and contract rules

1. **Scripting read:** AE-side ExtendScript snapshot; serialize primitive results and stable identity evidence; never export a raw live host object across process boundaries.
2. **Scripting write:** named operation or explicitly trusted development script; explicit target and write intent; bounded args; trace; no automatic replay after a possible dispatch.
3. **Native host command:** compiled AEGP or effect plug-in registers a supported command, with SDK version and lifecycle checks; only a safe subset can be invoked at arbitrary host times.
4. **Native host callback:** effect selector, render callback, custom UI or SDK host-driven entry point is **not** generic remote callable. Expose a test/build/load/fixture operation that causes AE to invoke it in the correct lifecycle and returns evidence afterward.
5. **External CLI/OS:** aerender or GUI automation only where a host API does not provide the required capability, with explicit permissions and lower reliability; not a substitute for SDK callbacks.
6. **Unsupported/unknown:** maintain catalog row with source, reason, version, test and next investigation; never silently drop it from the public API denominator.

Capability handshake must include protocol version, AE build, OS/architecture, target/session/ownership evidence, adapter/plug-in identity, permission and per-capability status. See [contract](contracts/capability-catalog.md).

## 4. Dependency graph and independently reviewable issues

```text
#8 tool inventory ────┐
#9 scripting inventory ├──► #11 catalog/schema ─┬──► #14 trusted execution ─► #15 DOM A ─► #16 DOM B
#10 SDK inventory ────┘                         ├──► #17 AEGP proof ──┐
        │                                        ├──► #18 Effect proof ─┼──► #19 SDK family expansion
        └──► #12 boundary ADR ◄─ ae-a8n #97–99  ├──► #20 VSCode/MCP     │
                         │                       └──► #21 conformance ◄─┘
                         └──► #13 read-only AE probe ─► #14

ae-a8n #97/#98/#99 + ae-devtools #11/#12 ─► ae-a8n #102 capability negotiation
ae-a8n #102 + ae-devtools #11/#17/#18/#21 + ae-test #19 ─► ae-test #21 conformance
ae-test #21 + dedicated-host gates ─► ae-farm #4 (design only)
```

Edges mean prerequisites for *closing* the dependent slice; research/contract drafting may proceed in parallel. AEGP #17 and Effect #18 are independent after SDK inventory/ADR; SDK expansion #19 must not be closed as a substitute for its later suite-family implementation Issues.

## 5. Phases and gates

| Phase | Issues | Deliverable / stop condition |
| --- | --- | --- |
| **P0: universe and decisions** | [#8](https://github.com/ido-bata/ae-devtools/issues/8), [#9](https://github.com/ido-bata/ae-devtools/issues/9), [#10](https://github.com/ido-bata/ae-devtools/issues/10), [#11](https://github.com/ido-bata/ae-devtools/issues/11), [#12](https://github.com/ido-bata/ae-devtools/issues/12) | Source-linked inventory, denominator, status schema, reconciled ADR; no implementation claim. |
| **P1: safe host access** | [#13](https://github.com/ido-bata/ae-devtools/issues/13), [#14](https://github.com/ido-bata/ae-devtools/issues/14), [ae-a8n #102](https://github.com/ido-bata/ae-a8n/issues/102) | Read-only real AE proof first; then bounded script writes; G0/G1/G2 from ae-a8n #99 remain hard gates. |
| **P2: scripting coverage** | [#15](https://github.com/ido-bata/ae-devtools/issues/15), [#16](https://github.com/ido-bata/ae-devtools/issues/16) | Inventory-driven domain adapters and conformance. Each newly discovered symbol remains visible as missing until addressed. |
| **P3: native SDK proof** | [#17](https://github.com/ido-bata/ae-devtools/issues/17), [#18](https://github.com/ido-bata/ae-devtools/issues/18) | Native AEGP and effect plugin build/load/use/test in AE; Windows/macOS verified separately. |
| **P4: SDK breadth and developer clients** | [#19](https://github.com/ido-bata/ae-devtools/issues/19), [#20](https://github.com/ido-bata/ae-devtools/issues/20) | Suite-family child issues from SDK inventory; VSCode/MCP small developer-loop surface; never declare complete from one plugin. |
| **P5: ecosystem conformance** | [#21](https://github.com/ido-bata/ae-devtools/issues/21), [ae-test #21](https://github.com/ido-bata/ae-test/issues/21), [ae-farm #4](https://github.com/ido-bata/ae-farm/issues/4) | Exact AE/OS/SDK/build evidence, packaged consumers, release gating; farm remains future until ae-test real-host runner proven. |

No release dates are committed by this plan. P2 and P3 can proceed in parallel **after** the relevant contracts; one real AE host cannot be used concurrently by uncoordinated workers.

## 6. Version/host verification matrix

### 6.1 Supported-release set is decided before it is measured

Nothing in this plan names a supported AE build or SDK release. That set is **not** implied by an installed copy, by a marketing year, or by which SDK happened to be downloaded. It is fixed deliberately, after the source snapshots exist:

1. [#9](https://github.com/ido-bata/ae-devtools/issues/9) and [#10](https://github.com/ido-bata/ae-devtools/issues/10) produce the dated, source-linked symbol snapshots.
2. The candidate builds and SDK releases are listed with what evidence each one already has.
3. An owner decision records the **supported-release set** — which AE builds and SDK releases this repository claims, and which are explicitly out of scope — with a named reason per exclusion (FR-13, FR-14).
4. Only then does a coverage denominator exist for a specific release, and only then may any percentage be published.

Until step 3 is recorded, the state of every coverage number is **undetermined, not zero and not complete**. Reported coverage must be `unknown` rather than 0% or 100%. A later AE or SDK release creates a new denominator and a tracked delta; it never redefines an existing denominator.

This ordering is deliberate: acceptance criterion 1 in [spec.md](spec.md) ("each explicitly supported release") is unmeasurable while the supported set is undefined, so the set is fixed first and the measurement second.

### 6.2 Matrix axes

The test matrix is **generated from inventory**, not guessed in advance. Initial candidate axes to investigate (not yet supported promises):

- Windows 11 and macOS, separately; CPU architecture and GPU backend as applicable.
- AE 2026 and 2027 exact builds, SDK header versions and plugin binary ABI; version/OS support may be narrowed only with explicit evidence/owner decision.
- Read-only/writes/native plugin load/render/host callback, with permission present/absent, owned/attached/unknown, single/competing AE, idle/render busy/modal/quit/reconnect.
- Packaged consumer vs source checkout; immutable package/plugin/source SHA and signed artifact hashes.

Each row records `NOT_RUN | BLOCKED | PASS | FAIL | UNKNOWN` and evidence level `source-reviewed | automated/fake | verified-real-host`. No automatic retry after possible host dispatch; unknown outcome stays quarantined until resolved.

## 7. Security and release constraints

- Existing [ae-a8n #95](https://github.com/ido-bata/ae-a8n/issues/95) and [#93](https://github.com/ido-bata/ae-a8n/issues/93)/[#94](https://github.com/ido-bata/ae-a8n/issues/94) remain safety dependencies for process identity, channel integrity and recovery.
- Local control is not console non-interference. Dedicated host must prove target AE and signed job identity; same-user token is not same-user adversary isolation.
- Native SDK plugins require explicit install/enable intent, ABI and signing/permission review, crash containment and verified clean removal. Rendering threads must not synchronously block on IPC.
- Static extension methods are compiled/declared before session start; privileged arbitrary script evaluation is a separate opt-in developer operation and cannot be exposed as a generic untrusted RPC.
- Unknown outcome is not retryable; project writes occur only on disposable/copy fixtures for E2E; no Adobe sign-in/TCC prompt automation.
- Stable/latest promotion remains exclusively under [ae-a8n #63](https://github.com/ido-bata/ae-a8n/issues/63) / [#75](https://github.com/ido-bata/ae-a8n/issues/75) and existing human authorization. No merge/publish authorized by this plan.

## 8. Definition of done per child Issue

A child Issue can close only when: (a) all its CAP tasks are implemented or a documented waiver is accepted, (b) contract and negative tests are current-SHA green, (c) the promised platform/host evidence is actually present, (d) its code is integrated through a reviewed PR, and (e) the coverage matrix is updated. Documentation-only Issues close on reviewed source evidence, not fake host success.

**Epic #6 completion is planning completion**, not all-capabilities completion. The longer-term coverage target remains open in the generated catalog and successor Issues even after the planning PR is integrated.
