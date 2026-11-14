// mutating-clean.jsx — succeeds but mutates: adds one item per run.
// Regression-rerunning this duplicates the mutation — exactly what
// assumeIdempotent + stateFingerprint must detect.
var it = app.project.items.add({ name: "regression-item" });
return it.name;
