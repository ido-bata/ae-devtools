// Deliberate runtime fault for real-host sourcemap verification.
function boom(): void {
  var missing = __toolchainUndeclaredIdentifier;
  $.global.__toolchainBoom = missing;
}
boom();
