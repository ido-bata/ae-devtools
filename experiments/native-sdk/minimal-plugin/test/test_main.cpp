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
