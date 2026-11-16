// Uses ES5+ builtins that do not exist in ExtendScript ES3.
var names: string[] = ["a", "b"];
names.forEach(function (n) { $.global[n] = n; });
var keys = Object.keys($.global);
var payload = JSON.stringify({ v: app.version });
