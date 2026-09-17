# CEP / AE Version Mapping: Factual Correction

> Status: **Open correction.** Applies to `/home/basic/work/ae-devtools/docs/architecture/research/02-cep-deep-dive.md` (and any downstream ADR/experiment that reused its version table).
> Author: corrections pass, 2026-09-18.
> Scope: the per-fiscal-year mapping of After Effects major versions to the CEP engine version Adobe ships with them, plus the canonical runtime API for self-detection.

## What the prior research claimed

`02-cep-deep-dive.md` presents the following mapping (verbatim, lines 21-25):

| Calendar year | AE major | CEP engine |
|---------------|----------|------------|
| 2022          | 22.x     | CEP 11     |
| 2023          | 23.x     | CEP 11     |
| 2024          | 24.x     | CEP 12     |
| 2025          | 25.x     | CEP 12     |
| 2026          | 26.x     | CEP 12 (no 13 confirmed at time of research) |

The text immediately below the table states:

> Adobe's `CEP 12 HTML Extension Cookbook` lists `AEFT 25.0` as the After Effects host that integrates CEP 12. There is **no CEP 13 release** for any After Effects […].

Two factual problems with this block:

1. The Cookbook table does **not** list AE 24.x → CEP 12. It jumps directly from `18.4 (CEP 11)` in the FY2021 column to `25.0 (CEP 12)` in the FY2024 column. The mapping AE 24.x → CEP 12 is asserted but not directly evidenced in the cited primary source.
2. The Cookbook table also does **not** list AE 22.x or AE 23.x. The AE-22/23 → CEP 11 entries were inferred (plausible, but unverified against the cited source).

This correction restates what the primary source actually proves, what can be supported only by community reports, and what remains undocumented.

## What the CEP 12 Cookbook actually says (quote)

Source: `Adobe-CEP/CEP-Resources`, `CEP_12.x/Documentation/CEP 12 HTML Extension Cookbook.md`. Fetched 2026-09-18.
URLs: <https://github.com/Adobe-CEP/CEP-Resources/blob/master/CEP_12.x/Documentation/CEP%2012%20HTML%20Extension%20Cookbook.md> and the raw view <https://raw.githubusercontent.com/Adobe-CEP/CEP-Resources/master/CEP_12.x/Documentation/CEP%2012%20HTML%20Extension%20Cookbook.md>.

Verbatim "Applications Integrated with CEP" table (all rows, all columns):

| Application   | Host ID | CC 2019 Version | CC 2020 Version | FY 2020       | FY2021       | FY2024        |
|---------------|---------|-----------------|-----------------|---------------|--------------|---------------|
| Photoshop     | PHSP/PHXS | 20 (CEP 9)    | 21 (CEP 9)      | 22.0 (CEP 10) | 23.0 (CEP 11)| 25.12 (CEP 12)|
| InDesign      | IDSN    | 14 (CEP 9)      | 15 (CEP 9)      | 16.0 (CEP 10) | 16.3 (CEP 11)| 20.4          |
| InCopy        | AICY    | 14 (CEP 9)      | 15 (CEP 9)      | 16.0 (CEP 10) | 16.3 (CEP 11)| TBD           |
| Illustrator   | ILST    | 23 (CEP 9)      | 24 (CEP 9)      | 25.0 (CEP 10) | 25.3 (CEP 11)| 29.5.1 (CEP 12)|
| Premiere Pro  | PPRO    | 13 (CEP 9)      | 14 (CEP 9)      | 14.4 (CEP 10) | 15.4 (CEP 11)| 25.0 (CEP 12) |
| Prelude       | PRLD    | 8 (CEP 9)       | 9 (CEP 9)       | 10.0 (CEP 10) | 10.1 (CEP 11)| TBD           |
| **After Effects** | **AEFT** | **16 (CEP 9)** | **17 (CEP 9)** | **17.1.4 (CEP 10)** | **18.4 (CEP 11)** | **25.0 (CEP 12)** |
| Animate       | FLPR    | 19 (CEP 9)      | 20 (CEP 9)      | 21.0 (CEP 10) | 22.0 (CEP 11)| TBD           |
| Audition      | AUDT    | 12 (CEP 9)      | 13 (CEP 9)      | 13.0.10 (CEP 10)| 14.4 (CEP 11)| 25.0 (CEP 12)|
| Dreamweaver   | DRWV    | 19 (CEP 9)      | 20 (CEP 9)      | 21.0 (CEP 10) | 21.2.0 (CEP 11)| TBD         |
| Bridge        | KBRG    | 9 (CEP 9)       | 10 (CEP 9)      | 11.0 (CEP 10) | 12.0 (CEP 11)| TBD           |
| Rush          | RUSH    | 1 (CEP 9)       | 1.2.1 (CEP 9)   | 1.5.29 (CEP 10)| 2.1 (CEP 11)| TBD           |

Critical observations from the table as published:

- The table columns are **fiscal years**, not calendar years. Adobe FY2021 corresponds to the FY ending late 2021 (i.e. AE released ~Oct 2020 to Oct 2021). FY2024 in this table corresponds to the FY ending late 2024.
- The After Effects row has entries for CC 2019, CC 2020, FY2020, FY2021, and FY2024. **There is no FY2022, FY2023, or any AE-22.x / 23.x / 24.x cell.**
- The Cookbook does not list AE 23.x or AE 24.x. The next AE row after 18.4 is 25.0.

Therefore the only Cookbook-confirmed AE → CEP claims are:

- AE 16 (CC 2019) → CEP 9.
- AE 17 (CC 2020) → CEP 9.
- AE 17.1.4 (FY2020) → CEP 10.
- AE 18.4 (FY2021) → CEP 11.
- AE 25.0 (FY2024) → CEP 12.

Everything between AE 18.4 and AE 25.0 (i.e. AE 22.x, 23.x, 24.x) is a gap in the Cookbook table.

## AE 24.x CEP version (evidence verdict)

**Verdict: NOT confirmed by Adobe primary source.** The CEP 12 Cookbook contains no AE 24.x row. The prior research's claim "AE 24.x → CEP 12" must be downgraded.

Supporting evidence and counter-evidence:

- **Adobe official (CEP 12 Cookbook):** silent on AE 24.x. The FY2024 column shows AE 25.0, not AE 24.x.
- **Adobe official (CEP 11.1 Cookbook, `CEP_11.x/Documentation/CEP 11.1 HTML Extension Cookbook.md`):** last AE row is also 18.4 (CEP 11) in FY2021. There is no CEP 11.1 row that adds AE 23.x or AE 24.x. Fetched 2026-09-18.
- **Community attribution:** `elevenpercent.net` AutoEdit help docs (fetched 2026-09-18) states "enable debugging for CEP 11 (2024) or CEP 12 (2025)". This is the strongest community signal that **AE 2024 (= 24.x) ships with CEP 11** and **AE 2025 (= 25.x) ships with CEP 12**. But this is a single vendor's documentation, not a primary source, and the same vendor has not formally published its evidence chain.
- **Reddit / community (paraphrased via search snippets, 2026-09-18):** a thread about an AE 2026 extension describes "two flags in `CSXS/manifest.xml` break CEP 12" — implying a CEP 11 → CEP 12 transition that aligns with AE 24.x → 25.x but does not directly say so.

Working hypothesis consistent with all evidence: **AE 24.x (2024) ships CEP 11; AE 25.x (2025) ships CEP 12.** This is the most plausible reading because:

1. The Cookbook FY2024 row lists AE 25.0, which strongly implies FY2024 is the year Adobe integrated CEP 12 into AE.
2. AE 24.x was a 2023–2024 release line; if CEP 12 had already been integrated, the Cookbook would presumably have listed a FY2023 row for AE 24.x. Its absence suggests AE 24.x is on CEP 11 (continuing from AE 18.4 → AE 24.x → CEP 11).

Until an Adobe primary source confirms this, the table should read **"AE 24.x → CEP 11 (community-attributed, not Cookbook-confirmed)"** rather than "CEP 12".

## Other AE versions (evidence verdict)

- **AE 22.x (2022) → CEP 11**: Cookbook-confirmed only in the sense that AE 18.4 → CEP 11 is the last Cookbook entry, and AE 22.x inherits. No explicit row. Plausible; same gap as AE 23/24.
- **AE 23.x (2023) → CEP 11**: same as 22.x. Inferred from the FY2021 entry plus absence of an earlier FY entry.
- **AE 25.x (2025) → CEP 12**: **Cookbook-confirmed.** Direct primary-source quote: `25.0 (CEP 12)` in FY2024.
- **AE 26.x (2025/2026) → CEP 12**: **not Cookbook-listed.** No Adobe primary source consulted during this correction pass lists AE 26.x. AE 26.x is a real product line (AE 26.x system-requirements page exists at `helpx.adobe.com/ca/after-effects/system-requirements/`); whether it ships CEP 12 or a future CEP 13 is **undocumented in the materials examined here**. The prior research's "CEP 12 (no 13 confirmed at time of research)" is consistent with the evidence but should be qualified with "undocumented" rather than "no 13 confirmed".

For the AE 22.x / 23.x rows the safer statement is: **"Not listed in the CEP 12 Cookbook; consistent with CEP 11 continuation from AE 18.4."** Do not assert "CEP 11" as Cookbook-confirmed for those rows — they are not in the table.

## CSInterface.getCurrentApiVersion() behavior (signature, return type, encoding)

Source: `Adobe-CEP/CEP-Resources`, `CEP_12.x/CSInterface.js` (header version `CSInterface - v12.0.0`). Fetched 2026-09-18.
URL: <https://raw.githubusercontent.com/Adobe-CEP/CEP-Resources/master/CEP_12.x/CSInterface.js>.

**Signature (verbatim from the file):**

```javascript
/**
 * Retrieves current API version.
 *
 * Since 4.2.0
 *
 * @return ApiVersion object.
 *
 */
CSInterface.prototype.getCurrentApiVersion = function()
{
    var apiVersion = JSON.parse(window.__adobe_cep__.getCurrentApiVersion());
    return apiVersion;
};
```

**Underlying native call:** `window.__adobe_cep__.getCurrentApiVersion()` — a host-injected function. Its return is a **JSON-encoded string** that the CSInterface wrapper parses into an object. The native side does not return a number.

**Return type:** an `ApiVersion` instance, defined as:

```javascript
/**
 * @class ApiVersion
 * Stores current api version.
 *
 * Since 4.2.0
 * @param major The major version.
 * @param minor The minor version.
 * @param micro The micro version.
 * @return ApiVersion object.
 */
function ApiVersion(major, minor, micro)
{
    this.major = major;
    this.minor = minor;
    this.micro = micro;
}
```

**Concrete example:** for a CEP 12 host the call returns `{major: 12, minor: 0, micro: 0}`. For CEP 11 it would return `{major: 11, minor: 1, micro: 0}` (or whatever the host's CEP build is). **The encoding is three numeric fields on an object, not a string like `"12.0"` and not a single number.**

**Correct usage for self-detection:**

```javascript
var cs = new CSInterface();
var v = cs.getCurrentApiVersion();   // {major: 12, minor: 0, micro: 0}
if (v && v.major >= 12) { /* CEP 12+ feature path */ }
```

**Important caveats from the CSInterface 11.1 Cookbook (verbatim, fetched 2026-09-18):**

> Use `CSInterface.getCurrentApiVersion()` to retrieve the version of CEP integrated by the Adobe Product. Please note this API itself is available only since 4.2.0. If you get an error saying `getCurrentApiVersion` is undefined, then you are running in CEP 4.0 or 4.1.

So feature-gating on `getCurrentApiVersion()` itself is only safe on CEP 4.2+. On CEP 4.0/4.1 the call does not exist; extensions targeting those hosts must use `manifest.xml` `RequiredRuntime` instead.

**No `VERSION_11` / `VERSION_12` constants on `CSInterface`.** Multiple passes through the current `CSInterface.js` (v12.0.0) and the community TypeScript port `csinterface-ts@1.0.3` show **no** `VERSION_11` or `VERSION_12` constants on the prototype or class. The only version-related identifier in the file header is the library's own version string `CSInterface - v12.0.0`. Snippet searches of older blog posts sometimes reference `CSInterface.VERSION_11` as a shorthand, but it is not defined in the current shipped source. Do not use it; compare against `apiVersion.major` directly.

## Documents that need correction

- `/home/basic/work/ae-devtools/docs/architecture/research/02-cep-deep-dive.md` lines 21-25 and surrounding prose — the AE 24.x → CEP 12 row must be re-graded to "community-attributed, not Cookbook-confirmed"; the AE 22.x / 23.x → CEP 11 rows must be re-graded to "not Cookbook-listed, inferred from FY2021 baseline".
- Any ADR that cited 02-cep-deep-dive.md for its CEP engine target (search for `CEP 12` in `docs/architecture/adr/` and `docs/architecture/experiment/`).
- Any experiment that hard-coded `CSInterface.VERSION_12` style constants — replace with `apiVersion.major` comparison.

## Evidence (URL — date)

- `Adobe-CEP/CEP-Resources` CEP 12 HTML Extension Cookbook (full table quoted above) — <https://github.com/Adobe-CEP/CEP-Resources/blob/master/CEP_12.x/Documentation/CEP%2012%20HTML%20Extension%20Cookbook.md> — 2026-09-18.
- `Adobe-CEP/CEP-Resources` CEP 12 CSInterface.js (v12.0.0; `getCurrentApiVersion` and `ApiVersion` quoted above) — <https://raw.githubusercontent.com/Adobe-CEP/CEP-Resources/master/CEP_12.x/CSInterface.js> — 2026-09-18.
- `Adobe-CEP/CEP-Resources` CEP 11.1 HTML Extension Cookbook (`getCurrentApiVersion` quote, AE row 18.4 CEP 11) — <https://github.com/Adobe-CEP/CEP-Resources/blob/master/CEP_11.x/Documentation/CEP%2011.1%20HTML%20Extension%20Cookbook.md> — 2026-09-18.
- `elevenpercent.net` AutoEdit help docs ("enable debugging for CEP 11 (2024) or CEP 12 (2025)") — <https://elevenpercent.net/pages/autoedit%E2%84%A2-help-docs> — 2026-09-18. (Third-party; the only third-party attribution directly tying AE 24.x → CEP 11 found in this pass.)
- `ae-plugins.docsforadobe.dev` "Other Integration Possibilities" (HTML5 panels supported since CC 2014, no CEP version info) — <https://ae-plugins.docsforadobe.dev/intro/other-integration-possibilities/> — 2026-09-18.

## Unverified items

1. **AE 24.x → CEP 11 (or CEP 12).** No Adobe primary source lists AE 24.x at all. The strongest evidence (AutoEdit docs) attributes CEP 11 to AE 2024. Until Adobe publishes a CEP 11.x or CEP 12.x cookbook that includes an AE 24.x row, this row remains **community-attributed**.
2. **AE 26.x CEP version.** No Adobe primary source consulted here lists AE 26.x. AE 26.x is a real product line, but its CEP engine version is undocumented in the materials fetched. Do not state "AE 26.x → CEP 12" as confirmed.
3. **CEP 13 existence.** No evidence of CEP 13 in any source consulted. The prior research's "no CEP 13 confirmed" is consistent with the evidence but should be phrased as "no CEP 13 evidence found" rather than as a definitive negative.
4. **`CSInterface.VERSION_11` / `VERSION_12` constants.** Not present in the current `CSInterface.js` (v12.0.0). If any project code references them, it is referring either to a non-shipped variant, an older bundled CSInterface, or a misremembered API. Compare against `apiVersion.major` directly.
5. **CEP 12 row for AE 25.x in FY2024 — calendar mapping.** The Cookbook column header says FY2024, which Adobe defines as the fiscal year ending ~Nov 2024. AE 25.0 was released **October 2024** (per CGChannel, <https://www.cgchannel.com/2024/10/adobe-releases-after-effects-25-0/>, 2026-09-18). So "AE 25.x → CEP 12" lines up with both the Cookbook FY2024 column and the Oct-2024 release. This is **confirmed**, but flagged here because prior research mixes "FY2024" and "2025" labels and the distinction matters for downstream calendar-year documentation.
