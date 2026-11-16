import { greet, VERSION } from "./lib/greet";
import { formatReport } from "./lib/format";

const msg: string = greet("ae") + " v" + VERSION;
const report: string = formatReport("probe", [msg, "second"]);
$.global.__toolchainProject = report;
