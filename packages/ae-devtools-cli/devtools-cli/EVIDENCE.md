# EVIDENCE — devtools-cli real-host runs

Artifacts in `evidence/` are `ae-devtools.cli.run/v1` / `ae-devtools.cli.error/v1`
records produced by `devtools-cli/cli.mjs --out`. The attached-session (#366)
follow-up section moved here from `../a8n-transport/EVIDENCE.md` because those
artifacts are CLI run records, not `a8n-transport/real-run` records.

## Issue #366 follow-up — attach pre-flight + project pin + comp/layer loop (macOS, AE 2027 `27.0x78`)

Branch `366` @ `9e9f5d4`+ (pre-flight census, `ATTACHED_TARGET_AMBIGUOUS`,
`--project-file` / `ae-devtools.attachedProjectFile` pin, Project-handle
read fix). All runs `--ae-a8n-root` = local ae-a8n `release-0-5-0` @
`50e712b`; every session reports `ownership: "attached"`,
`evidenceLevel: verified on real host (attach to a running AE)`,
`policy.readOnly` or scoped `mutation.allowedOps`; `cleanup.quit` is
always `null` (the host is never quit).

- `run-366-attached-preflight-norun-2027.json` — **pre-flight refuse, no
  launch**: with zero AE processes the opener refuses
  `ATTACHED_TARGET_NOT_RUNNING` in ~0.4 s. No `AfterEffects.launch`,
  no cold start, no quit (previously this path cold-started AE and then
  closed it).
- `run-366-attached-verify-2027.json` — read-only attach verify on a
  user-launched AE 2027 (pid 22873): `read.projectSummary` COMPLETED,
  `target.ownershipEvidence` = `already running before launch: pid
  22873`, install dir + app path recorded.
- Comp/layer lifecycle on the attached host (each op its own attached
  session, explicit `--allow-mutation` scope + `--consent grant`):
  `project.new` → `item.addComp` (Comp1 1920x1080@30) →
  `comp.addNullLayer` ("Null 1") → `read.compLayers` shows the layer →
  `layer.setTransformPosition` x=100 y=200 → `read.layerDetail`
  read-back `position: [100,200,0]` → `project.save`
  `/tmp/ae-att-test.aep` → `project.open` of that file →
  `read.projectSummary` on the reopened project (3 items).
- `run-366-attached-projectpin-2027.json` — `--project-file
  /tmp/ae-att-test.aep` matches the open project (`target.project.file`
  recorded, verify COMPLETED); `--project-file` pointing elsewhere
  refuses `ATTACHED_TARGET_MISMATCH` before dispatch.
- Real-host bug found and fixed by this evidence: `ae.project()` is
  async and resolves to a `Project` handle — the previous
  `ae.project().info()` read was always `null` on real hosts (the
  fixture's sync stub masked it). Every attached session's
  `target.project` was silently null until `9e9f5d4`.

Not yet covered here: Windows comp/layer loop, MCP/VSCode surfaces on a
real attached session, multi-instance ambiguity on a real host (unit
tested only).
