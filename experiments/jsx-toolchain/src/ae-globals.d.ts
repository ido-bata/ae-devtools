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
 */

declare const app: AeApp;
declare const system: AeSystem;
declare const $: {
  global: any;
  evalFile: (path: string) => any;
  bp: () => void;
  [key: string]: any;
};

interface AeApp {
  version: string;
  name: string;
  project: AeProject;
  /** most-recently-used / active item accessors vary by version — any until pinned */
  [key: string]: any;
}

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

interface AeSystem {
  osName: string;
  [key: string]: any;
}
