/**
 * ae-globals.d.ts — PARTIAL ambient declarations for After Effects
 * ExtendScript (Issue #52).
 *
 * Generated surface is intentionally small: the scripting inventory
 * (inventories/scripting/generated/symbols.json) records 656 symbols but
 * almost no signatures, so this file declares the common entry points
 * with `any`-typed members. It exists so `check` can catch real user-code
 * type errors and give *some* AE-API typo protection on declared members.
 * It is NOT a complete API surface — absence of a member here does not
 * mean the API lacks it.
 *
 * TODO(#52-followup): generate fuller declarations once signature data is
 * extracted into the inventory.
 *
 * The `app` and `system` globals are declared ONCE, here — ae-api.d.ts
 * (generated) provides the `AeAppApi`/`System` types and this file
 * layers the hand-maintained shapes on top via interface `extends`.
 * Do not redeclare the consts in ae-api.d.ts (TS2451/TS2403).
 *
 * Issue #97 additions: ExtendScript host objects File/Folder
 * (declarations modeled on types-for-adobe@7.2.6 shared/JavaScript.d.ts,
 * MIT — the same provenance as scriptui.d.ts), and the `PREFType`
 * enum used by `app.preferences`/`app.settings` (values per the After
 * Effects Scripting Guide, Preferences object —
 * ae-scripting.docsforadobe.dev). Members not listed fall through
 * `[key: string]: any`; absence of a member here is not proof the host
 * lacks it.
 *
 * LIB CONSTRAINT: like scriptui.d.ts, the bare `File`/`Folder`/`type`
 * aliases below collide with `lib.dom.d.ts`. These ambient files are
 * meant for ExtendScript checking where the DOM lib must NOT be
 * loaded — check.mjs pins `lib: ["lib.es5.d.ts"]`. Consumers including
 * them in their own tsconfig must do the same.
 */

// `app` is the Application singleton. AeAppApi (generated) already
// carries every inventory member; this interface only narrows the
// hand-maintained high-traffic ones. No index signature — unknown
// members stay type errors, same as the generated surface.
interface AeApp extends AeAppApi {
  version: string;
  name: string;
  project: AeProject;
}

declare const app: AeApp;

// `system` is the System singleton; AeSystem adds nothing the
// generated System class lacks beyond a narrower osName.
interface AeSystem extends System {
  osName: string;
}

declare const system: AeSystem;
declare const $: {
  global: any;
  evalFile: (path: string) => any;
  bp: () => void;
  [key: string]: any;
};

// ExtendScript host functions (signatures per types-for-adobe
// shared/global.d.ts / Adobe JavaScript Tools Guide).
declare function alert(message: string, title?: string, errorIcon?: boolean): void;
declare function confirm(message: string, noAsDefault?: boolean, title?: string): boolean;
declare function prompt(prompt: string, default_?: string, title?: string): string | null;

interface AeProject {
  name: string;
  path: string;
  items: AeItemArray;
  activeItem: AeItem | null;
  renderQueue: any;
  [key: string]: any;
}

interface AeItemArray {
  length: number;
  [index: number]: AeItem;
  [key: string]: any;
}

interface AeItem {
  name: string;
  typeName: string;
  id: number;
  [key: string]: any;
}

interface AeCompItem extends AeItem {
  width: number;
  height: number;
  duration: number;
  frameRate: number;
  layers: AeLayerArray;
  [key: string]: any;
}

interface AeLayerArray {
  length: number;
  [index: number]: AeLayer;
  [key: string]: any;
}

interface AeLayer {
  name: string;
  index: number;
  enabled: boolean;
  [key: string]: any;
}

// ---- ExtendScript host objects (Issue #97) ---------------------------
// File/Folder are ExtendScript built-ins, NOT AE scripting classes, so
// they are absent from the generated ae-api.d.ts. In ExtendScript both
// are callable with or without `new` (e.g. `File("a.txt")` and
// `new File("a.txt")` both work) — the call signatures below reflect
// that. check.mjs pins `lib: ["lib.es5.d.ts"]` so these do not collide with the
// DOM lib's unrelated File/Window declarations.

interface AeFile {
  name: string;
  fsName: string;
  path: string;
  exists: boolean;
  parent: AeFolder | null;
  open(mode?: string): boolean;
  close(): void;
  read(): string;
  /** ExtendScript File.write returns success as boolean. */
  write(...args: any[]): boolean;
  remove(): boolean;
  rename(newName: string): boolean;
  copy(target: string | AeFile): AeFile | null;
  move(target: string | AeFile): AeFile | null;
  created: Date;
  modified: Date;
  [key: string]: any;
}

interface AeFileConstructor {
  new (path?: string): AeFile;
  (path?: string): AeFile;
  openDialog(...args: any[]): AeFile | AeFile[] | null;
  saveDialog(...args: any[]): AeFile | null;
  [key: string]: any;
}

declare const File: AeFileConstructor;

interface AeFolder {
  name: string;
  fsName: string;
  path: string;
  exists: boolean;
  parent: AeFolder | null;
  create(): boolean;
  remove(): boolean;
  rename(newName: string): boolean;
  // getFiles() returns ONE array that may mix File and Folder entries —
  // a single array of the union, not a union of homogeneous arrays.
  getFiles(...args: any[]): (AeFile | AeFolder)[];
  [key: string]: any;
}

interface AeFolderConstructor {
  new (path?: string): AeFolder;
  (path?: string): AeFolder;
  /** well-known folder locations; all return Folder */
  userData: AeFolder;
  appData: AeFolder;
  appDataFull: AeFolder;
  commonFiles: AeFolder;
  myDocuments: AeFolder;
  desktop: AeFolder;
  temp: AeFolder;
  startup: AeFolder;
  system: AeFolder;
  [key: string]: any;
}

declare const Folder: AeFolderConstructor;

// Consumers annotate with the bare names (`folder: Folder`); the value
// side is the constructor const above, the type side is these aliases.
type File = AeFile;
type Folder = AeFolder;

/**
 * `PREFType` — which preferences file a `Preferences`/`Settings` call
 * targets (AE Scripting Guide, Preferences object; numeric values per
 * the scripting dictionary as recorded by types-for-adobe).
 */
declare enum PREFType {
  PREF_Type_MACHINE_SPECIFIC = 8812,
  PREF_Type_MACHINE_INDEPENDENT = 8813,
  PREF_Type_MACHINE_INDEPENDENT_RENDER = 8814,
  PREF_Type_MACHINE_INDEPENDENT_OUTPUT = 8815,
  PREF_Type_MACHINE_INDEPENDENT_COMPOSITION = 8816,
  PREF_Type_MACHINE_SPECIFIC_TEXT = 8817,
  PREF_Type_MACHINE_SPECIFIC_PAINT = 8818,
}
