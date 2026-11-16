// Minimal valid ExtendScript-bound script.
function greet(): string {
  return "hello ae " + app.version;
}
var msg: string = greet();
$.global.__toolchainProbe = msg;
