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
    CHECK(h.idleHook != NULL);
    return h.idleHook(NULL, NULL, &max_sleep);
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
    CHECK(h->log.empty());
    CHECK(h->StartCount() == 0);
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
    CHECK(h->LogContains("project.rootFolder.name: Root Folder"));
    CHECK(h->LogContains("project.items[0].name: Plate"));
    CHECK(h->LogContains("project.items[1].name: Caf\xC3\xA9"));
    CHECK(h->LogContains("project.items[2].name: \xF0\x9F\x98\x80"));
    CHECK(h->LogContains("project.items.count=3"));
    CHECK(h->LogContains("driver.pluginInitVersion=1.0"));
    CHECK(h->LogContains("driver.implementationVersion=26.5"));
    CHECK(h->LogContains("host.isActivated=1"));

    /* every AE-allocated mem handle disposed */
    CHECK(AllMemFreed(*h) == 0);
    CHECK(h->memHandlesFreed == (int)h->memRecs.size());
    CHECK(h->memHandlesFreed == 4); /* root + 3 items */
    CHECK(h->lastGetItemNamePluginId == 4242); /* id from RegisterWithAEGP */
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
    CHECK(h->memHandlesFreed == 0); /* no handles were produced */
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
    CHECK(h->memHandlesFreed == 0); /* NULL handle: nothing to free */
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

    printf("----\n%d checks, %d failures\n", g_checks, g_failures);
    return g_failures == 0 ? 0 : 1;
}
