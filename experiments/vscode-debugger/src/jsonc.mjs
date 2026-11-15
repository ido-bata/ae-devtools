/**
 * jsonc.mjs — safe JSONC read/update for `.vscode/launch.json`
 * (Issue #53).
 *
 * launch.json is JSONC: comments and trailing commas are legal, and
 * users keep arbitrary settings in it. Two rules:
 *
 *   1. NEVER strip comments with regex — `//` inside a string literal
 *      is not a comment. Parsing is delegated to `jsonc-parser`, a
 *      real JSONC tokenizer.
 *   2. NEVER re-serialize the whole document — that would drop user
 *      comments, reformat foreign configs, and reorder keys. Updates
 *      are surgical `modify`/`applyEdits` on the `configurations`
 *      array only; every other byte of the file is preserved.
 */
import {
  parse, parseTree, modify, applyEdits,
  getNodeValue, printParseErrorCode,
} from "jsonc-parser";

export { printParseErrorCode };

export const JSONC_PARSE_OPTIONS = {
  allowTrailingComma: true,
  disallowComments: false,
};

/**
 * Parse JSONC text. Returns { value, errors } — errors are jsonc-parser
 * error objects (empty = clean parse). `value` is the JS value even
 * when errors exist, so callers decide whether partial data is usable.
 */
export function parseJsonc(text) {
  const errors = [];
  const value = parse(text, errors, JSONC_PARSE_OPTIONS);
  return { value, errors };
}

function describeErrors(errors) {
  return errors.slice(0, 5).map((e) =>
    `${printParseErrorCode(e.error)} at offset ${e.offset}`).join("; ");
}

/**
 * Upsert one launch configuration into JSONC text, preserving all
 * comments/formatting outside the edited `configurations` segment.
 *
 * Returns { text, value, changed } where `value` is the post-edit
 * document value (for validation) and `text` the post-edit source.
 * Throws when the existing file is not parseable JSONC — we refuse to
 * clobber a file we cannot understand.
 */
export function upsertLaunchConfig(text, config) {
  const tree = parseTree(text, [], JSONC_PARSE_OPTIONS);
  const scanErrors = [];
  parse(text, scanErrors, JSONC_PARSE_OPTIONS);
  if (scanErrors.length > 0) {
    throw new Error(`existing launch.json is not parseable JSONC — refusing to overwrite: ${describeErrors(scanErrors)}`);
  }
  if (!tree || typeof tree !== "object" || Array.isArray(tree)) {
    throw new Error("existing launch.json root is not an object — refusing to overwrite");
  }

  const formatting = { formattingOptions: { insertSpaces: true, tabSize: 2 } };
  let edits = [];

  // Ensure top-level version is "0.2.0" when absent; a *different*
  // existing value is left alone and reported by validation instead.
  const versionNode = tree.children?.find((c) => c.type === "property" && getNodeValue(c.children?.[0]) === "version");
  if (!versionNode) {
    edits.push(...modify(text, ["version"], "0.2.0", formatting));
  }

  const configsNode = tree.children?.find((c) => c.type === "property" && getNodeValue(c.children?.[0]) === "configurations");
  const arrayNode = configsNode?.children?.find((c) => c.type === "array");
  const isArray = !!arrayNode;

  if (!isArray) {
    // No usable configurations array — create/replace it wholesale.
    // (A non-array `configurations` is already a validation error we
    // report; replacing it is the only way to produce a working file.)
    edits.push(...modify(text, ["configurations"], [config], formatting));
  } else {
    // Array children are value nodes only (no punctuation nodes), so
    // child index === array index — required for `modify` pathing.
    const elements = arrayNode.children ?? [];
    let idx = -1;
    elements.forEach((el, i) => {
      const v = getNodeValue(el);
      if (v && typeof v === "object" && !Array.isArray(v) && v.name === config.name) idx = i;
    });
    if (idx >= 0) {
      edits.push(...modify(text, ["configurations", idx], config, formatting));
    } else {
      edits.push(...modify(text, ["configurations", -1], config, formatting));
    }
  }

  const next = applyEdits(text, edits);
  const { value, errors } = parseJsonc(next);
  if (errors.length > 0) {
    // Our own edit broke the document — surface, never write.
    throw new Error(`internal error: edited launch.json failed to reparse: ${describeErrors(errors)}`);
  }
  return { text: next, value, changed: edits.length > 0 };
}
