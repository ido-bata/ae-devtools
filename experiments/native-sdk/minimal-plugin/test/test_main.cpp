/*******************************************************************/
/*                                                                 */
/* ae-a8n NativeProbe — mock-host unit tests                       */
/*                                                                 */
/* Original test code. Runs the REAL probe.cpp entry point and     */
/* idle hook against FakeHost (fake_host.h/.cpp): no After Effects, */
/* no GUI, plain clang++ compile + run.                            */
/*                                                                 */
/* These are unit/mock-level checks of OUR code's control flow and */
/* memory discipline. They say nothing about real AE behaviour —    */
/* see ../README.md verification-state table.                      */
/*******************************************************************/

#include "fake_host.h"
#include "../src/native_json.h"
#include "../src/native_consent.h"
#include "../src/native_registry.h"
#include "../src/native_ops.h"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

extern "C" A_Err AEProbePluginEntry(
    struct SPBasicSuite* pica_basicP,
    A_long driver_major_versionL,
    A_long driver_minor_versionL,
    AEGP_PluginID aegp_plugin_id,
    AEGP_GlobalRefcon* global_refconP);

static int g_failures = 0;
static int g_checks = 0;

#define CHECK(cond)                                                     \
    do                                                                  \
    {                                                                   \
        g_checks++;                                                     \
        if (!(cond))                                                    \
        {                                                               \
            g_failures++;                                               \
            printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);      \
        }                                                               \
    } while (0)

static A_Err CallEntry(FakeHost& h, AEGP_PluginID id = 7)
{
    return AEProbePluginEntry(&h.basicSuite, 1, 0, id, NULL);
}

static A_Err CallIdle(FakeHost& h)
{
    A_long max_sleep = 0;
    A_Err err;
    CHECK(h.idleHook != NULL);
    err = h.idleHook(NULL, NULL, &max_sleep);
    /* The hook must always leave its steady-state throttle hint:
       60 ticks of 1/60 s = 1 s between idle dispatches. */
    CHECK(max_sleep == 60);
    return err;
}

static void SuitesBalanced(FakeHost& h)
{
    for (int i = 0; i < 10; i++)
    {
        CHECK(h.acquireCount[i] == h.releaseCount[i]);
    }
}

static int AllMemFreed(FakeHost& h)
{
    int bad = 0;
    for (const auto& rec : h.memRecs)
    {
        if (!rec->freed)
        {
            bad++;
        }
    }
    return bad;
}

/* ------------------------------------------------------------------ */

static void TestEntryRegistersIdleHook()
{
    auto h = MakeFakeHost();
    A_Err err = CallEntry(*h);
    CHECK(err == A_Err_NONE);
    CHECK(h->idleHookRegistrations == 1);
    CHECK(h->idleHook != NULL);
    CHECK(h->idleHookPluginId == 7);      /* entry-point id used for hooks */
    CHECK(h->registerWithAegpCalls == 1); /* identity registered at init */
    CHECK(h->registeredName == "ae-a8n NativeProbe");
    SuitesBalanced(*h);
    /* init must not probe: no project queries at entry time */
    CHECK(h->StartCount() == 0);
    /* ...but registration calls leave op-record evidence */
    CHECK(h->LogContains("op SPBasicSuite.AcquireSuite err=0 suite=\"AEGP Utility Suite\" version=13"));
    CHECK(h->LogContains("op SPBasicSuite.AcquireSuite err=0 suite=\"AEGP Register Suite\" version=6"));
    CHECK(h->LogContains("op AEGP_UtilitySuite6.AEGP_RegisterWithAEGP err=0 value=4242"));
    CHECK(h->LogContains("op AEGP_RegisterSuite5.AEGP_RegisterIdleHook err=0 value=7"));
    CHECK(h->LogContains("op SPBasicSuite.ReleaseSuite err=0 suite=\"AEGP Register Suite\" version=6"));
}

static void TestEntrySuiteAcquireFailures()
{
    const char* names[2] = {"utility", "register"};
    for (int i = 0; i < 2; i++)
    {
        auto h = MakeFakeHost();
        if (i == 0) h->failAcquireUtility = true;
        else h->failAcquireRegister = true;
        h->PopulateSuites();
        A_Err err = CallEntry(*h);
        CHECK(err == A_Err_STRUCT);
        CHECK(h->idleHook == NULL);
        SuitesBalanced(*h);
        (void)names;
    }
}

static void TestEntryNullBasicSuite()
{
    A_Err err = AEProbePluginEntry(NULL, 1, 0, 7, NULL);
    CHECK(err == A_Err_STRUCT);
}

static void TestEntryRegisterIdleHookFails()
{
    auto h = MakeFakeHost();
    h->registerIdleHookFails = true;
    h->PopulateSuites();
    A_Err err = CallEntry(*h);
    CHECK(err == A_Err_STRUCT); /* fail closed: probe could never run */
    SuitesBalanced(*h);
}

static void TestEntryRegisterWithAEGPFails_StillRegisters()
{
    auto h = MakeFakeHost();
    h->registerWithAegpFails = true;
    h->PopulateSuites();
    A_Err err = CallEntry(*h);
    CHECK(err == A_Err_NONE);
    CHECK(h->idleHook != NULL); /* falls back to entry-point plugin id */
    SuitesBalanced(*h);
}

/* ------------------------------------------------------------------ */

static void TestProbeHappyPathOneProject()
{
    auto h = MakeFakeHost();
    CHECK(CallEntry(*h) == A_Err_NONE);

    FakeProject& p = h->AddProject("Shot01");
    p.path = "/tmp/proj/shot01.aep";
    p.dirty = true;
    p.bitDepth = AEGP_ProjBitDepth_16;
    p.rootName = h->MakeNameSpec(FakeHost::U16("Root Folder"));
    h->SetItemNames(0, {
        h->MakeNameSpec(FakeHost::U16("Plate")),
        h->MakeNameSpec(FakeHost::U16Codepoints({'C', 'a', 'f', 0xE9})), /* Café */
        h->MakeNameSpec(FakeHost::U16Codepoints({0x1F600})),           /* 😀 surrogate pair */
    });
    h->numProjects = 1;

    CHECK(CallIdle(*h) == A_Err_NONE);

    CHECK(h->StartCount() == 1);
    CHECK(h->LogContains("probe.end"));
    CHECK(h->LogContains("app.numProjects=1"));
    CHECK(h->LogContains("project[0].name=Shot01"));
    CHECK(h->LogContains("project[0].isDirty=1"));
    CHECK(h->LogContains("project[0].bitDepth=1"));
    CHECK(h->LogContains("project[0].path: /tmp/proj/shot01.aep"));
    CHECK(h->LogContains("project.rootFolder.name: Root Folder"));
    CHECK(h->LogContains("project.items[0].name: Plate"));
    CHECK(h->LogContains("project.items[1].name: Caf\xC3\xA9"));
    CHECK(h->LogContains("project.items[2].name: \xF0\x9F\x98\x80"));
    CHECK(h->LogContains("project.items.count=3"));
    CHECK(h->LogContains("driver.pluginInitVersion=1.0"));
    CHECK(h->LogContains("driver.implementationVersion=26.5"));
    CHECK(h->LogContains("host.isActivated=1"));
    /* Issue #63 extended read-only evidence */
    CHECK(h->LogContains("project[0].timeDisplay displayMode=0"));
    CHECK(h->LogContains("app.activeItem=none"));
    CHECK(h->LogContains("project.items[0].type=2"));
    CHECK(h->LogContains("project.items[0].typeName=fake-type-2"));
    CHECK(h->LogContains("project.items[0].id=1000"));
    CHECK(h->LogContains("project.items[0].selected=0"));
    CHECK(h->LogContains("project.items[0].label=0"));
    CHECK(h->LogContains("project.items[0].duration=90/30"));
    CHECK(h->LogContains("project.items[0].currentTime=0/30"));
    CHECK(h->LogContains("project.items[0].dimensions=640x360"));
    CHECK(h->LogContains("project.items[0].pixelAspect=1/1"));
    CHECK(h->LogContains("project.items[0].parentFolder=present"));
    CHECK(h->LogContains("project.items[0].comment:"));
    CHECK(h->LogContains("project.items[0].mruView=0"));
    CHECK(h->LogContains("op AEGP_ProjSuite6.AEGP_GetProjectTimeDisplay err=0"));
    CHECK(h->LogContains("op AEGP_ItemSuite9.AEGP_GetActiveItem err=0 hasItem=0"));
    CHECK(h->LogContains("op AEGP_ItemSuite9.AEGP_GetItemID err=0 i=0"));
    CHECK(h->LogContains("op AEGP_ItemSuite9.AEGP_GetItemComment err=0 i=0"));
    CHECK(h->LogContains("op AEGP_ItemSuite9.AEGP_GetItemMRUView err=0 i=0 hasView=0"));
    CHECK(h->LogContains("op SPBasicSuite.AcquireSuite err=0 suite=\"AEGP Item View Suite\" version=2"));
    CHECK(h->LogContains("op SPBasicSuite.ReleaseSuite err=0 suite=\"AEGP Item View Suite\" version=2"));

    /* every AE-allocated mem handle disposed: fingerprint path +
       probe path + root-folder name + 3 item names + 3 item comments */
    CHECK(AllMemFreed(*h) == 0);
    CHECK(h->memHandlesFreed == (int)h->memRecs.size());
    CHECK(h->memHandlesFreed == 9);
    CHECK(h->lastGetItemNamePluginId == 4242); /* id from RegisterWithAEGP */
    /* per-call op records: trigger-phase calls flushed into the run,
       probe-phase calls recorded live */
    CHECK(h->LogContains("probe.reason=initial"));
    CHECK(h->LogContains("op AEGP_ProjSuite6.AEGP_GetNumProjects err=0 value=1"));
    CHECK(h->LogContains("op AEGP_ProjSuite6.AEGP_GetProjectPath err=0"));
    CHECK(h->LogContains("op AEGP_ProjSuite6.AEGP_GetProjectName err=0"));
    CHECK(h->LogContains("op AEGP_ProjSuite6.AEGP_ProjectIsDirty err=0 value=1"));
    CHECK(h->LogContains("op AEGP_ProjSuite6.AEGP_GetProjectBitDepth err=0 value=1"));
    CHECK(h->LogContains("op AEGP_ProjSuite6.AEGP_GetProjectRootFolder err=0"));
    CHECK(h->LogContains("op AEGP_ItemSuite9.AEGP_GetFirstProjItem err=0"));
    CHECK(h->LogContains("op AEGP_ItemSuite9.AEGP_GetItemName err=0"));
    CHECK(h->LogContains("op AEGP_ItemSuite9.AEGP_GetItemType err=0 i=0 value=2")); /* AEGP_ItemType_COMP */
    CHECK(h->LogContains("op AEGP_ItemSuite9.AEGP_GetNextProjItem err=0"));
    CHECK(h->LogContains("op AEGP_MemorySuite1.AEGP_GetMemHandleSize err=0"));
    CHECK(h->LogContains("op AEGP_MemorySuite1.AEGP_LockMemHandle err=0"));
    CHECK(h->LogContains("op AEGP_MemorySuite1.AEGP_UnlockMemHandle err=0"));
    CHECK(h->LogContains("op AEGP_MemorySuite1.AEGP_FreeMemHandle err=0"));
    CHECK(h->LogContains("op SPBasicSuite.AcquireSuite err=0 suite=\"AEGP Item Suite\" version=14"));
    CHECK(h->LogContains("op SPBasicSuite.ReleaseSuite err=0 suite=\"AEGP Item Suite\" version=14"));
    for (const auto& rec : h->memRecs)
    {
        CHECK(rec->lockCount == 0); /* every lock paired with unlock */
    }
    SuitesBalanced(*h);
}

static void TestProbeZeroProjects()
{
    auto h = MakeFakeHost();
    CHECK(CallEntry(*h) == A_Err_NONE);
    h->numProjects = 0;

    CHECK(CallIdle(*h) == A_Err_NONE);
    CHECK(h->StartCount() == 1);
    CHECK(h->LogContains("app.numProjects=0"));
    CHECK(h->LogContains("probe.end"));
    CHECK(!h->LogContains("project[0].name")); /* no project queries ran */
    SuitesBalanced(*h);
}

/* Issue #64: read-only render-queue slice emits per-op records and
   log lines, acquires/releases both suites, and stays silent on
   quiet ticks. */
static void TestProbeRenderQueueSlice()
{
    auto h = MakeFakeHost();
    CHECK(CallEntry(*h) == A_Err_NONE);
    h->numProjects = 0;
    h->numRQItems = 2;

    CHECK(CallIdle(*h) == A_Err_NONE);
    CHECK(h->StartCount() == 1);
    CHECK(h->LogContains("renderQueue.state=0"));
    CHECK(h->LogContains("renderQueue.numItems=2"));
    CHECK(h->LogContains("rq[0].renderState=0"));
    CHECK(h->LogContains("rq[0].logType=0"));
    CHECK(h->LogContains("rq[0].numOutputModules=1"));
    CHECK(h->LogContains("rq[0].comment: fake rq comment"));
    CHECK(h->LogContains("rq[1].renderState=0"));
    CHECK(h->LogContains("op AEGP_RenderQueueSuite1.AEGP_GetRenderQueueState err=0"));
    CHECK(h->LogContains("op AEGP_RQItemSuite4.AEGP_GetNumRQItems err=0"));
    CHECK(h->LogContains("op AEGP_RQItemSuite4.AEGP_GetRQItemByIndex err=0 i=0"));
    CHECK(h->LogContains("op AEGP_RQItemSuite4.AEGP_GetComment err=0 i=0"));
    CHECK(h->LogContains("op AEGP_RQItemSuite4.AEGP_GetCompFromRQItem err=0"));
    SuitesBalanced(*h);

    /* quiet tick: no second run, no RQ re-acquire */
    CHECK(CallIdle(*h) == A_Err_NONE);
    CHECK(h->StartCount() == 1);
    CHECK(h->acquireCount[5] == 1);
    CHECK(h->acquireCount[6] == 1);
}

static void TestProbeRenderQueueSuiteAcquireFails_NonFatal()
{
    auto h = MakeFakeHost();
    CHECK(CallEntry(*h) == A_Err_NONE);
    h->numProjects = 0;
    h->numRQItems = 1;
    h->failAcquireRQ = true;
    h->PopulateSuites();

    CHECK(CallIdle(*h) == A_Err_NONE);
    CHECK(h->StartCount() == 1);
    CHECK(h->LogContains("probe.end")); /* core probe still completed */
    CHECK(h->LogContains("probe.error: AEGP Render Queue suite unavailable"));
    CHECK(!h->LogContains("renderQueue.state="));
    SuitesBalanced(*h);
}

static void TestProbeRenderQueueItemsQueryFails()
{
    auto h = MakeFakeHost();
    CHECK(CallEntry(*h) == A_Err_NONE);
    h->numProjects = 0;
    h->numRQItems = 1;
    h->rqItemsErr = A_Err_GENERIC;

    CHECK(CallIdle(*h) == A_Err_NONE);
    CHECK(h->LogContains("op AEGP_RQItemSuite4.AEGP_GetNumRQItems err=1"));
    CHECK(!h->LogContains("rq[0].renderState"));
    SuitesBalanced(*h);
}

static void TestProbeTwoProjects()
{
    auto h = MakeFakeHost();
    CHECK(CallEntry(*h) == A_Err_NONE);
    h->AddProject("First");
    h->AddProject("Second");
    h->numProjects = 2;

    CHECK(CallIdle(*h) == A_Err_NONE);
    CHECK(h->LogContains("app.numProjects=2"));
    CHECK(h->LogContains("project[0].name=First"));
    CHECK(h->LogContains("project[1].name=Second"));
    SuitesBalanced(*h);
}

static void TestIdleUnchangedCountDoesNotReprobe()
{
    auto h = MakeFakeHost();
    CHECK(CallEntry(*h) == A_Err_NONE);
    h->numProjects = 0;

    CHECK(CallIdle(*h) == A_Err_NONE);
    CHECK(CallIdle(*h) == A_Err_NONE);
    CHECK(CallIdle(*h) == A_Err_NONE);
    CHECK(h->StartCount() == 1); /* probed once, then silent */
    SuitesBalanced(*h);
}

static void TestIdleReprobesOnProjectCountChange()
{
    auto h = MakeFakeHost();
    CHECK(CallEntry(*h) == A_Err_NONE);
    h->numProjects = 0;
    CHECK(CallIdle(*h) == A_Err_NONE);
    CHECK(h->StartCount() == 1);

    h->AddProject("Late");
    h->numProjects = 1;
    CHECK(CallIdle(*h) == A_Err_NONE);
    CHECK(h->StartCount() == 2);
    CHECK(h->LogContains("project[0].name=Late"));

    h->numProjects = 0; /* project closed */
    CHECK(CallIdle(*h) == A_Err_NONE);
    CHECK(h->StartCount() == 3);
    SuitesBalanced(*h);
}

static void TestIdleSuiteAcquireFailures()
{
    /* each of the four probe suites failing at acquire → STRUCT,
       acquired suites still released */
    for (int which = 0; which < 4; which++)
    {
        auto h = MakeFakeHost();
        CHECK(CallEntry(*h) == A_Err_NONE);
        switch (which)
        {
            case 0: h->failAcquireUtility = true; break;
            case 1: h->failAcquireProj = true; break;
            case 2: h->failAcquireItem = true; break;
            default: h->failAcquireMemory = true; break;
        }
        /* acquire flags live in FakeAcquireSuite directly — no
           PopulateSuites needed (basicSuite fns are static). */
        h->numProjects = 1;
        h->AddProject("P");
        A_Err err = CallIdle(*h);
        CHECK(err == A_Err_STRUCT);
        CHECK(h->StartCount() == 0); /* probe never ran */
        SuitesBalanced(*h);
    }
}

static void TestIdleNullSuiteEntries()
{
    /* missing function-table entries → fail closed, no crash */
    {
        auto h = MakeFakeHost();
        CHECK(CallEntry(*h) == A_Err_NONE);
        h->nullProjEntry = 1; /* AEGP_GetNumProjects == NULL */
        h->PopulateSuites();
        h->numProjects = 1;
        h->AddProject("P");
        CHECK(CallIdle(*h) == A_Err_STRUCT);
        CHECK(h->LogContains("probe.aborted"));
        SuitesBalanced(*h);
    }
    {
        auto h = MakeFakeHost();
        CHECK(CallEntry(*h) == A_Err_NONE);
        h->nullMemEntry = 1; /* AEGP_FreeMemHandle == NULL */
        h->PopulateSuites();
        h->numProjects = 1;
        h->AddProject("P");
        CHECK(CallIdle(*h) == A_Err_STRUCT);
        SuitesBalanced(*h);
    }
    {
        /* WriteToDebugLog missing → cannot even log; still STRUCT */
        auto h = MakeFakeHost();
        CHECK(CallEntry(*h) == A_Err_NONE);
        h->nullWriteToDebugLog = true;
        h->PopulateSuites();
        h->numProjects = 1;
        h->AddProject("P");
        CHECK(CallIdle(*h) == A_Err_STRUCT);
        SuitesBalanced(*h);
    }
}

static void TestMemLockFailureStillFrees()
{
    auto h = MakeFakeHost();
    CHECK(CallEntry(*h) == A_Err_NONE);
    h->AddProject("P");
    h->numProjects = 1;
    h->SetItemNames(0, {
        h->MakeNameSpec(FakeHost::U16("LockedOut"), 0, false, 2), /* failMode=lock */
    });
    h->projects[0].rootName = h->MakeNameSpec(FakeHost::U16("R"), 0, false, 2);

    CHECK(CallIdle(*h) == A_Err_NONE);
    CHECK(h->LogContains("lock failed"));
    CHECK(AllMemFreed(*h) == 0); /* freed despite lock failure */
    CHECK(h->memHandlesFreed == (int)h->memRecs.size());
    for (const auto& rec : h->memRecs)
    {
        CHECK(rec->lockCount == 0); /* never locked → stays 0 */
    }
    SuitesBalanced(*h);
}

static void TestMemSizeFailureStillFrees()
{
    auto h = MakeFakeHost();
    CHECK(CallEntry(*h) == A_Err_NONE);
    h->AddProject("P");
    h->numProjects = 1;
    h->SetItemNames(0, {
        h->MakeNameSpec(FakeHost::U16("NoSize"), 0, false, 1), /* failMode=size */
    });

    CHECK(CallIdle(*h) == A_Err_NONE);
    CHECK(h->LogContains("size query failed"));
    CHECK(AllMemFreed(*h) == 0);
    CHECK(h->memHandlesFreed == (int)h->memRecs.size());
    SuitesBalanced(*h);
}

static void TestUnterminatedAndOddSizeUtf16()
{
    auto h = MakeFakeHost();
    CHECK(CallEntry(*h) == A_Err_NONE);
    h->AddProject("P");
    h->numProjects = 1;

    /* Name with NO NUL terminator inside the reported size: the
       converter must stop at the size bound, not scan forever. */
    std::vector<A_UTF16Char> noNul = {'H', 'i', 0x3042}; /* no terminator */
    FakeNameSpec spec = h->MakeNameSpec(noNul,
        (AEGP_MemSize)(noNul.size() * sizeof(A_UTF16Char)), true, 0);
    h->SetItemNames(0, {spec});

    /* Odd byte size: trailing half-unit must be ignored. */
    FakeNameSpec odd = h->MakeNameSpec(FakeHost::U16("Odd"),
        (AEGP_MemSize)(3 * sizeof(A_UTF16Char) + 1), true, 0);
    h->projects[0].itemNames.push_back(odd);
    h->projects[0].itemTypes.push_back(AEGP_ItemType_COMP);

    CHECK(CallIdle(*h) == A_Err_NONE);
    CHECK(h->LogContains("project.items[0].name: Hi\xE3\x81\x82")); /* こんにちは? no: Hi+あ */
    CHECK(h->LogContains("project.items[1].name: Odd"));
    CHECK(AllMemFreed(*h) == 0);
    SuitesBalanced(*h);
}

static void TestLoneSurrogatesBecomeReplacementChar()
{
    auto h = MakeFakeHost();
    CHECK(CallEntry(*h) == A_Err_NONE);
    h->AddProject("P");
    h->numProjects = 1;
    /* lone high surrogate (followed by 'A', not a low surrogate),
       lone low surrogate, then a valid surrogate pair (U+1F600) */
    h->SetItemNames(0, {
        h->MakeNameSpec(FakeHost::U16Codepoints({0xD800, 0x41, 0xDC00, 0x1F600})),
    });

    CHECK(CallIdle(*h) == A_Err_NONE);
    /* U+FFFD = EF BF BD, 'A', U+FFFD, then F0 9F 98 80 */
    CHECK(h->LogContains("project.items[0].name: \xEF\xBF\xBD" "A" "\xEF\xBF\xBD\xF0\x9F\x98\x80"));
    CHECK(AllMemFreed(*h) == 0);
    SuitesBalanced(*h);
}

static void TestGetItemNameErrorPath()
{
    auto h = MakeFakeHost();
    CHECK(CallEntry(*h) == A_Err_NONE);
    h->AddProject("P");
    h->numProjects = 1;
    h->itemNameErr = A_Err_GENERIC; /* every GetItemName fails */

    CHECK(CallIdle(*h) == A_Err_NONE);
    CHECK(h->LogContains("project.items.count=0")); /* empty project anyway */
    /* root-folder name also fails but probe continues */
    CHECK(h->LogContains("probe.end"));
    /* fingerprint + probe path handles were produced and freed */
    CHECK(h->memHandlesFreed == (int)h->memRecs.size());
    CHECK(h->memHandlesFreed == 2);
    SuitesBalanced(*h);
}

static void TestNullHandleFromGetItemName()
{
    auto h = MakeFakeHost();
    CHECK(CallEntry(*h) == A_Err_NONE);
    h->AddProject("P");
    h->numProjects = 1;
    /* GetItemName succeeds but hands back a NULL handle. */
    h->projects[0].rootName = h->MakeNameSpec(FakeHost::U16("R"), 0, false, 4);
    h->SetItemNames(0, {h->MakeNameSpec(FakeHost::U16("N"), 0, false, 4)});

    CHECK(CallIdle(*h) == A_Err_NONE);
    CHECK(h->LogContains("<null handle>"));
    /* NULL name handles produce nothing to free; the two project-path
       handles (fingerprint + probe) plus the item comment handle are
       still disposed. */
    CHECK(h->memHandlesFreed == (int)h->memRecs.size());
    CHECK(h->memHandlesFreed == 3);
    CHECK(h->StartCount() == 1);
    SuitesBalanced(*h);
}

static void TestNumProjectsQueryFails()
{
    auto h = MakeFakeHost();
    CHECK(CallEntry(*h) == A_Err_NONE);
    h->numProjectsErr = A_Err_GENERIC;

    CHECK(CallIdle(*h) == A_Err_NONE); /* query-level error: logged only */
    CHECK(h->LogContains("probe.error: AEGP_GetNumProjects failed"));
    CHECK(h->StartCount() == 0);
    /* persistent failure logs once, not every tick */
    CHECK(CallIdle(*h) == A_Err_NONE);
    CHECK(h->CountLogContaining("probe.error: AEGP_GetNumProjects failed") == 1);
    SuitesBalanced(*h);
}

static void TestIdleSameCountProjectSwitchReprobes()
{
    /* The audit finding: a project switch that keeps the project
       COUNT unchanged must still re-probe — count alone is not a
       valid trigger. */
    auto h = MakeFakeHost();
    CHECK(CallEntry(*h) == A_Err_NONE);
    FakeProject& p = h->AddProject("Alpha");
    p.path = "/tmp/alpha.aep";
    h->numProjects = 1;

    CHECK(CallIdle(*h) == A_Err_NONE);
    CHECK(h->StartCount() == 1);
    CHECK(h->LogContains("probe.reason=initial"));
    CHECK(h->LogContains("project[0].name=Alpha"));

    /* Same count, different project identity. */
    p.name = "Beta";
    p.path = "/tmp/beta.aep";
    CHECK(CallIdle(*h) == A_Err_NONE);
    CHECK(h->StartCount() == 2);
    CHECK(h->LogContains("probe.reason=identity-change"));
    CHECK(h->LogContains("project[0].name=Beta"));
    CHECK(h->LogContains("project[0].path: /tmp/beta.aep"));

    /* Steady state again: silent. */
    {
        size_t before = h->log.size();
        CHECK(CallIdle(*h) == A_Err_NONE);
        CHECK(h->log.size() == before);
        CHECK(h->StartCount() == 2);
    }
    SuitesBalanced(*h);
}

static void TestIdleSameNameDifferentPathReprobes()
{
    /* Name alone is not identity either: same display name, different
       file path is a different project. */
    auto h = MakeFakeHost();
    CHECK(CallEntry(*h) == A_Err_NONE);
    FakeProject& p = h->AddProject("Untitled");
    p.path = "/tmp/one.aep";
    h->numProjects = 1;
    CHECK(CallIdle(*h) == A_Err_NONE);
    CHECK(h->StartCount() == 1);

    p.path = "/tmp/two.aep";
    CHECK(CallIdle(*h) == A_Err_NONE);
    CHECK(h->StartCount() == 2);
    CHECK(h->LogContains("project[0].path: /tmp/two.aep"));
    SuitesBalanced(*h);
}

static void TestIdleRecoveryAfterCountFailure()
{
    /* Failure window: GetNumProjects fails, then recovers. The next
       successful fingerprint must probe (recovery), even though the
       project set may be identical to the last good one. */
    auto h = MakeFakeHost();
    CHECK(CallEntry(*h) == A_Err_NONE);
    h->AddProject("P");
    h->numProjects = 1;

    CHECK(CallIdle(*h) == A_Err_NONE);
    CHECK(h->StartCount() == 1);
    CHECK(h->LogContains("probe.reason=initial"));

    h->numProjectsErr = A_Err_GENERIC;
    CHECK(CallIdle(*h) == A_Err_NONE);
    CHECK(h->StartCount() == 1); /* no probe during failure */

    h->numProjectsErr = A_Err_NONE; /* recovery: same project set */
    CHECK(CallIdle(*h) == A_Err_NONE);
    CHECK(h->StartCount() == 2);
    CHECK(h->LogContains("probe.reason=recovery"));

    /* And steady state resumes. */
    {
        size_t before = h->log.size();
        CHECK(CallIdle(*h) == A_Err_NONE);
        CHECK(h->log.size() == before);
    }
    SuitesBalanced(*h);
}

static void TestIdleRecoveryAfterFingerprintFailure()
{
    /* A fingerprint component fails (project name query): the tick is
       skipped, state invalidated, and the next good tick re-probes. */
    auto h = MakeFakeHost();
    CHECK(CallEntry(*h) == A_Err_NONE);
    h->AddProject("P");
    h->numProjects = 1;
    CHECK(CallIdle(*h) == A_Err_NONE);
    CHECK(h->StartCount() == 1);

    h->projectNameErr = A_Err_GENERIC;
    CHECK(CallIdle(*h) == A_Err_NONE);
    CHECK(h->StartCount() == 1);
    CHECK(h->LogContains("probe.error: project fingerprint failed"));
    /* persistent fingerprint failure logs once */
    CHECK(CallIdle(*h) == A_Err_NONE);
    CHECK(h->CountLogContaining("probe.error: project fingerprint failed") == 1);

    h->projectNameErr = A_Err_NONE;
    CHECK(CallIdle(*h) == A_Err_NONE);
    CHECK(h->StartCount() == 2);
    CHECK(h->LogContains("probe.reason=recovery"));
    SuitesBalanced(*h);
}

static void TestIdleFingerprintFailsOnMissingProject()
{
    /* numProjects reports a project the host cannot return: the
       fingerprint fails closed rather than probing on partial data. */
    auto h = MakeFakeHost();
    CHECK(CallEntry(*h) == A_Err_NONE);
    h->numProjects = 1; /* but projects[] is empty */

    CHECK(CallIdle(*h) == A_Err_NONE);
    CHECK(h->StartCount() == 0);
    CHECK(h->LogContains("probe.error: project fingerprint failed"));

    h->AddProject("Late"); /* recovery: project now resolvable */
    CHECK(CallIdle(*h) == A_Err_NONE);
    CHECK(h->StartCount() == 1);
    CHECK(h->LogContains("probe.reason=recovery"));
    CHECK(h->LogContains("project[0].name=Late"));
    SuitesBalanced(*h);
}

static void TestIdlePathQueryFailureFailsFingerprint()
{
    auto h = MakeFakeHost();
    CHECK(CallEntry(*h) == A_Err_NONE);
    h->AddProject("P");
    h->numProjects = 1;
    CHECK(CallIdle(*h) == A_Err_NONE);
    CHECK(h->StartCount() == 1);

    h->projectPathErr = A_Err_GENERIC;
    CHECK(CallIdle(*h) == A_Err_NONE);
    CHECK(h->StartCount() == 1);
    CHECK(h->LogContains("probe.error: project fingerprint failed"));

    h->projectPathErr = A_Err_NONE;
    CHECK(CallIdle(*h) == A_Err_NONE);
    CHECK(h->StartCount() == 2);
    CHECK(h->LogContains("probe.reason=recovery"));
    SuitesBalanced(*h);
}

static void TestSilentTickEmitsNoOpRecords()
{
    /* Steady-state ticks must not spam: no probe markers AND no op
       records reach the debug log. */
    auto h = MakeFakeHost();
    CHECK(CallEntry(*h) == A_Err_NONE);
    h->AddProject("P");
    h->numProjects = 1;
    CHECK(CallIdle(*h) == A_Err_NONE);
    CHECK(h->StartCount() == 1);

    int op_records_before = h->CountLogContaining("op ");
    size_t before = h->log.size();
    CHECK(CallIdle(*h) == A_Err_NONE);
    CHECK(CallIdle(*h) == A_Err_NONE);
    CHECK(h->log.size() == before);
    CHECK(h->CountLogContaining("op ") == op_records_before);
    SuitesBalanced(*h);
}

/* Issue #63: extended item metadata + configured MRU view slice. */
static void TestProbeItemMetadataAndViewSlice()
{
    auto h = MakeFakeHost();
    CHECK(CallEntry(*h) == A_Err_NONE);
    FakeProject& p = h->AddProject("Meta");
    h->numProjects = 1;
    h->SetItemNames(0, {
        h->MakeNameSpec(FakeHost::U16("First")),
        h->MakeNameSpec(FakeHost::U16("Second")),
    });
    p.itemMeta.resize(2);
    p.itemMeta[0].id = 42;
    p.itemMeta[0].flags = 0x10;
    p.itemMeta[0].selected = TRUE;
    p.itemMeta[0].label = 5;
    p.itemMeta[0].duration = {300, 30};
    p.itemMeta[0].currentTime = {15, 30};
    p.itemMeta[0].width = 1920;
    p.itemMeta[0].height = 1080;
    p.itemMeta[0].par = {2, 1};
    p.itemMeta[0].hasView = true;
    p.itemMeta[0].comment = h->MakeNameSpec(FakeHost::U16("note"));
    p.timeDisplay.display_mode = 1;
    p.timeDisplay.timebaseC = 24;
    h->activeItemProject = 0;
    h->activeItemIndex = 1;

    CHECK(CallIdle(*h) == A_Err_NONE);
    CHECK(h->StartCount() == 1);
    CHECK(h->LogContains("probe.end"));
    CHECK(h->LogContains("project[0].timeDisplay displayMode=1"));
    CHECK(h->LogContains("timebase=24"));
    CHECK(h->LogContains("app.activeItem=present"));
    CHECK(h->LogContains("app.activeItem.name: Second"));
    CHECK(h->LogContains("project.items[0].type=2"));
    CHECK(h->LogContains("project.items[0].typeName=fake-type-2"));
    CHECK(h->LogContains("project.items[0].id=42"));
    CHECK(h->LogContains("project.items[0].flags=16"));
    CHECK(h->LogContains("project.items[0].selected=1"));
    CHECK(h->LogContains("project.items[0].label=5"));
    CHECK(h->LogContains("project.items[0].duration=300/30"));
    CHECK(h->LogContains("project.items[0].currentTime=15/30"));
    CHECK(h->LogContains("project.items[0].dimensions=1920x1080"));
    CHECK(h->LogContains("project.items[0].pixelAspect=2/1"));
    CHECK(h->LogContains("project.items[0].parentFolder=present"));
    CHECK(h->LogContains("project.items[0].comment: note"));
    CHECK(h->LogContains("project.items[0].mruView=1"));
    CHECK(h->LogContains("project.items[0].view.previewing=1 playback=12/30"));
    CHECK(h->LogContains("project.items[0].view.guidesVisible=1"));
    CHECK(h->LogContains("project.items[0].view.guidesSnap=0"));
    CHECK(h->LogContains("project.items[0].view.guidesLocked=1"));
    CHECK(h->LogContains("project.items[1].mruView=0"));
    CHECK(!h->LogContains("project.items[1].view."));
    CHECK(h->LogContains("op AEGP_ItemSuite9.AEGP_GetItemMRUView err=0 i=0 hasView=1"));
    CHECK(h->LogContains("op AEGP_ItemViewSuite2.AEGP_GetItemViewPlaybackTime err=0 i=0"));
    CHECK(h->LogContains("op AEGP_ItemViewSuite2.AEGP_GetItemViewGuidesLocked err=0 i=0"));
    CHECK(AllMemFreed(*h) == 0);
    for (const auto& rec : h->memRecs)
    {
        CHECK(rec->lockCount == 0);
    }
    SuitesBalanced(*h);
}

/* Issue #63: Item View suite acquisition failure is non-fatal — the
   core probe still completes and the view slice stays silent. */
static void TestProbeItemViewSuiteUnavailable_NonFatal()
{
    auto h = MakeFakeHost();
    CHECK(CallEntry(*h) == A_Err_NONE);
    h->AddProject("P");
    h->numProjects = 1;
    h->SetItemNames(0, {h->MakeNameSpec(FakeHost::U16("N"))});
    h->projects[0].itemMeta.resize(1);
    h->projects[0].itemMeta[0].hasView = true;
    h->failAcquireItemView = true;

    CHECK(CallIdle(*h) == A_Err_NONE);
    CHECK(h->StartCount() == 1);
    CHECK(h->LogContains("probe.end"));
    CHECK(h->LogContains("probe.error: AEGP Item View suite unavailable"));
    CHECK(!h->LogContains("mruView"));
    CHECK(!h->LogContains("AEGP_ItemViewSuite2.AEGP_GetItemViewPlaybackTime"));
    /* core item metadata still ran */
    CHECK(h->LogContains("project.items[0].id=1000"));
    SuitesBalanced(*h);
}

/* Issue #63: acquired Item View suite with a missing entry degrades
   the slice (suite still released), never the run. */
static void TestProbeItemViewEntriesMissing_NonFatal()
{
    auto h = MakeFakeHost();
    CHECK(CallEntry(*h) == A_Err_NONE);
    h->AddProject("P");
    h->numProjects = 1;
    h->SetItemNames(0, {h->MakeNameSpec(FakeHost::U16("N"))});
    h->projects[0].itemMeta.resize(1);
    h->projects[0].itemMeta[0].hasView = true;
    h->nullItemViewEntry = 2; /* GuidesVisible NULL */
    h->PopulateSuites();

    CHECK(CallIdle(*h) == A_Err_NONE);
    CHECK(h->StartCount() == 1);
    CHECK(h->LogContains("probe.error: AEGP Item View suite unavailable"));
    CHECK(!h->LogContains("mruView"));
    SuitesBalanced(*h);
    CHECK(h->acquireCount[7] == h->releaseCount[7]);
    CHECK(h->acquireCount[7] == 1);
}

/* Issue #63: extended-metadata getter failures are per-call — the
   walk, names and probe completion are unaffected. */
static void TestProbeItemMetaFailuresNonFatal()
{
    auto h = MakeFakeHost();
    CHECK(CallEntry(*h) == A_Err_NONE);
    h->AddProject("P");
    h->numProjects = 1;
    h->SetItemNames(0, {h->MakeNameSpec(FakeHost::U16("N"))});
    h->itemMetaErr = A_Err_GENERIC;

    CHECK(CallIdle(*h) == A_Err_NONE);
    CHECK(h->StartCount() == 1);
    CHECK(h->LogContains("probe.end"));
    CHECK(h->LogContains("project.items[0].name: N")); /* core path intact */
    CHECK(h->LogContains("project.items[0].type=2"));
    CHECK(!h->LogContains("project.items[0].typeName="));
    CHECK(!h->LogContains("project.items[0].id="));
    CHECK(h->LogContains("op AEGP_ItemSuite9.AEGP_GetItemID err=1 i=0"));
    CHECK(h->LogContains("op AEGP_ItemSuite9.AEGP_GetItemComment err=1 i=0"));
    CHECK(h->LogContains("op AEGP_ItemSuite9.AEGP_GetItemMRUView err=1 i=0"));
    CHECK(!h->LogContains("mruView="));
    CHECK(AllMemFreed(*h) == 0);
    SuitesBalanced(*h);
}

/* Issue #63: project time-display and active-item query failures are
   logged per-call and never abort the run. */
static void TestProbeProjectLevelQueryFailures()
{
    auto h = MakeFakeHost();
    CHECK(CallEntry(*h) == A_Err_NONE);
    h->AddProject("P");
    h->numProjects = 1;
    h->projectTimeDisplayErr = A_Err_GENERIC;
    h->activeItemErr = A_Err_GENERIC;

    CHECK(CallIdle(*h) == A_Err_NONE);
    CHECK(h->StartCount() == 1);
    CHECK(h->LogContains("probe.end"));
    CHECK(h->LogContains("AEGP_GetActiveItem err=1"));
    CHECK(!h->LogContains("timeDisplay displayMode"));
    CHECK(h->LogContains("op AEGP_ProjSuite6.AEGP_GetProjectTimeDisplay err=1"));
    CHECK(h->LogContains("op AEGP_ItemSuite9.AEGP_GetActiveItem err=1"));
    SuitesBalanced(*h);
}

/* Issue #63: a missing required ItemSuite9 detail entry fails closed
   like any other missing suite entry; a missing ItemViewSuite2 entry
   is non-fatal (covered above). */
static void TestIdleNullItemEntryFailsClosed()
{
    auto h = MakeFakeHost();
    CHECK(CallEntry(*h) == A_Err_NONE);
    h->nullItemEntry = 1; /* AEGP_GetItemMRUView == NULL */
    h->PopulateSuites();
    h->numProjects = 1;
    h->AddProject("P");
    CHECK(CallIdle(*h) == A_Err_STRUCT);
    CHECK(h->StartCount() == 0);
    CHECK(h->LogContains("probe.aborted"));
    SuitesBalanced(*h);
}

/* Issue #64: comp read-only slice — per-comp getters for COMP items,
   MRU comp query, op records, balanced suites. */
static void TestProbeCompSlice()
{
    auto h = MakeFakeHost();
    CHECK(CallEntry(*h) == A_Err_NONE);
    FakeProject& p = h->AddProject("CompProj");
    h->numProjects = 1;
    h->SetItemNames(0, {
        h->MakeNameSpec(FakeHost::U16("CompA")),
        h->MakeNameSpec(FakeHost::U16("FootageB")),
    });
    p.itemTypes[0] = AEGP_ItemType_COMP;
    p.itemTypes[1] = AEGP_ItemType_FOOTAGE;
    p.itemMeta.resize(2);
    p.itemMeta[0].compMeta.fps = 24.0;
    p.itemMeta[0].compMeta.frameDuration = {1001, 24000};
    p.itemMeta[0].compMeta.dsf = {2, 1};
    p.itemMeta[0].compMeta.bgColor = {1.0, 0.1, 0.2, 0.3};
    p.itemMeta[0].compMeta.flags = 0x8;
    p.itemMeta[0].compMeta.showLayerNames = FALSE;
    p.itemMeta[0].compMeta.showBlendModes = TRUE;
    p.itemMeta[0].compMeta.shutterAngle = {180, 1};
    p.itemMeta[0].compMeta.shutterPhase = {1, 2};
    p.itemMeta[0].compMeta.shutterStart = {5, 30};
    p.itemMeta[0].compMeta.shutterDuration = {2, 30};
    p.itemMeta[0].compMeta.mbSamples = 8;
    p.itemMeta[0].compMeta.mbAdaptiveLimit = 64;
    p.itemMeta[0].compMeta.workAreaStart = {10, 30};
    p.itemMeta[0].compMeta.workAreaDuration = {60, 30};
    p.itemMeta[0].compMeta.displayStart = {3, 30};
    p.itemMeta[0].compMeta.displayDropFrame = TRUE;
    h->mruCompProject = 0;
    h->mruCompIndex = 0;

    CHECK(CallIdle(*h) == A_Err_NONE);
    CHECK(h->StartCount() == 1);
    CHECK(h->LogContains("probe.end"));
    CHECK(h->LogContains("app.mruComp=present"));
    CHECK(h->LogContains("project.items[0].comp=present"));
    CHECK(h->LogContains("project.items[0].comp.itemFromComp=present"));
    CHECK(h->LogContains("project.items[0].comp.fps=24"));
    CHECK(h->LogContains("project.items[0].comp.frameDuration=1001/24000"));
    CHECK(h->LogContains("project.items[0].comp.downsample=2x1"));
    CHECK(h->LogContains("project.items[0].comp.bgColor a=1 r=0.1 g=0.2 b=0.3"));
    CHECK(h->LogContains("project.items[0].comp.flags=8"));
    CHECK(h->LogContains("project.items[0].comp.showLayerNames=0"));
    CHECK(h->LogContains("project.items[0].comp.showBlendModes=1"));
    CHECK(h->LogContains("project.items[0].comp.shutterAngle=180/1 phase=1/2"));
    CHECK(h->LogContains("project.items[0].comp.shutterRange start=5/30 duration=2/30"));
    CHECK(h->LogContains("project.items[0].comp.mbSamples=8"));
    CHECK(h->LogContains("project.items[0].comp.mbAdaptiveLimit=64"));
    CHECK(h->LogContains("project.items[0].comp.workAreaStart=10/30"));
    CHECK(h->LogContains("project.items[0].comp.workAreaDuration=60/30"));
    CHECK(h->LogContains("project.items[0].comp.displayStart=3/30"));
    CHECK(h->LogContains("project.items[0].comp.displayDropFrame=1"));
    /* footage item: no comp slice */
    CHECK(!h->LogContains("project.items[1].comp"));
    CHECK(h->LogContains("op AEGP_CompSuite13.AEGP_GetCompFromItem err=0 i=0"));
    CHECK(h->LogContains("op AEGP_CompSuite13.AEGP_GetCompFramerate err=0 i=0"));
    CHECK(h->LogContains("op AEGP_CompSuite13.AEGP_GetMostRecentlyUsedComp err=0 hasComp=1"));
    CHECK(AllMemFreed(*h) == 0);
    SuitesBalanced(*h);
    CHECK(h->acquireCount[8] == 1);
    CHECK(h->releaseCount[8] == 1);
}

/* Issue #64: comp suite acquisition failure is non-fatal — the core
   probe still completes and the comp slice stays silent. */
static void TestProbeCompSuiteUnavailable_NonFatal()
{
    auto h = MakeFakeHost();
    CHECK(CallEntry(*h) == A_Err_NONE);
    h->AddProject("P");
    h->numProjects = 1;
    h->SetItemNames(0, {h->MakeNameSpec(FakeHost::U16("N"))});
    h->failAcquireComp = true;

    CHECK(CallIdle(*h) == A_Err_NONE);
    CHECK(h->StartCount() == 1);
    CHECK(h->LogContains("probe.end"));
    CHECK(h->LogContains("probe.error: AEGP Comp suite unavailable"));
    CHECK(!h->LogContains(".comp="));
    CHECK(!h->LogContains("app.mruComp"));
    CHECK(h->LogContains("project.items[0].name: N"));
    SuitesBalanced(*h);
}

/* Issue #64: acquired comp suite with a missing entry degrades the
   slice (suite still released), never the run. */
static void TestProbeCompEntriesMissing_NonFatal()
{
    auto h = MakeFakeHost();
    CHECK(CallEntry(*h) == A_Err_NONE);
    h->AddProject("P");
    h->numProjects = 1;
    h->SetItemNames(0, {h->MakeNameSpec(FakeHost::U16("N"))});
    h->nullCompEntry = 8; /* GetCompFramerate NULL */
    h->PopulateSuites();

    CHECK(CallIdle(*h) == A_Err_NONE);
    CHECK(h->StartCount() == 1);
    CHECK(h->LogContains("probe.error: AEGP Comp suite unavailable"));
    CHECK(!h->LogContains(".comp="));
    SuitesBalanced(*h);
    CHECK(h->acquireCount[8] == h->releaseCount[8]);
    CHECK(h->acquireCount[8] == 1);
}

/* Issue #64: comp getter failures are per-call — the walk and probe
   completion are unaffected; non-comp GetCompFromItem failure is
   logged without aborting. */
static void TestProbeCompQueryFailuresNonFatal()
{
    auto h = MakeFakeHost();
    CHECK(CallEntry(*h) == A_Err_NONE);
    h->AddProject("P");
    h->numProjects = 1;
    h->SetItemNames(0, {
        h->MakeNameSpec(FakeHost::U16("C")),
        h->MakeNameSpec(FakeHost::U16("F")),
    });
    h->projects[0].itemTypes[0] = AEGP_ItemType_COMP;
    h->projects[0].itemTypes[1] = AEGP_ItemType_FOOTAGE;
    h->compQueryErr = A_Err_GENERIC;

    CHECK(CallIdle(*h) == A_Err_NONE);
    CHECK(h->StartCount() == 1);
    CHECK(h->LogContains("probe.end"));
    CHECK(h->LogContains("project.items[0].comp=present"));
    CHECK(!h->LogContains("project.items[0].comp.fps="));
    CHECK(h->LogContains("op AEGP_CompSuite13.AEGP_GetCompFramerate err=1 i=0"));
    /* footage item: the comp slice never runs for it — no comp-suite
       op records carry i=1. */
    CHECK(!h->LogContains("op AEGP_CompSuite13.AEGP_GetCompFramerate err=0 i=1"));
    CHECK(!h->LogContains("project.items[1].comp"));
    SuitesBalanced(*h);
}

/* Issue #64: no MRU comp is a normal state, not an error. */
static void TestProbeNoMRUComp()
{
    auto h = MakeFakeHost();
    CHECK(CallEntry(*h) == A_Err_NONE);
    h->AddProject("P");
    h->numProjects = 1;
    h->SetItemNames(0, {h->MakeNameSpec(FakeHost::U16("N"))});
    /* mruCompProject stays -1 → NULL comp */

    CHECK(CallIdle(*h) == A_Err_NONE);
    CHECK(h->StartCount() == 1);
    CHECK(h->LogContains("app.mruComp=none"));
    CHECK(h->LogContains("project.items[0].comp=present")); /* item itself is a comp */
    SuitesBalanced(*h);
}

/* ------------------------------------------------------------------ */

/* Issue #64 layer slice: per-comp layer enumeration + read-only
   layer getters. Layers are probed only inside COMP items; every
   getter is op-recorded and mem handles (layer/source names) are
   freed. */
static void TestProbeLayerSlice()
{
    auto h = MakeFakeHost();
    CHECK(CallEntry(*h) == A_Err_NONE);
    FakeProject& p = h->AddProject("LayerProj");
    h->numProjects = 1;
    h->SetItemNames(0, {
        h->MakeNameSpec(FakeHost::U16("CompA")),
        h->MakeNameSpec(FakeHost::U16("FootageB")),
    });
    p.itemTypes[0] = AEGP_ItemType_COMP;
    p.itemTypes[1] = AEGP_ItemType_FOOTAGE;
    p.itemMeta.resize(2);
    p.itemMeta[0].compMeta.layers.resize(2);
    FakeLayerMeta& l0 = p.itemMeta[0].compMeta.layers[0];
    l0.name = h->MakeNameSpec(FakeHost::U16("Layer One"));
    l0.sourceName = h->MakeNameSpec(FakeHost::U16("src0"));
    l0.flags = 0x11;
    l0.quality = AEGP_LayerQual_DRAFT;
    l0.objectType = AEGP_ObjectType_TEXT;
    l0.is3D = TRUE;
    l0.is2D = FALSE;
    l0.currentTime = {15, 30};
    l0.inPoint = {2, 30};
    l0.duration = {48, 30};
    l0.id = 4242;
    l0.label = 3;
    l0.samplingQuality = AEGP_LayerSamplingQual_BICUBIC;
    l0.sourceItemID = 77;
    l0.videoOn = FALSE;
    l0.audioOn = TRUE;
    l0.hasTrackMatte = TRUE;
    l0.isTrackMatte = FALSE;
    l0.trackMatteLayerIndex = 1;
    FakeLayerMeta& l1 = p.itemMeta[0].compMeta.layers[1];
    l1.name = h->MakeNameSpec(FakeHost::U16("Layer Two"));
    l1.sourceName = h->MakeNameSpec(FakeHost::U16("src1"));
    l1.id = 4343;
    l1.trackMatteLayerIndex = -1;

    CHECK(CallIdle(*h) == A_Err_NONE);
    CHECK(h->StartCount() == 1);
    CHECK(h->LogContains("probe.end"));
    CHECK(h->LogContains("project.items[0].comp.numLayers=2"));
    CHECK(h->LogContains("project.items[0].comp.layers[0].index=0"));
    CHECK(h->LogContains("project.items[0].comp.layers[0].name: Layer One"));
    CHECK(h->LogContains("project.items[0].comp.layers[0].sourceName: src0"));
    CHECK(h->LogContains("project.items[0].comp.layers[0].flags=17"));
    CHECK(h->LogContains("project.items[0].comp.layers[0].quality=1"));
    CHECK(h->LogContains("project.items[0].comp.layers[0].objectType=3"));
    CHECK(h->LogContains("project.items[0].comp.layers[0].is3D=1"));
    CHECK(h->LogContains("project.items[0].comp.layers[0].is2D=0"));
    CHECK(h->LogContains("project.items[0].comp.layers[0].currentTime=15/30"));
    CHECK(h->LogContains("project.items[0].comp.layers[0].inPoint=2/30"));
    CHECK(h->LogContains("project.items[0].comp.layers[0].duration=48/30"));
    CHECK(h->LogContains("project.items[0].comp.layers[0].id=4242"));
    CHECK(h->LogContains("project.items[0].comp.layers[0].label=3"));
    CHECK(h->LogContains("project.items[0].comp.layers[0].samplingQuality=1"));
    CHECK(h->LogContains("project.items[0].comp.layers[0].sourceItemID=77"));
    CHECK(h->LogContains("project.items[0].comp.layers[0].parentComp=present"));
    CHECK(h->LogContains("project.items[0].comp.layers[0].videoOn=0"));
    CHECK(h->LogContains("project.items[0].comp.layers[0].audioOn=1"));
    CHECK(h->LogContains("project.items[0].comp.layers[0].hasTrackMatte=1"));
    CHECK(h->LogContains("project.items[0].comp.layers[0].isTrackMatte=0"));
    CHECK(h->LogContains("project.items[0].comp.layers[0].trackMatteLayer=present"));
    CHECK(h->LogContains("project.items[0].comp.layers[1].name: Layer Two"));
    CHECK(h->LogContains("project.items[0].comp.layers[1].trackMatteLayer=none"));
    /* footage item: no layer slice */
    CHECK(!h->LogContains("project.items[1].comp.layers"));
    CHECK(h->LogContains("op AEGP_LayerSuite9.AEGP_GetCompNumLayers err=0 i=0"));
    CHECK(h->LogContains("op AEGP_LayerSuite9.AEGP_GetLayerName err=0 i=0 l=0"));
    CHECK(AllMemFreed(*h) == 0);
    SuitesBalanced(*h);
    CHECK(h->acquireCount[9] == 1);
    CHECK(h->releaseCount[9] == 1);
}

/* Issue #64 layer slice: layer suite acquisition failure is
   non-fatal — comp slice still runs, layer slice stays silent. */
static void TestProbeLayerSuiteUnavailable_NonFatal()
{
    auto h = MakeFakeHost();
    CHECK(CallEntry(*h) == A_Err_NONE);
    FakeProject& p = h->AddProject("P");
    h->numProjects = 1;
    h->SetItemNames(0, {h->MakeNameSpec(FakeHost::U16("C"))});
    p.itemTypes[0] = AEGP_ItemType_COMP;
    p.itemMeta.resize(1);
    p.itemMeta[0].compMeta.layers.resize(1);
    h->failAcquireLayer = true;

    CHECK(CallIdle(*h) == A_Err_NONE);
    CHECK(h->StartCount() == 1);
    CHECK(h->LogContains("probe.end"));
    CHECK(h->LogContains("probe.error: AEGP Layer suite unavailable"));
    CHECK(h->LogContains("project.items[0].comp=present"));
    CHECK(!h->LogContains(".comp.layers"));
    CHECK(!h->LogContains("comp.numLayers"));
    SuitesBalanced(*h);
}

/* Issue #64 layer slice: acquired layer suite with a missing entry
   degrades the slice (suite still released), never the run. */
static void TestProbeLayerEntriesMissing_NonFatal()
{
    auto h = MakeFakeHost();
    CHECK(CallEntry(*h) == A_Err_NONE);
    FakeProject& p = h->AddProject("P");
    h->numProjects = 1;
    h->SetItemNames(0, {h->MakeNameSpec(FakeHost::U16("C"))});
    p.itemTypes[0] = AEGP_ItemType_COMP;
    p.itemMeta.resize(1);
    p.itemMeta[0].compMeta.layers.resize(1);
    h->nullLayerEntry = 1; /* GetCompNumLayers NULL */
    h->PopulateSuites();

    CHECK(CallIdle(*h) == A_Err_NONE);
    CHECK(h->StartCount() == 1);
    CHECK(h->LogContains("probe.error: AEGP Layer suite unavailable"));
    CHECK(!h->LogContains("comp.numLayers"));
    SuitesBalanced(*h);
    CHECK(h->acquireCount[9] == h->releaseCount[9]);
    CHECK(h->acquireCount[9] == 1);
}

/* Issue #64 layer slice: per-call layer getter failures are
   tolerated; enumeration failure skips the layer walk for that comp. */
static void TestProbeLayerQueryFailuresNonFatal()
{
    auto h = MakeFakeHost();
    CHECK(CallEntry(*h) == A_Err_NONE);
    FakeProject& p = h->AddProject("P");
    h->numProjects = 1;
    h->SetItemNames(0, {h->MakeNameSpec(FakeHost::U16("C"))});
    p.itemTypes[0] = AEGP_ItemType_COMP;
    p.itemMeta.resize(1);
    p.itemMeta[0].compMeta.layers.resize(1);
    h->layerQueryErr = A_Err_GENERIC;

    CHECK(CallIdle(*h) == A_Err_NONE);
    CHECK(h->StartCount() == 1);
    CHECK(h->LogContains("probe.end"));
    CHECK(h->LogContains("project.items[0].comp.numLayers err=1"));
    CHECK(!h->LogContains("comp.layers[0]"));
    CHECK(h->LogContains("op AEGP_LayerSuite9.AEGP_GetCompNumLayers err=1 i=0"));
    SuitesBalanced(*h);
}

/* Issue #64 layer slice: a comp with zero layers logs numLayers=0
   and no per-layer records. */
static void TestProbeCompNoLayers()
{
    auto h = MakeFakeHost();
    CHECK(CallEntry(*h) == A_Err_NONE);
    FakeProject& p = h->AddProject("P");
    h->numProjects = 1;
    h->SetItemNames(0, {h->MakeNameSpec(FakeHost::U16("C"))});
    p.itemTypes[0] = AEGP_ItemType_COMP;

    CHECK(CallIdle(*h) == A_Err_NONE);
    CHECK(h->LogContains("project.items[0].comp.numLayers=0"));
    CHECK(!h->LogContains("comp.layers["));
    SuitesBalanced(*h);
}

/* ================= native intake channel (Issue #267) ============== */

static const char* kTok =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
static const char* kTokBad =
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

struct TmpChan
{
    char root[256];
    TmpChan()
    {
        char tmpl[280];
        snprintf(tmpl, sizeof(tmpl), "/tmp/aeprobe%dXXXXXX", (int)getpid());
        CHECK(mkdtemp(tmpl) != NULL);
        strncpy(root, tmpl, sizeof(root) - 1);
        root[sizeof(root) - 1] = '\0';
        char d[300];
        snprintf(d, sizeof(d), "%s/inbox", root); mkdir(d, 0700);
        snprintf(d, sizeof(d), "%s/outbox", root); mkdir(d, 0700);
        chmod(root, 0700);
        char cj[400];
        snprintf(cj, sizeof(cj), "%s/channel.json", root);
        FILE* f = fopen(cj, "wb");
        CHECK(f != NULL);
        fprintf(f, "{\"v\":1,\"token\":\"%s\"}", kTok);
        fclose(f);
        chmod(cj, 0600);
    }
    ~TmpChan()
    {
        std::string cmd = std::string("rm -rf '") + root + "'";
        system(cmd.c_str());
    }
    std::string Path(const char* rel) const
    {
        return std::string(root) + "/" + rel;
    }
};

static void WriteReq0600(const std::string& path, const std::string& body)
{
    FILE* f = fopen(path.c_str(), "wb");
    CHECK(f != NULL);
    fwrite(body.data(), 1, body.size(), f);
    fclose(f);
    chmod(path.c_str(), 0600);
}

static std::string Slurp(const std::string& path)
{
    FILE* f = fopen(path.c_str(), "rb");
    if (!f) return std::string();
    char buf[65536];
    size_t n = fread(buf, 1, sizeof(buf) - 1, f);
    fclose(f);
    buf[n] = '\0';
    return std::string(buf, n);
}

static bool Exists(const std::string& path)
{
    return access(path.c_str(), F_OK) == 0;
}

static std::string ReqJson(const char* id, const char* tok,
                           long timeoutMs, const char* op,
                           const char* aeVer, const char* target,
                           const char* extraInner)
{
    char b[2048];
    snprintf(b, sizeof(b),
        "{\"v\":1,\"token\":\"%s\",\"timeoutMs\":%ld%s,\"request\":{"
        "\"schema\":\"ae-devtools/native-dispatch/v1\",\"requestId\":\"%s\","
        "\"session\":{\"sessionId\":\"sess-1\",\"aeVersion\":\"%s\"},"
        "\"operationId\":\"%s\",\"args\":null,\"authorizationRef\":\"opaque\"}%s}",
        tok, timeoutMs, target ? (std::string(",\"target\":\"") + target + "\"").c_str() : "",
        id, aeVer, op, extraInner ? extraInner : "");
    return std::string(b);
}

static std::string ResultPath(TmpChan& c, const char* id)
{
    return c.Path((std::string("outbox/") + id + ".result.json").c_str());
}

/* Variant of ReqJson with a verbatim `args` JSON member (Issue #270). */
static std::string ReqJsonArgs(const char* id, const char* tok,
                               long timeoutMs, const char* op,
                               const char* aeVer, const char* argsJson)
{
    char b[2048];
    snprintf(b, sizeof(b),
        "{\"v\":1,\"token\":\"%s\",\"timeoutMs\":%ld,\"request\":{"
        "\"schema\":\"ae-devtools/native-dispatch/v1\",\"requestId\":\"%s\","
        "\"session\":{\"sessionId\":\"sess-1\",\"aeVersion\":\"%s\"},"
        "\"operationId\":\"%s\",\"args\":%s,\"authorizationRef\":\"opaque\"}}",
        tok, timeoutMs, id, aeVer, op, argsJson ? argsJson : "null");
    return std::string(b);
}

/* Byte-level contract check for an outbox result document (Issue #271).
   The file must be ONE complete JSON document — substring checks alone
   missed an extra closing brace that made every EmitResult output
   invalid (Slice B E2E). Structural assertions mirror
   contracts/native-channel.md §5: wrapper {v,instance,host,result}
   where result is a DispatchResult. */
static void CheckResultDoc(TmpChan& c, const char* id,
                           const char* wantOutcome, const char* wantRefusal)
{
    std::string r = Slurp(ResultPath(c, id));
    JVal* doc = JParseDoc(r.data(), r.size());
    CHECK(doc != NULL);
    if (!doc)
    {
        printf("FAIL result %s: emitted bytes are not one JSON document\n", id);
        return;
    }
    JVal* v = JGet(doc, "v");
    CHECK(v != NULL && v->kind == JK_NUM && v->num == 1);
    CHECK(JNonEmptyStr(JGet(doc, "instance")));
    CHECK(JGet(doc, "host") != NULL);
    JVal* res = JGet(doc, "result");
    CHECK(res != NULL);
    if (res)
    {
        CHECK(JStrEq(JGet(res, "schema"), "ae-devtools/native-dispatch/v1"));
        CHECK(JStrEq(JGet(res, "requestId"), id));
        if (!JStrEq(JGet(res, "outcome"), wantOutcome))
            printf("FAIL result %s: outcome=%s want=%s detail=%s\n", id,
                   JGet(res, "outcome") && JGet(res, "outcome")->kind == JK_STR
                       ? JGet(res, "outcome")->str : "?",
                   wantOutcome,
                   JGet(res, "detail") && JGet(res, "detail")->kind == JK_STR
                       ? JGet(res, "detail")->str : "?");
        CHECK(JStrEq(JGet(res, "outcome"), wantOutcome));
        JVal* rc = JGet(res, "refusalCode");
        if (wantRefusal)
            CHECK(JStrEq(rc, wantRefusal));
        else
            CHECK(rc == NULL);
    }
    JFree(doc);
}

/* Byte-level check for the state.json heartbeat (Issue #271): one
   complete JSON document with the contract shape and no token. */
static void CheckHeartbeat(TmpChan& c)
{
    std::string r = Slurp(c.Path("state.json"));
    CHECK(!r.empty());
    JVal* doc = JParseDoc(r.data(), r.size());
    CHECK(doc != NULL);
    if (!doc) return;
    JVal* v = JGet(doc, "v");
    CHECK(v != NULL && v->kind == JK_NUM && v->num == 1);
    CHECK(JNonEmptyStr(JGet(doc, "instance")));
    JVal* pid = JGet(doc, "pluginId");
    CHECK(pid != NULL && pid->kind == JK_NUM);
    JVal* tick = JGet(doc, "lastTick");
    CHECK(tick != NULL && tick->kind == JK_NUM);
    JVal* allow = JGet(doc, "allowlist");
    CHECK(allow != NULL && allow->kind == JK_ARR);
    if (allow && allow->kind == JK_ARR)
    {
        int found = 0;
        for (size_t i = 0; i < allow->nitems; i++)
            if (JStrEq(allow->items[i],
                       "AEGP_ProjSuite6.AEGP_GetNumProjects"))
                found = 1;
        CHECK(found);
    }
    CHECK(r.find(kTok) == std::string::npos);
    JFree(doc);
}

static void IntakeEntry(FakeHost& h, TmpChan& c)
{
    setenv("AE_DEVTOOLS_NATIVE_CHANNEL", c.root, 1);
    CHECK(CallEntry(h) == A_Err_NONE);
}

static void TestIntakeDisabledByDefault()
{
    auto h = MakeFakeHost();
    TmpChan c;
    unsetenv("AE_DEVTOOLS_NATIVE_CHANNEL");
    CHECK(CallEntry(*h) == A_Err_NONE);
    WriteReq0600(c.Path("inbox/req1.request.json"),
                 ReqJson("req1", kTok, 30000,
                         "AEGP_ProjSuite6.AEGP_GetNumProjects", "26.5", NULL, NULL));
    CHECK(CallIdle(*h) == A_Err_NONE);
    /* no claim, no result, no heartbeat: intake fully off */
    CHECK(Exists(c.Path("inbox/req1.request.json")));
    CHECK(!Exists(ResultPath(c, "req1")));
    CHECK(!Exists(c.Path("state.json")));
    CHECK(!h->LogContains("native.request"));
}

static void TestIntakeCompletedGetNumProjects()
{
    auto h = MakeFakeHost();
    h->numProjects = 2;
    TmpChan c;
    IntakeEntry(*h, c);
    CHECK(CallIdle(*h) == A_Err_NONE);
    CHECK(Exists(c.Path("state.json"))); /* heartbeat on first tick */
    WriteReq0600(c.Path("inbox/reqA.request.json"),
                 ReqJson("reqA", kTok, 30000,
                         "AEGP_ProjSuite6.AEGP_GetNumProjects", "26.5", NULL, NULL));
    CHECK(CallIdle(*h) == A_Err_NONE);
    CHECK(!Exists(c.Path("inbox/reqA.request.json")));
    std::string r = Slurp(ResultPath(c, "reqA"));
    CHECK(r.find("\"outcome\":\"completed\"") != std::string::npos);
    CHECK(r.find("\"numProjects\":2") != std::string::npos);
    CHECK(r.find("opCalls") != std::string::npos);
    /* the result file must be one complete JSON document — substring
       checks alone missed an extra closing brace (Slice B E2E) */
    CheckResultDoc(c, "reqA", "completed", NULL);
    CheckHeartbeat(c);
    CHECK(r.find("AEGP_ProjSuite6.AEGP_GetNumProjects") != std::string::npos);
    CHECK(h->LogContains("native.request id=reqA"));
    CHECK(h->LogContains("native.result id=reqA outcome=completed"));
    CHECK(h->LogContains("op AEGP_UtilitySuite6.AEGP_GetDriverImplementationVersion err=0"));
    CHECK(h->LogContains("op AEGP_ProjSuite6.AEGP_GetNumProjects err=0 value=2"));
    /* secret hygiene: token must never reach logs or results */
    CHECK(h->CountLogContaining(kTok) == 0);
    CHECK(r.find(kTok) == std::string::npos);
}

static void TestIntakeVersionOp()
{
    auto h = MakeFakeHost();
    TmpChan c;
    IntakeEntry(*h, c);
    WriteReq0600(c.Path("inbox/v.request.json"),
                 ReqJson("v", kTok, 30000,
                         "AEGP_UtilitySuite6.AEGP_GetDriverImplementationVersion",
                         "26.5", NULL, NULL));
    CHECK(CallIdle(*h) == A_Err_NONE);
    std::string r = Slurp(ResultPath(c, "v"));
    CHECK(r.find("\"outcome\":\"completed\"") != std::string::npos);
    CHECK(r.find("\"major\":26") != std::string::npos);
    CheckResultDoc(c, "v", "completed", NULL);
}

/* ---- Issue #270 Stage 1: read-only args codec ------------------------ */

static void TestIntakeGetTypeNameCompleted()
{
    auto h = MakeFakeHost();
    TmpChan c;
    IntakeEntry(*h, c);
    WriteReq0600(c.Path("inbox/tn.request.json"),
                 ReqJsonArgs("tn", kTok, 30000,
                             "AEGP_ItemSuite9.AEGP_GetTypeName", "26.5",
                             "{\"itemType\":2}"));
    CHECK(CallIdle(*h) == A_Err_NONE);
    std::string r = Slurp(ResultPath(c, "tn"));
    CHECK(r.find("\"outcome\":\"completed\"") != std::string::npos);
    CHECK(r.find("\"typeName\":\"fake-type-2\"") != std::string::npos);
    CheckResultDoc(c, "tn", "completed", NULL);
    /* the op record chain shows suite acquire → call → release inside
       this request's evidence window */
    CHECK(r.find("SPBasicSuite.AcquireSuite") != std::string::npos);
    CHECK(r.find("AEGP_ItemSuite9.AEGP_GetTypeName") != std::string::npos);
    CHECK(r.find("SPBasicSuite.ReleaseSuite") != std::string::npos);
    CHECK(h->LogContains("op AEGP_ItemSuite9.AEGP_GetTypeName err=0 t=2"));
    CHECK(r.find(kTok) == std::string::npos);
}

static void TestIntakeArgsRejected()
{
    /* Every unpermitted args shape refuses MALFORMED_REQUEST before any
       AEGP call: the result carries no opCalls at all (attestation runs
       after args validation), and the probe's own buffered op records
       never enter the result file. */
    static const struct { const char* id; const char* args; } cases[] = {
        { "a0", "{\"itemType\":0}" },          /* AEGP_ItemType_NONE */
        { "a5", "{\"itemType\":5}" },          /* NUM_TYPES1: undefined */
        { "a9", "{\"itemType\":99}" },         /* far out of range */
        { "an", "{\"itemType\":-1}" },         /* negative */
        { "af", "{\"itemType\":1.5}" },        /* non-integral */
        { "as", "{\"itemType\":\"2\"}" },      /* wrong type */
        { "ab", "{\"itemType\":true}" },       /* wrong type */
        { "ae", "{\"itemType\":2,\"extra\":1}" }, /* extra field */
        { "am", "{\"other\":2}" },             /* missing itemType */
        { "aa", "{}" },                       /* empty object */
        { "ar", "[2]" },                      /* array, not object */
        { "an2", "2" },                       /* bare number */
        { "an3", "null" },                    /* missing args for arg-op */
    };
    auto h = MakeFakeHost();
    TmpChan c;
    IntakeEntry(*h, c);
    size_t i;
    for (i = 0; i < sizeof(cases) / sizeof(cases[0]); i++)
    {
        std::string p = c.Path((std::string("inbox/") + cases[i].id +
                               ".request.json").c_str());
        WriteReq0600(p, ReqJsonArgs(cases[i].id, kTok, 30000,
                                    "AEGP_ItemSuite9.AEGP_GetTypeName",
                                    "26.5", cases[i].args));
        CHECK(CallIdle(*h) == A_Err_NONE);
        std::string r = Slurp(ResultPath(c, cases[i].id));
        CHECK(r.find("\"outcome\":\"refused\"") != std::string::npos);
        CHECK(r.find("MALFORMED_REQUEST") != std::string::npos);
        /* refused before attestation/execution: no host calls recorded
           for this request at all */
        CHECK(r.find("opCalls") == std::string::npos);
        CHECK(r.find("AEGP_ItemSuite9") == std::string::npos);
        CheckResultDoc(c, cases[i].id, "refused", "MALFORMED_REQUEST");
    }
}

static void TestIntakeArgsOnZeroArgOpRejected()
{
    auto h = MakeFakeHost();
    TmpChan c;
    IntakeEntry(*h, c);
    /* the pre-existing zero-arg getters still refuse any args value —
       Slice A semantics preserved */
    WriteReq0600(c.Path("inbox/z.request.json"),
                 ReqJsonArgs("z", kTok, 30000,
                             "AEGP_ProjSuite6.AEGP_GetNumProjects", "26.5",
                             "{\"itemType\":2}"));
    CHECK(CallIdle(*h) == A_Err_NONE);
    std::string r = Slurp(ResultPath(c, "z"));
    CHECK(r.find("MALFORMED_REQUEST") != std::string::npos);
    CHECK(r.find("opCalls") == std::string::npos);
    CheckResultDoc(c, "z", "refused", "MALFORMED_REQUEST");
}

static void TestIntakeGetTypeNameSuiteFailure()
{
    auto h = MakeFakeHost();
    TmpChan c;
    IntakeEntry(*h, c);
    h->failAcquireItem = true;
    h->PopulateSuites();
    WriteReq0600(c.Path("inbox/sf.request.json"),
                 ReqJsonArgs("sf", kTok, 30000,
                             "AEGP_ItemSuite9.AEGP_GetTypeName", "26.5",
                             "{\"itemType\":2}"));
    {
        /* failAcquireItem also breaks the probe's own stage-2 item
           suite, so the hook returns an error — the intake verdict is
           already published by then. */
        A_long ms = 0;
        (void)h->idleHook(NULL, NULL, &ms);
    }
    std::string r = Slurp(ResultPath(c, "sf"));
    /* environment-proven non-dispatch: not-sent, retryable as a new
       request — never executed, never UNKNOWN */
    CHECK(r.find("\"outcome\":\"not-sent\"") != std::string::npos);
    /* the op itself was never invoked: only the failed AcquireSuite
       record appears in opCalls */
    CHECK(r.find("AEGP_ItemSuite9.AEGP_GetTypeName") == std::string::npos);
    CheckResultDoc(c, "sf", "not-sent", NULL);
}

static void TestIntakeGetTypeNameOpFailure()
{
    auto h = MakeFakeHost();
    TmpChan c;
    IntakeEntry(*h, c);
    h->itemMetaErr = A_Err_GENERIC; /* FakeGetTypeName surfaces it */
    WriteReq0600(c.Path("inbox/of.request.json"),
                 ReqJsonArgs("of", kTok, 30000,
                             "AEGP_ItemSuite9.AEGP_GetTypeName", "26.5",
                             "{\"itemType\":4}"));
    CHECK(CallIdle(*h) == A_Err_NONE);
    std::string r = Slurp(ResultPath(c, "of"));
    CHECK(r.find("\"outcome\":\"failed\"") != std::string::npos);
    CHECK(r.find("mayHaveMutated\":false") != std::string::npos);
    CheckResultDoc(c, "of", "failed", NULL);
    CHECK(h->LogContains("op AEGP_ItemSuite9.AEGP_GetTypeName err="));
}

/* ---- Issue #270 Stage 2: zero-arg read-only getter expansion -------- */

static void TestIntakeStage2ZeroArgGetters()
{
    /* Five new allowlisted ops, all zero-arg; one request per idle
       tick, claimed in name-sorted order: rq1, rq2, u1, u2, u3. */
    static const struct { const char* id; const char* op; const char* want; } ops[] = {
        { "rq1", "AEGP_RenderQueueSuite1.AEGP_GetRenderQueueState",
          "\"state\":" },
        { "rq2", "AEGP_RQItemSuite4.AEGP_GetNumRQItems",
          "\"numRQItems\":3" },
        { "u1", "AEGP_UtilitySuite6.AEGP_GetDriverPluginInitFuncVersion",
          "\"major\":1" },
        { "u2", "AEGP_UtilitySuite6.AEGP_GetSuppressInteractiveUI",
          "\"interactiveUiSuppressed\":false" },
        { "u3", "AEGP_UtilitySuite6.AEGP_HostIsActivated",
          "\"hostActivated\":true" },
    };
    auto h = MakeFakeHost();
    h->numRQItems = 3;
    TmpChan c;
    IntakeEntry(*h, c);
    size_t i;
    for (i = 0; i < sizeof(ops) / sizeof(ops[0]); i++)
        WriteReq0600(c.Path((std::string("inbox/") + ops[i].id +
                             ".request.json").c_str()),
                     ReqJson(ops[i].id, kTok, 30000, ops[i].op, "26.5", NULL, NULL));
    for (i = 0; i < sizeof(ops) / sizeof(ops[0]); i++)
    {
        CHECK(CallIdle(*h) == A_Err_NONE);
        std::string r = Slurp(ResultPath(c, ops[i].id));
        CHECK(r.find("\"outcome\":\"completed\"") != std::string::npos);
        CHECK(r.find(ops[i].want) != std::string::npos);
        CheckResultDoc(c, ops[i].id, "completed", NULL);
        CHECK(r.find(ops[i].op) != std::string::npos); /* opCalls linkage */
    }
    /* render-queue ops acquired + released their suites inside the
       request windows */
    CHECK(h->LogContains("op SPBasicSuite.AcquireSuite"));
    CHECK(h->LogContains("op AEGP_RQItemSuite4.AEGP_GetNumRQItems err=0 value=3"));
}

static void TestIntakeStage2RQSuiteFailure()
{
    auto h = MakeFakeHost();
    TmpChan c;
    IntakeEntry(*h, c);
    h->failAcquireRQItem = true;
    h->PopulateSuites();
    WriteReq0600(c.Path("inbox/rqf.request.json"),
                 ReqJson("rqf", kTok, 30000,
                         "AEGP_RQItemSuite4.AEGP_GetNumRQItems", "26.5",
                         NULL, NULL));
    {
        A_long ms = 0;
        (void)h->idleHook(NULL, NULL, &ms);
    }
    std::string r = Slurp(ResultPath(c, "rqf"));
    CHECK(r.find("\"outcome\":\"not-sent\"") != std::string::npos);
    CHECK(r.find("AEGP_RQItemSuite4.AEGP_GetNumRQItems") == std::string::npos);
    CheckResultDoc(c, "rqf", "not-sent", NULL);
}

static void TestIntakeStage2ArgsStillRejected()
{
    /* zero-arg Stage-2 ops keep the Slice-A contract: any args value
       refuses MALFORMED_REQUEST before attestation */
    auto h = MakeFakeHost();
    TmpChan c;
    IntakeEntry(*h, c);
    WriteReq0600(c.Path("inbox/za.request.json"),
                 ReqJsonArgs("za", kTok, 30000,
                             "AEGP_UtilitySuite6.AEGP_HostIsActivated",
                             "26.5", "{\"x\":1}"));
    CHECK(CallIdle(*h) == A_Err_NONE);
    std::string r = Slurp(ResultPath(c, "za"));
    CHECK(r.find("MALFORMED_REQUEST") != std::string::npos);
    CHECK(r.find("opCalls") == std::string::npos);
    CheckResultDoc(c, "za", "refused", "MALFORMED_REQUEST");
}

/* ---- Issue #270 Stage 3: aeRef identity resolution ------------------ */

static void TestIntakeGetItemNameCompleted()
{
    /* descriptor → host-side resolve → AEGP_GetItemName → typed result.
       Item index 1 is "Café" (non-ASCII UTF-16 → UTF-8 round-trip). */
    auto h = MakeFakeHost();
    FakeProject& p = h->AddProject("Shot01");
    p.rootName = h->MakeNameSpec(FakeHost::U16("Root"));
    h->SetItemNames(0, {
        h->MakeNameSpec(FakeHost::U16("Plate")),
        h->MakeNameSpec(FakeHost::U16Codepoints({'C', 'a', 'f', 0xE9})),
    });
    h->numProjects = 1;
    TmpChan c;
    IntakeEntry(*h, c);
    WriteReq0600(c.Path("inbox/in.request.json"),
                 ReqJsonArgs("in", kTok, 30000,
                             "AEGP_ItemSuite9.AEGP_GetItemName", "26.5",
                             "{\"projectIndex\":0,\"item\":{\"aeRef\":"
                             "{\"type\":\"comp\",\"name\":\"Caf\\u00e9\",\"path\":[1]}}}"));
    CHECK(CallIdle(*h) == A_Err_NONE);
    std::string r = Slurp(ResultPath(c, "in"));
    CHECK(r.find("\"outcome\":\"completed\"") != std::string::npos);
    CHECK(r.find("\"name\":\"Caf") != std::string::npos);
    CheckResultDoc(c, "in", "completed", NULL);
    /* resolve + op records all land in this request's opCalls window */
    CHECK(r.find("AEGP_ProjSuite6.AEGP_GetProjectByIndex") != std::string::npos);
    CHECK(r.find("AEGP_ItemSuite9.AEGP_GetFirstProjItem") != std::string::npos);
    CHECK(r.find("AEGP_ItemSuite9.AEGP_GetItemType") != std::string::npos);
    CHECK(r.find("AEGP_ItemSuite9.AEGP_GetItemName") != std::string::npos);
    CHECK(r.find("AEGP_MemorySuite1.AEGP_FreeMemHandle") != std::string::npos);
    CHECK(h->LogContains("op AEGP_ItemSuite9.AEGP_GetItemName err=0 (resolve+result)"));
    CHECK(r.find(kTok) == std::string::npos);
}

static void TestIntakeGetItemNameStale()
{
    /* Well-formed descriptors that no longer match live state refuse
       STALE_REFERENCE — never re-resolved, never executed. */
    static const struct { const char* id; const char* args; } cases[] = {
        { "p9", "{\"projectIndex\":9,\"item\":{\"aeRef\":{\"type\":\"comp\",\"name\":\"Plate\",\"path\":[0]}}}" },
        { "i9", "{\"projectIndex\":0,\"item\":{\"aeRef\":{\"type\":\"comp\",\"name\":\"Plate\",\"path\":[9]}}}" },
        { "nm", "{\"projectIndex\":0,\"item\":{\"aeRef\":{\"type\":\"comp\",\"name\":\"Nope\",\"path\":[0]}}}" },
        { "tp", "{\"projectIndex\":0,\"item\":{\"aeRef\":{\"type\":\"footage\",\"name\":\"Plate\",\"path\":[0]}}}" },
    };
    auto h = MakeFakeHost();
    FakeProject& p = h->AddProject("Shot01");
    p.rootName = h->MakeNameSpec(FakeHost::U16("Root"));
    h->SetItemNames(0, { h->MakeNameSpec(FakeHost::U16("Plate")) });
    h->numProjects = 1;
    TmpChan c;
    IntakeEntry(*h, c);
    size_t i;
    for (i = 0; i < sizeof(cases) / sizeof(cases[0]); i++)
    {
        WriteReq0600(c.Path((std::string("inbox/") + cases[i].id +
                             ".request.json").c_str()),
                     ReqJsonArgs(cases[i].id, kTok, 30000,
                                 "AEGP_ItemSuite9.AEGP_GetItemName", "26.5",
                                 cases[i].args));
        CHECK(CallIdle(*h) == A_Err_NONE);
        std::string r = Slurp(ResultPath(c, cases[i].id));
        CHECK(r.find("\"outcome\":\"refused\"") != std::string::npos);
        CHECK(r.find("STALE_REFERENCE") != std::string::npos);
        CheckResultDoc(c, cases[i].id, "refused", "STALE_REFERENCE");
        CHECK(r.find("\"name\":") == std::string::npos);
    }
}

static void TestIntakeGetItemNameMalformed()
{
    /* Descriptor shape violations refuse MALFORMED_REQUEST before any
       AEGP call — same discipline as the Stage-1 args codec. */
    static const struct { const char* id; const char* args; } cases[] = {
        { "m1", "{\"projectIndex\":0}" },                                  /* missing item */
        { "m2", "{\"item\":{\"aeRef\":{\"type\":\"comp\",\"name\":\"P\",\"path\":[0]}},\"projectIndex\":0,\"x\":1}" }, /* extra arg */
        { "m3", "{\"projectIndex\":0,\"item\":{\"type\":\"comp\",\"name\":\"P\",\"path\":[0]}}" }, /* no aeRef wrapper */
        { "m4", "{\"projectIndex\":0,\"item\":{\"aeRef\":{\"type\":\"comp\",\"name\":\"P\",\"path\":[0],\"contentHash\":\"h\"}}}" }, /* contentHash unsupported */
        { "m5", "{\"projectIndex\":0,\"item\":{\"aeRef\":{\"type\":\"solid\",\"name\":\"P\",\"path\":[0]}}}" }, /* bad type tag */
        { "m6", "{\"projectIndex\":0,\"item\":{\"aeRef\":{\"type\":\"comp\",\"name\":\"\",\"path\":[0]}}}" }, /* empty name */
        { "m7", "{\"projectIndex\":0,\"item\":{\"aeRef\":{\"type\":\"comp\",\"name\":\"P\",\"path\":[]}}}" }, /* empty path */
        { "m8", "{\"projectIndex\":0,\"item\":{\"aeRef\":{\"type\":\"comp\",\"name\":\"P\",\"path\":[0,1]}}}" }, /* deep path unsupported */
        { "m9", "{\"projectIndex\":0,\"item\":{\"aeRef\":{\"type\":\"comp\",\"name\":\"P\",\"path\":[-1]}}}" }, /* negative index */
        { "m10", "{\"projectIndex\":0,\"item\":{\"aeRef\":{\"type\":\"comp\",\"name\":\"P\",\"path\":[0.5]}}}" }, /* fractional index */
        { "m11", "{\"projectIndex\":-1,\"item\":{\"aeRef\":{\"type\":\"comp\",\"name\":\"P\",\"path\":[0]}}}" }, /* negative projectIndex */
    };
    auto h = MakeFakeHost();
    FakeProject& p = h->AddProject("Shot01");
    p.rootName = h->MakeNameSpec(FakeHost::U16("Root"));
    h->SetItemNames(0, { h->MakeNameSpec(FakeHost::U16("Plate")) });
    h->numProjects = 1;
    TmpChan c;
    IntakeEntry(*h, c);
    size_t i;
    for (i = 0; i < sizeof(cases) / sizeof(cases[0]); i++)
    {
        WriteReq0600(c.Path((std::string("inbox/") + cases[i].id +
                             ".request.json").c_str()),
                     ReqJsonArgs(cases[i].id, kTok, 30000,
                                 "AEGP_ItemSuite9.AEGP_GetItemName", "26.5",
                                 cases[i].args));
        CHECK(CallIdle(*h) == A_Err_NONE);
        std::string r = Slurp(ResultPath(c, cases[i].id));
        CHECK(r.find("MALFORMED_REQUEST") != std::string::npos);
        /* refused before attestation/resolution: no op records */
        CHECK(r.find("opCalls") == std::string::npos);
        CheckResultDoc(c, cases[i].id, "refused", "MALFORMED_REQUEST");
    }
}

static void TestIntakeGetItemNameSuiteFailure()
{
    /* ItemSuite acquire failure inside the resolve window is
       environment-proven non-dispatch: not-sent, never executed. */
    auto h = MakeFakeHost();
    FakeProject& p = h->AddProject("Shot01");
    p.rootName = h->MakeNameSpec(FakeHost::U16("Root"));
    h->SetItemNames(0, { h->MakeNameSpec(FakeHost::U16("Plate")) });
    h->numProjects = 1;
    TmpChan c;
    IntakeEntry(*h, c);
    h->failAcquireItem = true;
    h->PopulateSuites();
    WriteReq0600(c.Path("inbox/isf.request.json"),
                 ReqJsonArgs("isf", kTok, 30000,
                             "AEGP_ItemSuite9.AEGP_GetItemName", "26.5",
                             "{\"projectIndex\":0,\"item\":{\"aeRef\":"
                             "{\"type\":\"comp\",\"name\":\"Plate\",\"path\":[0]}}}"));
    {
        A_long ms = 0;
        (void)h->idleHook(NULL, NULL, &ms);
    }
    std::string r = Slurp(ResultPath(c, "isf"));
    CHECK(r.find("\"outcome\":\"not-sent\"") != std::string::npos);
    CheckResultDoc(c, "isf", "not-sent", NULL);
}

static void TestIntakeGetItemNameOpFailure()
{
    /* AEGP_GetItemName error after successful resolution is a typed
       failed outcome — read-only, mayHaveMutated=false. */
    auto h = MakeFakeHost();
    FakeProject& p = h->AddProject("Shot01");
    p.rootName = h->MakeNameSpec(FakeHost::U16("Root"));
    h->SetItemNames(0, { h->MakeNameSpec(FakeHost::U16("Plate")) });
    h->numProjects = 1;
    TmpChan c;
    IntakeEntry(*h, c);
    h->itemNameErr = A_Err_GENERIC;
    WriteReq0600(c.Path("inbox/iof.request.json"),
                 ReqJsonArgs("iof", kTok, 30000,
                             "AEGP_ItemSuite9.AEGP_GetItemName", "26.5",
                             "{\"projectIndex\":0,\"item\":{\"aeRef\":"
                             "{\"type\":\"comp\",\"name\":\"Plate\",\"path\":[0]}}}"));
    CHECK(CallIdle(*h) == A_Err_NONE);
    std::string r = Slurp(ResultPath(c, "iof"));
    CHECK(r.find("\"outcome\":\"failed\"") != std::string::npos);
    CHECK(r.find("mayHaveMutated\":false") != std::string::npos);
    CheckResultDoc(c, "iof", "failed", NULL);
}

/* ---- Issue #270 identity slice: issuance / discovery / v2 resolve -- */

struct ItemSpec
{
    const char* name;
    AEGP_ItemType type;
    A_long id;
};

/* Populate a project's parallel item vectors (names/types/meta) so
   itemIds are explicit — the fake derives 1000+index when id<0. */
static void SetupProjectItems(FakeHost& h, int projIndex,
                              std::initializer_list<ItemSpec> items)
{
    FakeProject& p = h.projects[projIndex];
    p.itemNames.clear();
    p.itemTypes.clear();
    p.itemMeta.clear();
    for (const ItemSpec& s : items)
    {
        p.itemNames.push_back(h.MakeNameSpec(FakeHost::U16(s.name)));
        p.itemTypes.push_back(s.type);
        FakeItemMeta m;
        m.id = s.id;
        p.itemMeta.push_back(m);
    }
}

/* Swap two top-level items across all parallel vectors — models a
   project-panel reorder between requests. */
static void SwapProjectItems(FakeProject& p, int a, int b)
{
    std::swap(p.itemNames[a], p.itemNames[b]);
    std::swap(p.itemTypes[a], p.itemTypes[b]);
    if ((int)p.itemMeta.size() > a && (int)p.itemMeta.size() > b)
        std::swap(p.itemMeta[a], p.itemMeta[b]);
}

/* Parse an outbox result file; returns the DispatchResult's `result`
   payload member as a JVal owned by *docOut (caller JFree(*docOut)). */
static JVal* ResultPayload(TmpChan& c, const char* id, JVal** docOut)
{
    std::string r = Slurp(ResultPath(c, id));
    JVal* doc = JParseDoc(r.data(), r.size());
    *docOut = doc;
    if (!doc) return NULL;
    JVal* res = JGet(doc, "result");
    return res ? JGet(res, "result") : NULL;
}

static JVal* PayloadNum(JVal* obj, const char* key)
{
    JVal* v = obj ? JGet(obj, key) : NULL;
    return (v && v->kind == JK_NUM) ? v : NULL;
}

static void TestIntakeGetItemIDIssuance()
{
    /* Legacy descriptor in → canonical identity-bearing descriptor
       out: live itemId + project name/path + live path index. The
       client stores result.item verbatim as args.item. */
    auto h = MakeFakeHost();
    FakeProject& p = h->AddProject("Shot01");
    p.path = "/tmp/shot01.aep";
    p.rootName = h->MakeNameSpec(FakeHost::U16("Root"));
    SetupProjectItems(*h, 0, {
        { "Alpha", AEGP_ItemType_COMP, 5001 },
        { "Beta",  AEGP_ItemType_FOLDER, 5002 },
    });
    h->numProjects = 1;
    TmpChan c;
    IntakeEntry(*h, c);
    WriteReq0600(c.Path("inbox/iss.request.json"),
                 ReqJsonArgs("iss", kTok, 30000,
                             "AEGP_ItemSuite9.AEGP_GetItemID", "26.5",
                             "{\"projectIndex\":0,\"item\":{\"aeRef\":"
                             "{\"type\":\"comp\",\"name\":\"Alpha\",\"path\":[0]}}}"));
    CHECK(CallIdle(*h) == A_Err_NONE);
    std::string r = Slurp(ResultPath(c, "iss"));
    CHECK(r.find("\"outcome\":\"completed\"") != std::string::npos);
    CheckResultDoc(c, "iss", "completed", NULL);
    JVal* doc = NULL;
    JVal* pay = ResultPayload(c, "iss", &doc);
    CHECK(pay != NULL);
    if (pay)
    {
        JVal* idv = PayloadNum(pay, "itemId");
        CHECK(idv && idv->num == 5001);
        JVal* item = JGet(pay, "item");
        JVal* ref = item ? JGet(item, "aeRef") : NULL;
        CHECK(ref != NULL);
        if (ref)
        {
            JVal* rid = PayloadNum(ref, "itemId");
            CHECK(rid && rid->num == 5001);
            JVal* pn = JGet(ref, "projectName");
            CHECK(pn && JStrEq(pn, "Shot01"));
            JVal* pp = JGet(ref, "projectPath");
            CHECK(pp && JStrEq(pp, "/tmp/shot01.aep"));
            JVal* path = JGet(ref, "path");
            CHECK(path && path->kind == JK_ARR && path->nitems == 1 &&
                  path->items[0]->num == 0);
        }
    }
    if (doc) JFree(doc);
    CHECK(h->LogContains("op AEGP_ItemSuite9.AEGP_GetItemID err=0 (result)"));
}

static void TestIntakeGetFirstProjItemPages()
{
    /* Discovery/enumeration: paged ready-to-use descriptors.
       Page 1: offset 0 limit 2 of 3 → truncated:true.
       Page 2: offset 2 limit 2 → 1 item, truncated:false. */
    auto h = MakeFakeHost();
    FakeProject& p = h->AddProject("Shot01");
    p.path = "/tmp/shot.aep";
    p.rootName = h->MakeNameSpec(FakeHost::U16("Root"));
    SetupProjectItems(*h, 0, {
        { "Alpha", AEGP_ItemType_COMP, 5001 },
        { "Beta",  AEGP_ItemType_FOLDER, 5002 },
        { "Gamma", AEGP_ItemType_FOOTAGE, 5003 },
    });
    h->numProjects = 1;
    TmpChan c;
    IntakeEntry(*h, c);
    WriteReq0600(c.Path("inbox/e1.request.json"),
                 ReqJsonArgs("e1", kTok, 30000,
                             "AEGP_ItemSuite9.AEGP_GetFirstProjItem", "26.5",
                             "{\"projectIndex\":0,\"offset\":0,\"limit\":2}"));
    CHECK(CallIdle(*h) == A_Err_NONE);   /* one request per tick */
    WriteReq0600(c.Path("inbox/e2.request.json"),
                 ReqJsonArgs("e2", kTok, 30000,
                             "AEGP_ItemSuite9.AEGP_GetFirstProjItem", "26.5",
                             "{\"projectIndex\":0,\"offset\":2,\"limit\":2}"));
    CHECK(CallIdle(*h) == A_Err_NONE);
    CheckResultDoc(c, "e1", "completed", NULL);
    CheckResultDoc(c, "e2", "completed", NULL);
    {
        JVal* doc = NULL;
        JVal* pay = ResultPayload(c, "e1", &doc);
        CHECK(pay != NULL);
        if (pay)
        {
            JVal* proj = JGet(pay, "project");
            CHECK(proj && JGet(proj, "name") && JStrEq(JGet(proj, "name"), "Shot01"));
            CHECK(JGet(proj, "path") && JStrEq(JGet(proj, "path"), "/tmp/shot.aep"));
            JVal* total = PayloadNum(pay, "total");
            CHECK(total && total->num == 3);
            JVal* items = JGet(pay, "items");
            CHECK(items && items->kind == JK_ARR && items->nitems == 2);
            JVal* tr = JGet(pay, "truncated");
            CHECK(tr && tr->kind == JK_TRUE);
            if (items && items->kind == JK_ARR && items->nitems == 2)
            {
                JVal* ref0 = JGet(JGet(items->items[0], "item"), "aeRef");
                JVal* ref1 = JGet(JGet(items->items[1], "item"), "aeRef");
                CHECK(ref0 && JGet(ref0, "projectName") &&
                      JStrEq(JGet(ref0, "projectName"), "Shot01"));
                CHECK(PayloadNum(ref0, "itemId") && PayloadNum(ref0, "itemId")->num == 5001);
                CHECK(PayloadNum(ref1, "itemId") && PayloadNum(ref1, "itemId")->num == 5002);
                JVal* p0 = JGet(ref0, "path");
                CHECK(p0 && p0->nitems == 1 && p0->items[0]->num == 0);
                JVal* p1 = JGet(ref1, "path");
                CHECK(p1 && p1->nitems == 1 && p1->items[0]->num == 1);
            }
        }
        if (doc) JFree(doc);
        doc = NULL;
        pay = ResultPayload(c, "e2", &doc);
        CHECK(pay != NULL);
        if (pay)
        {
            JVal* items = JGet(pay, "items");
            CHECK(items && items->kind == JK_ARR && items->nitems == 1);
            JVal* tr = JGet(pay, "truncated");
            CHECK(tr && tr->kind == JK_FALSE);
            if (items && items->nitems == 1)
            {
                JVal* ref = JGet(JGet(items->items[0], "item"), "aeRef");
                CHECK(PayloadNum(ref, "itemId") && PayloadNum(ref, "itemId")->num == 5003);
            }
        }
        if (doc) JFree(doc);
    }
}

static void TestIntakeIdentityReorder()
{
    /* Identity descriptor survives reorder: itemId is authoritative,
       path is not consulted. Legacy positional descriptor stales —
       the Stage-3 hazard the identity fields exist to fix. */
    auto h = MakeFakeHost();
    FakeProject& p = h->AddProject("Shot01");
    p.path = "/tmp/s.aep";
    p.rootName = h->MakeNameSpec(FakeHost::U16("Root"));
    SetupProjectItems(*h, 0, {
        { "Alpha", AEGP_ItemType_COMP, 5001 },
        { "Beta",  AEGP_ItemType_COMP, 5002 },
    });
    h->numProjects = 1;
    TmpChan c;
    IntakeEntry(*h, c);
    const char* ident =
        "{\"projectIndex\":0,\"item\":{\"aeRef\":{\"type\":\"comp\","
        "\"name\":\"Beta\",\"path\":[1],\"itemId\":5002,"
        "\"projectName\":\"Shot01\",\"projectPath\":\"/tmp/s.aep\"}}}";
    WriteReq0600(c.Path("inbox/r0.request.json"),
                 ReqJsonArgs("r0", kTok, 30000,
                             "AEGP_ItemSuite9.AEGP_GetItemName", "26.5", ident));
    CHECK(CallIdle(*h) == A_Err_NONE);
    {
        std::string r = Slurp(ResultPath(c, "r0"));
        CHECK(r.find("\"outcome\":\"completed\"") != std::string::npos);
    }
    /* reorder: Beta moves to index 0 */
    SwapProjectItems(p, 0, 1);
    /* identity descriptor still resolves — live path is now [0] but
       itemId 5002 finds Beta regardless of the stale path claim */
    WriteReq0600(c.Path("inbox/r1.request.json"),
                 ReqJsonArgs("r1", kTok, 30000,
                             "AEGP_ItemSuite9.AEGP_GetItemName", "26.5", ident));
    CHECK(CallIdle(*h) == A_Err_NONE);
    {
        std::string r = Slurp(ResultPath(c, "r1"));
        CHECK(r.find("\"outcome\":\"completed\"") != std::string::npos);
        CHECK(r.find("\"name\":\"Beta\"") != std::string::npos);
        CheckResultDoc(c, "r1", "completed", NULL);
    }
    /* legacy descriptor claiming Beta at path[1] now lands on Alpha →
       name corroboration refuses it (fail-closed, not wrong-target) */
    WriteReq0600(c.Path("inbox/r2.request.json"),
                 ReqJsonArgs("r2", kTok, 30000,
                             "AEGP_ItemSuite9.AEGP_GetItemName", "26.5",
                             "{\"projectIndex\":0,\"item\":{\"aeRef\":"
                             "{\"type\":\"comp\",\"name\":\"Beta\",\"path\":[1]}}}"));
    CHECK(CallIdle(*h) == A_Err_NONE);
    {
        std::string r = Slurp(ResultPath(c, "r2"));
        CHECK(r.find("STALE_REFERENCE") != std::string::npos);
        CheckResultDoc(c, "r2", "refused", "STALE_REFERENCE");
    }
}

static void TestIntakeIdentityABA()
{
    /* Delete + recreate with a NEW id: the issued descriptor must
       stale (itemId not found) — this is the ABA case Stage 3 could
       not detect. Legacy descriptor still resolves the impostor:
       documented residual, pinned here. Recreated with the SAME id +
       name + type is indistinguishable — the contract's stated
       guarantee boundary (SDK does not promise id uniqueness). */
    auto h = MakeFakeHost();
    FakeProject& p = h->AddProject("Shot01");
    p.path = "/tmp/s.aep";
    p.rootName = h->MakeNameSpec(FakeHost::U16("Root"));
    SetupProjectItems(*h, 0, {
        { "Alpha", AEGP_ItemType_COMP, 5001 },
        { "Beta",  AEGP_ItemType_COMP, 5002 },
    });
    h->numProjects = 1;
    TmpChan c;
    IntakeEntry(*h, c);
    const char* ident =
        "{\"projectIndex\":0,\"item\":{\"aeRef\":{\"type\":\"comp\","
        "\"name\":\"Beta\",\"path\":[1],\"itemId\":5002,"
        "\"projectName\":\"Shot01\",\"projectPath\":\"/tmp/s.aep\"}}}";
    /* delete Beta, recreate same name/type at same index, NEW id */
    p.itemMeta[1].id = 5003;
    WriteReq0600(c.Path("inbox/aba1.request.json"),
                 ReqJsonArgs("aba1", kTok, 30000,
                             "AEGP_ItemSuite9.AEGP_GetItemName", "26.5", ident));
    CHECK(CallIdle(*h) == A_Err_NONE);
    {
        std::string r = Slurp(ResultPath(c, "aba1"));
        CHECK(r.find("STALE_REFERENCE") != std::string::npos);
        CheckResultDoc(c, "aba1", "refused", "STALE_REFERENCE");
    }
    /* legacy descriptor resolves the recreated impostor — pinned as
       the known limitation identity fields fix */
    WriteReq0600(c.Path("inbox/aba2.request.json"),
                 ReqJsonArgs("aba2", kTok, 30000,
                             "AEGP_ItemSuite9.AEGP_GetItemName", "26.5",
                             "{\"projectIndex\":0,\"item\":{\"aeRef\":"
                             "{\"type\":\"comp\",\"name\":\"Beta\",\"path\":[1]}}}"));
    CHECK(CallIdle(*h) == A_Err_NONE);
    CheckResultDoc(c, "aba2", "completed", NULL);
    /* id reuse + identical name/type: indistinguishable by contract —
       resolution succeeds (documented residual, not a bug) */
    p.itemMeta[1].id = 5002;
    WriteReq0600(c.Path("inbox/aba3.request.json"),
                 ReqJsonArgs("aba3", kTok, 30000,
                             "AEGP_ItemSuite9.AEGP_GetItemName", "26.5", ident));
    CHECK(CallIdle(*h) == A_Err_NONE);
    CheckResultDoc(c, "aba3", "completed", NULL);
}

static void TestIntakeIdentityProjectBinding()
{
    /* Two projects, identical item id+name: projectName/projectPath
       corroboration is what refuses cross-project confusion. */
    auto h = MakeFakeHost();
    FakeProject& p0 = h->AddProject("Alpha");
    p0.path = "/a.aep";
    p0.rootName = h->MakeNameSpec(FakeHost::U16("Root"));
    SetupProjectItems(*h, 0, { { "Item", AEGP_ItemType_COMP, 5001 } });
    FakeProject& p1 = h->AddProject("Beta");
    p1.path = "/b.aep";
    p1.rootName = h->MakeNameSpec(FakeHost::U16("Root"));
    SetupProjectItems(*h, 1, { { "Item", AEGP_ItemType_COMP, 5001 } });
    h->numProjects = 2;
    TmpChan c;
    IntakeEntry(*h, c);
    const char* bound0 =
        "{\"projectIndex\":0,\"item\":{\"aeRef\":{\"type\":\"comp\","
        "\"name\":\"Item\",\"path\":[0],\"itemId\":5001,"
        "\"projectName\":\"Alpha\",\"projectPath\":\"/a.aep\"}}}";
    /* correct project → completed */
    WriteReq0600(c.Path("inbox/pb0.request.json"),
                 ReqJsonArgs("pb0", kTok, 30000,
                             "AEGP_ItemSuite9.AEGP_GetItemName", "26.5", bound0));
    CHECK(CallIdle(*h) == A_Err_NONE);
    CheckResultDoc(c, "pb0", "completed", NULL);
    /* same descriptor against projectIndex=1 → project name mismatch
       refuses BEFORE the item scan — no wrong-project resolution */
    {
        std::string wrong = std::string(bound0);
        wrong.replace(wrong.find("\"projectIndex\":0"), 16,
                      "\"projectIndex\":1");
        WriteReq0600(c.Path("inbox/pb1.request.json"),
                     ReqJsonArgs("pb1", kTok, 30000,
                                 "AEGP_ItemSuite9.AEGP_GetItemName", "26.5",
                                 wrong.c_str()));
        CHECK(CallIdle(*h) == A_Err_NONE);
        std::string r = Slurp(ResultPath(c, "pb1"));
        CHECK(r.find("STALE_REFERENCE") != std::string::npos);
        CheckResultDoc(c, "pb1", "refused", "STALE_REFERENCE");
    }
    /* wrong projectPath also stales */
    {
        std::string wrong = std::string(bound0);
        wrong.replace(wrong.find("/a.aep"), 6, "/b.aep");
        WriteReq0600(c.Path("inbox/pb2.request.json"),
                     ReqJsonArgs("pb2", kTok, 30000,
                                 "AEGP_ItemSuite9.AEGP_GetItemName", "26.5",
                                 wrong.c_str()));
        CHECK(CallIdle(*h) == A_Err_NONE);
        CheckResultDoc(c, "pb2", "refused", "STALE_REFERENCE");
    }
    /* descriptor bound to project 1 resolves there */
    {
        std::string b1 = std::string(bound0);
        b1.replace(b1.find("\"projectIndex\":0"), 16, "\"projectIndex\":1");
        b1.replace(b1.find("\"Alpha\""), 7, "\"Beta\"");
        b1.replace(b1.find("/a.aep"), 6, "/b.aep");
        WriteReq0600(c.Path("inbox/pb3.request.json"),
                     ReqJsonArgs("pb3", kTok, 30000,
                                 "AEGP_ItemSuite9.AEGP_GetItemName", "26.5",
                                 b1.c_str()));
        CHECK(CallIdle(*h) == A_Err_NONE);
        CheckResultDoc(c, "pb3", "completed", NULL);
    }
}

static void TestIntakeIdentitySessionRebuild()
{
    /* Session reconstruction may reassign itemIds. A descriptor issued
       before the rebuild must fail closed — never resolve against a
       recycled handle space. */
    auto h = MakeFakeHost();
    FakeProject& p = h->AddProject("Shot01");
    p.rootName = h->MakeNameSpec(FakeHost::U16("Root"));
    SetupProjectItems(*h, 0, { { "Alpha", AEGP_ItemType_COMP, 5001 } });
    h->numProjects = 1;
    TmpChan c;
    IntakeEntry(*h, c);
    const char* ident =
        "{\"projectIndex\":0,\"item\":{\"aeRef\":{\"type\":\"comp\","
        "\"name\":\"Alpha\",\"path\":[0],\"itemId\":5001}}}";
    /* sanity: resolves while ids are stable */
    WriteReq0600(c.Path("inbox/sb0.request.json"),
                 ReqJsonArgs("sb0", kTok, 30000,
                             "AEGP_ItemSuite9.AEGP_GetItemName", "26.5", ident));
    CHECK(CallIdle(*h) == A_Err_NONE);
    CheckResultDoc(c, "sb0", "completed", NULL);
    /* rebuild: itemMeta cleared → fake derives 1000+index; id 5001 gone */
    p.itemMeta.clear();
    WriteReq0600(c.Path("inbox/sb1.request.json"),
                 ReqJsonArgs("sb1", kTok, 30000,
                             "AEGP_ItemSuite9.AEGP_GetItemName", "26.5", ident));
    CHECK(CallIdle(*h) == A_Err_NONE);
    {
        std::string r = Slurp(ResultPath(c, "sb1"));
        CHECK(r.find("STALE_REFERENCE") != std::string::npos);
        CheckResultDoc(c, "sb1", "refused", "STALE_REFERENCE");
    }
}

static void TestIntakeIdentitySameNameSameType()
{
    /* Two comps named "Dup" with distinct ids: itemId is the
       discriminator — a descriptor whose path points at the OTHER
       Dup still resolves the id's owner (path is corroboration-free
       when itemId is present). */
    auto h = MakeFakeHost();
    FakeProject& p = h->AddProject("Shot01");
    p.rootName = h->MakeNameSpec(FakeHost::U16("Root"));
    SetupProjectItems(*h, 0, {
        { "Dup", AEGP_ItemType_COMP, 5001 },
        { "Dup", AEGP_ItemType_COMP, 5002 },
    });
    h->numProjects = 1;
    TmpChan c;
    IntakeEntry(*h, c);
    /* id 5001 but path claims [1] (the other Dup): GetItemID must
       return 5001 with live path [0] — id wins over path */
    WriteReq0600(c.Path("inbox/ss0.request.json"),
                 ReqJsonArgs("ss0", kTok, 30000,
                             "AEGP_ItemSuite9.AEGP_GetItemID", "26.5",
                             "{\"projectIndex\":0,\"item\":{\"aeRef\":"
                             "{\"type\":\"comp\",\"name\":\"Dup\",\"path\":[1],"
                             "\"itemId\":5001}}}"));
    CHECK(CallIdle(*h) == A_Err_NONE);
    {
        JVal* doc = NULL;
        JVal* pay = ResultPayload(c, "ss0", &doc);
        CHECK(pay != NULL);
        if (pay)
        {
            JVal* idv = PayloadNum(pay, "itemId");
            CHECK(idv && idv->num == 5001);
            JVal* ref = JGet(JGet(pay, "item"), "aeRef");
            JVal* path = ref ? JGet(ref, "path") : NULL;
            CHECK(path && path->nitems == 1 && path->items[0]->num == 0);
        }
        if (doc) JFree(doc);
        CheckResultDoc(c, "ss0", "completed", NULL);
    }
    /* legacy positional still discriminates by index */
    WriteReq0600(c.Path("inbox/ss1.request.json"),
                 ReqJsonArgs("ss1", kTok, 30000,
                             "AEGP_ItemSuite9.AEGP_GetItemID", "26.5",
                             "{\"projectIndex\":0,\"item\":{\"aeRef\":"
                             "{\"type\":\"comp\",\"name\":\"Dup\",\"path\":[1]}}}"));
    CHECK(CallIdle(*h) == A_Err_NONE);
    {
        JVal* doc = NULL;
        JVal* pay = ResultPayload(c, "ss1", &doc);
        JVal* idv = pay ? PayloadNum(pay, "itemId") : NULL;
        CHECK(idv && idv->num == 5002);
        if (doc) JFree(doc);
        CheckResultDoc(c, "ss1", "completed", NULL);
    }
}

static void TestIntakeIdentityMalformed()
{
    /* v2 descriptor shape violations refuse MALFORMED_REQUEST before
       any AEGP call — same discipline as Stage 1/3. */
    std::string longArgs;
    {
        std::string nm(1100, 'A');
        longArgs = std::string("{\"projectIndex\":0,\"item\":{\"aeRef\":{\"type\":\"comp\",\"name\":\"") + nm + "\",\"path\":[0]}}}";
    }
    static const struct { const char* id; const char* args; } cases[] = {
        { "v1", "{\"projectIndex\":0,\"item\":{\"aeRef\":{\"type\":\"comp\",\"name\":\"P\",\"path\":[0],\"itemId\":-1}}}" },
        { "v2", "{\"projectIndex\":0,\"item\":{\"aeRef\":{\"type\":\"comp\",\"name\":\"P\",\"path\":[0],\"itemId\":4294967296}}}" },
        { "v3", "{\"projectIndex\":0,\"item\":{\"aeRef\":{\"type\":\"comp\",\"name\":\"P\",\"path\":[0],\"itemId\":1.5}}}" },
        { "v4", "{\"projectIndex\":0,\"item\":{\"aeRef\":{\"type\":\"comp\",\"name\":\"P\",\"path\":[0],\"itemId\":\"7\"}}}" },
        { "v5", "{\"projectIndex\":0,\"item\":{\"aeRef\":{\"type\":\"comp\",\"name\":\"P\",\"path\":[0],\"projectName\":5}}}" },
        { "v6", "{\"projectIndex\":0,\"item\":{\"aeRef\":{\"type\":\"comp\",\"name\":\"P\",\"path\":[0],\"projectPath\":true}}}" },
        { "v7", "{\"projectIndex\":0,\"item\":{\"aeRef\":{\"type\":\"comp\",\"name\":\"P\",\"path\":[0],\"generation\":1}}}" },
        { "v9", "{\"projectIndex\":0,\"item\":{\"aeRef\":{\"type\":\"comp\",\"name\":\"P\",\"itemId\":7}}}" }, /* missing path */
    };
    auto h = MakeFakeHost();
    FakeProject& p = h->AddProject("Shot01");
    p.rootName = h->MakeNameSpec(FakeHost::U16("Root"));
    SetupProjectItems(*h, 0, { { "P", AEGP_ItemType_COMP, 7 } });
    h->numProjects = 1;
    TmpChan c;
    IntakeEntry(*h, c);
    size_t i;
    for (i = 0; i < sizeof(cases) / sizeof(cases[0]); i++)
    {
        WriteReq0600(c.Path((std::string("inbox/") + cases[i].id +
                             ".request.json").c_str()),
                     ReqJsonArgs(cases[i].id, kTok, 30000,
                                 "AEGP_ItemSuite9.AEGP_GetItemID", "26.5",
                                 cases[i].args));
        CHECK(CallIdle(*h) == A_Err_NONE);
        std::string r = Slurp(ResultPath(c, cases[i].id));
        CHECK(r.find("MALFORMED_REQUEST") != std::string::npos);
        CHECK(r.find("opCalls") == std::string::npos);
        CheckResultDoc(c, cases[i].id, "refused", "MALFORMED_REQUEST");
    }
    /* over-bound name (>1024 UTF-8 bytes) is malformed, not stale */
    WriteReq0600(c.Path("inbox/v8.request.json"),
                 ReqJsonArgs("v8", kTok, 30000,
                             "AEGP_ItemSuite9.AEGP_GetItemID", "26.5",
                             longArgs.c_str()));
    CHECK(CallIdle(*h) == A_Err_NONE);
    CheckResultDoc(c, "v8", "refused", "MALFORMED_REQUEST");
}

static void TestIntakeEnumerateUndescribableName()
{
    /* A live item name over the 1024-byte identity bound cannot be
       described: enumeration reports nameTruncated without a usable
       aeRef, and resolution refuses STALE (fail-closed). */
    auto h = MakeFakeHost();
    FakeProject& p = h->AddProject("Shot01");
    p.rootName = h->MakeNameSpec(FakeHost::U16("Root"));
    {
        std::vector<A_UTF16Char> units(1101, 'A');
        units[1100] = 0;
        p.itemNames.push_back(h->MakeNameSpec(units));
        p.itemNames.insert(p.itemNames.begin(),
                           h->MakeNameSpec(FakeHost::U16("Alpha")));
        p.itemTypes.assign(3, AEGP_ItemType_COMP);
        p.itemTypes[2] = AEGP_ItemType_SOLID_defunct; /* no descriptor tag */
        FakeItemMeta m0; m0.id = 5001;
        FakeItemMeta m1; m1.id = 5002;
        FakeItemMeta m2; m2.id = 5003;
        p.itemMeta.push_back(m0);
        p.itemMeta.push_back(m1);
        p.itemMeta.push_back(m2);
        p.itemNames.push_back(h->MakeNameSpec(FakeHost::U16("Sol")));
    }
    h->numProjects = 1;
    TmpChan c;
    IntakeEntry(*h, c);
    WriteReq0600(c.Path("inbox/en.request.json"),
                 ReqJsonArgs("en", kTok, 30000,
                             "AEGP_ItemSuite9.AEGP_GetFirstProjItem", "26.5",
                             "{\"projectIndex\":0,\"offset\":0,\"limit\":8}"));
    CHECK(CallIdle(*h) == A_Err_NONE);
    CheckResultDoc(c, "en", "completed", NULL);
    {
        JVal* doc = NULL;
        JVal* pay = ResultPayload(c, "en", &doc);
        CHECK(pay != NULL);
        if (pay)
        {
            JVal* items = JGet(pay, "items");
            CHECK(items && items->kind == JK_ARR && items->nitems == 3);
            if (items && items->nitems == 3)
            {
                JVal* e0 = items->items[0];
                JVal* e1 = items->items[1];
                JVal* e2 = items->items[2];
                CHECK(JGet(e0, "item") != NULL);           /* describable */
                CHECK(JGet(e1, "item") == NULL);           /* no usable aeRef */
                JVal* nt = JGet(e1, "nameTruncated");
                CHECK(nt && nt->kind == JK_TRUE);
                JVal* eid = PayloadNum(e1, "itemId");
                CHECK(eid && eid->num == 5002);
                /* SOLID_defunct: honest marker, never a partial aeRef */
                CHECK(JGet(e2, "item") == NULL);
                JVal* ut = JGet(e2, "unsupportedType");
                CHECK(ut && ut->kind == JK_TRUE);
            }
        }
        if (doc) JFree(doc);
    }
    /* resolution against the over-long live name fails closed —
       the descriptor cannot even carry the name (>1024 → malformed),
       and a truncated-name descriptor mismatches → stale */
    WriteReq0600(c.Path("inbox/en2.request.json"),
                 ReqJsonArgs("en2", kTok, 30000,
                             "AEGP_ItemSuite9.AEGP_GetItemName", "26.5",
                             "{\"projectIndex\":0,\"item\":{\"aeRef\":"
                             "{\"type\":\"comp\",\"name\":\"Alpha\",\"path\":[0],"
                             "\"itemId\":5002}}}"));
    CHECK(CallIdle(*h) == A_Err_NONE);
    {
        std::string r = Slurp(ResultPath(c, "en2"));
        CHECK(r.find("STALE_REFERENCE") != std::string::npos);
        CheckResultDoc(c, "en2", "refused", "STALE_REFERENCE");
    }
}

static void TestIntakeItemGetters()
{
    /* Issue #318 / #63: {projectIndex, item:<aeRefItem>} → shared
       resolver → typed ItemSuite9 detail getter on the resolved
       handle. Covers representative payload shapes plus stale,
       op-error, and missing-entry paths. */
    auto h = MakeFakeHost();
    FakeProject& p = h->AddProject("Shot01");
    p.path = "/tmp/shot01.aep";
    p.rootName = h->MakeNameSpec(FakeHost::U16("Root"));
    SetupProjectItems(*h, 0, {
        { "Clip", AEGP_ItemType_COMP, 7001 },
    });
    p.itemMeta[0].flags = 0x4;
    p.itemMeta[0].selected = TRUE;
    p.itemMeta[0].label = AEGP_Label_5;
    p.itemMeta[0].duration = {120, 24};
    p.itemMeta[0].currentTime = {10, 24};
    p.itemMeta[0].width = 1920;
    p.itemMeta[0].height = 1080;
    p.itemMeta[0].par = {16, 15};
    p.itemMeta[0].comment = h->MakeNameSpec(FakeHost::U16("selects ring"));
    h->numProjects = 1;
    TmpChan c;
    IntakeEntry(*h, c);
    const char* itemRef =
        "{\"projectIndex\":0,\"item\":{\"aeRef\":{\"type\":\"comp\","
        "\"name\":\"Clip\",\"path\":[0],\"itemId\":7001,"
        "\"projectName\":\"Shot01\",\"projectPath\":\"/tmp/shot01.aep\"}}}";

    struct { const char* id; const char* op; const char* key; } cases[] = {
        { "it",  "AEGP_ItemSuite9.AEGP_GetItemType",        "itemType" },
        { "if",  "AEGP_ItemSuite9.AEGP_GetItemFlags",       "flags" },
        { "il",  "AEGP_ItemSuite9.AEGP_GetItemLabel",       "label" },
        { "id",  "AEGP_ItemSuite9.AEGP_GetItemDuration",    NULL },
        { "ict", "AEGP_ItemSuite9.AEGP_GetItemCurrentTime", NULL },
        { "iw",  "AEGP_ItemSuite9.AEGP_GetItemDimensions",  NULL },
        { "ip",  "AEGP_ItemSuite9.AEGP_GetItemPixelAspectRatio", NULL },
    };
    for (size_t i = 0; i < sizeof(cases) / sizeof(cases[0]); i++)
    {
        char fname[64];
        snprintf(fname, sizeof(fname), "inbox/%s.request.json", cases[i].id);
        WriteReq0600(c.Path(fname),
                     ReqJsonArgs(cases[i].id, kTok, 30000, cases[i].op,
                                 "26.5", itemRef));
        CHECK(CallIdle(*h) == A_Err_NONE);
        JVal* doc = NULL;
        JVal* pay = ResultPayload(c, cases[i].id, &doc);
        CHECK(pay != NULL);
        if (pay)
        {
            if (cases[i].key && strcmp(cases[i].key, "itemType") == 0)
            {
                JVal* t = PayloadNum(pay, "itemType");
                CHECK(t != NULL && t->num == 2.0);
            }
            else if (cases[i].key && strcmp(cases[i].key, "flags") == 0)
            {
                JVal* f = PayloadNum(pay, "flags");
                CHECK(f != NULL && f->num == 4.0);
            }
            else if (cases[i].key && strcmp(cases[i].key, "label") == 0)
            {
                JVal* l = PayloadNum(pay, "label");
                CHECK(l != NULL && l->num == (double)AEGP_Label_5);
            }
            else if (strcmp(cases[i].id, "id") == 0)
            {
                JVal* d = JGet(pay, "duration");
                JVal* val = d ? PayloadNum(d, "value") : NULL;
                JVal* scl = d ? PayloadNum(d, "scale") : NULL;
                CHECK(val != NULL && val->num == 120.0);
                CHECK(scl != NULL && scl->num == 24.0);
            }
            else if (strcmp(cases[i].id, "ict") == 0)
            {
                JVal* t = JGet(pay, "currentTime");
                JVal* val = t ? PayloadNum(t, "value") : NULL;
                JVal* scl = t ? PayloadNum(t, "scale") : NULL;
                CHECK(val != NULL && val->num == 10.0);
                CHECK(scl != NULL && scl->num == 24.0);
            }
            else if (strcmp(cases[i].id, "iw") == 0)
            {
                JVal* w = PayloadNum(pay, "width");
                JVal* hh = PayloadNum(pay, "height");
                CHECK(w != NULL && w->num == 1920.0);
                CHECK(hh != NULL && hh->num == 1080.0);
            }
            else if (strcmp(cases[i].id, "ip") == 0)
            {
                JVal* par = JGet(pay, "pixelAspectRatio");
                JVal* num = par ? PayloadNum(par, "num") : NULL;
                JVal* den = par ? PayloadNum(par, "den") : NULL;
                CHECK(num != NULL && num->num == 16.0);
                CHECK(den != NULL && den->num == 15.0);
            }
        }
        if (doc) JFree(doc);
        CheckResultDoc(c, cases[i].id, "completed", NULL);
    }

    /* selected flag + comment string */
    WriteReq0600(c.Path("inbox/is.request.json"),
                 ReqJsonArgs("is", kTok, 30000,
                    "AEGP_ItemSuite9.AEGP_IsItemSelected", "26.5", itemRef));
    CHECK(CallIdle(*h) == A_Err_NONE);
    {
        JVal* doc = NULL;
        JVal* pay = ResultPayload(c, "is", &doc);
        JVal* s = pay ? JGet(pay, "selected") : NULL;
        CHECK(s != NULL && s->kind == JK_TRUE);
        if (doc) JFree(doc);
        CheckResultDoc(c, "is", "completed", NULL);
    }
    WriteReq0600(c.Path("inbox/ic.request.json"),
                 ReqJsonArgs("ic", kTok, 30000,
                    "AEGP_ItemSuite9.AEGP_GetItemComment", "26.5", itemRef));
    CHECK(CallIdle(*h) == A_Err_NONE);
    {
        std::string r = Slurp(ResultPath(c, "ic"));
        CHECK(r.find("\"comment\":\"selects ring\"") != std::string::npos);
        CheckResultDoc(c, "ic", "completed", NULL);
    }

    /* stale itemId → STALE_REFERENCE */
    {
        std::string stale = itemRef;
        size_t pos = stale.find("7001");
        stale.replace(pos, 4, "7999");
        WriteReq0600(c.Path("inbox/st.request.json"),
                     ReqJsonArgs("st", kTok, 30000,
                        "AEGP_ItemSuite9.AEGP_GetItemDuration", "26.5",
                        stale.c_str()));
    }
    CHECK(CallIdle(*h) == A_Err_NONE);
    CheckResultDoc(c, "st", "refused", "STALE_REFERENCE");

    /* itemMetaErr → all detail getters fail, mayHaveMutated=false */
    h->itemMetaErr = A_Err_GENERIC;
    WriteReq0600(c.Path("inbox/ie.request.json"),
                 ReqJsonArgs("ie", kTok, 30000,
                    "AEGP_ItemSuite9.AEGP_GetItemDuration", "26.5", itemRef));
    CHECK(CallIdle(*h) == A_Err_NONE);
    h->itemMetaErr = A_Err_NONE;
    {
        std::string r = Slurp(ResultPath(c, "ie"));
        CHECK(r.find("\"outcome\":\"failed\"") != std::string::npos);
        CHECK(r.find("\"mayHaveMutated\":false") != std::string::npos);
        CheckResultDoc(c, "ie", "failed", NULL);
    }

    /* GetItemComment entry NULL → not-sent (nullItemEntry 2) */
    h->nullItemEntry = 2;
    h->PopulateSuites();
    WriteReq0600(c.Path("inbox/in.request.json"),
                 ReqJsonArgs("in", kTok, 30000,
                    "AEGP_ItemSuite9.AEGP_GetItemComment", "26.5", itemRef));
    CHECK(CallIdle(*h) == A_Err_NONE);
    h->nullItemEntry = 0;
    h->PopulateSuites();
    CheckResultDoc(c, "in", "not-sent", NULL);
}

static void TestIntakeCompGetters()
{
    /* Issue #318 / #64: aeRef item descriptor → shared resolver →
       AEGP_GetCompFromItem → typed CompSuite13 getter → typed JSON.
       Covers happy path, identity reorder tolerance, wrong-type and
       stale refusals, non-comp item failure, suite/entry absence, and
       op-error handling. Comp suite acquire/release is balanced by the
       shared FakeHost teardown check (slot 8). */
    auto h = MakeFakeHost();
    FakeProject& p = h->AddProject("Shot01");
    p.path = "/tmp/shot01.aep";
    p.rootName = h->MakeNameSpec(FakeHost::U16("Root"));
    SetupProjectItems(*h, 0, {
        { "Clip",   AEGP_ItemType_COMP,    6001 },
        { "Reel",   AEGP_ItemType_FOOTAGE, 6002 },
        { "Folder", AEGP_ItemType_FOLDER,  6003 },
    });
    p.itemMeta[0].compMeta.fps = 24.0;
    p.itemMeta[0].compMeta.bgColor = {1.0, 0.1, 0.2, 0.3};
    p.itemMeta[0].compMeta.workAreaDuration = {60, 30};
    h->numProjects = 1;
    TmpChan c;
    IntakeEntry(*h, c);
    const char* compRef =
        "{\"projectIndex\":0,\"comp\":{\"aeRef\":{\"type\":\"comp\","
        "\"name\":\"Clip\",\"path\":[0],\"itemId\":6001,"
        "\"projectName\":\"Shot01\",\"projectPath\":\"/tmp/shot01.aep\"}}}";

    /* framerate: scalar typed payload */
    WriteReq0600(c.Path("inbox/cf.request.json"),
                 ReqJsonArgs("cf", kTok, 30000,
                    "AEGP_CompSuite13.AEGP_GetCompFramerate", "26.5", compRef));
    CHECK(CallIdle(*h) == A_Err_NONE);
    {
        JVal* doc = NULL;
        JVal* pay = ResultPayload(c, "cf", &doc);
        CHECK(pay != NULL);
        JVal* fps = PayloadNum(pay, "fps");
        CHECK(fps != NULL && fps->num == 24.0);
        if (doc) JFree(doc);
        CheckResultDoc(c, "cf", "completed", NULL);
        CHECK(h->LogContains("op AEGP_CompSuite13.AEGP_GetCompFromItem err=0"));
        CHECK(h->LogContains("op AEGP_CompSuite13.AEGP_GetCompFramerate err=0"));
    }

    /* bgColor: four-channel typed payload */
    WriteReq0600(c.Path("inbox/cb.request.json"),
                 ReqJsonArgs("cb", kTok, 30000,
                    "AEGP_CompSuite13.AEGP_GetCompBGColor", "26.5", compRef));
    CHECK(CallIdle(*h) == A_Err_NONE);
    {
        JVal* doc = NULL;
        JVal* pay = ResultPayload(c, "cb", &doc);
        CHECK(pay != NULL);
        JVal* bg = pay ? JGet(pay, "bgColor") : NULL;
        CHECK(bg != NULL);
        JVal* r = bg ? PayloadNum(bg, "red") : NULL;
        CHECK(r != NULL && r->num == 0.1);
        if (doc) JFree(doc);
        CheckResultDoc(c, "cb", "completed", NULL);
    }

    /* work-area duration: A_Time value/scale pair */
    WriteReq0600(c.Path("inbox/cw.request.json"),
                 ReqJsonArgs("cw", kTok, 30000,
                    "AEGP_CompSuite13.AEGP_GetCompWorkAreaDuration", "26.5",
                    compRef));
    CHECK(CallIdle(*h) == A_Err_NONE);
    {
        JVal* doc = NULL;
        JVal* pay = ResultPayload(c, "cw", &doc);
        CHECK(pay != NULL);
        JVal* wad = pay ? JGet(pay, "workAreaDuration") : NULL;
        JVal* val = wad ? PayloadNum(wad, "value") : NULL;
        JVal* scl = wad ? PayloadNum(wad, "scale") : NULL;
        CHECK(val != NULL && val->num == 60.0);
        CHECK(scl != NULL && scl->num == 30.0);
        if (doc) JFree(doc);
        CheckResultDoc(c, "cw", "completed", NULL);
    }

    /* reorder: Clip moves to index 2 — itemId keeps resolving */
    {
        /* move item 0 to the end via two swaps (0↔1, then 1↔2) */
        SwapProjectItems(p, 0, 1);
        SwapProjectItems(p, 1, 2);
    }
    WriteReq0600(c.Path("inbox/cr.request.json"),
                 ReqJsonArgs("cr", kTok, 30000,
                    "AEGP_CompSuite13.AEGP_GetCompFramerate", "26.5", compRef));
    CHECK(CallIdle(*h) == A_Err_NONE);
    {
        std::string r = Slurp(ResultPath(c, "cr"));
        CHECK(r.find("\"outcome\":\"completed\"") != std::string::npos);
        CHECK(r.find("\"fps\":24") != std::string::npos);
        CheckResultDoc(c, "cr", "completed", NULL);
    }

    /* stale itemId → STALE_REFERENCE, no comp calls */
    {
        std::string stale = compRef;
        size_t pos = stale.find("6001");
        stale.replace(pos, 4, "6999");
        WriteReq0600(c.Path("inbox/cs.request.json"),
                     ReqJsonArgs("cs", kTok, 30000,
                        "AEGP_CompSuite13.AEGP_GetCompFramerate", "26.5",
                        stale.c_str()));
    }
    CHECK(CallIdle(*h) == A_Err_NONE);
    CheckResultDoc(c, "cs", "refused", "STALE_REFERENCE");

    /* footage descriptor resolves (type matches) but the item is not
       a comp → AEGP_GetCompFromItem fails → failed, mayHaveMutated=false */
    WriteReq0600(c.Path("inbox/cn.request.json"),
                 ReqJsonArgs("cn", kTok, 30000,
                    "AEGP_CompSuite13.AEGP_GetCompFramerate", "26.5",
                    "{\"projectIndex\":0,\"comp\":{\"aeRef\":{\"type\":"
                    "\"footage\",\"name\":\"Reel\",\"path\":[0],"
                    "\"itemId\":6002}}}"));
    CHECK(CallIdle(*h) == A_Err_NONE);
    {
        std::string r = Slurp(ResultPath(c, "cn"));
        CHECK(r.find("\"outcome\":\"failed\"") != std::string::npos);
        CHECK(r.find("\"mayHaveMutated\":false") != std::string::npos);
        CheckResultDoc(c, "cn", "failed", NULL);
    }

    /* comp-suite acquisition failure → not-sent */
    h->failAcquireComp = true;
    WriteReq0600(c.Path("inbox/ca.request.json"),
                 ReqJsonArgs("ca", kTok, 30000,
                    "AEGP_CompSuite13.AEGP_GetCompFramerate", "26.5", compRef));
    CHECK(CallIdle(*h) == A_Err_NONE);
    h->failAcquireComp = false;
    CheckResultDoc(c, "ca", "not-sent", NULL);

    /* missing getter entry → not-sent (entry 8 = GetCompFramerate) */
    h->nullCompEntry = 8;
    h->PopulateSuites();
    WriteReq0600(c.Path("inbox/ce.request.json"),
                 ReqJsonArgs("ce", kTok, 30000,
                    "AEGP_CompSuite13.AEGP_GetCompFramerate", "26.5", compRef));
    CHECK(CallIdle(*h) == A_Err_NONE);
    h->nullCompEntry = 0;
    h->PopulateSuites();
    CheckResultDoc(c, "ce", "not-sent", NULL);

    /* comp getter AEGP error → failed, mayHaveMutated=false */
    h->compQueryErr = A_Err_GENERIC;
    WriteReq0600(c.Path("inbox/co.request.json"),
                 ReqJsonArgs("co", kTok, 30000,
                    "AEGP_CompSuite13.AEGP_GetCompFramerate", "26.5", compRef));
    CHECK(CallIdle(*h) == A_Err_NONE);
    h->compQueryErr = A_Err_NONE;
    {
        std::string r = Slurp(ResultPath(c, "co"));
        CHECK(r.find("\"outcome\":\"failed\"") != std::string::npos);
        CHECK(r.find("\"mayHaveMutated\":false") != std::string::npos);
        CheckResultDoc(c, "co", "failed", NULL);
    }
}

static void TestIntakeLayerGetters()
{
    /* Issue #318 / #64 layer slice: aeRefLayer descriptor (comp aeRef
       embedded) → comp item resolve → compH → layerId scan + name
       corroboration → typed LayerSuite9 getter → typed JSON.
       Covers issuance (GetCompLayerByIndex emits a usable descriptor),
       layer reorder tolerance, stale/ambiguous/wrong-parent refusals,
       suite/entry absence, and op-error handling. */
    auto h = MakeFakeHost();
    FakeProject& p = h->AddProject("Shot01");
    p.path = "/tmp/shot01.aep";
    p.rootName = h->MakeNameSpec(FakeHost::U16("Root"));
    SetupProjectItems(*h, 0, {
        { "Clip",   AEGP_ItemType_COMP,    6001 },
        { "Reel",   AEGP_ItemType_FOOTAGE, 6002 },
    });
    p.itemMeta[0].compMeta.layers.resize(2);
    FakeLayerMeta& l0 = p.itemMeta[0].compMeta.layers[0];
    l0.name = h->MakeNameSpec(FakeHost::U16("Layer One"));
    l0.sourceName = h->MakeNameSpec(FakeHost::U16("src0"));
    l0.flags = 0x11;
    l0.quality = AEGP_LayerQual_DRAFT;
    l0.objectType = AEGP_ObjectType_TEXT;
    l0.is3D = TRUE;
    l0.is2D = FALSE;
    l0.currentTime = {15, 30};
    l0.inPoint = {2, 30};
    l0.duration = {48, 30};
    l0.id = 4242;
    l0.label = 3;
    l0.samplingQuality = AEGP_LayerSamplingQual_BICUBIC;
    l0.sourceItemID = 77;
    l0.videoOn = FALSE;
    l0.audioOn = TRUE;
    l0.hasTrackMatte = TRUE;
    l0.isTrackMatte = FALSE;
    l0.trackMatteLayerIndex = 1;
    FakeLayerMeta& l1 = p.itemMeta[0].compMeta.layers[1];
    l1.name = h->MakeNameSpec(FakeHost::U16("Layer Two"));
    l1.sourceName = h->MakeNameSpec(FakeHost::U16("src1"));
    l1.id = 4343;
    l1.trackMatteLayerIndex = -1;
    h->numProjects = 1;
    TmpChan c;
    IntakeEntry(*h, c);

    const char* compRefJson =
        "\"comp\":{\"aeRef\":{\"type\":\"comp\",\"name\":\"Clip\","
        "\"path\":[0],\"itemId\":6001,\"projectName\":\"Shot01\","
        "\"projectPath\":\"/tmp/shot01.aep\"}}";
    /* full args object for comp-scoped ops */
    std::string compArgs =
        std::string("{\"projectIndex\":0,") + compRefJson + "}";
    /* full args object for layer ops — layer descriptor embeds the
       same comp aeRef verbatim */
    std::string layerArgs =
        std::string("{\"projectIndex\":0,\"layer\":{\"aeRef\":{"
                    "\"type\":\"layer\",\"name\":\"Layer One\","
                    "\"layerId\":4242,") + compRefJson + "}}}";
    /* NOTE: compRefJson already starts with "comp": — inside the layer
       aeRef the key is also "comp", so the nested shape is correct. */

    /* ---- comp-scoped: layer count ---- */
    WriteReq0600(c.Path("inbox/ln.request.json"),
                 ReqJsonArgs("ln", kTok, 30000,
                    "AEGP_LayerSuite9.AEGP_GetCompNumLayers", "26.5",
                    compArgs.c_str()));
    CHECK(CallIdle(*h) == A_Err_NONE);
    {
        JVal* doc = NULL;
        JVal* pay = ResultPayload(c, "ln", &doc);
        JVal* n = PayloadNum(pay, "numLayers");
        CHECK(n != NULL && n->num == 2.0);
        if (doc) JFree(doc);
        CheckResultDoc(c, "ln", "completed", NULL);
    }

    /* ---- issuance: GetCompLayerByIndex emits a usable descriptor ---- */
    std::string idxArgs =
        std::string("{\"projectIndex\":0,") + compRefJson +
        ",\"layerIndex\":0}";
    WriteReq0600(c.Path("inbox/li.request.json"),
                 ReqJsonArgs("li", kTok, 30000,
                    "AEGP_LayerSuite9.AEGP_GetCompLayerByIndex", "26.5",
                    idxArgs.c_str()));
    CHECK(CallIdle(*h) == A_Err_NONE);
    std::string issuedLayerRef;
    {
        JVal* doc = NULL;
        JVal* pay = ResultPayload(c, "li", &doc);
        CHECK(pay != NULL);
        JVal* idx = PayloadNum(pay, "index");
        CHECK(idx != NULL && idx->num == 0.0);
        JVal* layer = pay ? JGet(pay, "layer") : NULL;
        JVal* ref = layer ? JGet(layer, "aeRef") : NULL;
        CHECK(ref != NULL);
        if (ref)
        {
            CHECK(JStrEq(JGet(ref, "type"), "layer"));
            JVal* lid = PayloadNum(ref, "layerId");
            CHECK(lid != NULL && lid->num == 4242.0);
            JVal* comp = JGet(ref, "comp");
            JVal* cref = comp ? JGet(comp, "aeRef") : NULL;
            CHECK(cref != NULL);
            JVal* cid = cref ? PayloadNum(cref, "itemId") : NULL;
            CHECK(cid != NULL && cid->num == 6001.0);
        }
        CheckResultDoc(c, "li", "completed", NULL);
        if (doc) JFree(doc);
        /* extract the emitted layer aeRef verbatim for reuse below —
           proves the client never hand-assembles descriptors */
        std::string r = Slurp(ResultPath(c, "li"));
        size_t lp = r.find("\"layer\":{\"aeRef\":");
        CHECK(lp != std::string::npos);
        if (lp != std::string::npos)
        {
            size_t start = lp + 8; /* at '{' of {"aeRef":...} */
            /* find matching close: the layer object ends before ,"index"? no —
               layer is last member: ..."layer":{...}} — take through the
               aeRef object's own close by brace matching */
            int depth = 0;
            size_t i = start;
            for (; i < r.size(); i++)
            {
                if (r[i] == '{') depth++;
                else if (r[i] == '}') { depth--; if (depth == 0) { i++; break; } }
            }
            issuedLayerRef = r.substr(start, i - start);
        }
    }
    CHECK(!issuedLayerRef.empty());

    /* ---- layer getters on the hand-built descriptor ---- */
    WriteReq0600(c.Path("inbox/lx.request.json"),
                 ReqJsonArgs("lx", kTok, 30000,
                    "AEGP_LayerSuite9.AEGP_GetLayerIndex", "26.5",
                    layerArgs.c_str()));
    CHECK(CallIdle(*h) == A_Err_NONE);
    {
        JVal* doc = NULL;
        JVal* pay = ResultPayload(c, "lx", &doc);
        JVal* idx = PayloadNum(pay, "index");
        CHECK(idx != NULL && idx->num == 0.0);
        if (doc) JFree(doc);
        CheckResultDoc(c, "lx", "completed", NULL);
        CHECK(h->LogContains("op AEGP_LayerSuite9.AEGP_GetLayerIndex err=0"));
    }

    WriteReq0600(c.Path("inbox/lf.request.json"),
                 ReqJsonArgs("lf", kTok, 30000,
                    "AEGP_LayerSuite9.AEGP_GetLayerFlags", "26.5",
                    layerArgs.c_str()));
    CHECK(CallIdle(*h) == A_Err_NONE);
    {
        JVal* doc = NULL;
        JVal* pay = ResultPayload(c, "lf", &doc);
        JVal* fl = PayloadNum(pay, "flags");
        CHECK(fl != NULL && fl->num == 17.0);
        if (doc) JFree(doc);
        CheckResultDoc(c, "lf", "completed", NULL);
    }

    /* time-mode getter: explicit AEGP_LTimeMode arg */
    {
        std::string tArgs = layerArgs;
        tArgs.insert(tArgs.size() - 1, ",\"timeMode\":1");
        WriteReq0600(c.Path("inbox/lt.request.json"),
                     ReqJsonArgs("lt", kTok, 30000,
                        "AEGP_LayerSuite9.AEGP_GetLayerCurrentTime", "26.5",
                        tArgs.c_str()));
    }
    CHECK(CallIdle(*h) == A_Err_NONE);
    {
        JVal* doc = NULL;
        JVal* pay = ResultPayload(c, "lt", &doc);
        JVal* ct = pay ? JGet(pay, "currentTime") : NULL;
        JVal* val = ct ? PayloadNum(ct, "value") : NULL;
        JVal* scl = ct ? PayloadNum(ct, "scale") : NULL;
        CHECK(val != NULL && val->num == 15.0);
        CHECK(scl != NULL && scl->num == 30.0);
        if (doc) JFree(doc);
        CheckResultDoc(c, "lt", "completed", NULL);
    }

    /* booleans + ids + label + quality + sourceItemID */
    {
        const char* ops[] = {
            "AEGP_LayerSuite9.AEGP_IsLayer3D",
            "AEGP_LayerSuite9.AEGP_IsLayer2D",
            "AEGP_LayerSuite9.AEGP_GetLayerID",
            "AEGP_LayerSuite9.AEGP_GetLayerLabel",
            "AEGP_LayerSuite9.AEGP_GetLayerSamplingQuality",
            "AEGP_LayerSuite9.AEGP_GetLayerSourceItemID",
            "AEGP_LayerSuite9.AEGP_IsLayerVideoReallyOn",
            "AEGP_LayerSuite9.AEGP_IsLayerAudioReallyOn",
            "AEGP_LayerSuite9.AEGP_DoesLayerHaveTrackMatte",
            "AEGP_LayerSuite9.AEGP_GetLayerObjectType",
            "AEGP_LayerSuite9.AEGP_GetLayerQuality",
        };
        const char* ids[] = { "b3", "b2", "gi", "gl", "gq", "gs",
                              "gv", "ga", "gm", "go", "gql" };
        for (int i = 0; i < 11; i++)
        {
            char fname[64];
            snprintf(fname, sizeof(fname), "inbox/%s.request.json", ids[i]);
            WriteReq0600(c.Path(fname),
                         ReqJsonArgs(ids[i], kTok, 30000, ops[i], "26.5",
                                     layerArgs.c_str()));
        }
        for (int i = 0; i < 11; i++)
            CHECK(CallIdle(*h) == A_Err_NONE);
        {
            JVal* doc = NULL;
            JVal* pay;
            pay = ResultPayload(c, "b3", &doc); CHECK(pay != NULL);
            JVal* b = pay ? JGet(pay, "is3D") : NULL;
            CHECK(b != NULL && b->kind == JK_TRUE);
            if (doc) JFree(doc);
            pay = ResultPayload(c, "b2", &doc); CHECK(pay != NULL);
            b = pay ? JGet(pay, "is2D") : NULL;
            CHECK(b != NULL && b->kind == JK_FALSE);
            if (doc) JFree(doc);
            pay = ResultPayload(c, "gi", &doc); CHECK(pay != NULL);
            JVal* lid = PayloadNum(pay, "layerId");
            CHECK(lid != NULL && lid->num == 4242.0);
            if (doc) JFree(doc);
            pay = ResultPayload(c, "gl", &doc); CHECK(pay != NULL);
            JVal* lb = PayloadNum(pay, "label");
            CHECK(lb != NULL && lb->num == 3.0);
            if (doc) JFree(doc);
            pay = ResultPayload(c, "gq", &doc); CHECK(pay != NULL);
            JVal* sq = PayloadNum(pay, "samplingQuality");
            CHECK(sq != NULL && sq->num != 0.0);
            if (doc) JFree(doc);
            pay = ResultPayload(c, "gs", &doc); CHECK(pay != NULL);
            JVal* sid = PayloadNum(pay, "sourceItemId");
            CHECK(sid != NULL && sid->num == 77.0);
            if (doc) JFree(doc);
            pay = ResultPayload(c, "gv", &doc); CHECK(pay != NULL);
            b = pay ? JGet(pay, "videoOn") : NULL;
            CHECK(b != NULL && b->kind == JK_FALSE);
            if (doc) JFree(doc);
            pay = ResultPayload(c, "ga", &doc); CHECK(pay != NULL);
            b = pay ? JGet(pay, "audioOn") : NULL;
            CHECK(b != NULL && b->kind == JK_TRUE);
            if (doc) JFree(doc);
            pay = ResultPayload(c, "gm", &doc); CHECK(pay != NULL);
            b = pay ? JGet(pay, "hasTrackMatte") : NULL;
            CHECK(b != NULL && b->kind == JK_TRUE);
            if (doc) JFree(doc);
            for (int i = 0; i < 11; i++)
                CheckResultDoc(c, ids[i], "completed", NULL);
        }
    }

    /* matte-arg getter: fillMustBeActive bounded int */
    {
        std::string mArgs = layerArgs;
        mArgs.insert(mArgs.size() - 1, ",\"fillMustBeActive\":0");
        WriteReq0600(c.Path("inbox/mm.request.json"),
                     ReqJsonArgs("mm", kTok, 30000,
                        "AEGP_LayerSuite9.AEGP_IsLayerUsedAsTrackMatte",
                        "26.5", mArgs.c_str()));
    }
    CHECK(CallIdle(*h) == A_Err_NONE);
    {
        JVal* doc = NULL;
        JVal* pay = ResultPayload(c, "mm", &doc);
        JVal* b = pay ? JGet(pay, "isTrackMatte") : NULL;
        CHECK(b != NULL && b->kind == JK_FALSE);
        if (doc) JFree(doc);
        CheckResultDoc(c, "mm", "completed", NULL);
    }

    /* track-matte layer: emits a nested aeRefLayer descriptor */
    WriteReq0600(c.Path("inbox/tm.request.json"),
                 ReqJsonArgs("tm", kTok, 30000,
                    "AEGP_LayerSuite9.AEGP_GetTrackMatteLayer", "26.5",
                    layerArgs.c_str()));
    CHECK(CallIdle(*h) == A_Err_NONE);
    {
        JVal* doc = NULL;
        JVal* pay = ResultPayload(c, "tm", &doc);
        CHECK(pay != NULL);
        JVal* tml = pay ? JGet(pay, "trackMatteLayer") : NULL;
        JVal* ref = tml ? JGet(tml, "aeRef") : NULL;
        CHECK(ref != NULL);
        if (ref)
        {
            JVal* lid = PayloadNum(ref, "layerId");
            CHECK(lid != NULL && lid->num == 4343.0); /* l0 matte → l1 */
            JVal* nm = JGet(ref, "name");
            CHECK(nm != NULL && nm->kind == JK_STR);
        }
        if (doc) JFree(doc);
        CheckResultDoc(c, "tm", "completed", NULL);
    }

    /* GetLayerName: both mem handles read + freed */
    WriteReq0600(c.Path("inbox/lnm.request.json"),
                 ReqJsonArgs("lnm", kTok, 30000,
                    "AEGP_LayerSuite9.AEGP_GetLayerName", "26.5",
                    layerArgs.c_str()));
    CHECK(CallIdle(*h) == A_Err_NONE);
    {
        JVal* doc = NULL;
        JVal* pay = ResultPayload(c, "lnm", &doc);
        CHECK(pay != NULL);
        JVal* nm = pay ? JGet(pay, "name") : NULL;
        JVal* sn = pay ? JGet(pay, "sourceName") : NULL;
        CHECK(nm != NULL && nm->kind == JK_STR &&
              nm->slen == strlen("Layer One") &&
              memcmp(nm->str, "Layer One", nm->slen) == 0);
        CHECK(sn != NULL && sn->kind == JK_STR &&
              sn->slen == strlen("src0") &&
              memcmp(sn->str, "src0", sn->slen) == 0);
        if (doc) JFree(doc);
        CheckResultDoc(c, "lnm", "completed", NULL);
    }

    /* issued descriptor reuse: verbatim aeRefLayer from "li" resolves */
    if (!issuedLayerRef.empty())
    {
        std::string reuseArgs =
            std::string("{\"projectIndex\":0,\"layer\":") +
            issuedLayerRef + "}";
        WriteReq0600(c.Path("inbox/lr.request.json"),
                     ReqJsonArgs("lr", kTok, 30000,
                        "AEGP_LayerSuite9.AEGP_GetLayerID", "26.5",
                        reuseArgs.c_str()));
        CHECK(CallIdle(*h) == A_Err_NONE);
        CheckResultDoc(c, "lr", "completed", NULL);
    }

    /* ---- refusal paths ---- */

    /* stale layerId → STALE_REFERENCE */
    {
        std::string stale = layerArgs;
        size_t pos = stale.find("4242");
        stale.replace(pos, 4, "9999");
        WriteReq0600(c.Path("inbox/ls.request.json"),
                     ReqJsonArgs("ls", kTok, 30000,
                        "AEGP_LayerSuite9.AEGP_GetLayerID", "26.5",
                        stale.c_str()));
    }
    CHECK(CallIdle(*h) == A_Err_NONE);
    CheckResultDoc(c, "ls", "refused", "STALE_REFERENCE");

    /* right id, wrong name → STALE_REFERENCE (rename stales) */
    {
        std::string wrong = layerArgs;
        size_t pos = wrong.find("Layer One");
        wrong.replace(pos, 9, "Renamed!!");
        WriteReq0600(c.Path("inbox/lw.request.json"),
                     ReqJsonArgs("lw", kTok, 30000,
                        "AEGP_LayerSuite9.AEGP_GetLayerID", "26.5",
                        wrong.c_str()));
    }
    CHECK(CallIdle(*h) == A_Err_NONE);
    CheckResultDoc(c, "lw", "refused", "STALE_REFERENCE");

    /* layer descriptor bound to the footage item → parent is not a
       comp → STALE_REFERENCE */
    {
        std::string bad = layerArgs;
        size_t pos = bad.find("\"type\":\"comp\"");
        bad.replace(pos, 13, "\"type\":\"footage\"");
        pos = bad.find("\"name\":\"Clip\"");
        bad.replace(pos, 13, "\"name\":\"Reel\"");
        pos = bad.find("\"itemId\":6001");
        bad.replace(pos, 13, "\"itemId\":6002");
        WriteReq0600(c.Path("inbox/lp.request.json"),
                     ReqJsonArgs("lp", kTok, 30000,
                        "AEGP_LayerSuite9.AEGP_GetLayerID", "26.5",
                        bad.c_str()));
    }
    CHECK(CallIdle(*h) == A_Err_NONE);
    CheckResultDoc(c, "lp", "refused", "STALE_REFERENCE");

    /* layer reorder: swap the two layers — layerId still resolves,
       GetLayerIndex now reports the live position 1 */
    std::swap(p.itemMeta[0].compMeta.layers[0],
              p.itemMeta[0].compMeta.layers[1]);
    {
        std::string l1args = layerArgs; /* still "Layer One"/4242 */
        WriteReq0600(c.Path("inbox/lr2.request.json"),
                     ReqJsonArgs("lr2", kTok, 30000,
                        "AEGP_LayerSuite9.AEGP_GetLayerIndex", "26.5",
                        l1args.c_str()));
    }
    CHECK(CallIdle(*h) == A_Err_NONE);
    {
        JVal* doc = NULL;
        JVal* pay = ResultPayload(c, "lr2", &doc);
        JVal* idx = PayloadNum(pay, "index");
        CHECK(idx != NULL && idx->num == 1.0); /* reordered to index 1 */
        if (doc) JFree(doc);
        CheckResultDoc(c, "lr2", "completed", NULL);
    }
    std::swap(p.itemMeta[0].compMeta.layers[0],
              p.itemMeta[0].compMeta.layers[1]);

    /* malformed: layerId out of int32 range → MALFORMED_REQUEST */
    {
        std::string bad = layerArgs;
        size_t pos = bad.find("4242");
        bad.replace(pos, 4, "99999999999");
        WriteReq0600(c.Path("inbox/lm.request.json"),
                     ReqJsonArgs("lm", kTok, 30000,
                        "AEGP_LayerSuite9.AEGP_GetLayerID", "26.5",
                        bad.c_str()));
    }
    CHECK(CallIdle(*h) == A_Err_NONE);
    CheckResultDoc(c, "lm", "refused", "MALFORMED_REQUEST");

    /* malformed: aeRefLayer missing comp → MALFORMED_REQUEST */
    {
        std::string bad =
            "{\"projectIndex\":0,\"layer\":{\"aeRef\":{\"type\":\"layer\","
            "\"name\":\"Layer One\",\"layerId\":4242}}}";
        WriteReq0600(c.Path("inbox/lc.request.json"),
                     ReqJsonArgs("lc", kTok, 30000,
                        "AEGP_LayerSuite9.AEGP_GetLayerID", "26.5",
                        bad.c_str()));
    }
    CHECK(CallIdle(*h) == A_Err_NONE);
    CheckResultDoc(c, "lc", "refused", "MALFORMED_REQUEST");

    /* layer-suite acquisition failure → not-sent */
    h->failAcquireLayer = true;
    WriteReq0600(c.Path("inbox/la.request.json"),
                 ReqJsonArgs("la", kTok, 30000,
                    "AEGP_LayerSuite9.AEGP_GetLayerID", "26.5",
                    layerArgs.c_str()));
    CHECK(CallIdle(*h) == A_Err_NONE);
    h->failAcquireLayer = false;
    CheckResultDoc(c, "la", "not-sent", NULL);

    /* missing getter entry → not-sent (entry 5 = GetLayerFlags) */
    h->nullLayerEntry = 5;
    h->PopulateSuites();
    WriteReq0600(c.Path("inbox/le.request.json"),
                 ReqJsonArgs("le", kTok, 30000,
                    "AEGP_LayerSuite9.AEGP_GetLayerFlags", "26.5",
                    layerArgs.c_str()));
    CHECK(CallIdle(*h) == A_Err_NONE);
    h->nullLayerEntry = 0;
    h->PopulateSuites();
    CheckResultDoc(c, "le", "not-sent", NULL);

    /* layer getter AEGP error → failed, mayHaveMutated=false. The same
       flag fails the resolve scan's GetCompNumLayers — still an honest
       `failed` (no mutation possible on a read path). */
    h->layerQueryErr = A_Err_GENERIC;
    WriteReq0600(c.Path("inbox/lq.request.json"),
                 ReqJsonArgs("lq", kTok, 30000,
                    "AEGP_LayerSuite9.AEGP_GetLayerID", "26.5",
                    layerArgs.c_str()));
    CHECK(CallIdle(*h) == A_Err_NONE);
    h->layerQueryErr = A_Err_NONE;
    {
        std::string r = Slurp(ResultPath(c, "lq"));
        CHECK(r.find("\"outcome\":\"failed\"") != std::string::npos);
        CHECK(r.find("\"mayHaveMutated\":false") != std::string::npos);
        CheckResultDoc(c, "lq", "failed", NULL);
    }

    /* out-of-range layerIndex on issuance → failed (AEGP error) */
    {
        std::string oob =
            std::string("{\"projectIndex\":0,") + compRefJson +
            ",\"layerIndex\":99}";
        WriteReq0600(c.Path("inbox/lo.request.json"),
                     ReqJsonArgs("lo", kTok, 30000,
                        "AEGP_LayerSuite9.AEGP_GetCompLayerByIndex",
                        "26.5", oob.c_str()));
    }
    CHECK(CallIdle(*h) == A_Err_NONE);
    CheckResultDoc(c, "lo", "failed", NULL);
}

static void TestIntakeUnknownOperation()
{
    auto h = MakeFakeHost();
    TmpChan c;
    IntakeEntry(*h, c);
    WriteReq0600(c.Path("inbox/u.request.json"),
                 ReqJson("u", kTok, 30000,
                         "AEGP_ProjSuite6.AEGP_GetProjectName", "26.5", NULL, NULL));
    CHECK(CallIdle(*h) == A_Err_NONE);
    std::string r = Slurp(ResultPath(c, "u"));
    CHECK(r.find("OPERATION_NOT_DISPATCHABLE") != std::string::npos);
    CHECK(r.find("\"outcome\":\"refused\"") != std::string::npos);
    CheckResultDoc(c, "u", "refused", "OPERATION_NOT_DISPATCHABLE");
    /* refused before any suite call: no op records for this request */
    CHECK(!h->LogContains("op AEGP_ProjSuite6.AEGP_GetProjectName"));
}

static void TestIntakeStaleDeadline()
{
    auto h = MakeFakeHost();
    TmpChan c;
    IntakeEntry(*h, c);
    std::string p = c.Path("inbox/s.request.json");
    WriteReq0600(p,
                 ReqJson("s", kTok, 1000,
                         "AEGP_ProjSuite6.AEGP_GetNumProjects", "26.5", NULL, NULL));
    /* age the file 60 s into the past: deadline = mtime + 1 s is past */
    struct timespec ts[2];
    ts[0].tv_sec = ts[1].tv_sec = time(NULL) - 60;
    ts[0].tv_nsec = ts[1].tv_nsec = 0;
    CHECK(utimensat(AT_FDCWD, p.c_str(), ts, 0) == 0);
    CHECK(CallIdle(*h) == A_Err_NONE);
    std::string r = Slurp(ResultPath(c, "s"));
    CHECK(r.find("STALE_REQUEST") != std::string::npos);
    CheckResultDoc(c, "s", "refused", "STALE_REQUEST");
}

static void TestIntakeDeadlineBounds()
{
    auto h = MakeFakeHost();
    TmpChan c;
    IntakeEntry(*h, c);
    /* negative and absurd deadlines are malformed, never executed */
    WriteReq0600(c.Path("inbox/dn.request.json"),
                 ReqJson("dn", kTok, -1,
                         "AEGP_ProjSuite6.AEGP_GetNumProjects", "26.5", NULL, NULL));
    {
        char b[2048];
        snprintf(b, sizeof(b),
            "{\"v\":1,\"token\":\"%s\",\"timeoutMs\":1e300,\"request\":{"
            "\"schema\":\"ae-devtools/native-dispatch/v1\",\"requestId\":\"dh\","
            "\"session\":{\"sessionId\":\"sess-1\",\"aeVersion\":\"26.5\"},"
            "\"operationId\":\"AEGP_ProjSuite6.AEGP_GetNumProjects\","
            "\"args\":null,\"authorizationRef\":\"o\"}}",
            kTok);
        WriteReq0600(c.Path("inbox/dh.request.json"), b);
    }
    CHECK(CallIdle(*h) == A_Err_NONE); /* dn processed (name-sorted first) */
    CHECK(CallIdle(*h) == A_Err_NONE); /* dh next tick */
    CHECK(Slurp(ResultPath(c, "dn")).find("MALFORMED_REQUEST") != std::string::npos);
    CHECK(Slurp(ResultPath(c, "dh")).find("MALFORMED_REQUEST") != std::string::npos);
    CheckResultDoc(c, "dn", "refused", "MALFORMED_REQUEST");
    CheckResultDoc(c, "dh", "refused", "MALFORMED_REQUEST");
}

static void TestIntakeSymlinkRequestNotClaimed()
{
    auto h = MakeFakeHost();
    TmpChan c;
    IntakeEntry(*h, c);
    /* a symlink with a request-shaped name must never be claimed or read */
    std::string target = c.Path("secret.txt");
    WriteReq0600(target, "top secret payload");
    std::string link = c.Path("inbox/l.request.json");
    CHECK(symlink(target.c_str(), link.c_str()) == 0);
    CHECK(CallIdle(*h) == A_Err_NONE);
    CHECK(Exists(link)); /* untouched */
    CHECK(!Exists(ResultPath(c, "l")));
    CHECK(!h->LogContains("native.request id=l"));
}

static void TestIntakePartSymlinkNeverWrittenThrough()
{
    auto h = MakeFakeHost();
    TmpChan c;
    IntakeEntry(*h, c);
    /* pre-plant a symlink at the staging path: O_NOFOLLOW must refuse to
       write through it — the victim file is never touched */
    std::string victim = c.Path("victim.txt");
    WriteReq0600(victim, "do not overwrite");
    std::string part = c.Path("outbox/y.result.json.part");
    CHECK(symlink(victim.c_str(), part.c_str()) == 0);
    WriteReq0600(c.Path("inbox/y.request.json"),
                 ReqJson("y", kTok, 30000,
                         "AEGP_ProjSuite6.AEGP_GetNumProjects", "26.5", NULL, NULL));
    CHECK(CallIdle(*h) == A_Err_NONE);
    CHECK(Slurp(victim) == "do not overwrite");
    /* the planted link is dropped and the retry publishes atomically —
       or, if it keeps failing, the caller sees UNKNOWN, never a partial
       result. Either way no non-atomic write ever occurred. */
    std::string r = Slurp(ResultPath(c, "y"));
    CHECK(r.empty() || r.find("\"outcome\"") != std::string::npos);
    if (!r.empty()) CheckResultDoc(c, "y", "completed", NULL);
    CHECK(!Exists(part));
}

static void TestIntakeClaimedLeftoverIgnored()
{
    auto h = MakeFakeHost();
    TmpChan c;
    IntakeEntry(*h, c);
    /* a *.claimed leftover from a crashed earlier run is evidence only */
    WriteReq0600(c.Path("inbox/stale.claimed"), "{\"v\":1}");
    WriteReq0600(c.Path("inbox/q.request.json"),
                 ReqJson("q", kTok, 30000,
                         "AEGP_ProjSuite6.AEGP_GetNumProjects", "26.5", NULL, NULL));
    CHECK(CallIdle(*h) == A_Err_NONE);
    CHECK(Exists(c.Path("inbox/stale.claimed")));
    CHECK(Slurp(ResultPath(c, "q")).find("completed") != std::string::npos);
    CheckResultDoc(c, "q", "completed", NULL);
}

static void TestIntakeTokenMismatch()
{
    auto h = MakeFakeHost();
    TmpChan c;
    IntakeEntry(*h, c);
    WriteReq0600(c.Path("inbox/t.request.json"),
                 ReqJson("t", kTokBad, 30000,
                         "AEGP_ProjSuite6.AEGP_GetNumProjects", "26.5", NULL, NULL));
    CHECK(CallIdle(*h) == A_Err_NONE);
    std::string r = Slurp(ResultPath(c, "t"));
    CHECK(r.find("CHANNEL_TOKEN_MISMATCH") != std::string::npos);
    CheckResultDoc(c, "t", "refused", "CHANNEL_TOKEN_MISMATCH");
}

static void TestIntakeSessionMismatch()
{
    auto h = MakeFakeHost();
    TmpChan c;
    IntakeEntry(*h, c);
    WriteReq0600(c.Path("inbox/m.request.json"),
                 ReqJson("m", kTok, 30000,
                         "AEGP_ProjSuite6.AEGP_GetNumProjects", "25.0", NULL, NULL));
    CHECK(CallIdle(*h) == A_Err_NONE);
    std::string r = Slurp(ResultPath(c, "m"));
    CHECK(r.find("WRONG_TARGET") != std::string::npos);
    CheckResultDoc(c, "m", "refused", "WRONG_TARGET");
    /* version attestation ran (op-recorded) before the refusal */
    CHECK(r.find("AEGP_UtilitySuite6.AEGP_GetDriverImplementationVersion") != std::string::npos);
}

static void TestIntakeTargetMismatchSkipped()
{
    auto h = MakeFakeHost();
    TmpChan c;
    IntakeEntry(*h, c);
    WriteReq0600(c.Path("inbox/x.request.json"),
                 ReqJson("x", kTok, 30000,
                         "AEGP_ProjSuite6.AEGP_GetNumProjects", "26.5",
                         "some-other-instance", NULL));
    CHECK(CallIdle(*h) == A_Err_NONE);
    /* not ours: left in inbox, no result */
    CHECK(Exists(c.Path("inbox/x.request.json")));
    CHECK(!Exists(ResultPath(c, "x")));
    CHECK(!h->LogContains("native.request id=x"));
}

static void TestIntakeMalformed()
{
    auto h = MakeFakeHost();
    TmpChan c;
    IntakeEntry(*h, c);
    WriteReq0600(c.Path("inbox/bad.request.json"), "this is not json{{{");
    CHECK(CallIdle(*h) == A_Err_NONE);
    std::string r = Slurp(ResultPath(c, "bad"));
    CHECK(r.find("MALFORMED_REQUEST") != std::string::npos);
    CheckResultDoc(c, "bad", "refused", "MALFORMED_REQUEST");
}

static void TestIntakeDuplicateRequestId()
{
    auto h = MakeFakeHost();
    TmpChan c;
    IntakeEntry(*h, c);
    WriteReq0600(c.Path("inbox/d.request.json"),
                 ReqJson("d", kTok, 30000,
                         "AEGP_ProjSuite6.AEGP_GetNumProjects", "26.5", NULL, NULL));
    CHECK(CallIdle(*h) == A_Err_NONE);
    CHECK(Slurp(ResultPath(c, "d")).find("completed") != std::string::npos);
    /* same requestId re-issued: refused, never re-executed */
    WriteReq0600(c.Path("inbox/d.request.json"),
                 ReqJson("d", kTok, 30000,
                         "AEGP_ProjSuite6.AEGP_GetNumProjects", "26.5", NULL, NULL));
    CHECK(CallIdle(*h) == A_Err_NONE);
    std::string r = Slurp(ResultPath(c, "d"));
    CHECK(r.find("DUPLICATE_REQUEST") != std::string::npos);
    CheckResultDoc(c, "d", "refused", "DUPLICATE_REQUEST");
}

static void TestIntakeOnePerTick()
{
    auto h = MakeFakeHost();
    TmpChan c;
    IntakeEntry(*h, c);
    WriteReq0600(c.Path("inbox/a1.request.json"),
                 ReqJson("a1", kTok, 30000,
                         "AEGP_ProjSuite6.AEGP_GetNumProjects", "26.5", NULL, NULL));
    WriteReq0600(c.Path("inbox/a2.request.json"),
                 ReqJson("a2", kTok, 30000,
                         "AEGP_ProjSuite6.AEGP_GetNumProjects", "26.5", NULL, NULL));
    CHECK(CallIdle(*h) == A_Err_NONE);
    CHECK(Exists(ResultPath(c, "a1")));
    CHECK(!Exists(ResultPath(c, "a2")));
    CHECK(Exists(c.Path("inbox/a2.request.json")));
    CHECK(CallIdle(*h) == A_Err_NONE);
    CHECK(Exists(ResultPath(c, "a2")));
}

static void TestIntakeSuiteFailureGivesFailed()
{
    auto h = MakeFakeHost();
    h->numProjectsErr = A_Err_GENERIC;
    TmpChan c;
    IntakeEntry(*h, c);
    WriteReq0600(c.Path("inbox/f.request.json"),
                 ReqJson("f", kTok, 30000,
                         "AEGP_ProjSuite6.AEGP_GetNumProjects", "26.5", NULL, NULL));
    CHECK(CallIdle(*h) == A_Err_NONE);
    std::string r = Slurp(ResultPath(c, "f"));
    CHECK(r.find("\"outcome\":\"failed\"") != std::string::npos);
    CHECK(r.find("mayHaveMutated\":false") != std::string::npos);
    CheckResultDoc(c, "f", "failed", NULL);
    CHECK(h->LogContains("op AEGP_ProjSuite6.AEGP_GetNumProjects err="));
}

static void TestIntakeMissingEntryAbortsBeforeIntake()
{
    auto h = MakeFakeHost();
    h->nullProjEntry = 1; /* GetNumProjects entry NULL: probe aborts in stage 1 */
    h->PopulateSuites();
    TmpChan c;
    IntakeEntry(*h, c);
    WriteReq0600(c.Path("inbox/n.request.json"),
                 ReqJson("n", kTok, 30000,
                         "AEGP_ProjSuite6.AEGP_GetNumProjects", "26.5", NULL, NULL));
    A_long ms = 0;
    (void)h->idleHook(NULL, NULL, &ms); /* probe aborts; intake never reached */
    /* request preserved untouched for a later healthy tick */
    CHECK(Exists(c.Path("inbox/n.request.json")));
    CHECK(!Exists(ResultPath(c, "n")));
    CHECK(!h->LogContains("native.request id=n"));
}

static void TestIntakeResultPublishFailure()
{
    auto h = MakeFakeHost();
    TmpChan c;
    IntakeEntry(*h, c);
    chmod(c.Path("outbox").c_str(), 0500); /* channel check still passes (no group/other bits) */
    WriteReq0600(c.Path("inbox/w.request.json"),
                 ReqJson("w", kTok, 30000,
                         "AEGP_ProjSuite6.AEGP_GetNumProjects", "26.5", NULL, NULL));
    CHECK(CallIdle(*h) == A_Err_NONE);
    chmod(c.Path("outbox").c_str(), 0700);
    CHECK(!Exists(ResultPath(c, "w")));
    CHECK(h->LogContains("native.error: result publish failed"));
    /* claimed file consumed; no unsafe resend of the same id */
    CHECK(!Exists(c.Path("inbox/w.request.json")));
}

static void TestIntakeInterruptedBySuiteAcquireFailure()
{
    auto h = MakeFakeHost();
    TmpChan c;
    IntakeEntry(*h, c);
    WriteReq0600(c.Path("inbox/i.request.json"),
                 ReqJson("i", kTok, 30000,
                         "AEGP_ProjSuite6.AEGP_GetNumProjects", "26.5", NULL, NULL));
    h->failAcquireProj = true;
    h->PopulateSuites();
    {
        A_long ms = 0;
        (void)h->idleHook(NULL, NULL, &ms); /* stage-1 failure: hook returns early */
    }
    /* stage-1 failure: intake never ran, request untouched */
    CHECK(Exists(c.Path("inbox/i.request.json")));
    CHECK(!Exists(ResultPath(c, "i")));
    CHECK(!h->LogContains("native.request id=i"));
    /* recovery: next healthy tick claims and completes it */
    h->failAcquireProj = false;
    h->PopulateSuites();
    CHECK(CallIdle(*h) == A_Err_NONE);
    CHECK(Slurp(ResultPath(c, "i")).find("completed") != std::string::npos);
    CheckResultDoc(c, "i", "completed", NULL);
}

static void TestIntakeChannelPrivacyViolation()
{
    auto h = MakeFakeHost();
    TmpChan c;
    IntakeEntry(*h, c);
    chmod(c.Path("inbox").c_str(), 0755); /* group/other accessible: refuse to use channel */
    WriteReq0600(c.Path("inbox/p.request.json"),
                 ReqJson("p", kTok, 30000,
                         "AEGP_ProjSuite6.AEGP_GetNumProjects", "26.5", NULL, NULL));
    CHECK(CallIdle(*h) == A_Err_NONE);
    chmod(c.Path("inbox").c_str(), 0700);
    CHECK(!Exists(ResultPath(c, "p")));
    CHECK(Exists(c.Path("inbox/p.request.json")));
    CHECK(h->LogContains("native.error: channel privacy check failed"));
}

/* Issue #318 §7e: aeRefProject descriptor → index+name+path
   corroboration + collision scan → borrowed projectH → typed
   ProjSuite6 getter. Covers the three getters, name/path mismatch,
   index reuse after close/open (project vector mutation), empty-path
   save tolerance, and the ambiguous-identity collision refusal. */
static void TestIntakeProjectGetters()
{
    auto h = MakeFakeHost();
    FakeProject& p0 = h->AddProject("Shot01");
    p0.path = "/tmp/shot01.aep";
    p0.dirty = TRUE;
    p0.bitDepth = AEGP_ProjBitDepth_16;
    p0.timeDisplay.display_mode = 1;
    p0.timeDisplay.footage_display_mode = 2;
    p0.timeDisplay.display_dropframeB = TRUE;
    p0.timeDisplay.use_feet_framesB = FALSE;
    p0.timeDisplay.timebaseC = 'f';
    p0.timeDisplay.frames_per_footC = 24;
    p0.timeDisplay.frames_display_mode = 3;
    FakeProject& p1 = h->AddProject("Untitled");
    p1.path = "";
    h->numProjects = 2;
    TmpChan c;
    IntakeEntry(*h, c);

    const char* proj0 =
        "{\"project\":{\"aeRef\":{\"type\":\"project\",\"index\":0,"
        "\"name\":\"Shot01\",\"path\":\"/tmp/shot01.aep\"}}}";
    const char* proj1 =
        "{\"project\":{\"aeRef\":{\"type\":\"project\",\"index\":1,"
        "\"name\":\"Untitled\",\"path\":\"\"}}}";

    /* ---- three typed getters on project 0 (one request per tick) ---- */
    WriteReq0600(c.Path("inbox/pd.request.json"),
                 ReqJsonArgs("pd", kTok, 30000,
                    "AEGP_ProjSuite6.AEGP_ProjectIsDirty", "26.5", proj0));
    CHECK(CallIdle(*h) == A_Err_NONE);
    {
        JVal* doc = NULL;
        JVal* pay = ResultPayload(c, "pd", &doc);
        JVal* d = pay ? JGet(pay, "dirty") : NULL;
        CHECK(d != NULL && d->kind == JK_TRUE);
        if (doc) JFree(doc);
        CheckResultDoc(c, "pd", "completed", NULL);
    }
    WriteReq0600(c.Path("inbox/pb.request.json"),
                 ReqJsonArgs("pb", kTok, 30000,
                    "AEGP_ProjSuite6.AEGP_GetProjectBitDepth", "26.5", proj0));
    CHECK(CallIdle(*h) == A_Err_NONE);
    {
        JVal* doc = NULL;
        JVal* pay = ResultPayload(c, "pb", &doc);
        JVal* bd = PayloadNum(pay, "bitDepth");
        CHECK(bd != NULL && bd->num == 1.0); /* AEGP_ProjBitDepth_16 */
        if (doc) JFree(doc);
        CheckResultDoc(c, "pb", "completed", NULL);
    }
    WriteReq0600(c.Path("inbox/pt.request.json"),
                 ReqJsonArgs("pt", kTok, 30000,
                    "AEGP_ProjSuite6.AEGP_GetProjectTimeDisplay", "26.5", proj0));
    CHECK(CallIdle(*h) == A_Err_NONE);
    {
        JVal* doc = NULL;
        JVal* pay = ResultPayload(c, "pt", &doc);
        JVal* td = pay ? JGet(pay, "timeDisplay") : NULL;
        CHECK(td != NULL);
        JVal* tb = td ? PayloadNum(td, "timebase") : NULL;
        CHECK(tb != NULL && tb->num == (double)'f');
        JVal* fpf = td ? PayloadNum(td, "framesPerFoot") : NULL;
        CHECK(fpf != NULL && fpf->num == 24.0);
        JVal* df = td ? JGet(td, "displayDropFrame") : NULL;
        CHECK(df != NULL && df->kind == JK_TRUE);
        if (doc) JFree(doc);
        CheckResultDoc(c, "pt", "completed", NULL);
    }

    /* ---- untitled project: empty path descriptor resolves ---- */
    WriteReq0600(c.Path("inbox/pu.request.json"),
                 ReqJsonArgs("pu", kTok, 30000,
                    "AEGP_ProjSuite6.AEGP_ProjectIsDirty", "26.5", proj1));
    CHECK(CallIdle(*h) == A_Err_NONE);
    CheckResultDoc(c, "pu", "completed", NULL);

    /* ---- empty descriptor path tolerates a later save (path gains
       value): document tolerance, resolution still succeeds ---- */
    {
        const char* savedArgs =
            "{\"project\":{\"aeRef\":{\"type\":\"project\",\"index\":1,"
            "\"name\":\"Untitled\",\"path\":\"\"}}}";
        h->projects[1].path = "/tmp/now-saved.aep";
        WriteReq0600(c.Path("inbox/ps.request.json"),
                     ReqJsonArgs("ps", kTok, 30000,
                        "AEGP_ProjSuite6.AEGP_ProjectIsDirty", "26.5",
                        savedArgs));
        CHECK(CallIdle(*h) == A_Err_NONE);
        CheckResultDoc(c, "ps", "completed", NULL);
        h->projects[1].path = "";
    }

    /* ---- wrong name → STALE_REFERENCE ---- */
    {
        const char* bad =
            "{\"project\":{\"aeRef\":{\"type\":\"project\",\"index\":0,"
            "\"name\":\"Other\",\"path\":\"/tmp/shot01.aep\"}}}";
        WriteReq0600(c.Path("inbox/pn.request.json"),
                     ReqJsonArgs("pn", kTok, 30000,
                        "AEGP_ProjSuite6.AEGP_ProjectIsDirty", "26.5", bad));
        CHECK(CallIdle(*h) == A_Err_NONE);
        CheckResultDoc(c, "pn", "refused", "STALE_REFERENCE");
    }

    /* ---- wrong path → STALE_REFERENCE ---- */
    {
        const char* bad =
            "{\"project\":{\"aeRef\":{\"type\":\"project\",\"index\":0,"
            "\"name\":\"Shot01\",\"path\":\"/tmp/other.aep\"}}}";
        WriteReq0600(c.Path("inbox/pp.request.json"),
                     ReqJsonArgs("pp", kTok, 30000,
                        "AEGP_ProjSuite6.AEGP_ProjectIsDirty", "26.5", bad));
        CHECK(CallIdle(*h) == A_Err_NONE);
        CheckResultDoc(c, "pp", "refused", "STALE_REFERENCE");
    }

    /* ---- index reuse after close/open: a new project inserted at
       index 0 shifts Shot01 to index 1 — the old descriptor's index
       now resolves to a different project → name mismatch → STALE ---- */
    {
        FakeProject fresh = h->AddProject("NewFirst");
        fresh.path = "/tmp/newfirst.aep";
        /* AddProject appends; emulate close/open reorder by rebuilding
           the vector so NewFirst sits at index 0 */
        std::vector<FakeProject> reordered;
        reordered.push_back(fresh);
        reordered.push_back(h->projects[0]);
        reordered.push_back(h->projects[1]);
        h->projects = reordered;
        h->numProjects = 3;
        WriteReq0600(c.Path("inbox/pr.request.json"),
                     ReqJsonArgs("pr", kTok, 30000,
                        "AEGP_ProjSuite6.AEGP_ProjectIsDirty", "26.5", proj0));
        CHECK(CallIdle(*h) == A_Err_NONE);
        CheckResultDoc(c, "pr", "refused", "STALE_REFERENCE");
        /* …but a descriptor carrying the live index still resolves */
        const char* proj0moved =
            "{\"project\":{\"aeRef\":{\"type\":\"project\",\"index\":1,"
            "\"name\":\"Shot01\",\"path\":\"/tmp/shot01.aep\"}}}";
        WriteReq0600(c.Path("inbox/pr2.request.json"),
                     ReqJsonArgs("pr2", kTok, 30000,
                        "AEGP_ProjSuite6.AEGP_ProjectIsDirty", "26.5",
                        proj0moved));
        CHECK(CallIdle(*h) == A_Err_NONE);
        CheckResultDoc(c, "pr2", "completed", NULL);
    }

    /* ---- malformed descriptor shape → MALFORMED_REQUEST ---- */
    {
        const char* bad1 =
            "{\"project\":{\"aeRef\":{\"type\":\"item\",\"index\":0,"
            "\"name\":\"Shot01\",\"path\":\"/tmp/shot01.aep\"}}}";
        WriteReq0600(c.Path("inbox/pm.request.json"),
                     ReqJsonArgs("pm", kTok, 30000,
                        "AEGP_ProjSuite6.AEGP_ProjectIsDirty", "26.5", bad1));
        CHECK(CallIdle(*h) == A_Err_NONE);
        CheckResultDoc(c, "pm", "refused", "MALFORMED_REQUEST");
    }
}

/* Issue #318 §7f: aeRefRQItem descriptor → comp aeRef resolve →
   queue index → bound-comp itemId + (status,numOutputModules)
   fingerprint, all re-verified inside ONE dispatch. Covers
   enumeration/issuance, all seven getters, queue reorder (index
   reuse), comp rebind, fingerprint change, duplicate same-comp
   entries, and malformed shapes. */
static void TestIntakeRQItemGetters()
{
    auto h = MakeFakeHost();
    FakeProject& p = h->AddProject("Shot01");
    p.path = "/tmp/shot01.aep";
    p.rootName = h->MakeNameSpec(FakeHost::U16("Root"));
    SetupProjectItems(*h, 0, {
        { "ClipA",  AEGP_ItemType_COMP,    6101 },
        { "ClipB",  AEGP_ItemType_COMP,    6102 },
    });
    h->numProjects = 1;
    h->numRQItems = 3;
    h->rqItemMeta.resize(3);
    /* slot 0: ClipA, queued, 1 OM, comment */
    h->rqItemMeta[0].compProject = 0;
    h->rqItemMeta[0].compItem = 0;
    h->rqItemMeta[0].status = AEGP_RenderItemStatus_QUEUED;
    h->rqItemMeta[0].numOutputModules = 1;
    h->rqItemMeta[0].comment =
        h->MakeNameSpec(FakeHost::U16("render note"));
    h->rqItemMeta[0].logType = AEGP_LogType_PLUS_SETTINGS;
    h->rqItemMeta[0].startedTime = {12, 30};
    h->rqItemMeta[0].elapsedTime = {34, 30};
    /* slot 1: ClipB, rendering, 2 OMs */
    h->rqItemMeta[1].compProject = 0;
    h->rqItemMeta[1].compItem = 1;
    h->rqItemMeta[1].status = AEGP_RenderItemStatus_RENDERING;
    h->rqItemMeta[1].numOutputModules = 2;
    /* slot 2: SAME comp as slot 0 but different status — two queue
       entries bound to one comp must still resolve independently */
    h->rqItemMeta[2].compProject = 0;
    h->rqItemMeta[2].compItem = 0;
    h->rqItemMeta[2].status = AEGP_RenderItemStatus_UNQUEUED;
    h->rqItemMeta[2].numOutputModules = 1;
    TmpChan c;
    IntakeEntry(*h, c);

    /* ---- enumeration: GetRQItemByIndex issues descriptors ---- */
    WriteReq0600(c.Path("inbox/rq.request.json"),
                 ReqJsonArgs("rq", kTok, 30000,
                    "AEGP_RQItemSuite4.AEGP_GetRQItemByIndex", "26.5",
                    "{\"offset\":0,\"limit\":32}"));
    CHECK(CallIdle(*h) == A_Err_NONE);
    {
        JVal* doc = NULL;
        JVal* pay = ResultPayload(c, "rq", &doc);
        JVal* items = pay ? JGet(pay, "items") : NULL;
        JVal* num = pay ? PayloadNum(pay, "numRQItems") : NULL;
        CHECK(items != NULL && items->kind == JK_ARR && items->nitems == 3);
        CHECK(num != NULL && num->num == 3.0);
        if (items && items->nitems > 0)
        {
            JVal* it0 = items->items[0];
            JVal* rq = JGet(it0, "rqItem");
            JVal* ref = rq ? JGet(rq, "aeRef") : NULL;
            CHECK(ref != NULL);
            JVal* ty = ref ? JGet(ref, "type") : NULL;
            CHECK(ty != NULL && JStrEq(ty, "rqItem"));
            JVal* idx = ref ? PayloadNum(ref, "index") : NULL;
            CHECK(idx != NULL && idx->num == 0.0);
            JVal* cmp = ref ? JGet(ref, "comp") : NULL;
            JVal* cref = cmp ? JGet(cmp, "aeRef") : NULL;
            JVal* cid = cref ? PayloadNum(cref, "itemId") : NULL;
            CHECK(cid != NULL && cid->num == 6101.0);
            JVal* st = ref ? PayloadNum(ref, "status") : NULL;
            CHECK(st != NULL &&
                  st->num == (double)AEGP_RenderItemStatus_QUEUED);
            JVal* pi = JGet(it0, "projectIndex");
            CHECK(pi != NULL && pi->num == 0.0);
        }
        if (doc) JFree(doc);
        CheckResultDoc(c, "rq", "completed", NULL);
    }

    /* ---- hand-built descriptor for slot 0 (ClipA binding) ---- */
    std::string rqArgs0 =
        std::string("{\"projectIndex\":0,\"rqItem\":{\"aeRef\":{"
                    "\"type\":\"rqItem\",\"index\":0,\"comp\":{\"aeRef\":{")
        + "\"type\":\"comp\",\"name\":\"ClipA\",\"path\":[0],"
        "\"itemId\":6101,\"projectName\":\"Shot01\","
        "\"projectPath\":\"/tmp/shot01.aep\"}},\"status\":"
        + std::to_string((long)AEGP_RenderItemStatus_QUEUED)
        + ",\"numOutputModules\":1}}}";

    /* ---- typed getters ---- */
    WriteReq0600(c.Path("inbox/rs.request.json"),
                 ReqJsonArgs("rs", kTok, 30000,
                    "AEGP_RQItemSuite4.AEGP_GetRenderState", "26.5",
                    rqArgs0.c_str()));
    CHECK(CallIdle(*h) == A_Err_NONE);
    {
        JVal* doc = NULL;
        JVal* pay = ResultPayload(c, "rs", &doc);
        JVal* st = PayloadNum(pay, "status");
        CHECK(st != NULL && st->num == (double)AEGP_RenderItemStatus_QUEUED);
        if (doc) JFree(doc);
        CheckResultDoc(c, "rs", "completed", NULL);
    }

    WriteReq0600(c.Path("inbox/rm.request.json"),
                 ReqJsonArgs("rm", kTok, 30000,
                    "AEGP_RQItemSuite4.AEGP_GetNumOutputModulesForRQItem",
                    "26.5", rqArgs0.c_str()));
    CHECK(CallIdle(*h) == A_Err_NONE);
    {
        JVal* doc = NULL;
        JVal* pay = ResultPayload(c, "rm", &doc);
        JVal* n = PayloadNum(pay, "numOutputModules");
        CHECK(n != NULL && n->num == 1.0);
        if (doc) JFree(doc);
        CheckResultDoc(c, "rm", "completed", NULL);
    }

    WriteReq0600(c.Path("inbox/rt.request.json"),
                 ReqJsonArgs("rt", kTok, 30000,
                    "AEGP_RQItemSuite4.AEGP_GetStartedTime", "26.5",
                    rqArgs0.c_str()));
    CHECK(CallIdle(*h) == A_Err_NONE);
    {
        JVal* doc = NULL;
        JVal* pay = ResultPayload(c, "rt", &doc);
        JVal* t = pay ? JGet(pay, "startedTime") : NULL;
        JVal* val = t ? PayloadNum(t, "value") : NULL;
        CHECK(val != NULL && val->num == 12.0);
        if (doc) JFree(doc);
        CheckResultDoc(c, "rt", "completed", NULL);
    }

    WriteReq0600(c.Path("inbox/re.request.json"),
                 ReqJsonArgs("re", kTok, 30000,
                    "AEGP_RQItemSuite4.AEGP_GetElapsedTime", "26.5",
                    rqArgs0.c_str()));
    CHECK(CallIdle(*h) == A_Err_NONE);
    {
        JVal* doc = NULL;
        JVal* pay = ResultPayload(c, "re", &doc);
        JVal* t = pay ? JGet(pay, "elapsedTime") : NULL;
        JVal* val = t ? PayloadNum(t, "value") : NULL;
        CHECK(val != NULL && val->num == 34.0);
        if (doc) JFree(doc);
        CheckResultDoc(c, "re", "completed", NULL);
    }

    WriteReq0600(c.Path("inbox/rl.request.json"),
                 ReqJsonArgs("rl", kTok, 30000,
                    "AEGP_RQItemSuite4.AEGP_GetLogType", "26.5",
                    rqArgs0.c_str()));
    CHECK(CallIdle(*h) == A_Err_NONE);
    {
        JVal* doc = NULL;
        JVal* pay = ResultPayload(c, "rl", &doc);
        JVal* lt = PayloadNum(pay, "logType");
        CHECK(lt != NULL && lt->num == (double)AEGP_LogType_PLUS_SETTINGS);
        if (doc) JFree(doc);
        CheckResultDoc(c, "rl", "completed", NULL);
    }

    WriteReq0600(c.Path("inbox/rc.request.json"),
                 ReqJsonArgs("rc", kTok, 30000,
                    "AEGP_RQItemSuite4.AEGP_GetComment", "26.5",
                    rqArgs0.c_str()));
    CHECK(CallIdle(*h) == A_Err_NONE);
    {
        JVal* doc = NULL;
        JVal* pay = ResultPayload(c, "rc", &doc);
        JVal* cm = pay ? JGet(pay, "comment") : NULL;
        CHECK(cm != NULL && cm->kind == JK_STR &&
              cm->slen == strlen("render note") &&
              memcmp(cm->str, "render note", cm->slen) == 0);
        if (doc) JFree(doc);
        CheckResultDoc(c, "rc", "completed", NULL);
    }

    /* GetCompFromRQItem → bound comp emitted as descriptor */
    WriteReq0600(c.Path("inbox/rk.request.json"),
                 ReqJsonArgs("rk", kTok, 30000,
                    "AEGP_RQItemSuite4.AEGP_GetCompFromRQItem", "26.5",
                    rqArgs0.c_str()));
    CHECK(CallIdle(*h) == A_Err_NONE);
    {
        JVal* doc = NULL;
        JVal* pay = ResultPayload(c, "rk", &doc);
        JVal* cmp = pay ? JGet(pay, "comp") : NULL;
        JVal* cref = cmp ? JGet(cmp, "aeRef") : NULL;
        JVal* cid = cref ? PayloadNum(cref, "itemId") : NULL;
        JVal* pi = pay ? PayloadNum(pay, "projectIndex") : NULL;
        CHECK(cid != NULL && cid->num == 6101.0);
        CHECK(pi != NULL && pi->num == 0.0);
        if (doc) JFree(doc);
        CheckResultDoc(c, "rk", "completed", NULL);
    }

    /* ---- duplicate same-comp entries resolve independently ---- */
    {
        std::string rqArgs2 = rqArgs0;
        /* slot 2: same comp, UNQUEUED status, index 2 */
        size_t si = rqArgs2.find("\"index\":0");
        CHECK(si != std::string::npos);
        rqArgs2.replace(si + 8, 1, "2");
        size_t sp = rqArgs2.find("\"status\":");
        CHECK(sp != std::string::npos);
        rqArgs2.replace(sp + 9, 1, "1"); /* UNQUEUED = 1 */
        WriteReq0600(c.Path("inbox/rd.request.json"),
                     ReqJsonArgs("rd", kTok, 30000,
                        "AEGP_RQItemSuite4.AEGP_GetRenderState", "26.5",
                        rqArgs2.c_str()));
        CHECK(CallIdle(*h) == A_Err_NONE);
        {
            JVal* doc = NULL;
            JVal* pay = ResultPayload(c, "rd", &doc);
            JVal* st = PayloadNum(pay, "status");
            CHECK(st != NULL &&
                  st->num == (double)AEGP_RenderItemStatus_UNQUEUED);
            if (doc) JFree(doc);
            CheckResultDoc(c, "rd", "completed", NULL);
        }
    }

    /* ---- stale: index out of range after queue emptied ---- */
    {
        h->numRQItems = 0;
        WriteReq0600(c.Path("inbox/ro.request.json"),
                     ReqJsonArgs("ro", kTok, 30000,
                        "AEGP_RQItemSuite4.AEGP_GetRenderState", "26.5",
                        rqArgs0.c_str()));
        CHECK(CallIdle(*h) == A_Err_NONE);
        CheckResultDoc(c, "ro", "refused", "STALE_REFERENCE");
        h->numRQItems = 3;
    }

    /* ---- stale: queue reorder — slot 0 now binds ClipB; the old
       descriptor's comp binding no longer matches → STALE ---- */
    {
        FakeRQItemMeta m0 = h->rqItemMeta[0];
        FakeRQItemMeta m1 = h->rqItemMeta[1];
        h->rqItemMeta[0] = m1;
        h->rqItemMeta[1] = m0;
        WriteReq0600(c.Path("inbox/rq2.request.json"),
                     ReqJsonArgs("rq2", kTok, 30000,
                        "AEGP_RQItemSuite4.AEGP_GetRenderState", "26.5",
                        rqArgs0.c_str()));
        CHECK(CallIdle(*h) == A_Err_NONE);
        CheckResultDoc(c, "rq2", "refused", "STALE_REFERENCE");
        h->rqItemMeta[0] = m0;
        h->rqItemMeta[1] = m1;
    }

    /* ---- stale: fingerprint change (status mutated in place) ---- */
    {
        h->rqItemMeta[0].status = AEGP_RenderItemStatus_DONE;
        WriteReq0600(c.Path("inbox/rf.request.json"),
                     ReqJsonArgs("rf", kTok, 30000,
                        "AEGP_RQItemSuite4.AEGP_GetRenderState", "26.5",
                        rqArgs0.c_str()));
        CHECK(CallIdle(*h) == A_Err_NONE);
        CheckResultDoc(c, "rf", "refused", "STALE_REFERENCE");
        h->rqItemMeta[0].status = AEGP_RenderItemStatus_QUEUED;
    }

    /* ---- stale: comp deleted/recreated with a new itemId ---- */
    {
        p.itemMeta[0].id = 6999; /* ClipA recreated → new id */
        WriteReq0600(c.Path("inbox/rc2.request.json"),
                     ReqJsonArgs("rc2", kTok, 30000,
                        "AEGP_RQItemSuite4.AEGP_GetRenderState", "26.5",
                        rqArgs0.c_str()));
        CHECK(CallIdle(*h) == A_Err_NONE);
        CheckResultDoc(c, "rc2", "refused", "STALE_REFERENCE");
        p.itemMeta[0].id = 6101;
    }

    /* ---- malformed descriptor → MALFORMED_REQUEST ---- */
    {
        const char* bad =
            "{\"projectIndex\":0,\"rqItem\":{\"aeRef\":{\"type\":\"rqItem\","
            "\"index\":0,\"status\":2,\"numOutputModules\":1}}}";
        WriteReq0600(c.Path("inbox/rm2.request.json"),
                     ReqJsonArgs("rm2", kTok, 30000,
                        "AEGP_RQItemSuite4.AEGP_GetRenderState", "26.5", bad));
        CHECK(CallIdle(*h) == A_Err_NONE);
        CheckResultDoc(c, "rm2", "refused", "MALFORMED_REQUEST");
    }
}

/* §7e collision counterexample: two identically-named untitled
   projects satisfy the same (name, empty-path) corroboration — the
   resolver must refuse STALE_REFERENCE rather than silently pick one.
   Separate host: MakeFakeHost installs a process-global g_host, so a
   second host cannot coexist inside another test's lifetime. */
static void TestIntakeProjectCollision()
{
    auto h = MakeFakeHost();
    FakeProject& a = h->AddProject("Dup");
    a.path = "";
    FakeProject& b = h->AddProject("Dup");
    b.path = "";
    h->numProjects = 2;
    TmpChan c;
    IntakeEntry(*h, c);
    const char* dup =
        "{\"project\":{\"aeRef\":{\"type\":\"project\",\"index\":0,"
        "\"name\":\"Dup\",\"path\":\"\"}}}";
    WriteReq0600(c.Path("inbox/pc.request.json"),
                 ReqJsonArgs("pc", kTok, 30000,
                    "AEGP_ProjSuite6.AEGP_ProjectIsDirty", "26.5", dup));
    CHECK(CallIdle(*h) == A_Err_NONE);
    CheckResultDoc(c, "pc", "refused", "STALE_REFERENCE");
    /* same name but distinct paths → unambiguous → resolves */
    h->projects[1].path = "/tmp/dup-b.aep";
    const char* dupB =
        "{\"project\":{\"aeRef\":{\"type\":\"project\",\"index\":1,"
        "\"name\":\"Dup\",\"path\":\"/tmp/dup-b.aep\"}}}";
    WriteReq0600(c.Path("inbox/pc2.request.json"),
                 ReqJsonArgs("pc2", kTok, 30000,
                    "AEGP_ProjSuite6.AEGP_ProjectIsDirty", "26.5", dupB));
    CHECK(CallIdle(*h) == A_Err_NONE);
    CheckResultDoc(c, "pc2", "completed", NULL);
}

/* ================= Issue #327: first mutating op ==================
   AEGP_ItemSuite9.AEGP_SetItemComment behind the §7g consent proof.
   The test computes real HMACs through the same native_consent module
   the plug-in verifies with (crypto itself is pinned by
   TestConsentVectors against the TS mirror). */

static const char* kConsentKey =
    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

/* channel.json with a consentKey — the default TmpChan writes token
   only, which is the no-key configuration. */
static void AddConsentKey(TmpChan& c)
{
    char p[400];
    snprintf(p, sizeof(p), "%s/channel.json", c.root);
    FILE* f = fopen(p, "wb");
    CHECK(f != NULL);
    fprintf(f, "{\"v\":1,\"token\":\"%s\",\"consentKey\":\"%s\"}",
            kTok, kConsentKey);
    fclose(f);
    chmod(p, 0600);
}

/* Compute the §7g MAC for an arbitrary scope exactly as the plug-in
   will: canonicalConsentString over the PARSED session/args,
   HMAC-SHA256 under the hex consentKey. Returns "" on failure. */
static std::string ConsentMacHex(const char* keyHex64,
                                 const char* opIdZ, size_t opIdLen,
                                 const char* reqIdZ, size_t reqIdLen,
                                 const JVal* session, const JVal* args,
                                 const char* targetZ, size_t targetLen)
{
    char canon[8192];
    size_t clen = 0;
    unsigned char key[32], mac[32];
    char hex[65];
    int i;
    if (!ConsentBuildString(canon, sizeof(canon), &clen,
                            opIdZ, opIdLen, reqIdZ, reqIdLen,
                            session, args, targetZ, targetLen))
        return "";
    if (!ConsentHexKeyDecode(keyHex64, key)) return "";
    ConsentHmacSha256(key, sizeof(key),
                      (const unsigned char*)canon, clen, mac);
    for (i = 0; i < 32; i++) snprintf(hex + i * 2, 3, "%02x", mac[i]);
    hex[64] = '\0';
    return std::string(hex);
}

/* Fixed-scope wrapper: session matches ReqJsonMut's literal, no
   target, key is the test channel's kConsentKey. */
static std::string ConsentMacFor(const char* op, const char* id,
                                 const char* argsJson)
{
    const char* sessJson = "{\"sessionId\":\"sess-1\",\"aeVersion\":\"26.5\"}";
    JVal* sess = JParseDoc(sessJson, strlen(sessJson));
    JVal* args = argsJson ? JParseDoc(argsJson, strlen(argsJson)) : NULL;
    std::string mac;
    CHECK(sess != NULL);
    CHECK(argsJson == NULL || args != NULL);
    if (!sess || (argsJson && !args)) { JFree(sess); JFree(args); return ""; }
    mac = ConsentMacHex(kConsentKey, op, strlen(op), id, strlen(id),
                        sess, args, NULL, 0);
    JFree(sess); JFree(args);
    return mac;
}

/* Envelope variant of ReqJsonArgs carrying an optional envelope-level
   consent {v:1,mac} (contract §7g — outside the inner request). */
static std::string ReqJsonMut(const char* id, const char* tok,
                              const char* mac, const char* op,
                              const char* aeVer, const char* argsJson)
{
    char b[4096];
    char consent[300];
    if (mac)
        snprintf(consent, sizeof(consent),
                 "\"consent\":{\"v\":1,\"mac\":\"%s\"},", mac);
    else
        consent[0] = '\0';
    snprintf(b, sizeof(b),
        "{\"v\":1,\"token\":\"%s\",\"timeoutMs\":30000,%s\"request\":{"
        "\"schema\":\"ae-devtools/native-dispatch/v1\",\"requestId\":\"%s\","
        "\"session\":{\"sessionId\":\"sess-1\",\"aeVersion\":\"%s\"},"
        "\"operationId\":\"%s\",\"args\":%s,\"authorizationRef\":\"opaque\"}}",
        tok, consent, id, aeVer, op, argsJson ? argsJson : "null");
    return std::string(b);
}

static const char* kSetCommentOp = "AEGP_ItemSuite9.AEGP_SetItemComment";

static void TestIntakeSetItemComment()
{
    auto h = MakeFakeHost();
    FakeProject& p = h->AddProject("Shot01");
    p.path = "/tmp/shot01.aep";
    p.rootName = h->MakeNameSpec(FakeHost::U16("Root"));
    SetupProjectItems(*h, 0, {
        { "Clip", AEGP_ItemType_COMP, 7001 },
    });
    p.itemMeta[0].comment = h->MakeNameSpec(FakeHost::U16("old note"));
    h->numProjects = 1;
    TmpChan c;
    IntakeEntry(*h, c);

    const char* refJson =
        "\"item\":{\"aeRef\":{\"type\":\"comp\",\"name\":\"Clip\","
        "\"path\":[0],\"itemId\":7001,\"projectName\":\"Shot01\","
        "\"projectPath\":\"/tmp/shot01.aep\"}}";
    char argsBuf[1024];

    /* (a) requiresConsent op without a consent object → CONSENT_REQUIRED,
       and no mutation AEGP call is recorded. */
    snprintf(argsBuf, sizeof(argsBuf),
             "{\"projectIndex\":0,%s,\"comment\":\"x\"}", refJson);
    WriteReq0600(c.Path("inbox/sc.request.json"),
                 ReqJsonMut("sc", kTok, NULL, kSetCommentOp, "26.5", argsBuf));
    CHECK(CallIdle(*h) == A_Err_NONE);
    CheckResultDoc(c, "sc", "refused", "CONSENT_REQUIRED");
    {
        std::string r = Slurp(ResultPath(c, "sc"));
        CHECK(r.find("AEGP_SetItemComment") == std::string::npos);
    }

    /* (b) well-formed MAC but channel.json has no consentKey →
       CONSENT_REQUIRED (fail closed). */
    std::string macNoKey = ConsentMacFor(kSetCommentOp, "sk", argsBuf);
    WriteReq0600(c.Path("inbox/sk.request.json"),
                 ReqJsonMut("sk", kTok, macNoKey.c_str(), kSetCommentOp,
                            "26.5", argsBuf));
    CHECK(CallIdle(*h) == A_Err_NONE);
    CheckResultDoc(c, "sk", "refused", "CONSENT_REQUIRED");

    /* channel gains a consentKey — remaining cases verify real MACs. */
    AddConsentKey(c);

    /* (c) wrong MAC → CONSENT_INVALID, no mutation call. */
    WriteReq0600(c.Path("inbox/bw.request.json"),
                 ReqJsonMut("bw", kTok,
                            "1111111111111111111111111111111111111111111111111111111111111111",
                            kSetCommentOp, "26.5", argsBuf));
    CHECK(CallIdle(*h) == A_Err_NONE);
    CheckResultDoc(c, "bw", "refused", "CONSENT_INVALID");
    {
        std::string r = Slurp(ResultPath(c, "bw"));
        CHECK(r.find("AEGP_SetItemComment") == std::string::npos);
    }

    /* (d) MAC computed for comment "Alpha" but args carry "Beta" →
       scope tampering breaks the MAC → CONSENT_INVALID. */
    {
        char alphaArgs[1024];
        snprintf(alphaArgs, sizeof(alphaArgs),
                 "{\"projectIndex\":0,%s,\"comment\":\"Alpha\"}", refJson);
        std::string macAlpha = ConsentMacFor(kSetCommentOp, "tp", alphaArgs);
        WriteReq0600(c.Path("inbox/tp.request.json"),
                     ReqJsonMut("tp", kTok, macAlpha.c_str(), kSetCommentOp,
                                "26.5", argsBuf)); /* argsBuf has "x" ≠ Alpha */
        CHECK(CallIdle(*h) == A_Err_NONE);
        CheckResultDoc(c, "tp", "refused", "CONSENT_INVALID");
    }

    /* (e) valid MAC → completed; mayHaveMutated:true; comment applied;
       read-back through the read-only getter proves the effect. */
    {
        char okArgs[1024];
        snprintf(okArgs, sizeof(okArgs),
                 "{\"projectIndex\":0,%s,\"comment\":\"caf\\u00e9 \\ud83d\\ude00\"}",
                 refJson);
        std::string macOk = ConsentMacFor(kSetCommentOp, "ok", okArgs);
        WriteReq0600(c.Path("inbox/ok.request.json"),
                     ReqJsonMut("ok", kTok, macOk.c_str(), kSetCommentOp,
                                "26.5", okArgs));
        CHECK(CallIdle(*h) == A_Err_NONE);
        CheckResultDoc(c, "ok", "completed", NULL);
        {
            std::string r = Slurp(ResultPath(c, "ok"));
            CHECK(r.find("\"mayHaveMutated\":true") != std::string::npos);
            CHECK(r.find("AEGP_SetItemComment") != std::string::npos);
        }
        /* read-back via the existing read-only getter (no consent) */
        {
            char getArgs[1024];
            snprintf(getArgs, sizeof(getArgs),
                     "{\"projectIndex\":0,%s}", refJson);
            WriteReq0600(c.Path("inbox/rb.request.json"),
                         ReqJsonArgs("rb", kTok, 30000,
                                     "AEGP_ItemSuite9.AEGP_GetItemComment",
                                     "26.5", getArgs));
            CHECK(CallIdle(*h) == A_Err_NONE);
            JVal* doc = NULL;
            JVal* pay = ResultPayload(c, "rb", &doc);
            CHECK(pay != NULL);
            if (pay)
            {
                JVal* cm = JGet(pay, "comment");
                CHECK(cm && cm->kind == JK_STR && cm->slen == 10 &&
                      memcmp(cm->str, "caf\xC3\xA9 \xF0\x9F\x98\x80", 10) == 0);
            }
            JFree(doc);
        }
    }

    /* (f) stale identity + valid MAC → STALE_REFERENCE before any
       mutation call; consent does not bypass identity checks. */
    {
        char staleArgs[1024];
        snprintf(staleArgs, sizeof(staleArgs),
                 "{\"projectIndex\":0,"
                 "\"item\":{\"aeRef\":{\"type\":\"comp\",\"name\":\"Clip\","
                 "\"path\":[0],\"itemId\":9999,\"projectName\":\"Shot01\","
                 "\"projectPath\":\"/tmp/shot01.aep\"}},"
                 "\"comment\":\"stale\"}");
        std::string macStale = ConsentMacFor(kSetCommentOp, "st", staleArgs);
        WriteReq0600(c.Path("inbox/st.request.json"),
                     ReqJsonMut("st", kTok, macStale.c_str(), kSetCommentOp,
                                "26.5", staleArgs));
        CHECK(CallIdle(*h) == A_Err_NONE);
        CheckResultDoc(c, "st", "refused", "STALE_REFERENCE");
        {
            std::string r = Slurp(ResultPath(c, "st"));
            CHECK(r.find("AEGP_SetItemComment") == std::string::npos);
        }
    }

    /* (g) AEGP call attempted but fails → failed + mayHaveMutated:true
       (the host may have applied the change before erroring). */
    {
        char errArgs[1024];
        snprintf(errArgs, sizeof(errArgs),
                 "{\"projectIndex\":0,%s,\"comment\":\"boom\"}", refJson);
        std::string macErr = ConsentMacFor(kSetCommentOp, "er", errArgs);
        h->setCommentErr = A_Err_GENERIC;
        WriteReq0600(c.Path("inbox/er.request.json"),
                     ReqJsonMut("er", kTok, macErr.c_str(), kSetCommentOp,
                                "26.5", errArgs));
        CHECK(CallIdle(*h) == A_Err_NONE);
        CheckResultDoc(c, "er", "failed", NULL);
        {
            std::string r = Slurp(ResultPath(c, "er"));
            CHECK(r.find("\"mayHaveMutated\":true") != std::string::npos);
        }
        h->setCommentErr = A_Err_NONE;
    }
}

static void TestIntakeSetItemCommentNoEntry()
{
    /* nullItemEntry=5 → AEGP_SetItemComment entry NULL → not-sent with
       valid consent; mayHaveMutated stays false (never attempted). */
    auto h = MakeFakeHost();
    h->nullItemEntry = 5;
    h->PopulateSuites();
    FakeProject& p = h->AddProject("Shot01");
    p.path = "/tmp/shot01.aep";
    p.rootName = h->MakeNameSpec(FakeHost::U16("Root"));
    SetupProjectItems(*h, 0, {
        { "Clip", AEGP_ItemType_COMP, 7001 },
    });
    h->numProjects = 1;
    TmpChan c;
    IntakeEntry(*h, c);
    AddConsentKey(c);

    const char* argsJson =
        "{\"projectIndex\":0,"
        "\"item\":{\"aeRef\":{\"type\":\"comp\",\"name\":\"Clip\","
        "\"path\":[0],\"itemId\":7001,\"projectName\":\"Shot01\","
        "\"projectPath\":\"/tmp/shot01.aep\"}},"
        "\"comment\":\"x\"}";
    std::string mac = ConsentMacFor(kSetCommentOp, "ne", argsJson);
    WriteReq0600(c.Path("inbox/ne.request.json"),
                 ReqJsonMut("ne", kTok, mac.c_str(), kSetCommentOp,
                            "26.5", argsJson));
    CHECK(CallIdle(*h) == A_Err_NONE);
    CheckResultDoc(c, "ne", "not-sent", NULL);
    {
        std::string r = Slurp(ResultPath(c, "ne"));
        CHECK(r.find("mayHaveMutated") == std::string::npos ||
              r.find("\"mayHaveMutated\":true") == std::string::npos);
    }
}

/* ---- shared consent fixture (Issue #337) --------------------------
   packages/native-adapter/tests/fixtures/native-consent-vectors.json
   is the canonical cross-repo contract fixture: the TS mirror
   (packages/native-adapter/src/consent.ts + tests/consent.test.ts)
   and ae-a8n's consent issuance consume the SAME file. run_tests.sh
   passes its absolute path via -DCONSENT_VECTORS_PATH. */

#ifndef CONSENT_VECTORS_PATH
#define CONSENT_VECTORS_PATH ""
#endif

static std::string g_fxDoc;
static JVal* g_fx = NULL;

static void LoadConsentFixture()
{
    if (g_fx) return;
    CHECK(CONSENT_VECTORS_PATH[0] != '\0');
    g_fxDoc = Slurp(CONSENT_VECTORS_PATH);
    CHECK(!g_fxDoc.empty());
    if (g_fxDoc.empty()) return;
    g_fx = JParseDoc(g_fxDoc.data(), g_fxDoc.size());
    CHECK(g_fx != NULL);
}

static std::string JStrOf(JVal* v)
{
    if (!v || v->kind != JK_STR || !v->str) return "";
    return std::string(v->str, v->slen);
}

static JVal* JParseStr(const std::string& json)
{
    return json.empty() ? NULL : JParseDoc(json.data(), json.size());
}

/* canonicalVectors: identical canon strings and MACs on both sides —
   divergence is a contract bug. */
static void TestConsentVectors()
{
    LoadConsentFixture();
    if (!g_fx) return;
    {
        JVal* keyV = JGet(g_fx, "consentKey");
        JVal* vecs = JGet(g_fx, "canonicalVectors");
        std::string key = JStrOf(keyV);
        CHECK(key.size() == 64);
        CHECK(vecs && vecs->kind == JK_ARR && vecs->nitems > 0);
        if (!(key.size() == 64) || !vecs || vecs->kind != JK_ARR) return;
        for (size_t i = 0; i < vecs->nitems; i++)
        {
            JVal* v = vecs->items[i];
            JVal* sessJ = JGet(v, "sessionJson");
            JVal* argsJ = JGet(v, "argsJson");
            JVal* tgt = JGet(v, "target");
            JVal* opV = JGet(v, "operationId");
            JVal* ridV = JGet(v, "requestId");
            JVal* canonV = JGet(v, "canonicalString");
            JVal* macV = JGet(v, "mac");
            std::string name = JStrOf(JGet(v, "name"));
            JVal* sess = JParseStr(JStrOf(sessJ));
            JVal* args = argsJ ? JParseStr(JStrOf(argsJ)) : NULL;
            std::string op = JStrOf(opV), rid = JStrOf(ridV);
            std::string wantCanon = JStrOf(canonV), wantMac = JStrOf(macV);
            char buf[16384];
            size_t len = 0;
            const char* tgtZ =
                (tgt && tgt->kind == JK_STR) ? tgt->str : NULL;
            size_t tgtLen =
                (tgt && tgt->kind == JK_STR) ? tgt->slen : 0;
            CHECK(sess != NULL);
            CHECK(!argsJ || args != NULL);
            if (!sess || (argsJ && !args)) { JFree(sess); JFree(args); continue; }
            CHECK(ConsentBuildString(buf, sizeof(buf), &len,
                                     op.data(), op.size(),
                                     rid.data(), rid.size(),
                                     sess, args, tgtZ, tgtLen));
            CHECK(len == wantCanon.size() &&
                  memcmp(buf, wantCanon.data(), len) == 0);
            if (!(len == wantCanon.size() &&
                  memcmp(buf, wantCanon.data(), len) == 0))
                printf("FAIL vec %s canon:\nGOT : %.*s\nWANT: %s\n",
                       name.c_str(), (int)len, buf, wantCanon.c_str());
            CHECK(ConsentVerifyMac(key.c_str(), buf, len,
                                   wantMac.data(), wantMac.size()));
            if (!ConsentVerifyMac(key.c_str(), buf, len,
                                  wantMac.data(), wantMac.size()))
                printf("FAIL vec %s mac: got-verification failed\n",
                       name.c_str());
            /* tamper each scope field → MAC must not verify */
            {
                char tampered[16384];
                size_t tlen = 0;
                const char* op2 = "OP.TAMPERED";
                CHECK(ConsentBuildString(tampered, sizeof(tampered), &tlen,
                                         op2, strlen(op2),
                                         rid.data(), rid.size(),
                                         sess, args, tgtZ, tgtLen));
                CHECK(!ConsentVerifyMac(key.c_str(), tampered, tlen,
                                        wantMac.data(), wantMac.size()));
            }
            /* wrong key → must not verify */
            CHECK(!ConsentVerifyMac(
                "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                buf, len, wantMac.data(), wantMac.size()));
            /* malformed MAC shape → must not verify */
            CHECK(!ConsentVerifyMac(key.c_str(), buf, len, "zz", 2));
            JFree(sess); JFree(args);
        }
    }
}

/* ---- wire-level contract cases (Issue #337) ------------------------
   Executes fixture.wireCases IN ORDER against one fake host + one
   channel (the seen-ring and lazy consentKey write make order
   significant). Each case pins outcome / refusalCode /
   mayHaveMutated / opCalls against the §7g/§7h wire contract. */

static void FxCheck(int cond, const char* caseName, const char* what)
{
    g_checks++;
    if (!cond)
    {
        g_failures++;
        printf("FAIL wirecase %s: %s\n", caseName, what);
    }
}

/* channel.json carrying the fixture consentKey (token unchanged). */
static void WriteChannelKey(TmpChan& c, const std::string& keyHex)
{
    char p[400];
    snprintf(p, sizeof(p), "%s/channel.json", c.root);
    FILE* f = fopen(p, "wb");
    CHECK(f != NULL);
    fprintf(f, "{\"v\":1,\"token\":\"%s\",\"consentKey\":\"%s\"}",
            kTok, keyHex.c_str());
    fclose(f);
    chmod(p, 0600);
}

/* Envelope with verbatim args JSON and an optional raw consent member
   (e.g. "\"consent\":{...},"). Session is the canonical form of the
   fixture session — identical JVal after parse. */
static std::string ReqJsonFx(const char* id, const char* opId,
                             const char* sessionJson, const char* argsJson,
                             const std::string& consentMember)
{
    char b[16384];
    snprintf(b, sizeof(b),
        "{\"v\":1,\"token\":\"%s\",\"timeoutMs\":30000,%s\"request\":{"
        "\"schema\":\"ae-devtools/native-dispatch/v1\",\"requestId\":\"%s\","
        "\"session\":%s,"
        "\"operationId\":\"%s\",\"args\":%s,\"authorizationRef\":\"opaque\"}}",
        kTok, consentMember.c_str(), id, sessionJson, opId,
        argsJson ? argsJson : "null");
    return std::string(b);
}

/* JVal string contains substring (opCalls entries are op ids). */
static int JValContains(JVal* hay, const char* needle)
{
    size_t nl = strlen(needle);
    if (!hay || hay->kind != JK_STR) return 0;
    if (hay->slen < nl) return 0;
    for (size_t i = 0; i + nl <= hay->slen; i++)
        if (memcmp(hay->str + i, needle, nl) == 0) return 1;
    return 0;
}

/* Canonical-JSON serialization of a JVal for embedding verbatim in a
   request file (session object). */
static std::string CanonOf(JVal* v)
{
    char buf[8192];
    size_t len = 0;
    if (!ConsentCanonJson(buf, sizeof(buf), &len, v)) return "";
    return std::string(buf, len);
}

static void TestConsentWireCases()
{
    LoadConsentFixture();
    if (!g_fx) return;
    {
        JVal* keyV = JGet(g_fx, "consentKey");
        JVal* sessV = JGet(g_fx, "session");
        JVal* opV = JGet(g_fx, "operationId");
        JVal* argsDefV = JGet(g_fx, "argsJson");
        JVal* cases = JGet(g_fx, "wireCases");
        std::string key = JStrOf(keyV);
        std::string opId = JStrOf(opV);
        std::string argsDef = JStrOf(argsDefV);
        std::string sessionJson = CanonOf(sessV);
        CHECK(key.size() == 64 && sessV && sessV->kind == JK_OBJ &&
              opId.size() > 0 && !sessionJson.empty());
        CHECK(cases && cases->kind == JK_ARR && cases->nitems > 0);
        if (!(key.size() == 64) || !sessV || sessV->kind != JK_OBJ ||
            opId.empty() || sessionJson.empty() ||
            !cases || cases->kind != JK_ARR)
            return;

        auto h = MakeFakeHost();
        FakeProject& p = h->AddProject("Shot01");
        p.path = "/tmp/shot01.aep";
        p.rootName = h->MakeNameSpec(FakeHost::U16("Root"));
        SetupProjectItems(*h, 0, {
            { "Clip", AEGP_ItemType_COMP, 7001 },
        });
        p.itemMeta[0].comment = h->MakeNameSpec(FakeHost::U16("old note"));
        h->numProjects = 1;
        TmpChan c;
        IntakeEntry(*h, c);

        int keyWritten = 0;
        for (size_t i = 0; i < cases->nitems; i++)
        {
            JVal* cv = cases->items[i];
            std::string name = JStrOf(JGet(cv, "name"));
            std::string rid = JStrOf(JGet(cv, "requestId"));
            JVal* cargs = JGet(cv, "argsJson");
            JVal* ckey = JGet(cv, "channelConsentKey");
            JVal* consent = JGet(cv, "consent");
            JVal* herr = JGet(cv, "hostSetCommentError");
            JVal* nentry = JGet(cv, "nullItemEntry");
            JVal* expect = JGet(cv, "expect");
            std::string argsJson = cargs ? JStrOf(cargs) : argsDef;
            int wantKey = ckey && ckey->kind == JK_TRUE;
            std::string consentMember;
            JVal* macScopeSess = NULL;
            const char* macScopeTgt = NULL;
            size_t macScopeTgtLen = 0;
            std::string macScopeOp, macScopeRid;

            FxCheck(!rid.empty() && !name.empty() && consent && expect,
                    name.c_str(), "case fields missing");
            if (rid.empty() || !consent || !expect) continue;

            /* channel consentKey: written lazily on first keyed case;
               a no-key case after a keyed one is a fixture-order bug */
            if (wantKey && !keyWritten)
            {
                WriteChannelKey(c, key);
                keyWritten = 1;
            }
            FxCheck(wantKey || !keyWritten, name.c_str(),
                    "no-key case ordered after a keyed case");
            if (!wantKey && keyWritten) continue;

            h->setCommentErr =
                (herr && herr->kind == JK_TRUE) ? A_Err_GENERIC : A_Err_NONE;
            h->nullItemEntry =
                (nentry && nentry->kind == JK_TRUE) ? 5 : 0;
            /* suite entry tables are populated once at construction —
               re-populate so a nullItemEntry case sees the NULL entry */
            h->PopulateSuites();

            /* ---- presented consent member ---- */
            {
                JVal* mode = JGet(consent, "mode");
                std::string m = JStrOf(mode);
                if (m == "absent")
                {
                    consentMember = "";
                }
                else if (m == "invalid")
                {
                    std::string mac = JStrOf(JGet(consent, "mac"));
                    consentMember = "\"consent\":{\"v\":1,\"mac\":\"" +
                                     mac + "\"},";
                }
                else if (m == "raw")
                {
                    consentMember = "\"consent\":" +
                                     JStrOf(JGet(consent, "raw")) + ",";
                }
                else if (m == "valid" || m == "macFor")
                {
                    JVal* over = JGet(consent, "macFor");
                    JVal* oReq = over ? JGet(over, "requestId") : NULL;
                    JVal* oOp = over ? JGet(over, "operationId") : NULL;
                    JVal* oSess = over ? JGet(over, "sessionJson") : NULL;
                    JVal* oArgs = over ? JGet(over, "argsJson") : NULL;
                    JVal* oTgt = over ? JGet(over, "target") : NULL;
                    JVal* sessUse = sessV;
                    JVal* argsUse = NULL;
                    std::string computed, wantMac, useArgsJson;

                    macScopeOp = oOp ? JStrOf(oOp) : opId;
                    macScopeRid = oReq ? JStrOf(oReq) : rid;
                    if (oSess)
                    {
                        macScopeSess = JParseStr(JStrOf(oSess));
                        sessUse = macScopeSess;
                    }
                    if (oTgt && oTgt->kind == JK_STR)
                    {
                        macScopeTgt = oTgt->str;
                        macScopeTgtLen = oTgt->slen;
                    }
                    /* args scope: macFor.argsJson overrides the case's
                       args; JSON null means canonical "null" args. */
                    if (oArgs && oArgs->kind == JK_NULL)
                        argsUse = NULL;
                    else
                    {
                        useArgsJson = oArgs ? JStrOf(oArgs) : argsJson;
                        argsUse = useArgsJson.empty()
                                      ? NULL
                                      : JParseStr(useArgsJson);
                    }

                    computed = ConsentMacHex(
                        key.c_str(),
                        macScopeOp.data(), macScopeOp.size(),
                        macScopeRid.data(), macScopeRid.size(),
                        sessUse, argsUse,
                        macScopeTgt, macScopeTgtLen);
                    wantMac = JStrOf(JGet(consent, "expectedMac"));
                    FxCheck(!computed.empty(), name.c_str(),
                            "MAC computation failed");
                    FxCheck(computed == wantMac, name.c_str(),
                            "presented MAC != fixture expectedMac");
                    if (!computed.empty())
                        consentMember = "\"consent\":{\"v\":1,\"mac\":\"" +
                                         computed + "\"},";
                    JFree(macScopeSess);
                    JFree(argsUse);
                }
                else
                {
                    FxCheck(0, name.c_str(), "unknown consent mode");
                    continue;
                }
            }

            /* ---- submit + verdict ---- */
            WriteReq0600(
                c.Path((std::string("inbox/") + rid + ".request.json").c_str()),
                ReqJsonFx(rid.c_str(), opId.c_str(), sessionJson.c_str(),
                          argsJson.c_str(), consentMember));
            CHECK(CallIdle(*h) == A_Err_NONE);
            {
                JVal* doc = NULL;
                std::string r = Slurp(ResultPath(c, rid.c_str()));
                doc = JParseDoc(r.data(), r.size());
                FxCheck(doc != NULL, name.c_str(), "result not JSON");
                if (doc)
                {
                    JVal* res = JGet(doc, "result");
                    FxCheck(res != NULL, name.c_str(), "no result member");
                    if (res)
                    {
                        JVal* eo = JGet(expect, "outcome");
                        JVal* ro = JGet(res, "outcome");
                        FxCheck(JStrEq(ro, JStrOf(eo).c_str()), name.c_str(),
                                "outcome mismatch");
                        if (!JStrEq(ro, JStrOf(eo).c_str()))
                            printf("  case %s: outcome=%s want=%s\n",
                                   name.c_str(), JStrOf(ro).c_str(),
                                   JStrOf(eo).c_str());
                        JVal* erc = JGet(expect, "refusalCode");
                        JVal* rrc = JGet(res, "refusalCode");
                        if (erc && erc->kind == JK_STR)
                            FxCheck(JStrEq(rrc, JStrOf(erc).c_str()),
                                    name.c_str(), "refusalCode mismatch");
                        else
                            FxCheck(rrc == NULL, name.c_str(),
                                    "unexpected refusalCode");
                        JVal* emm = JGet(expect, "mayHaveMutated");
                        JVal* rmm = JGet(res, "mayHaveMutated");
                        std::string emmStr = JStrOf(emm);
                        if (emmStr == "true")
                            FxCheck(rmm && rmm->kind == JK_TRUE, name.c_str(),
                                    "mayHaveMutated != true");
                        else if (emmStr == "false")
                            FxCheck(rmm && rmm->kind == JK_FALSE,
                                    name.c_str(),
                                    "mayHaveMutated != false");
                        else
                            FxCheck(rmm == NULL, name.c_str(),
                                    "mayHaveMutated should be absent");
                        JVal* epay = JGet(expect, "payload");
                        if (epay && epay->kind == JK_OBJ)
                        {
                            JVal* rpay = JGet(res, "result");
                            for (size_t pi = 0; pi < epay->npairs; pi++)
                            {
                                /* JPair keys are length-delimited, not
                                   NUL-terminated — copy before JGet. */
                                std::string pkey(epay->pairs[pi].key,
                                                 epay->pairs[pi].klen);
                                JVal* pv = JGet(rpay, pkey.c_str());
                                JVal* ev = epay->pairs[pi].val;
                                int ok = 0;
                                if (ev->kind == JK_TRUE)
                                    ok = pv && pv->kind == JK_TRUE;
                                else if (ev->kind == JK_FALSE)
                                    ok = pv && pv->kind == JK_FALSE;
                                else if (ev->kind == JK_NUM && pv &&
                                         pv->kind == JK_NUM)
                                    ok = pv->num == ev->num;
                                else if (ev->kind == JK_STR)
                                    ok = JStrEq(pv, JStrOf(ev).c_str());
                                FxCheck(ok, name.c_str(),
                                        "payload field mismatch");
                            }
                        }
                        JVal* opc = JGet(res, "opCalls");
                        JVal* einc = JGet(expect, "opCallsInclude");
                        JVal* eexc = JGet(expect, "opCallsExclude");
                        if (einc && einc->kind == JK_ARR)
                        {
                            for (size_t k = 0; k < einc->nitems; k++)
                            {
                                std::string sub = JStrOf(einc->items[k]);
                                int found = 0;
                                if (opc && opc->kind == JK_ARR)
                                    for (size_t j = 0; j < opc->nitems; j++)
                                        if (JValContains(opc->items[j],
                                                         sub.c_str()))
                                            found = 1;
                                FxCheck(found, name.c_str(),
                                        "opCalls missing expected entry");
                            }
                        }
                        if (eexc && eexc->kind == JK_ARR)
                        {
                            for (size_t k = 0; k < eexc->nitems; k++)
                            {
                                std::string sub = JStrOf(eexc->items[k]);
                                int bad = 0;
                                if (opc && opc->kind == JK_ARR)
                                    for (size_t j = 0; j < opc->nitems; j++)
                                        if (JValContains(opc->items[j],
                                                         sub.c_str()))
                                            bad = 1;
                                FxCheck(!bad, name.c_str(),
                                        "opCalls contains forbidden entry");
                            }
                        }
                    }
                }
                JFree(doc);
            }
        }
        /* leave host flags clean for any later tests */
        h->setCommentErr = A_Err_NONE;
        h->nullItemEntry = 0;
    }
}

/* Declarative operation-metadata integrity (Issue #328 residual):
   S_ALLOWLIST + the executor binding table are the single source for
   opId → arg schema → executor → mutation class. These checks pin
   the real table AND prove ValidateOpTable detects deliberately
   corrupted tables — the counterexamples for "metadata drift passes
   silently". */
static void TestOpTableMetadata()
{
    char detail[160];

    /* the shipped table is self-consistent and fully bound */
    CHECK(ValidateOpTable(S_ALLOWLIST, S_ALLOWLIST_COUNT,
                          detail, sizeof(detail)) == 1);
    CHECK(OpTableSelfCheck() == 1);
    {
        int k;
        for (k = 0; k < EXEC_KIND_COUNT; k++)
            CHECK(ExecForKind(k) != NULL);
    }

    /* mutation classification has exactly one home: the binding
       table. Exactly one kind is mutating, exactly one allowlist
       entry uses it, and that entry is AEGP_SetItemComment — an
       injected misclassification (getter marked mutating, or the
       mutating op rebound to a read-only kind) fails here. */
    {
        int k, mutatingKinds = 0, setCommentEntries = 0;
        for (k = 0; k < EXEC_KIND_COUNT; k++)
            if (ExecKindIsMutating(k)) mutatingKinds++;
        CHECK(mutatingKinds == 1);
        CHECK(ExecKindIsMutating(EXEC_SET_ITEM_COMMENT) == 1);
        for (k = 0; k < S_ALLOWLIST_COUNT; k++)
        {
            if (S_ALLOWLIST[k].execKind == EXEC_SET_ITEM_COMMENT)
            {
                setCommentEntries++;
                CHECK(strcmp(S_ALLOWLIST[k].operationId,
                             "AEGP_ItemSuite9.AEGP_SetItemComment") == 0);
            }
        }
        CHECK(setCommentEntries == 1);
        /* no other entry may bind the mutating kind */
        CHECK(ExecKindIsMutating(EXEC_ITEM_GETTER) == 0);
        CHECK(ExecKindIsMutating(EXEC_COMP_GETTER) == 0);
        CHECK(ExecKindIsMutating(EXEC_RQ_ITEM_GETTER) == 0);
    }

    /* ---- corrupted-table counterexamples -------------------------- */
    {
        static const IntakeArgSpec goodSpec[] = {
            { "projectIndex", ARGK_INT, 0.0, 1000000.0 },
        };
        AllowEntry good = {
            "AEGP_X.AEGP_Y", "AEGP_X.AEGP_Y", goodSpec, 1,
            EXEC_NUM_PROJECTS };
        AllowEntry bad[4];
        int i;

        /* baseline: a minimal valid table passes */
        CHECK(ValidateOpTable(&good, 1, detail, sizeof(detail)) == 1);

        /* empty table */
        CHECK(ValidateOpTable(NULL, 0, detail, sizeof(detail)) == 0);

        /* duplicate operationId */
        bad[0] = good; bad[1] = good;
        CHECK(ValidateOpTable(bad, 2, detail, sizeof(detail)) == 0);

        /* opRecordId must mirror operationId */
        bad[0] = good; bad[0].opRecordId = "AEGP_X.AEGP_Z";
        CHECK(ValidateOpTable(bad, 1, detail, sizeof(detail)) == 0);

        /* nargs>0 with NULL spec */
        bad[0] = good; bad[0].argsSpec = NULL;
        CHECK(ValidateOpTable(bad, 1, detail, sizeof(detail)) == 0);

        /* nargs=0 with spec present */
        bad[0] = good; bad[0].nargs = 0;
        CHECK(ValidateOpTable(bad, 1, detail, sizeof(detail)) == 0);

        /* execKind out of range (both directions) */
        bad[0] = good; bad[0].execKind = -1;
        CHECK(ValidateOpTable(bad, 1, detail, sizeof(detail)) == 0);
        bad[0] = good; bad[0].execKind = EXEC_KIND_COUNT;
        CHECK(ValidateOpTable(bad, 1, detail, sizeof(detail)) == 0);

        /* arg kind out of range */
        {
            IntakeArgSpec badKind[] = {
                { "x", 99, 0.0, 1.0 },
            };
            bad[0] = good; bad[0].argsSpec = badKind;
            CHECK(ValidateOpTable(bad, 1, detail, sizeof(detail)) == 0);
        }

        /* inverted integer bounds */
        {
            IntakeArgSpec badBounds[] = {
                { "x", ARGK_INT, 5.0, 1.0 },
            };
            bad[0] = good; bad[0].argsSpec = badBounds;
            CHECK(ValidateOpTable(bad, 1, detail, sizeof(detail)) == 0);
        }

        /* ARGK_STR with non-positive byte bound */
        {
            IntakeArgSpec badStr[] = {
                { "x", ARGK_STR, 0.0, 0.0 },
            };
            bad[0] = good; bad[0].argsSpec = badStr;
            CHECK(ValidateOpTable(bad, 1, detail, sizeof(detail)) == 0);
        }

        /* missing operationId */
        bad[0] = good; bad[0].operationId = NULL;
        CHECK(ValidateOpTable(bad, 1, detail, sizeof(detail)) == 0);

        (void)i;
    }
}

int main(int argc, char** argv)
{
    /* --channel-server <root> <requestId> [deadlineMs]: drive the real
       entry + idle hook against FakeHost until the result file for
       <requestId> appears in <root>/outbox — the plug-in side of the
       native-channel/v1 fake E2E (Issue #267 Slice B). Exit 0 on
       delivery, 3 on deadline, 4 on entry failure. */
    if (argc > 3 && strcmp(argv[1], "--channel-server") == 0)
    {
        auto h = MakeFakeHost();
        /* optional 5th arg "with-items": deterministic project fixture
           for the Issue #270 Stage 3 aeRef resolution E2E — one project
           with two top-level COMP items ("Plate", "Café"). */
        if (argc > 5 && strcmp(argv[5], "with-items") == 0)
        {
            FakeProject& p = h->AddProject("E2EShot");
            p.rootName = h->MakeNameSpec(FakeHost::U16("Root"));
            h->SetItemNames(0, {
                h->MakeNameSpec(FakeHost::U16("Plate")),
                h->MakeNameSpec(FakeHost::U16Codepoints({'C', 'a', 'f', 0xE9})),
            });
            h->numProjects = 1;
        }
        /* "with-rq": §7f fixture — one project, two comp items, three
           queue slots (ClipA×2 different status, ClipB) for manual
           channel debugging. */
        if (argc > 5 && strcmp(argv[5], "with-rq") == 0)
        {
            FakeProject& p = h->AddProject("Shot01");
            p.path = "/tmp/shot01.aep";
            p.rootName = h->MakeNameSpec(FakeHost::U16("Root"));
            SetupProjectItems(*h, 0, {
                { "ClipA", AEGP_ItemType_COMP, 6101 },
                { "ClipB", AEGP_ItemType_COMP, 6102 },
            });
            h->numProjects = 1;
            h->numRQItems = 3;
            h->rqItemMeta.resize(3);
            h->rqItemMeta[0].compProject = 0;
            h->rqItemMeta[0].compItem = 0;
            h->rqItemMeta[0].status = AEGP_RenderItemStatus_QUEUED;
            h->rqItemMeta[0].numOutputModules = 1;
            h->rqItemMeta[0].comment =
                h->MakeNameSpec(FakeHost::U16("render note"));
            h->rqItemMeta[1].compProject = 0;
            h->rqItemMeta[1].compItem = 1;
            h->rqItemMeta[1].status = AEGP_RenderItemStatus_RENDERING;
            h->rqItemMeta[1].numOutputModules = 2;
            h->rqItemMeta[2].compProject = 0;
            h->rqItemMeta[2].compItem = 0;
            h->rqItemMeta[2].status = AEGP_RenderItemStatus_UNQUEUED;
            h->rqItemMeta[2].numOutputModules = 1;
        }
        setenv("AE_DEVTOOLS_NATIVE_CHANNEL", argv[2], 1);
        if (CallEntry(*h) != A_Err_NONE)
            return 4;
        std::string result =
            std::string(argv[2]) + "/outbox/" + argv[3] + ".result.json";
        long deadlineMs = argc > 4 ? atol(argv[4]) : 15000;
        long waited = 0;
        while (waited < deadlineMs)
        {
            CallIdle(*h);
            if (access(result.c_str(), F_OK) == 0)
            {
                printf("%s\n", result.c_str());
                return 0;
            }
            usleep(20000);
            waited += 20;
        }
        return 3;
    }

    TestEntryRegistersIdleHook();
    TestEntrySuiteAcquireFailures();
    TestEntryNullBasicSuite();
    TestEntryRegisterIdleHookFails();
    TestEntryRegisterWithAEGPFails_StillRegisters();

    TestProbeHappyPathOneProject();
    TestProbeZeroProjects();
    TestProbeRenderQueueSlice();
    TestProbeRenderQueueSuiteAcquireFails_NonFatal();
    TestProbeRenderQueueItemsQueryFails();
    TestProbeTwoProjects();
    TestIdleUnchangedCountDoesNotReprobe();
    TestIdleReprobesOnProjectCountChange();
    TestIdleSuiteAcquireFailures();
    TestIdleNullSuiteEntries();
    TestMemLockFailureStillFrees();
    TestMemSizeFailureStillFrees();
    TestUnterminatedAndOddSizeUtf16();
    TestLoneSurrogatesBecomeReplacementChar();
    TestGetItemNameErrorPath();
    TestNullHandleFromGetItemName();
    TestNumProjectsQueryFails();
    TestIdleSameCountProjectSwitchReprobes();
    TestIdleSameNameDifferentPathReprobes();
    TestIdleRecoveryAfterCountFailure();
    TestIdleRecoveryAfterFingerprintFailure();
    TestIdleFingerprintFailsOnMissingProject();
    TestIdlePathQueryFailureFailsFingerprint();
    TestSilentTickEmitsNoOpRecords();
    TestProbeItemMetadataAndViewSlice();
    TestProbeItemViewSuiteUnavailable_NonFatal();
    TestProbeItemViewEntriesMissing_NonFatal();
    TestProbeItemMetaFailuresNonFatal();
    TestProbeProjectLevelQueryFailures();
    TestIdleNullItemEntryFailsClosed();
    TestProbeCompSlice();
    TestProbeCompSuiteUnavailable_NonFatal();
    TestProbeCompEntriesMissing_NonFatal();
    TestProbeCompQueryFailuresNonFatal();

    TestProbeNoMRUComp();
    TestProbeLayerSlice();
    TestProbeLayerSuiteUnavailable_NonFatal();
    TestProbeLayerEntriesMissing_NonFatal();
    TestProbeLayerQueryFailuresNonFatal();
    TestProbeCompNoLayers();

    TestIntakeDisabledByDefault();
    TestIntakeCompletedGetNumProjects();
    TestIntakeVersionOp();
    TestIntakeGetTypeNameCompleted();
    TestIntakeArgsRejected();
    TestIntakeArgsOnZeroArgOpRejected();
    TestIntakeGetTypeNameSuiteFailure();
    TestIntakeGetTypeNameOpFailure();
    TestIntakeStage2ZeroArgGetters();
    TestIntakeStage2RQSuiteFailure();
    TestIntakeStage2ArgsStillRejected();
    TestIntakeGetItemNameCompleted();
    TestIntakeGetItemNameStale();
    TestIntakeGetItemNameMalformed();
    TestIntakeGetItemNameSuiteFailure();
    TestIntakeGetItemNameOpFailure();
    TestIntakeGetItemIDIssuance();
    TestIntakeGetFirstProjItemPages();
    TestIntakeIdentityReorder();
    TestIntakeIdentityABA();
    TestIntakeIdentityProjectBinding();
    TestIntakeIdentitySessionRebuild();
    TestIntakeIdentitySameNameSameType();
    TestIntakeIdentityMalformed();
    TestIntakeEnumerateUndescribableName();
    TestIntakeCompGetters();
    TestIntakeItemGetters();
    TestIntakeLayerGetters();
    TestIntakeProjectGetters();
    TestIntakeProjectCollision();
    TestIntakeRQItemGetters();
    TestIntakeSetItemComment();
    TestIntakeSetItemCommentNoEntry();
    TestConsentVectors();
    TestConsentWireCases();
    TestOpTableMetadata();
    TestIntakeUnknownOperation();
    TestIntakeStaleDeadline();
    TestIntakeDeadlineBounds();
    TestIntakeSymlinkRequestNotClaimed();
    TestIntakePartSymlinkNeverWrittenThrough();
    TestIntakeClaimedLeftoverIgnored();
    TestIntakeTokenMismatch();
    TestIntakeSessionMismatch();
    TestIntakeTargetMismatchSkipped();
    TestIntakeMalformed();
    TestIntakeDuplicateRequestId();
    TestIntakeOnePerTick();
    TestIntakeSuiteFailureGivesFailed();
    TestIntakeMissingEntryAbortsBeforeIntake();
    TestIntakeResultPublishFailure();
    TestIntakeInterruptedBySuiteAcquireFailure();
    TestIntakeChannelPrivacyViolation();

    printf("----\n%d checks, %d failures\n", g_checks, g_failures);
    return g_failures == 0 ? 0 : 1;
}
