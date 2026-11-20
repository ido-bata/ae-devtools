// sample-args.mjs — deterministic per-op argument fixtures shared by the
// registry contract tests and the member-kind audit script. Values are
// chosen to pass each op's validate() so buildSource can generate the
// real ExtendScript source under audit.
export function sampleArgs(op) {
  const a = {};
  for (const n of op.args) {
    if (["x", "y", "width", "height", "pixelAspect", "duration", "frameRate"].includes(n)) a[n] = 30;
    else if (n === "to") a[n] = "top";
    else if (n === "type" && !op.id.startsWith("pref.")) a[n] = "CompItem";
    else if (n === "path") a[n] = "/tmp/x.aep";
    else if (n === "parentName") a[n] = null;
    else if (n === "propertyPath") a[n] = ["ADBE Transform Group", "ADBE Position"];
    else if (n === "time") a[n] = 0;
    else if (n === "keyIndex") a[n] = 1;
    else if (n === "value" && !op.id.startsWith("pref.")) a[n] = 1;
    else if (n === "effectMatchName") a[n] = "ADBE Gaussian Blur 2";
    else if (n === "label") a[n] = 3;
    else if (n === "startTime" || n === "timeSpanStart") a[n] = 0;
    else if (n === "stretch" || n === "timeSpanDuration") a[n] = 100;
    else if (n === "solo" || n === "shy" || n === "locked") a[n] = true;
    else if (n === "audioEnabled" || n === "threeDLayer" || n === "motionBlur" || n === "guideLayer" || n === "enabled") a[n] = true;
    else if (n === "comment") a[n] = "sample comment";
    else if (n === "setting") a[n] = "Output File Info";
    else if (n === "resolutionFactor") a[n] = 0.5;
    else if (n === "color") a[n] = [1, 0, 0];
    else if (n === "text") a[n] = "sample text";
    else if (n === "centerPoint") a[n] = [0, 0];
    else if (n === "fontSize") a[n] = 100;
    else if (n === "justification") a[n] = 1;
    else if (n === "fillColor" || n === "strokeColor") a[n] = [1, 0, 0];
    else if (["applyFill", "applyStroke", "strokeOverFill", "autoLeading"].includes(n)) a[n] = true;
    else if (n === "strokeWidth") a[n] = 5;
    else if (n === "boxTextSize") a[n] = [200, 100];
    else if (n === "boxTextPos") a[n] = [0, 0];
    else if (["baselineShift", "horizontalScale", "verticalScale"].includes(n)) a[n] = 0;
    else if (n === "tracking" || n === "leading") a[n] = 0;
    else if (["inPoint"].includes(n)) a[n] = 0;
    else if (n === "outPoint") a[n] = 10;
    else if (["adjustmentLayer", "preserveTransparency", "frameBlending", "collapseTransformation"].includes(n)) a[n] = true;
    else if (n === "inType" || n === "outType") a[n] = "LINEAR";
    else if (n === "inEase" || n === "outEase") a[n] = [{ speed: 0, influence: 50 }, { speed: 0, influence: 50 }];
    else if (n === "matteLayerName") a[n] = "Matte";
    else if (n === "matteType") a[n] = "ALPHA";
    else if (n === "bgColor") a[n] = [0, 0, 0];
    else if (n === "shutterAngle") a[n] = 180;
    else if (["displayStartTime", "shutterPhase"].includes(n)) a[n] = 0;
    else if (n === "displayStartFrame") a[n] = 0;
    else if (["motionBlur", "frameBlending", "draft3d", "hideShyLayers", "preserveNestedFrameRate", "dropFrame"].includes(n)) a[n] = true;
    else if (n === "footageName") a[n] = "clip.mov";
    else if (n === "solidName") a[n] = "Proxy Solid";
    else if (n === "placeholderName") a[n] = "Proxy Placeholder";
    else if (n === "forceAlphabetical") a[n] = true;
    else if (n === "useProxy") a[n] = true;
    else if (n === "moduleIndex") a[n] = 1;
    else if (n === "templateName") a[n] = "Lossless";
    else if (n === "postRenderAction") a[n] = "SET_PROXY";
    else if (n === "includeSourceXMP") a[n] = true;
    else if (n === "fixExpressions") a[n] = false;
    else if (n === "parentFolder") a[n] = null;
    else if (n === "selected") a[n] = true;
    else if (n === "id") a[n] = 1;
    else if (n === "section") a[n] = "General";
    else if (n === "key") a[n] = "SomeKey";
    else if (n === "duration") a[n] = 1;
    else if (n === "eventCuePoint") a[n] = true;
    else if (n === "params") a[n] = { cue: "in", label2: "x" };
    else if (n === "vertices") a[n] = [[0, 0], [10, 0], [10, 10]];
    else if (n === "inTangents" || n === "outTangents") a[n] = [[0, 0], [0, 0], [0, 0]];
    else if (n === "closed") a[n] = true;
    else if (n === "type" && op.id.startsWith("pref.")) a[n] = "string";
    else if (n === "default") a[n] = "d";
    else if (n === "value" && op.id.startsWith("pref.")) a[n] = "v";
    else a[n] = `sample-${n}`;
  }
  return a;
}
