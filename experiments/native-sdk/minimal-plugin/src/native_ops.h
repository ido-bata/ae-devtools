/*******************************************************************/
/*                                                                 */
/* ae-devtools NativeProbe — operation executors                    */
/* (extracted from native_intake.cpp for Issue #328)                */
/*                                                                 */
/* Original code written for this repository.                      */
/*                                                                 */
/* Every allowlisted op body lives in native_ops.cpp; dispatch       */
/* resolves allow->execKind through the binding table below — there  */
/* is no second routing table. Adding an op = allowlist entry        */
/* (opId + arg spec + execKind) + one executor + one binding row.    */
/*******************************************************************/

#ifndef AE_PROBE_NATIVE_OPS_H
#define AE_PROBE_NATIVE_OPS_H

#include "native_intake.h"   /* AE_GeneralPlug.h types */
#include "native_json.h"     /* JVal */
#include "native_registry.h" /* AllowEntry */
#include "native_request.h"  /* ReqVerdict */

/* IntakeMutCtx (native_request.h) is the mutation-attempt channel:
   ProcessClaimed passes non-NULL only to mutating bindings. */
typedef void (*IntakeExecFn)(
    const AEGP_UtilitySuite6* utilP,
    const AEGP_ProjSuite6* projP,
    struct SPBasicSuite* basicP,
    AEGP_PluginID plugin_id,
    const AllowEntry* allow,
    JVal* args,
    ReqVerdict* v,
    IntakeMutCtx* mut);

void ExecNumProjects(
    const AEGP_UtilitySuite6* utilP,
    const AEGP_ProjSuite6* projP,
    struct SPBasicSuite* basicP,
    AEGP_PluginID plugin_id,
    const AllowEntry* allow,
    JVal* args,
    ReqVerdict* v,
    IntakeMutCtx* mut);
void ExecDriverImplVersion(
    const AEGP_UtilitySuite6* utilP,
    const AEGP_ProjSuite6* projP,
    struct SPBasicSuite* basicP,
    AEGP_PluginID plugin_id,
    const AllowEntry* allow,
    JVal* args,
    ReqVerdict* v,
    IntakeMutCtx* mut);
void ExecGetTypeName(
    const AEGP_UtilitySuite6* utilP,
    const AEGP_ProjSuite6* projP,
    struct SPBasicSuite* basicP,
    AEGP_PluginID plugin_id,
    const AllowEntry* allow,
    JVal* args,
    ReqVerdict* v,
    IntakeMutCtx* mut);
void ExecItemNameOrId(
    const AEGP_UtilitySuite6* utilP,
    const AEGP_ProjSuite6* projP,
    struct SPBasicSuite* basicP,
    AEGP_PluginID plugin_id,
    const AllowEntry* allow,
    JVal* args,
    ReqVerdict* v,
    IntakeMutCtx* mut);
void ExecCompGetter(
    const AEGP_UtilitySuite6* utilP,
    const AEGP_ProjSuite6* projP,
    struct SPBasicSuite* basicP,
    AEGP_PluginID plugin_id,
    const AllowEntry* allow,
    JVal* args,
    ReqVerdict* v,
    IntakeMutCtx* mut);
void ExecSetItemComment(
    const AEGP_UtilitySuite6* utilP,
    const AEGP_ProjSuite6* projP,
    struct SPBasicSuite* basicP,
    AEGP_PluginID plugin_id,
    const AllowEntry* allow,
    JVal* args,
    ReqVerdict* v,
    IntakeMutCtx* mut);
void ExecItemGetter(
    const AEGP_UtilitySuite6* utilP,
    const AEGP_ProjSuite6* projP,
    struct SPBasicSuite* basicP,
    AEGP_PluginID plugin_id,
    const AllowEntry* allow,
    JVal* args,
    ReqVerdict* v,
    IntakeMutCtx* mut);
void ExecLayerCompOp(
    const AEGP_UtilitySuite6* utilP,
    const AEGP_ProjSuite6* projP,
    struct SPBasicSuite* basicP,
    AEGP_PluginID plugin_id,
    const AllowEntry* allow,
    JVal* args,
    ReqVerdict* v,
    IntakeMutCtx* mut);
void ExecLayerGetter(
    const AEGP_UtilitySuite6* utilP,
    const AEGP_ProjSuite6* projP,
    struct SPBasicSuite* basicP,
    AEGP_PluginID plugin_id,
    const AllowEntry* allow,
    JVal* args,
    ReqVerdict* v,
    IntakeMutCtx* mut);
void ExecProjectGetter(
    const AEGP_UtilitySuite6* utilP,
    const AEGP_ProjSuite6* projP,
    struct SPBasicSuite* basicP,
    AEGP_PluginID plugin_id,
    const AllowEntry* allow,
    JVal* args,
    ReqVerdict* v,
    IntakeMutCtx* mut);
void ExecRQItemGetter(
    const AEGP_UtilitySuite6* utilP,
    const AEGP_ProjSuite6* projP,
    struct SPBasicSuite* basicP,
    AEGP_PluginID plugin_id,
    const AllowEntry* allow,
    JVal* args,
    ReqVerdict* v,
    IntakeMutCtx* mut);
void ExecDriverPluginInitVersion(
    const AEGP_UtilitySuite6* utilP,
    const AEGP_ProjSuite6* projP,
    struct SPBasicSuite* basicP,
    AEGP_PluginID plugin_id,
    const AllowEntry* allow,
    JVal* args,
    ReqVerdict* v,
    IntakeMutCtx* mut);
void ExecSuppressUI(
    const AEGP_UtilitySuite6* utilP,
    const AEGP_ProjSuite6* projP,
    struct SPBasicSuite* basicP,
    AEGP_PluginID plugin_id,
    const AllowEntry* allow,
    JVal* args,
    ReqVerdict* v,
    IntakeMutCtx* mut);
void ExecHostActivated(
    const AEGP_UtilitySuite6* utilP,
    const AEGP_ProjSuite6* projP,
    struct SPBasicSuite* basicP,
    AEGP_PluginID plugin_id,
    const AllowEntry* allow,
    JVal* args,
    ReqVerdict* v,
    IntakeMutCtx* mut);
void ExecRQZeroArg(
    const AEGP_UtilitySuite6* utilP,
    const AEGP_ProjSuite6* projP,
    struct SPBasicSuite* basicP,
    AEGP_PluginID plugin_id,
    const AllowEntry* allow,
    JVal* args,
    ReqVerdict* v,
    IntakeMutCtx* mut);

/* Executor binding table — the single source mapping execKind to
   (executor, mutation class). ExecForKind is the only dispatch path;
   ExecKindIsMutating drives BOTH the consent gate and the mut ctx
   hand-off, so classification cannot diverge. OpTableSelfCheck
   verifies every S_ALLOWLIST execKind resolves — called once at
   configure time and by tests. */
IntakeExecFn ExecForKind(int kind);
int ExecKindIsMutating(int kind);
int OpTableSelfCheck(void);

#endif /* AE_PROBE_NATIVE_OPS_H */
