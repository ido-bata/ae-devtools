/*
 * probe-dispatcher.jsx — read-only, explicitly activated AE-side probe.
 *
 * Experiment: ae-devtools #13 (CAP021-CAP024). This is a MEASUREMENT
 * HARNESS, not a transport decision (ADR-0005 Open Q1 forbids that here).
 *
 * Safety rules baked into this file (do not weaken them in re-runs):
 *   - READ-ONLY: the fixed method table below contains only reads
 *     (app.version, app.buildName, app.scriptingVersion, app.isoLanguage,
 *     $.locale, $.getenv, app.project counts, Folder/File existence checks).
 *     No project mutation, no save, no quit, no preference write, no
 *     network listener, no dynamic evaluation of caller code.
 *   - The only files it writes are <channel>/outbox/<id>.result.json
 *     (publish-by-rename, atomic) and nothing else.
 *   - There is no "run this string" method: the dispatch table is fixed.
 *   - Activation inside an AE that this experiment owns requires explicit
 *     owner consent (File > Scripts > Run Script File, or an
 *     owner-authorized DoScriptFile). It must never be installed into
 *     a Startup folder by tooling, and it must not be activated in an AE
 *     that belongs to someone's interactive work.
 *   - Requests are claimed (renamed to .claimed) BEFORE evaluation, so a
 *     host restart cannot replay an operation.
 *   - Expired or malformed requests are REFUSED, never executed.
 *
 * ES3 only: no let/const, no arrow functions, no JSON (the codec file is
 * loaded instead), no Array.prototype.forEach, no Date.toISOString.
 */
(function () {
  var root = new Folder("__PROBE_ROOT__");
  var token = "__PROBE_TOKEN__";
  var channelId = "__PROBE_CHANNEL_ID__";
  var expectedAeVersion = "__PROBE_EXPECTED_AE_VERSION__"; // may be "" (unpinned)

  var inbox = new Folder(root.fsName + "/inbox");
  var outbox = new Folder(root.fsName + "/outbox");
  if (!inbox.exists || !outbox.exists) {
    throw new Error("read-only-probe: channel folders are missing");
  }
  if ($.global.__readOnlyProbeTask !== undefined) {
    throw new Error("read-only-probe: already active; no duplicate dispatcher");
  }

  var codec = $.evalFile(new File(root.fsName + "/probe-json.js"));
  if (!codec || typeof codec.parse !== "function" ||
      typeof codec.stringify !== "function") {
    throw new Error("read-only-probe: JSON codec unavailable");
  }

  // One id per activation; the dispatcher id inside one AE session.
  var dispatchId = "disp-" + Math.floor(Math.random() * 0xffffffff).toString(16) +
    "-" + Math.floor(new Date().getTime() / 1000).toString(16);
  var sessionId = "sess-" + dispatchId;

  function readText(file) {
    file.encoding = "UTF-8";
    if (!file.open("r")) {
      throw new Error("cannot read request");
    }
    var result = file.read();
    file.close();
    return result;
  }

  function publish(name, value) {
    var part = new File(outbox.fsName + "/" + name + ".part");
    part.encoding = "UTF-8";
    if (!part.open("w")) {
      throw new Error("cannot open response temp file");
    }
    part.write(codec.stringify(value));
    part.close();
    if (!part.rename(name)) {
      // Never publish a partial response: the caller sees UNKNOWN.
      part.remove();
      throw new Error("cannot publish response atomically");
    }
  }

  // True UTC instant: getUTC* only. Local-time getters with a "Z" suffix
  // would mislabel the host clock (observed +9h drift on a JST host).
  function isoNow() {
    var d = new Date();
    function two(n) { return (n < 10 ? "0" : "") + n; }
    return d.getUTCFullYear() + "-" + two(d.getUTCMonth() + 1) + "-" +
      two(d.getUTCDate()) + "T" + two(d.getUTCHours()) + ":" +
      two(d.getUTCMinutes()) + ":" + two(d.getUTCSeconds()) + "." +
      (d.getUTCMilliseconds() < 10 ? "00" :
        (d.getUTCMilliseconds() < 100 ? "0" : "")) +
      d.getUTCMilliseconds() + "Z";
  }

  function osUserName() {
    var name = $.getenv("USER");
    if (!name) { name = $.getenv("USERNAME"); }
    if (!name) { name = $.getenv("LOGNAME"); }
    return name === undefined || name === null ? "" : String(name);
  }

  /* ---------------- read-only method table (fixed) ---------------- */

  function identityPayload() {
    var p = {
      aeVersion: String(app.version),
      aeBuildName: String(app.buildName),
      scriptingVersion: String(app.scriptingVersion),
      isoLanguage: String(app.isoLanguage),
      locale: String($.locale),
      userName: osUserName(),
      sessionId: sessionId,
      channelId: channelId,
      dispatchId: dispatchId
    };
    return p;
  }

  // echo carries the same identity block as every other method: without it
  // the client cannot apply the wrong-target check to a ping (fail-open).
  function echoPayload(params) {
    var p = identityPayload();
    p.echoed = (params && params.message !== undefined)
      ? String(params.message) : "";
    return p;
  }

  function snapshotPayload() {
    var projectOpen = false;
    var itemCount = 0;
    var activePresent = false;
    var queueCount = 0;
    try {
      var pr = app.project;
      if (pr) {
        projectOpen = true;
        itemCount = Number(pr.numItems);
        activePresent = (pr.activeItem !== null && pr.activeItem !== undefined);
        queueCount = Number(pr.renderQueue.numItems);
      }
    } catch (e) {
      // Counts stay at defaults; the snapshot schema treats them as
      // volatile anyway. Never invent numbers.
    }
    return {
      projectOpen: projectOpen,
      projectItemCount: itemCount,
      activeItemPresent: activePresent,
      renderQueueItemCount: queueCount
    };
  }

  function sysinfoPayload() {
    var os = Folder.appsystem;
    return {
      systemFolderName: String(os && os.fsName ? os.fsName : ""),
      hostName: String($.getenv("HOSTNAME") || $.getenv("COMPUTERNAME") || ""),
      hostClock: isoNow()
    };
  }

  var methods = {
    "probe.echo": echoPayload,
    "probe.identify": identityPayload,
    "probe.snapshot": identityAndSnapshot,
    "probe.sysinfo": identityAndSysinfo
  };

  function identityAndSnapshot(params) {
    var p = identityPayload();
    var s = snapshotPayload();
    p.projectOpen = s.projectOpen;
    p.projectItemCount = s.projectItemCount;
    p.activeItemPresent = s.activeItemPresent;
    p.renderQueueItemCount = s.renderQueueItemCount;
    return p;
  }

  function identityAndSysinfo(params) {
    var p = identityPayload();
    var s = sysinfoPayload();
    p.systemFolderName = s.systemFolderName;
    p.hostName = s.hostName;
    p.hostClock = s.hostClock;
    return p;
  }

  /* ---------------- request validation ---------------- */

  function validateRequest(request, id, now) {
    if (!request || typeof request !== "object") {
      return "BAD_REQUEST";
    }
    if (request.v !== 1 || request.id !== id || request.token !== token) {
      return "BAD_REQUEST";
    }
    if (typeof request.method !== "string" ||
        !methods.hasOwnProperty(request.method)) {
      return "UNSUPPORTED_METHOD";
    }
    if (typeof request.deadlineMs !== "number" ||
        request.deadlineMs < now ||
        request.deadlineMs > now + 30000) {
      return "EXPIRED";
    }
    if (request.channelId !== channelId) {
      return "BAD_REQUEST";
    }
    if (request.targetAeVersion !== undefined &&
        request.targetAeVersion !== "" &&
        request.targetAeVersion !== String(app.version)) {
      // The request was pinned to a different AE build; this host must not
      // answer as if it were that target (mis-delivery guard, CAP023).
      return "WRONG_TARGET";
    }
    return null;
  }

  function refuse(id, code, message) {
    return {
      v: 1, id: id, token: token, channelId: channelId,
      dispatchId: dispatchId, ok: false,
      refusal: { code: code, message: message }
    };
  }

  function tick() {
    try {
      var files = inbox.getFiles("*.request.json");
      var count = Math.min(files.length, 4);
      for (var i = 0; i < count; i++) {
        var f = files[i];
        if (!(f instanceof File)) {
          continue;
        }
        var match = /^([0-9a-f]{32})\.request\.json$/.exec(f.name);
        if (!match) {
          continue;
        }
        var id = match[1];
        // Claim-before-run: a claimed request cannot be replayed by a
        // later host, and two dispatchers cannot both take it.
        var claimName = id + ".claimed";
        if (!f.rename(claimName)) {
          continue;
        }
        var claimed = new File(inbox.fsName + "/" + claimName);
        var reply = refuse(id, "BAD_REQUEST", "request refused");
        try {
          var request = codec.parse(readText(claimed));
          var now = new Date().getTime();
          var verdict = validateRequest(request, id, now);
          if (verdict !== null) {
            reply = refuse(id, verdict, "request refused before execution");
          } else {
            var started = new Date().getTime();
            var payload = methods[request.method](request.params);
            var evalMs = new Date().getTime() - started;
            reply = {
              v: 1, id: id, token: token, channelId: channelId,
              dispatchId: dispatchId, ok: true,
              hostClock: isoNow(), hostEvalMs: evalMs,
              result: payload
            };
          }
        } catch (failure) {
          reply = refuse(id, "BAD_REQUEST", "request refused");
        }
        try {
          publish(id + ".result.json", reply);
        } catch (publishError) {
          // Caller times out UNKNOWN; never retry a claimed request.
        }
        claimed.remove();
      }
    } catch (error) {
      // A scheduled task must never raise a modal while the human works.
      // No reply means the caller reports UNKNOWN, never a fabricated PASS.
    }
  }

  $.global.__readOnlyProbeTick = tick;
  $.global.__readOnlyProbeTask = app.scheduleTask(
    "$.global.__readOnlyProbeTick()", 250, true);
})();
