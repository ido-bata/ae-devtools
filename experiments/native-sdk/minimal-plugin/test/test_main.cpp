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

#include <cstdio>
#include <cstring>

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
    for (int i = 0; i < 5; i++)
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

    /* every AE-allocated mem handle disposed: fingerprint path +
       probe path + root-folder name + 3 item names */
    CHECK(AllMemFreed(*h) == 0);
    CHECK(h->memHandlesFreed == (int)h->memRecs.size());
    CHECK(h->memHandlesFreed == 6);
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
    CHECK(h->LogContains("op AEGP_ItemSuite9.AEGP_GetItemType err=0 value=2")); /* AEGP_ItemType_COMP */
    CHECK(h->LogContains("op AEGP_ItemSuite9.AEGP_GetNextProjItem err=0"));
    CHECK(h->LogContains("op AEGPMemorySuite1.AEGP_GetMemHandleSize err=0"));
    CHECK(h->LogContains("op AEGPMemorySuite1.AEGP_LockMemHandle err=0"));
    CHECK(h->LogContains("op AEGPMemorySuite1.AEGP_UnlockMemHandle err=0"));
    CHECK(h->LogContains("op AEGPMemorySuite1.AEGP_FreeMemHandle err=0"));
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
       handles (fingerprint + probe) are still disposed. */
    CHECK(h->memHandlesFreed == (int)h->memRecs.size());
    CHECK(h->memHandlesFreed == 2);
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

/* ------------------------------------------------------------------ */

int main()
{
    TestEntryRegistersIdleHook();
    TestEntrySuiteAcquireFailures();
    TestEntryNullBasicSuite();
    TestEntryRegisterIdleHookFails();
    TestEntryRegisterWithAEGPFails_StillRegisters();

    TestProbeHappyPathOneProject();
    TestProbeZeroProjects();
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

    printf("----\n%d checks, %d failures\n", g_checks, g_failures);
    return g_failures == 0 ? 0 : 1;
}
