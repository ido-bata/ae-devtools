// broken.jsx — fixture with two deliberate bugs for the fake dev loop.
// Bug 1: items.addd does not exist -> TypeError on attempt 0.
// Bug 2: f.setName does not exist -> TypeError on attempt 1 (after fix 1).
var f = app.project.items.addd({ name: "take" });
f.setName("final");
return f.name;
