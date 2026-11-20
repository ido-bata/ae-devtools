/*******************************************************************/
/*                                                                 */
/* ae-devtools NativeProbe — operation allowlist, arg schema,       */
/* aeRef descriptor validation (typed operation metadata)           */
/* (extracted from native_intake.cpp for Issue #328)                */
/*                                                                 */
/* Original code written for this repository.                      */
/*                                                                 */
/* The devtools-side canonical statement of the arg schemas is      */
/* NATIVE_INTAKE_ARG_SCHEMAS in packages/native-adapter/src/        */
/* dispatch.ts — keep the two in sync.                              */
/*******************************************************************/

#ifndef AE_PROBE_NATIVE_REGISTRY_H
#define AE_PROBE_NATIVE_REGISTRY_H

#include <stddef.h>

#include "native_intake.h"  /* AE_GeneralPlug.h types */
#include "native_json.h"    /* JVal */

enum
{
    ARGK_INT = 0,   /* bounded integer: min..max inclusive */
    ARGK_AEREFITEM, /* aeRef project-item descriptor (Issue #270 Stage 3) */
    ARGK_AEREFLAYER, /* aeRef layer descriptor embedding its comp aeRef
                        (Issue #318 layer slice) */
    ARGK_AEREFPROJECT, /* aeRef project descriptor (Issue #318 §7e) */
    ARGK_AEREFRQITEM,  /* aeRef render-queue-item descriptor (§7f) */
    ARGK_STR           /* bounded UTF-8 string: slen <= max bytes */
};

typedef struct
{
    const char* name; /* args object key */
    int kind;         /* ARGK_* */
    double min;       /* ARGK_INT: inclusive bounds (integral values only) */
    double max;
} IntakeArgSpec;

typedef struct
{
    const char* operationId;
    const char* opRecordId; /* identical string; kept explicit */
    const IntakeArgSpec* argsSpec;
    int nargs;
    /* Issue #326: 1 = mutating op — the request must carry a valid
       §7g consent MAC verified after session attestation and before
       any AEGP call. Read-only entries are 0 and skip consent
       entirely (a stray consent field is ignored, never an error). */
    int requiresConsent;
} AllowEntry;

/* Identity bound shared by descriptor validation and the identity
   resolvers' name buffers. */
#define AEREF_NAME_MAX 1024   /* UTF-8 bytes; longer live names are undescribable */

extern const AllowEntry S_ALLOWLIST[];
extern const int S_ALLOWLIST_COUNT;

const AllowEntry* AllowFind(const char* opIdZ, size_t len);
/* Record the dispatched op's own AEGP call under its allowlist id. */
void RecordAllowOp(
    const AEGP_UtilitySuite6* utilP,
    const AllowEntry* allow,
    A_Err err);
/* Per-operation args schema check — call only after AllowFind.
   Returns 1 on success; 0 with detailZ filled on violation. */
int ValidateArgs(
    const AllowEntry* allow, JVal* args,
    char* detailZ, size_t detailCap);
/* Fetch a validated integer argument (call only after ValidateArgs
   succeeded for this op). */
long ArgsInt(const AllowEntry* allow, JVal* args, int index);

/* aeRef <-> AEGP_ItemType mapping (descriptor validation + payload
   emission). */
int AeRefTypeToItemType(JVal* typeV, AEGP_ItemType* outP);
const char* ItemTypeToAeRefTag(AEGP_ItemType t);

#endif /* AE_PROBE_NATIVE_REGISTRY_H */
