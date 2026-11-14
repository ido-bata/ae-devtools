import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  install, uninstall, status, cleanup, collectLogs,
  cepExtensionsDir, cepLogDir, OWNED_MARKER, MANIFEST_PATH,
} from "../lifecycle.mjs";

const EXT_ID = "com.example.test-panel";

async function makeExt(name = EXT_ID) {
  const dir = await mkdtemp(join(tmpdir(), "cep-ext-"));
  await mkdir(join(dir, "CSXS"), { recursive: true });
  await mkdir(join(dir, "js"), { recursive: true });
  await writeFile(join(dir, MANIFEST_PATH),
    `<?xml version="1.0"?><ExtensionList><Extension Id="${name}"><DispatchInfoList/></Extension></ExtensionList>`);
  await writeFile(join(dir, "js", "main.js"), "// panel\n");
  await writeFile(join(dir, "index.html"), "<html></html>\n");
  return dir;
}

async function makeTarget() {
  return mkdtemp(join(tmpdir(), "cep-target-"));
}

test("platform dirs: darwin/win32 paths, others refused", () => {
  assert.match(cepExtensionsDir({ platform: "darwin", home: "/h" }), /Library.*CEP.*extensions$/);
  assert.match(cepExtensionsDir({ platform: "win32", appData: "C:\\AppData\\Roaming" }), /CEP.*extensions$/);
  assert.throws(() => cepExtensionsDir({ platform: "linux" }), /unsupported/);
  assert.match(cepLogDir({ platform: "darwin", home: "/h" }), /Library.*Logs.*CSXS$/);
});

test("install → status → idempotent reinstall → drift reinstall", async () => {
  const src = await makeExt();
  const target = await makeTarget();
  const r1 = await install({ sourceDir: src, targetDir: target });
  assert.equal(r1.status, "installed");
  assert.equal(r1.dest, join(target, EXT_ID));

  const st = await status({ extensionId: EXT_ID, targetDir: target, sourceDir: src });
  assert.equal(st.status, "installed-owned");
  assert.equal(st.drift, "none");

  const r2 = await install({ sourceDir: src, targetDir: target });
  assert.equal(r2.status, "already-installed");

  // drift: modify source, reinstall replaces owned content
  await writeFile(join(src, "js", "main.js"), "// changed\n");
  const r3 = await install({ sourceDir: src, targetDir: target });
  assert.equal(r3.status, "reinstalled-drift");
  assert.equal(await readFile(join(target, EXT_ID, "js", "main.js"), "utf8"), "// changed\n");
});

test("refuses foreign dirs; uninstall only removes owned; cleanup preserves foreign", async () => {
  const src = await makeExt();
  const target = await makeTarget();
  // foreign dir with same id, no marker
  await mkdir(join(target, EXT_ID), { recursive: true });
  await writeFile(join(target, EXT_ID, "keep.txt"), "not ours\n");
  await assert.rejects(() => install({ sourceDir: src, targetDir: target }), /unowned/);
  await assert.rejects(() => uninstall({ extensionId: EXT_ID, targetDir: target }), /unowned/);

  // a different foreign extension survives cleanup
  await mkdir(join(target, "com.other.panel"), { recursive: true });
  const c = await cleanup({ targetDir: target });
  assert.deepEqual(c.foreign.sort(), [EXT_ID, "com.other.panel"].sort());
  assert.equal(c.removed.length, 0);
});

test("uninstall removes owned; absent is idempotent; cleanup removes only owned", async () => {
  const src = await makeExt();
  const target = await makeTarget();
  await install({ sourceDir: src, targetDir: target });
  const u = await uninstall({ extensionId: EXT_ID, targetDir: target });
  assert.equal(u.status, "removed");
  const u2 = await uninstall({ extensionId: EXT_ID, targetDir: target });
  assert.equal(u2.status, "absent");

  await install({ sourceDir: src, targetDir: target });
  await mkdir(join(target, "com.foreign.x"), { recursive: true });
  const c = await cleanup({ targetDir: target });
  assert.deepEqual(c.removed, [EXT_ID]);
  assert.deepEqual(c.foreign, ["com.foreign.x"]);
});

test("manifest Id mismatch and missing manifest refuse", async () => {
  const src = await makeExt("com.example.real-id");
  const target = await makeTarget();
  await assert.rejects(
    () => install({ sourceDir: src, extensionId: "com.example.wrong", targetDir: target }),
    /manifest Extension Id/);
  const bad = await mkdtemp(join(tmpdir(), "cep-bad-"));
  await assert.rejects(() => install({ sourceDir: bad, targetDir: target }), /ENOENT|manifest/);
});

test("collectLogs lists CEPHtmlEngine logs with sizes; empty dir ok", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cep-logs-"));
  await writeFile(join(dir, "CEPHtmlEngine12-AEFT-26.5.3-abc.log"), "x".repeat(100));
  await writeFile(join(dir, "other.log"), "no");
  const r = await collectLogs({ logDir: dir });
  assert.equal(r.logs.length, 1);
  assert.equal(r.logs[0].bytes, 100);
  const empty = await collectLogs({ logDir: join(dir, "nope") });
  assert.deepEqual(empty.logs, []);
});
