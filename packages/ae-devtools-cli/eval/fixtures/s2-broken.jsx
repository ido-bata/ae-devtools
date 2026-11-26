// s2-broken.jsx — seeded-bug fixture for scenario S2 (script error).
//
// Intended behaviour: collect layer names of the first item and return
// them as a JSON array. The bug is deliberate: `comp` is null when the
// project has no items, and the code dereferences it anyway — a
// host-side TypeError with a real source position, exactly the class
// of failure a user script hits in the field.
//
// ES3 only (ExtendScript host).
(function () {
  var project = app.project;
  var comp = project.items.length > 0 ? project.items[1] : null;
  // BUG: comp may be null; no guard before dereference.
  var names = [];
  for (var j = 1; j <= comp.numLayers; j++) {
    names.push(String(comp.layer(j).name));
  }
  return JSON.stringify(names);
})();
