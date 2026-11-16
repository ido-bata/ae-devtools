// clean.jsx — regression fixture: must complete on first dispatch.
var f = app.project.items.add({ name: "take" });
f.name = "final";
return f.name;
