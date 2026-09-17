# Real-AE Validation Record

> Companion to `ADR-0001-runtime-bridge.md`. Records this round's
> attempt to perform real-AE validation. **Outcome: nothing was
> validated end-to-end, because the working environment has no
> After Effects installed.**

---

## Environment (this round)

- **Host OS**: Linux on WSL2 (kernel `Linux 6.18.40.1-microsoft-standard-WSL2`).
- **Date**: 2026-09-18.
- **After Effects**: **NOT installed.** No AE binary, no ExtendScript
  engine, no CEP, no AE-side scripting environment.
- **Node.js**: available (used for syntax-checking the
  `node-server/server.js` stub and for the `crypto.randomBytes`
  token-generation pattern in the spike script).
- **Adobe CEP runtime / `CEPHtmlEngine`**: not present; CSInterface.js
  is not available in this environment.

This matches the constraint recorded in `AGENTS.md` §5: "do not
mark anything as validated unless it was actually executed on a real
AE". The validation effort for this round therefore consists of
**documenting what could not be done**, building the probes so a
future round with a real AE can run them, and recording the per-ADR
gating condition as **deferred**.

---

## What was attempted

1. **Source-of-truth corrections** were applied to the existing
   research files (`research/01`, `02`, `04`), to the synthesis
   (`ae-bridge-research.md`), and to `ADR-0001-runtime-bridge.md`.
   These are based on `gh api` checks against `api.github.com` and
   the published CEP 12 Cookbook; they do not require AE and were
   carried out in full. See `research/corrections-01-adobe-cep-org.md`
   and `research/corrections-02-cep-ae-mapping.md` for the
   underlying evidence.
2. **Experiment artifacts** were authored under
   `experiments/runtime-bridge/` (CEP panel + ExtendScript probes +
   daemon stub + `spike.sh`). Each artifact is annotated
   **"Status: UNVERIFIED"** and includes a comment block pointing at
   this validation record.
3. **Syntax check of `node-server/server.js`** was performed with
   `node --check` and passed cleanly. This is the only artifact that
   could be mechanically verified in this environment.
4. **No real-AE probes were run.** All Actual sections in
   `experiments/runtime-bridge/EXPERIMENT-LOG.md` therefore read
   "Not executed — this environment (Linux on WSL2) has no After
   Effects installed." We do not fabricate measurements.

---

## What was NOT possible (and why)

| Item | Why not | Path forward |
|---|---|---|
| `CSInterface.evalScript` end-to-end on AE 25.x | No AE binary in this environment. | Run on a Windows AE host with `PlayerDebugMode=1` (Probe 01–07). |
| `CSInterface.getCurrentApiVersion()` shape verification | Same. | Probe 09. |
| Daemon ↔ CEP panel round-trip | Same. | Wire up the panel→daemon forwarding in the real implementation; Probe 10 covers only the loopback contract half. |
| Apple Silicon behavior of the CEP panel | No AE on macOS hardware. | macOS / Linux gate (M1, M2). |
| Linux AE availability | AE for Linux is not a product line as of 2026-09-18. | Marked **N/A — AE for Linux not in scope** unless Adobe ships it. |
| `evalScript` timing under load | Requires live AE. | Not in this round. |
| Adobe legitimacy question (research 05 §Unverified, item 22) | Not a technical question; needs Adobe outreach. | Out of scope for this round. |

---

## What remains to be tested (per-experiment pointer to EXPERIMENT-LOG.md)

| Probe | Description | EXPERIMENT-LOG.md section | ADR gate |
|---|---|---|---|
| 01 | `app.version` round-trip | §Probe 01 | Windows W1, W5 |
| 02 | `app.project.activeItem` JSON projection | §Probe 02 | Windows W1 |
| 03 | Mutate-then-inspect | §Probe 03 | Windows W2 |
| 04 | Intentional ExtendScript throw | §Probe 04 | Windows W3 |
| 05 + 06 | Concurrent A/B serialization | §Probe 05+06 | Windows W4 |
| 07 | Structured snapshot | §Probe 07 | Windows W1 |
| 08 | Temp comp / layer identity (create + read only) | §Probe 08 | Future |
| 09 | `getCurrentApiVersion()` shape | §Probe 09 | Windows W5 |
| 10 | Daemon loopback contract (runnable here) | §Probe 10 | Windows W6, W7 (when wired to the panel) |
| (future) | Daemon reconnect after AE restart | not yet authored | Windows W6 |
| (future) | Daemon survives `evalScript` failure | not yet authored | Windows W7 |

The probes above must all run on a **Windows AE 25.x** host to clear
the **Windows gate**. Probes 08 and beyond also feed the macOS /
Linux gate items M1–M4 once a non-Windows AE host is available.

---

## Status of each ADR gating condition (deferred — not exercised)

Per `ADR-0001-runtime-bridge.md` §Accepted conditions — Windows gate
vs macOS / Linux gate (added in this round), the gating conditions
are:

| Condition | Gate | Status this round |
|---|---|---|
| W1 `CSInterface.evalScript` returns JSON-stringified snapshot | Windows | **Deferred — not exercised** (no AE). |
| W2 `evalScript` observes in-engine mutation | Windows | **Deferred — not exercised** (no AE). |
| W3 `evalScript` propagates ExtendScript throw | Windows | **Deferred — not exercised** (no AE). |
| W4 Two `evalScript` calls serialize cleanly | Windows | **Deferred — not exercised** (no AE). |
| W5 `getCurrentApiVersion()` returns `{major, minor, micro}` numeric shape | Windows | **Deferred — not exercised** (no AE). |
| W6 Daemon reconnects after AE quit + relaunch | Windows | **Deferred — not exercised** (no AE; the daemon stub passed `node --check` only). |
| W7 Daemon survives `evalScript` failure | Windows | **Deferred — not exercised** (no AE). |
| M1 CEP 12 panel on macOS AE 25.x (Intel) loads with `PlayerDebugMode=1` | macOS / Linux | **Deferred — requires macOS hardware**. |
| M2 Apple Silicon AE 25.x loads CEP 12 panel without Rosetta | macOS / Linux | **Deferred — requires Apple Silicon hardware**. |
| M3 Linux AE availability | macOS / Linux | **N/A — AE for Linux not a product line as of 2026-09-18**. |
| M4 macOS Sequoia / Linux 6.x loopback ACL changes | macOS / Linux | **Deferred — requires macOS / Linux hardware**. |

---

## Recommendation on Accepted conditions: split into Windows gate (required for Accepted) and macOS/Linux gate (deferred)

The ADR's Accepted conditions are split as follows (also reflected
in `ADR-0001-runtime-bridge.md` §Accepted conditions — Windows gate
vs macOS / Linux gate):

- **Windows gate (W1–W7): required for Accepted.** These conditions
  can be cleared on a Windows AE instance. Once W1–W7 are observed
  on a real AE 25.x, the ADR may move from **Proposed** to
  **Accepted** without further platform coverage.
- **macOS / Linux gate (M1–M4): deferred beyond Accepted.** These
  conditions require macOS or Linux hardware and can be tracked as
  future work. They do **not** gate acceptance. M3 may remain
  **N/A** indefinitely if Adobe does not ship AE for Linux.

This split is necessary because:

1. The user explicitly requested **minimal real-AE validation**, and
   this environment cannot deliver it for any platform.
2. **Holding the ADR at Proposed indefinitely** would conflate
   "no AE was available" with "the architecture is unsound". The
   source-quality corrections in `research/corrections-01` and
   `research/corrections-02` improved, not weakened, the
   evidence base for the ADR.
3. **The Windows gate is the binding gate for v1.** The M1 + M3
   path runs on Windows AE; macOS / Linux gate items are about
   the second-platform story, which is a separate concern.

**Operational consequence**: a future round that has access to a
Windows AE 25.x instance can run Probes 01–10 (and the future
"daemon reconnect" probe), fill in the Actual sections of
`EXPERIMENT-LOG.md`, and promote `ADR-0001-runtime-bridge.md` to
**Accepted** without any macOS / Linux coverage.

---

## Cross-references

- `ADR-0001-runtime-bridge.md` §Accepted conditions — Windows gate
  vs macOS / Linux gate (the policy decision; this record is the
  evidence log).
- `research/corrections-01-adobe-cep-org.md` and
  `research/corrections-02-cep-ae-mapping.md` — the source-of-truth
  corrections applied this round (executed without AE).
- `experiments/runtime-bridge/EXPERIMENT-LOG.md` — per-probe
  Purpose / Environment / Procedure / Expected / Actual / Result /
  Evidence / Limitations; Actual sections all read "Not executed"
  for AE-required probes.
- `AGENTS.md` §5 — the rule that this validation record honors by
  not marking anything as validated that was not executed on a real AE.
