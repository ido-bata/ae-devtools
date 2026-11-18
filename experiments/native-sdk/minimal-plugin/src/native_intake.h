/*******************************************************************/
/*                                                                 */
/* ae-devtools NativeProbe — opt-in native intake channel          */
/* (Issue #267 Slice A, contract: specs/.../contracts/             */
/*  native-channel.md, `ae-devtools/native-channel/v1`)             */
/*                                                                 */
/* Original code written for this repository.                      */
/*******************************************************************/

#ifndef AE_PROBE_NATIVE_INTAKE_H
#define AE_PROBE_NATIVE_INTAKE_H

#include <AE_GeneralPlug.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Called once from AEProbePluginEntry. `channelRootZ` is the value of
   the AE_DEVTOOLS_NATIVE_CHANNEL environment variable: an absolute path
   to a prepared native channel root, or NULL/empty when intake must
   stay disabled (the default). Resets all intake state. */
void NativeIntakeConfigure(const char* channelRootZ);

/* Called once per idle-hook dispatch, after the fingerprint suites
   (utility/project/memory) are acquired and entry-validated. Polls the
   channel inbox for at most one request, executes it through the
   read-only allowlist, and publishes the typed result. Never affects
   the probe's own trigger state; all failures are per-request typed
   outcomes or logged diagnostics. */
void NativeIntakeTick(
    const AEGP_UtilitySuite6* utilP,
    const AEGP_ProjSuite6* projP,
    AEGP_PluginID plugin_id);

#ifdef __cplusplus
}
#endif

#endif /* AE_PROBE_NATIVE_INTAKE_H */
