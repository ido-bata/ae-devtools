(() => {
  // lib/greet.ts
  function greet(name) {
    return "hello " + name;
  }
  var VERSION = "1.2.3";

  // lib/format.ts
  function formatReport(title, items) {
    let out = "# " + title + "\n";
    for (let i = 0; i < items.length; i++) {
      out += "- " + items[i] + "\n";
    }
    return out;
  }

  // main.ts
  var msg = greet("ae") + " v" + VERSION;
  var report = formatReport("probe", [msg, "second"]);
  $.global.__toolchainProject = report;
})();
