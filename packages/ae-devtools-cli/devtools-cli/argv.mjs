/**
 * argv.mjs — shared `--flag` argv parsing for the shipped CLIs
 * (Issue #197).
 *
 * One parser replaces the hand-rolled copies that had drifted across
 * devtools-cli, mcp-server, recovery-orchestrator, cep-lifecycle and
 * vscode-debugger. Semantics (the devtools-cli original, now canonical):
 *
 *   --flag value    — value is the next token unless it starts with "--"
 *   --flag=value    — inline value, may be empty
 *   --flag          — boolean true when no value follows
 *   anything else   — positional
 *
 * Single-dash options (`-o`) are NOT handled here — jsx-toolchain's
 * `-o <dir>` operand-skipping logic stays local to its cli.mjs.
 *
 * `arg(flag, argv)` is the drop-in for the real-run drivers' `arg()`
 * helpers: it returns the flag's STRING value or undefined. A bare
 * boolean flag yields undefined (callers that need presence use
 * hasFlag). This deliberately differs from the old indexOf helpers,
 * which returned the next token even when it was another flag —
 * `--out --install-dir x` used to hand "--install-dir" to --out.
 *
 * `multi: ["key", ...]` collects repeated flags into arrays instead of
 * last-wins (recovery-orchestrator's --reports-dir/--sentry-dir).
 */
export function parseArgs(argv, { multi = [] } = {}) {
  const pos = [];
  const flags = {};
  const multiFlags = {};
  for (const key of multi) multiFlags[key] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const key = a.slice(2, eq >= 0 ? eq : undefined);
      const val = eq >= 0
        ? a.slice(eq + 1)
        : (i + 1 < argv.length && !argv[i + 1].startsWith("--") ? argv[++i] : true);
      if (Object.hasOwn(multiFlags, key)) multiFlags[key].push(val);
      else flags[key] = val;
    } else pos.push(a);
  }
  const out = { pos, flags };
  if (multi.length > 0) out.multi = multiFlags;
  return out;
}

/** Boolean presence check — `--flag` with or without a value. */
export function hasFlag(flag, argv = process.argv.slice(2)) {
  const key = flag.startsWith("--") ? flag.slice(2) : flag;
  return key in parseArgs(argv).flags;
}

/**
 * String value of `--flag` from argv (default: this process's args).
 * Returns undefined when absent or when the flag was given bare
 * (boolean) — a bare flag is not a value.
 */
export function arg(flag, argv = process.argv.slice(2)) {
  const key = flag.startsWith("--") ? flag.slice(2) : flag;
  const { flags } = parseArgs(argv);
  const v = flags[key];
  return typeof v === "string" ? v : undefined;
}
