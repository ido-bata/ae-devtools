/*******************************************************************/
/*                                                                 */
/* ae-devtools NativeProbe — intake channel state                  */
/* (extracted from native_intake.cpp for Issue #328)                */
/*                                                                 */
/* Original code written for this repository.                      */
/*                                                                 */
/* native_state.cpp is the ONLY translation unit that owns intake  */
/* mutable state (channel root, instance id, tick counters,        */
/* observed AE version, requestId seen-ring, opCalls window,        */
/* logged-once flags). Other modules reach it exclusively through  */
/* the narrow API below — no state is exposed as file-scope        */
/* variables.                                                      */
/*******************************************************************/

#ifndef AE_PROBE_NATIVE_STATE_H
#define AE_PROBE_NATIVE_STATE_H

#include <stddef.h>

#include "native_intake.h" /* AE_GeneralPlug.h types */

/* Debug-log + per-request opCalls recording. Every host call inside
   a request window is op-recorded; while collecting, unique ids are
   also appended to the opCalls set serialized by IntakeOpCallsJson. */
void IntakeLog(const AEGP_UtilitySuite6* utilP, const char* msgZ);
void IntakeLogf(const AEGP_UtilitySuite6* utilP, const char* fmtZ, ...);
void IntakeOpRecord(
    const AEGP_UtilitySuite6* utilP,
    const char* idZ,
    long errL,
    const char* extraZ);
void IntakeOpCallsReset(void);
void IntakeCollectingSet(int on);
/* Writes the opCalls JSON array into out; returns 1 when non-empty. */
int IntakeOpCallsJson(char* out, size_t cap);

/* Duplicate requestId seen-ring (per plug-in session). */
int SeenBefore(const char* idZ);
void SeenAdd(const char* idZ);

/* channel.json privacy + shape gate; fills inbox/outbox/state paths,
   token, optional consentKey and sessionAeVersion pin. */
int ChannelReady(
    const AEGP_UtilitySuite6* utilP,
    char* inboxOut, size_t inboxCap,
    char* outboxOut, size_t outboxCap,
    char* stateOut, size_t stateCap,
    char tokenOut[65],
    char consentKeyOut[65],
    char pinOut[48], size_t pinCap);

/* Instance id + observed "M.m" AE version (set by session
   attestation inside ProcessClaimed). */
const char* IntakeInstanceId(void);
const char* IntakeObservedVersion(void);
void IntakeNoteObservedVersion(int maj, int min);

/* Lifecycle: reset all state and bind the channel root (absolute
   path, "" disables). Tick/heartbeat scheduling helpers. */
void IntakeConfigureChannel(const char* channelRootZ);
int IntakeEnabled(void);
void IntakeAdvanceTick(void);
int IntakeHeartbeatDue(void);
void IntakeWriteHeartbeat(
    const AEGP_UtilitySuite6* utilP,
    AEGP_PluginID plugin_id,
    const char* statePathZ,
    const char* outboxDirZ);

#endif /* AE_PROBE_NATIVE_STATE_H */
