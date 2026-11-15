// mutate-then-fail.jsx — adds an item, THEN throws: partial mutation
// persists in the fake host even though the script FAILED.
var it = app.project.items.add({ name: "partial" });
throw new Error("boom after mutation");
