/*******************************************************************/
/*                                                                 */
/* ae-a8n NativeProbe — fake AEGP host implementation              */
/*                                                                 */
/* Original test code. See fake_host.h.                            */
/*******************************************************************/

#include "fake_host.h"

#include <string.h>

#include <cstdio>

/* Single active host — the tests are sequential and single-threaded,
   mirroring the probe's own main-thread affinity assumption. */
static FakeHost* g_host = NULL;

/* ------------------------------------------------------------------ */
/* small helpers                                                      */
/* ------------------------------------------------------------------ */

std::vector<A_UTF16Char> FakeHost::U16(const char* utf8Z)
{
    /* Test helper: ASCII + common Latin-1 only; tests needing wider
       coverage use U16Codepoints. */
    std::vector<A_UTF16Char> out;
    const unsigned char* p = (const unsigned char*)utf8Z;
    while (*p)
    {
        unsigned int cp;
        if (*p < 0x80)
        {
            cp = *p++;
        }
        else if ((*p & 0xE0) == 0xC0 && p[1])
        {
            cp = ((*p & 0x1F) << 6) | (p[1] & 0x3F);
            p += 2;
        }
        else if ((*p & 0xF0) == 0xE0 && p[1] && p[2])
        {
            cp = ((*p & 0x0F) << 12) | ((p[1] & 0x3F) << 6) | (p[2] & 0x3F);
            p += 3;
        }
        else
        {
            cp = 0xFFFD;
            p++;
        }
        out.push_back((A_UTF16Char)cp);
    }
    out.push_back(0);
    return out;
}

std::vector<A_UTF16Char> FakeHost::U16Codepoints(std::initializer_list<unsigned int> cps)
{
    std::vector<A_UTF16Char> out;
    for (unsigned int cp : cps)
    {
        if (cp > 0xFFFF)
        {
            cp -= 0x10000;
            out.push_back((A_UTF16Char)(0xD800 + (cp >> 10)));
            out.push_back((A_UTF16Char)(0xDC00 + (cp & 0x3FF)));
        }
        else
        {
            out.push_back((A_UTF16Char)cp);
        }
    }
    out.push_back(0);
    return out;
}

FakeNameSpec FakeHost::MakeNameSpec(
    const std::vector<A_UTF16Char>& units,
    AEGP_MemSize sizeBytes,
    bool sizeOverride,
    int failMode)
{
    FakeNameSpec spec;
    spec.units = units;
    spec.sizeBytes = sizeBytes;
    spec.sizeOverride = sizeOverride;
    spec.failMode = failMode;
    return spec;
}

FakeProject& FakeHost::AddProject(const char* name)
{
    FakeProject p;
    p.name = name;
    projects.push_back(p);
    return projects.back();
}

void FakeHost::SetItemNames(int projIndex, std::initializer_list<FakeNameSpec> names)
{
    if (projIndex < 0 || projIndex >= (int)projects.size())
    {
        return;
    }
    FakeProject& p = projects[projIndex];
    p.itemNames.assign(names.begin(), names.end());
    p.itemTypes.assign(names.size(), AEGP_ItemType_COMP);
}

int FakeHost::CountLogContaining(const char* needleZ) const
{
    int n = 0;
    for (const std::string& s : log)
    {
        if (s.find(needleZ) != std::string::npos)
        {
            n++;
        }
    }
    return n;
}

bool FakeHost::LogContains(const char* needleZ) const
{
    return CountLogContaining(needleZ) > 0;
}

int FakeHost::StartCount() const
{
    return CountLogContaining("probe.start");
}

/* ------------------------------------------------------------------ */
/* mem-handle plumbing                                                */
/* ------------------------------------------------------------------ */

static AEGP_MemHandle MakeMemHandle(FakeMemRec* rec)
{
    struct _Up_OpaqueMem* inner = new struct _Up_OpaqueMem;
    struct _Up_OpaqueMem** hp = new struct _Up_OpaqueMem*;
    inner->rec = rec;
    *hp = inner;
    return (AEGP_MemHandle)hp;
}

static FakeMemRec* RecFromHandle(AEGP_MemHandle h)
{
    struct _Up_OpaqueMem** hp = (struct _Up_OpaqueMem**)h;
    return (*hp)->rec;
}

static AEGP_MemHandle NewMemHandleFromSpec(const FakeNameSpec& spec)
{
    FakeHost* h = g_host;
    std::unique_ptr<FakeMemRec> rec(new FakeMemRec);
    rec->units = spec.units;
    rec->sizeOverride = spec.sizeOverride;
    rec->sizeBytes = spec.sizeBytes;
    rec->failMode = spec.failMode;
    if (!rec->sizeOverride)
    {
        rec->sizeBytes = (AEGP_MemSize)(rec->units.size() * sizeof(A_UTF16Char));
    }
    FakeMemRec* raw = rec.get();
    h->memRecs.push_back(std::move(rec));
    return MakeMemHandle(raw);
}

/* ------------------------------------------------------------------ */
/* fake suite entry points                                            */
/* ------------------------------------------------------------------ */

static SPErr FakeAcquireSuite(const char* nameZ, int32 versionL, const void** suitePP)
{
    FakeHost* h = g_host;
    (void)versionL;
    *suitePP = NULL;

    int slot = -1;
    bool fail = false;
    const void* table = NULL;

    if (strcmp(nameZ, kAEGPUtilitySuite) == 0)
    {
        slot = 0; fail = h->failAcquireUtility; table = &h->utilSuite;
    }
    else if (strcmp(nameZ, kAEGPProjSuite) == 0)
    {
        slot = 1; fail = h->failAcquireProj; table = &h->projSuite;
    }
    else if (strcmp(nameZ, kAEGPItemSuite) == 0)
    {
        slot = 2; fail = h->failAcquireItem; table = &h->itemSuite;
    }
    else if (strcmp(nameZ, kAEGPMemorySuite) == 0)
    {
        slot = 3; fail = h->failAcquireMemory; table = &h->memSuite;
    }
    else if (strcmp(nameZ, kAEGPRegisterSuite) == 0)
    {
        slot = 4; fail = h->failAcquireRegister; table = &h->regSuite;
    }
    else
    {
        return 1; /* unknown suite: acquisition fails */
    }

    if (fail)
    {
        return 1;
    }
    h->acquireCount[slot]++;
    *suitePP = table;
    return 0;
}

static SPErr FakeReleaseSuite(const char* nameZ, int32 versionL)
{
    FakeHost* h = g_host;
    (void)versionL;
    if (strcmp(nameZ, kAEGPUtilitySuite) == 0) h->releaseCount[0]++;
    else if (strcmp(nameZ, kAEGPProjSuite) == 0) h->releaseCount[1]++;
    else if (strcmp(nameZ, kAEGPItemSuite) == 0) h->releaseCount[2]++;
    else if (strcmp(nameZ, kAEGPMemorySuite) == 0) h->releaseCount[3]++;
    else if (strcmp(nameZ, kAEGPRegisterSuite) == 0) h->releaseCount[4]++;
    return 0;
}

static SPBoolean FakeIsEqual(const char* aZ, const char* bZ)
{
    return strcmp(aZ, bZ) == 0;
}

/* ---- utility suite ---- */

static A_Err FakeWriteToDebugLog(const A_char* subZ, const A_char* eventZ, const A_char* infoZ)
{
    (void)subZ; (void)eventZ;
    g_host->log.push_back(infoZ ? infoZ : "");
    return A_Err_NONE;
}

static A_Err FakeGetDriverPluginInitFuncVersion(A_short* majPS, A_short* minPS)
{
    *majPS = 1; *minPS = 0;
    return A_Err_NONE;
}

static A_Err FakeGetDriverImplementationVersion(A_short* majPS, A_short* minPS)
{
    *majPS = 26; *minPS = 5;
    return A_Err_NONE;
}

static A_Err FakeGetSuppressInteractiveUI(A_Boolean* outPB)
{
    *outPB = FALSE;
    return A_Err_NONE;
}

static A_Err FakeHostIsActivated(A_Boolean* outPB)
{
    *outPB = TRUE;
    return A_Err_NONE;
}

static A_Err FakeRegisterWithAEGP(AEGP_GlobalRefcon refcon, const A_char* nameZ, AEGP_PluginID* idP)
{
    (void)refcon;
    FakeHost* h = g_host;
    h->registerWithAegpCalls++;
    h->registeredName = nameZ ? nameZ : "";
    if (h->registerWithAegpFails)
    {
        return A_Err_GENERIC;
    }
    *idP = 4242;
    return A_Err_NONE;
}

/* ---- register suite ---- */

static A_Err FakeRegisterIdleHook(
    AEGP_PluginID plugin_id,
    AEGP_IdleHook idle_hook_func,
    AEGP_IdleRefcon refconP)
{
    (void)refconP;
    FakeHost* h = g_host;
    h->idleHookRegistrations++;
    h->idleHookPluginId = plugin_id;
    if (!h->registerIdleHookFails)
    {
        h->idleHook = idle_hook_func;
    }
    return h->registerIdleHookFails ? A_Err_GENERIC : A_Err_NONE;
}

/* ---- project suite ---- */

static FakeProject* ProjectForHandle(AEGP_ProjectH h)
{
    struct _AEGP_Project** hp = (struct _AEGP_Project**)h;
    int idx = (*hp)->index;
    FakeHost* host = g_host;
    if (idx < 0 || idx >= (int)host->projects.size())
    {
        return NULL;
    }
    return &host->projects[idx];
}

static A_Err FakeGetNumProjects(A_long* numP)
{
    if (g_host->numProjectsErr != A_Err_NONE)
    {
        return (A_Err)g_host->numProjectsErr;
    }
    *numP = g_host->numProjects;
    return A_Err_NONE;
}

static A_Err FakeGetProjectByIndex(A_long idxL, AEGP_ProjectH* projPH)
{
    FakeHost* h = g_host;
    *projPH = NULL;
    if (idxL < 0 || idxL >= h->numProjects || idxL >= (int)h->projects.size())
    {
        return A_Err_PARAMETER;
    }
    struct _AEGP_Project* p = new struct _AEGP_Project;
    p->index = (int)idxL;
    struct _AEGP_Project** hp = new struct _AEGP_Project*;
    *hp = p;
    *projPH = (AEGP_ProjectH)hp;
    return A_Err_NONE;
}

static A_Err FakeGetProjectName(AEGP_ProjectH projH, A_char* nameZ)
{
    FakeProject* p = ProjectForHandle(projH);
    if (!p)
    {
        return A_Err_PARAMETER;
    }
    strncpy(nameZ, p->name.c_str(), AEGP_MAX_PROJ_NAME_SIZE);
    nameZ[AEGP_MAX_PROJ_NAME_SIZE] = '\0';
    return A_Err_NONE;
}

static A_Err FakeProjectIsDirty(AEGP_ProjectH projH, A_Boolean* dirtyPB)
{
    FakeProject* p = ProjectForHandle(projH);
    if (!p) return A_Err_PARAMETER;
    *dirtyPB = p->dirty ? TRUE : FALSE;
    return A_Err_NONE;
}

static A_Err FakeGetProjectBitDepth(AEGP_ProjectH projH, AEGP_ProjBitDepth* depthP)
{
    FakeProject* p = ProjectForHandle(projH);
    if (!p) return A_Err_PARAMETER;
    *depthP = p->bitDepth;
    return A_Err_NONE;
}

static A_Err FakeGetProjectRootFolder(AEGP_ProjectH projH, AEGP_ItemH* itemPH)
{
    FakeProject* p = ProjectForHandle(projH);
    if (!p) return A_Err_PARAMETER;
    struct _AEGP_Item* it = new struct _AEGP_Item;
    it->projIndex = p - &g_host->projects[0];
    it->itemIndex = -1;
    struct _AEGP_Item** hp = new struct _AEGP_Item*;
    *hp = it;
    *itemPH = (AEGP_ItemH)hp;
    return A_Err_NONE;
}

/* ---- item suite ---- */

static FakeProject* ProjectOfItem(AEGP_ItemH itemH)
{
    struct _AEGP_Item** hp = (struct _AEGP_Item**)itemH;
    int pi = (*hp)->projIndex;
    if (pi < 0 || pi >= (int)g_host->projects.size())
    {
        return NULL;
    }
    return &g_host->projects[pi];
}

static int ItemIndexOf(AEGP_ItemH itemH)
{
    struct _AEGP_Item** hp = (struct _AEGP_Item**)itemH;
    return (*hp)->itemIndex;
}

static AEGP_ItemH MakeItemHandle(int projIndex, int itemIndex)
{
    struct _AEGP_Item* it = new struct _AEGP_Item;
    it->projIndex = projIndex;
    it->itemIndex = itemIndex;
    struct _AEGP_Item** hp = new struct _AEGP_Item*;
    *hp = it;
    return (AEGP_ItemH)hp;
}

static A_Err FakeGetFirstProjItem(AEGP_ProjectH projH, AEGP_ItemH* itemPH)
{
    FakeProject* p = ProjectForHandle(projH);
    *itemPH = NULL;
    if (!p) return A_Err_PARAMETER;
    int pi = (int)(p - &g_host->projects[0]);
    if (p->itemNames.empty())
    {
        return A_Err_NONE; /* *itemPH stays NULL: empty project */
    }
    *itemPH = MakeItemHandle(pi, 0);
    return A_Err_NONE;
}

static A_Err FakeGetNextProjItem(AEGP_ProjectH projH, AEGP_ItemH itemH, AEGP_ItemH* nextPH)
{
    FakeProject* p = ProjectForHandle(projH);
    *nextPH = NULL;
    if (!p) return A_Err_PARAMETER;
    int pi = (int)(p - &g_host->projects[0]);
    int next = ItemIndexOf(itemH) + 1;
    if (next < (int)p->itemNames.size())
    {
        *nextPH = MakeItemHandle(pi, next);
    }
    return A_Err_NONE;
}

static A_Err FakeGetItemType(AEGP_ItemH itemH, AEGP_ItemType* typeP)
{
    FakeProject* p = ProjectOfItem(itemH);
    int ii = ItemIndexOf(itemH);
    if (!p || ii < 0) return A_Err_PARAMETER;
    if (ii < (int)p->itemTypes.size())
    {
        *typeP = p->itemTypes[ii];
    }
    else
    {
        *typeP = AEGP_ItemType_COMP;
    }
    return A_Err_NONE;
}

static A_Err FakeGetItemName(AEGP_PluginID pluginID, AEGP_ItemH itemH, AEGP_MemHandle* namePH)
{
    g_host->lastGetItemNamePluginId = pluginID;
    *namePH = NULL;
    if (g_host->itemNameErr != A_Err_NONE)
    {
        return (A_Err)g_host->itemNameErr;
    }
    FakeProject* p = ProjectOfItem(itemH);
    int ii = ItemIndexOf(itemH);
    const FakeNameSpec* spec = NULL;
    if (p)
    {
        if (ii == -1 && !p->rootName.units.empty())
        {
            spec = &p->rootName;
        }
        else if (ii >= 0 && ii < (int)p->itemNames.size())
        {
            spec = &p->itemNames[ii];
        }
    }
    if (!spec)
    {
        /* No configured name: return an empty-string handle. */
        static const A_UTF16Char emptyU16[1] = {0};
        FakeNameSpec tmp;
        tmp.units.assign(emptyU16, emptyU16 + 1);
        *namePH = NewMemHandleFromSpec(tmp);
        return A_Err_NONE;
    }
    if (spec->failMode == 3)
    {
        return A_Err_GENERIC;
    }
    if (spec->failMode == 4)
    {
        return A_Err_NONE; /* success but NULL handle */
    }
    *namePH = NewMemHandleFromSpec(*spec);
    return A_Err_NONE;
}

/* ---- memory suite ---- */

static A_Err FakeNewMemHandle(
    AEGP_PluginID plugin_id, const A_char* whatZ, AEGP_MemSize size,
    AEGP_MemFlag flags, AEGP_MemHandle* memPH)
{
    (void)plugin_id; (void)whatZ; (void)size; (void)flags;
    *memPH = NULL;
    return A_Err_GENERIC;
}

static A_Err FakeFreeMemHandle(AEGP_MemHandle memH)
{
    FakeMemRec* rec = RecFromHandle(memH);
    rec->freed = true;
    g_host->memHandlesFreed++;
    struct _Up_OpaqueMem** hp = (struct _Up_OpaqueMem**)memH;
    delete *hp;
    delete hp;
    return A_Err_NONE;
}

static A_Err FakeLockMemHandle(AEGP_MemHandle memH, void** ptrPPV)
{
    FakeMemRec* rec = RecFromHandle(memH);
    if (rec->failMode == 2)
    {
        return A_Err_GENERIC;
    }
    rec->lockCount++;
    *ptrPPV = rec->units.empty() ? NULL : (void*)rec->units.data();
    return A_Err_NONE;
}

static A_Err FakeUnlockMemHandle(AEGP_MemHandle memH)
{
    FakeMemRec* rec = RecFromHandle(memH);
    if (rec->lockCount > 0)
    {
        rec->lockCount--;
    }
    return A_Err_NONE;
}

static A_Err FakeGetMemHandleSize(AEGP_MemHandle memH, AEGP_MemSize* sizeP)
{
    FakeMemRec* rec = RecFromHandle(memH);
    if (rec->failMode == 1)
    {
        return A_Err_GENERIC;
    }
    *sizeP = rec->sizeBytes;
    return A_Err_NONE;
}

/* ------------------------------------------------------------------ */
/* host construction                                                  */
/* ------------------------------------------------------------------ */

FakeHost::FakeHost()
{
    PopulateSuites();
}

void FakeHost::PopulateSuites()
{
    memset(&utilSuite, 0, sizeof(utilSuite));
    memset(&projSuite, 0, sizeof(projSuite));
    memset(&itemSuite, 0, sizeof(itemSuite));
    memset(&memSuite, 0, sizeof(memSuite));
    memset(&regSuite, 0, sizeof(regSuite));
    memset(&basicSuite, 0, sizeof(basicSuite));

    /* utility */
    if (!nullWriteToDebugLog)
    {
        utilSuite.AEGP_WriteToDebugLog = FakeWriteToDebugLog;
    }
    utilSuite.AEGP_GetDriverPluginInitFuncVersion = FakeGetDriverPluginInitFuncVersion;
    utilSuite.AEGP_GetDriverImplementationVersion = FakeGetDriverImplementationVersion;
    utilSuite.AEGP_GetSuppressInteractiveUI = FakeGetSuppressInteractiveUI;
    utilSuite.AEGP_HostIsActivated = FakeHostIsActivated;
    utilSuite.AEGP_RegisterWithAEGP = FakeRegisterWithAEGP;

    /* project */
    if (nullProjEntry != 1) projSuite.AEGP_GetNumProjects = FakeGetNumProjects;
    if (nullProjEntry != 2) projSuite.AEGP_GetProjectByIndex = FakeGetProjectByIndex;
    projSuite.AEGP_GetProjectName = FakeGetProjectName;
    projSuite.AEGP_ProjectIsDirty = FakeProjectIsDirty;
    projSuite.AEGP_GetProjectBitDepth = FakeGetProjectBitDepth;
    projSuite.AEGP_GetProjectRootFolder = FakeGetProjectRootFolder;

    /* item */
    itemSuite.AEGP_GetFirstProjItem = FakeGetFirstProjItem;
    itemSuite.AEGP_GetNextProjItem = FakeGetNextProjItem;
    itemSuite.AEGP_GetItemType = FakeGetItemType;
    itemSuite.AEGP_GetItemName = FakeGetItemName;

    /* memory */
    memSuite.AEGP_NewMemHandle = FakeNewMemHandle;
    if (nullMemEntry != 1) memSuite.AEGP_FreeMemHandle = FakeFreeMemHandle;
    memSuite.AEGP_LockMemHandle = FakeLockMemHandle;
    memSuite.AEGP_UnlockMemHandle = FakeUnlockMemHandle;
    if (nullMemEntry != 2) memSuite.AEGP_GetMemHandleSize = FakeGetMemHandleSize;

    /* register */
    if (!registerIdleHookMissing) regSuite.AEGP_RegisterIdleHook = FakeRegisterIdleHook;

    /* basic */
    basicSuite.AcquireSuite = FakeAcquireSuite;
    basicSuite.ReleaseSuite = FakeReleaseSuite;
    basicSuite.IsEqual = FakeIsEqual;
}

std::unique_ptr<FakeHost> MakeFakeHost()
{
    std::unique_ptr<FakeHost> h(new FakeHost);
    g_host = h.get();
    return h;
}
