import { makeReporter } from "./lib";

var r = makeReporter("helpers");
$.global.__toolchainHelpers = r.describe();
