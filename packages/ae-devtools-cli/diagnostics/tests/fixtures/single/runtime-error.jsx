// Deliberate runtime fault for real-host sourcemap verification.
function boom() {
    var missing = __toolchainUndeclaredIdentifier;
    $.global.__toolchainBoom = missing;
}
boom();
//# sourceMappingURL=runtime-error.js.map