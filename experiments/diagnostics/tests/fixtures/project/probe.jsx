(function () {
    // lib/greet.ts
    function greet(name) {
        return "hello " + name;
    }
    var VERSION = "1.2.3";
    // lib/format.ts
    function formatReport(title, items) {
        var out = "# " + title + "\n";
        for (var i = 0; i < items.length; i++) {
            out += "- " + items[i] + "\n";
        }
        return out;
    }
    // main.ts
    var msg = greet("ae") + " v" + VERSION;
    var report = formatReport("probe", [msg, "second"]);
    $.global.__toolchainProject = report;
})();
//# sourceMappingURL=probe.bundle.js.map