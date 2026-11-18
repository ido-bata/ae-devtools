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
    else if (strcmp(nameZ, kAEGPRenderQueueSuite) == 0)
    {
        slot = 5; fail = h->failAcquireRQ; table = &h->rqSuite;
    }
    else if (strcmp(nameZ, kAEGPRQItemSuite) == 0)
    {
        slot = 6; fail = h->failAcquireRQItem; table = &h->rqItemSuite;
    }
    else if (strcmp(nameZ, kAEGPItemViewSuite) == 0)
    {
        slot = 7; fail = h->failAcquireItemView; table = &h->itemViewSuite;
    }
    else if (strcmp(nameZ, kAEGPCompSuite) == 0)
    {
        slot = 8; fail = h->failAcquireComp; table = &h->compSuite;
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
    else if (strcmp(nameZ, kAEGPRenderQueueSuite) == 0) h->releaseCount[5]++;
    else if (strcmp(nameZ, kAEGPRQItemSuite) == 0) h->releaseCount[6]++;
    else if (strcmp(nameZ, kAEGPItemViewSuite) == 0) h->releaseCount[7]++;
    else if (strcmp(nameZ, kAEGPCompSuite) == 0) h->releaseCount[8]++;
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
    if (h->getProjectByIndexErr != A_Err_NONE)
    {
        return (A_Err)h->getProjectByIndexErr;
    }
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
    if (g_host->projectNameErr != A_Err_NONE)
    {
        return (A_Err)g_host->projectNameErr;
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

static A_Err FakeGetProjectPath(AEGP_ProjectH projH, AEGP_MemHandle* pathPH)
{
    FakeProject* p = ProjectForHandle(projH);
    *pathPH = NULL;
    if (!p)
    {
        return A_Err_PARAMETER;
    }
    if (g_host->projectPathErr != A_Err_NONE)
    {
        return (A_Err)g_host->projectPathErr;
    }
    /* Header contract: empty string when the project has no file. */
    FakeNameSpec spec = g_host->MakeNameSpec(FakeHost::U16(p->path.c_str()));
    *pathPH = NewMemHandleFromSpec(spec);
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

/* ---- render queue / rq item suites (read-only getters) ---- */

static A_Err FakeGetRenderQueueState(AEGP_RenderQueueState* stateP)
{
    if (g_host->rqStateErr != A_Err_NONE)
    {
        return (A_Err)g_host->rqStateErr;
    }
    *stateP = AEGP_RenderQueueState_STOPPED;
    return A_Err_NONE;
}

static A_Err FakeGetNumRQItems(A_long* numP)
{
    if (g_host->rqItemsErr != A_Err_NONE)
    {
        return (A_Err)g_host->rqItemsErr;
    }
    *numP = g_host->numRQItems;
    return A_Err_NONE;
}

static AEGP_RQItemRefH NewRQItemHandle(int index)
{
    struct _AEGP_RenderQueueItem* p = new struct _AEGP_RenderQueueItem;
    p->index = index;
    struct _AEGP_RenderQueueItem** hp = new struct _AEGP_RenderQueueItem*;
    *hp = p;
    return (AEGP_RQItemRefH)hp;
}

static A_Err FakeGetRQItemByIndex(A_long idxL, AEGP_RQItemRefH* rq_item_refPH)
{
    *rq_item_refPH = NULL;
    if (g_host->rqItemByIndexErr != A_Err_NONE)
    {
        return (A_Err)g_host->rqItemByIndexErr;
    }
    if (idxL < 0 || idxL >= g_host->numRQItems)
    {
        return A_Err_PARAMETER;
    }
    *rq_item_refPH = NewRQItemHandle((int)idxL);
    return A_Err_NONE;
}

static A_Err FakeGetRenderState(AEGP_RQItemRefH rq_itemH,
                                AEGP_RenderItemStatusType* statusP)
{
    (void)rq_itemH;
    *statusP = 0; /* QUEUED */
    return A_Err_NONE;
}

static A_Err FakeGetStartedTime(AEGP_RQItemRefH rq_itemH, A_Time* render_timePT)
{
    (void)rq_itemH;
    render_timePT->value = 0;
    render_timePT->scale = 1;
    return A_Err_NONE;
}

static A_Err FakeGetElapsedTime(AEGP_RQItemRefH rq_itemH, A_Time* render_timePT)
{
    (void)rq_itemH;
    render_timePT->value = 0;
    render_timePT->scale = 1;
    return A_Err_NONE;
}

static A_Err FakeGetLogType(AEGP_RQItemRefH rq_itemH, AEGP_LogType* logtypeP)
{
    (void)rq_itemH;
    *logtypeP = AEGP_LogType_ERRORS_ONLY;
    return A_Err_NONE;
}

static A_Err FakeGetNumOutputModulesForRQItem(AEGP_RQItemRefH rq_itemH,
                                              A_long* num_itemsPL)
{
    (void)rq_itemH;
    *num_itemsPL = 1;
    return A_Err_NONE;
}

static A_Err FakeGetComment(AEGP_RQItemRefH rq_itemH, AEGP_MemHandle* unicodeH)
{
    (void)rq_itemH;
    FakeNameSpec spec = g_host->MakeNameSpec(FakeHost::U16("fake rq comment"));
    *unicodeH = NewMemHandleFromSpec(spec);
    return A_Err_NONE;
}

static A_Err FakeGetCompFromRQItem(AEGP_RQItemRefH rq_itemH, AEGP_CompH* compPH)
{
    (void)rq_itemH;
    *compPH = NULL; /* fake host has no comp objects */
    return A_Err_NONE;
}

/* ---- Issue #63 extended read-only getters ---- */

static const FakeItemMeta& MetaFor(FakeProject* p, int ii)
{
    static const FakeItemMeta kDefault;
    if (!p || ii < 0 || ii >= (int)p->itemMeta.size())
    {
        return kDefault;
    }
    return p->itemMeta[ii];
}

static A_Err FakeGetProjectTimeDisplay(AEGP_ProjectH projH, AEGP_TimeDisplay3* tdP)
{
    FakeProject* p = ProjectForHandle(projH);
    if (!p) return A_Err_PARAMETER;
    if (g_host->projectTimeDisplayErr != A_Err_NONE)
    {
        return (A_Err)g_host->projectTimeDisplayErr;
    }
    *tdP = p->timeDisplay;
    return A_Err_NONE;
}

static A_Err FakeGetActiveItem(AEGP_ItemH* itemPH)
{
    *itemPH = NULL;
    if (g_host->activeItemErr != A_Err_NONE)
    {
        return (A_Err)g_host->activeItemErr;
    }
    int pi = g_host->activeItemProject;
    int ii = g_host->activeItemIndex;
    if (pi < 0 || pi >= (int)g_host->projects.size() || ii < 0)
    {
        return A_Err_NONE; /* no active item */
    }
    *itemPH = MakeItemHandle(pi, ii);
    return A_Err_NONE;
}

static A_Err FakeIsItemSelected(AEGP_ItemH itemH, A_Boolean* selectedPB)
{
    FakeProject* p = ProjectOfItem(itemH);
    if (g_host->itemMetaErr != A_Err_NONE) return (A_Err)g_host->itemMetaErr;
    *selectedPB = MetaFor(p, ItemIndexOf(itemH)).selected;
    return A_Err_NONE;
}

static A_Err FakeGetTypeName(AEGP_ItemType item_type, A_char* nameZ)
{
    if (g_host->itemMetaErr != A_Err_NONE) return (A_Err)g_host->itemMetaErr;
    snprintf(nameZ, AEGP_MAX_TYPE_NAME_SIZE + 1, "fake-type-%d", (int)item_type);
    nameZ[AEGP_MAX_TYPE_NAME_SIZE] = '\0';
    return A_Err_NONE;
}

static A_Err FakeGetItemID(AEGP_ItemH itemH, A_long* item_idPL)
{
    FakeProject* p = ProjectOfItem(itemH);
    int ii = ItemIndexOf(itemH);
    if (g_host->itemMetaErr != A_Err_NONE) return (A_Err)g_host->itemMetaErr;
    const FakeItemMeta& m = MetaFor(p, ii);
    *item_idPL = m.id >= 0 ? m.id : 1000 + ii;
    return A_Err_NONE;
}

static A_Err FakeGetItemFlags(AEGP_ItemH itemH, AEGP_ItemFlags* item_flagsP)
{
    FakeProject* p = ProjectOfItem(itemH);
    if (g_host->itemMetaErr != A_Err_NONE) return (A_Err)g_host->itemMetaErr;
    *item_flagsP = MetaFor(p, ItemIndexOf(itemH)).flags;
    return A_Err_NONE;
}

static A_Err FakeGetItemParentFolder(AEGP_ItemH itemH, AEGP_ItemH* parentPH)
{
    FakeProject* p = ProjectOfItem(itemH);
    if (g_host->itemMetaErr != A_Err_NONE) return (A_Err)g_host->itemMetaErr;
    if (!p) return A_Err_PARAMETER;
    int pi = (int)(p - &g_host->projects[0]);
    *parentPH = MakeItemHandle(pi, -1); /* top-level items live in root */
    return A_Err_NONE;
}

static A_Err FakeGetItemDuration(AEGP_ItemH itemH, A_Time* durationPT)
{
    FakeProject* p = ProjectOfItem(itemH);
    if (g_host->itemMetaErr != A_Err_NONE) return (A_Err)g_host->itemMetaErr;
    *durationPT = MetaFor(p, ItemIndexOf(itemH)).duration;
    return A_Err_NONE;
}

static A_Err FakeGetItemCurrentTime(AEGP_ItemH itemH, A_Time* curr_timePT)
{
    FakeProject* p = ProjectOfItem(itemH);
    if (g_host->itemMetaErr != A_Err_NONE) return (A_Err)g_host->itemMetaErr;
    *curr_timePT = MetaFor(p, ItemIndexOf(itemH)).currentTime;
    return A_Err_NONE;
}

static A_Err FakeGetItemDimensions(AEGP_ItemH itemH, A_long* widthPL, A_long* heightPL)
{
    FakeProject* p = ProjectOfItem(itemH);
    if (g_host->itemMetaErr != A_Err_NONE) return (A_Err)g_host->itemMetaErr;
    const FakeItemMeta& m = MetaFor(p, ItemIndexOf(itemH));
    *widthPL = m.width;
    *heightPL = m.height;
    return A_Err_NONE;
}

static A_Err FakeGetItemPixelAspectRatio(AEGP_ItemH itemH, A_Ratio* pix_aspect_ratioPRt)
{
    FakeProject* p = ProjectOfItem(itemH);
    if (g_host->itemMetaErr != A_Err_NONE) return (A_Err)g_host->itemMetaErr;
    *pix_aspect_ratioPRt = MetaFor(p, ItemIndexOf(itemH)).par;
    return A_Err_NONE;
}

static A_Err FakeGetItemComment(AEGP_ItemH itemH, AEGP_MemHandle* unicodePH)
{
    FakeProject* p = ProjectOfItem(itemH);
    *unicodePH = NULL;
    if (g_host->itemMetaErr != A_Err_NONE) return (A_Err)g_host->itemMetaErr;
    FakeNameSpec spec = MetaFor(p, ItemIndexOf(itemH)).comment;
    if (spec.units.empty())
    {
        /* No configured comment: return an empty-string handle. */
        static const A_UTF16Char emptyU16[1] = {0};
        spec.units.assign(emptyU16, emptyU16 + 1);
    }
    if (spec.failMode == 3)
    {
        return A_Err_GENERIC;
    }
    if (spec.failMode == 4)
    {
        return A_Err_NONE; /* success but NULL handle */
    }
    *unicodePH = NewMemHandleFromSpec(spec);
    return A_Err_NONE;
}

static A_Err FakeGetItemLabel(AEGP_ItemH itemH, AEGP_LabelID* labelP)
{
    FakeProject* p = ProjectOfItem(itemH);
    if (g_host->itemMetaErr != A_Err_NONE) return (A_Err)g_host->itemMetaErr;
    *labelP = MetaFor(p, ItemIndexOf(itemH)).label;
    return A_Err_NONE;
}

static AEGP_ItemViewP NewItemViewHandle(int index)
{
    struct _AEGP_ItemView* v = new struct _AEGP_ItemView;
    v->index = index;
    return (AEGP_ItemViewP)v;
}

static A_Err FakeGetItemMRUView(AEGP_ItemH itemH, AEGP_ItemViewP* mru_viewP)
{
    FakeProject* p = ProjectOfItem(itemH);
    int ii = ItemIndexOf(itemH);
    *mru_viewP = NULL;
    if (g_host->itemMetaErr != A_Err_NONE) return (A_Err)g_host->itemMetaErr;
    if (MetaFor(p, ii).hasView)
    {
        *mru_viewP = NewItemViewHandle(ii);
    }
    return A_Err_NONE;
}

/* ---- item view suite (read-only getters) ---- */

static A_Err FakeGetItemViewPlaybackTime(AEGP_ItemViewP viewP,
                                         A_Boolean* is_currently_previewingPB0,
                                         A_Time* curr_timePT)
{
    (void)viewP;
    if (g_host->itemViewQueryErr != A_Err_NONE)
    {
        return (A_Err)g_host->itemViewQueryErr;
    }
    *is_currently_previewingPB0 = TRUE;
    curr_timePT->value = 12;
    curr_timePT->scale = 30;
    return A_Err_NONE;
}

static A_Err FakeGetItemViewGuidesVisible(AEGP_ItemViewP viewP,
                                          A_Boolean* guides_visiblePB)
{
    (void)viewP;
    if (g_host->itemViewQueryErr != A_Err_NONE)
    {
        return (A_Err)g_host->itemViewQueryErr;
    }
    *guides_visiblePB = TRUE;
    return A_Err_NONE;
}

static A_Err FakeGetItemViewGuidesSnap(AEGP_ItemViewP viewP,
                                       A_Boolean* guides_snapPB)
{
    (void)viewP;
    if (g_host->itemViewQueryErr != A_Err_NONE)
    {
        return (A_Err)g_host->itemViewQueryErr;
    }
    *guides_snapPB = FALSE;
    return A_Err_NONE;
}

static A_Err FakeGetItemViewGuidesLocked(AEGP_ItemViewP viewP,
                                         A_Boolean* guides_lockedPB)
{
    (void)viewP;
    if (g_host->itemViewQueryErr != A_Err_NONE)
    {
        return (A_Err)g_host->itemViewQueryErr;
    }
    *guides_lockedPB = TRUE;
    return A_Err_NONE;
}

/* ---- comp suite (Issue #64 read-only getters) ---- */

static AEGP_CompH MakeCompHandle(int projIndex, int itemIndex)
{
    struct _AEGP_Comp* c = new struct _AEGP_Comp;
    c->projIndex = projIndex;
    c->itemIndex = itemIndex;
    struct _AEGP_Comp** hp = new struct _AEGP_Comp*;
    *hp = c;
    return (AEGP_CompH)hp;
}

static FakeProject* ProjectOfComp(AEGP_CompH compH)
{
    struct _AEGP_Comp** hp = (struct _AEGP_Comp**)compH;
    int pi = (*hp)->projIndex;
    if (pi < 0 || pi >= (int)g_host->projects.size())
    {
        return NULL;
    }
    return &g_host->projects[pi];
}

static int ItemIndexOfComp(AEGP_CompH compH)
{
    struct _AEGP_Comp** hp = (struct _AEGP_Comp**)compH;
    return (*hp)->itemIndex;
}

static A_Err FakeGetCompFromItem(AEGP_ItemH itemH, AEGP_CompH* compPH)
{
    *compPH = NULL;
    FakeProject* p = ProjectOfItem(itemH);
    int ii = ItemIndexOf(itemH);
    if (!p || ii < 0) return A_Err_PARAMETER;
    AEGP_ItemType t = AEGP_ItemType_COMP;
    if (ii < (int)p->itemTypes.size()) t = p->itemTypes[ii];
    if (t != AEGP_ItemType_COMP) return A_Err_GENERIC; /* not a comp */
    int pi = (int)(p - &g_host->projects[0]);
    *compPH = MakeCompHandle(pi, ii);
    return A_Err_NONE;
}

static A_Err FakeGetItemFromComp(AEGP_CompH compH, AEGP_ItemH* itemPH)
{
    *itemPH = NULL;
    FakeProject* p = ProjectOfComp(compH);
    if (!p) return A_Err_PARAMETER;
    int pi = (int)(p - &g_host->projects[0]);
    *itemPH = MakeItemHandle(pi, ItemIndexOfComp(compH));
    return A_Err_NONE;
}

static A_Err FakeGetMostRecentlyUsedComp(AEGP_CompH* compPH)
{
    *compPH = NULL;
    int pi = g_host->mruCompProject;
    int ii = g_host->mruCompIndex;
    if (pi >= 0 && pi < (int)g_host->projects.size() && ii >= 0)
    {
        *compPH = MakeCompHandle(pi, ii);
    }
    return A_Err_NONE;
}

#define FAKE_COMP_ERR() \
    if (g_host->compQueryErr != A_Err_NONE) return (A_Err)g_host->compQueryErr

static const FakeCompMeta& CompMetaFor(AEGP_CompH compH)
{
    static const FakeCompMeta kDefault;
    FakeProject* p = ProjectOfComp(compH);
    if (!p) return kDefault;
    return MetaFor(p, ItemIndexOfComp(compH)).compMeta;
}

static A_Err FakeGetCompFramerate(AEGP_CompH compH, A_FpLong* fpsPF)
{
    FAKE_COMP_ERR();
    if (!ProjectOfComp(compH)) return A_Err_PARAMETER;
    *fpsPF = CompMetaFor(compH).fps;
    return A_Err_NONE;
}

static A_Err FakeGetCompFrameDuration(AEGP_CompH compH, A_Time* timeP)
{
    FAKE_COMP_ERR();
    if (!ProjectOfComp(compH)) return A_Err_PARAMETER;
    *timeP = CompMetaFor(compH).frameDuration;
    return A_Err_NONE;
}

static A_Err FakeGetCompDownsampleFactor(AEGP_CompH compH,
                                         AEGP_DownsampleFactor* dsfP)
{
    FAKE_COMP_ERR();
    if (!ProjectOfComp(compH)) return A_Err_PARAMETER;
    *dsfP = CompMetaFor(compH).dsf;
    return A_Err_NONE;
}

static A_Err FakeGetCompBGColor(AEGP_CompH compH, AEGP_ColorVal* bgP)
{
    FAKE_COMP_ERR();
    if (!ProjectOfComp(compH)) return A_Err_PARAMETER;
    *bgP = CompMetaFor(compH).bgColor;
    return A_Err_NONE;
}

static A_Err FakeGetCompFlags(AEGP_CompH compH, AEGP_CompFlags* flagsP)
{
    FAKE_COMP_ERR();
    if (!ProjectOfComp(compH)) return A_Err_PARAMETER;
    *flagsP = CompMetaFor(compH).flags;
    return A_Err_NONE;
}

static A_Err FakeGetShowLayerNameOrSourceName(AEGP_CompH compH,
                                              A_Boolean* shownPB)
{
    FAKE_COMP_ERR();
    if (!ProjectOfComp(compH)) return A_Err_PARAMETER;
    *shownPB = CompMetaFor(compH).showLayerNames;
    return A_Err_NONE;
}

static A_Err FakeGetShowBlendModes(AEGP_CompH compH, A_Boolean* shownPB)
{
    FAKE_COMP_ERR();
    if (!ProjectOfComp(compH)) return A_Err_PARAMETER;
    *shownPB = CompMetaFor(compH).showBlendModes;
    return A_Err_NONE;
}

static A_Err FakeGetCompShutterAnglePhase(AEGP_CompH compH,
                                          A_Ratio* angleP, A_Ratio* phaseP)
{
    FAKE_COMP_ERR();
    if (!ProjectOfComp(compH)) return A_Err_PARAMETER;
    const FakeCompMeta& m = CompMetaFor(compH);
    *angleP = m.shutterAngle;
    *phaseP = m.shutterPhase;
    return A_Err_NONE;
}

static A_Err FakeGetCompShutterFrameRange(AEGP_CompH compH,
                                          const A_Time* comp_timeP,
                                          A_Time* startPT, A_Time* durationPT)
{
    (void)comp_timeP;
    FAKE_COMP_ERR();
    if (!ProjectOfComp(compH)) return A_Err_PARAMETER;
    const FakeCompMeta& m = CompMetaFor(compH);
    *startPT = m.shutterStart;
    *durationPT = m.shutterDuration;
    return A_Err_NONE;
}

static A_Err FakeGetCompSuggestedMotionBlurSamples(AEGP_CompH compH,
                                                   A_long* samplesPL)
{
    FAKE_COMP_ERR();
    if (!ProjectOfComp(compH)) return A_Err_PARAMETER;
    *samplesPL = CompMetaFor(compH).mbSamples;
    return A_Err_NONE;
}

static A_Err FakeGetCompMotionBlurAdaptiveSampleLimit(AEGP_CompH compH,
                                                      A_long* samplesPL)
{
    FAKE_COMP_ERR();
    if (!ProjectOfComp(compH)) return A_Err_PARAMETER;
    *samplesPL = CompMetaFor(compH).mbAdaptiveLimit;
    return A_Err_NONE;
}

static A_Err FakeGetCompWorkAreaStart(AEGP_CompH compH,
                                      A_Time* work_area_startPT)
{
    FAKE_COMP_ERR();
    if (!ProjectOfComp(compH)) return A_Err_PARAMETER;
    *work_area_startPT = CompMetaFor(compH).workAreaStart;
    return A_Err_NONE;
}

static A_Err FakeGetCompWorkAreaDuration(AEGP_CompH compH,
                                         A_Time* work_area_durationPT)
{
    FAKE_COMP_ERR();
    if (!ProjectOfComp(compH)) return A_Err_PARAMETER;
    *work_area_durationPT = CompMetaFor(compH).workAreaDuration;
    return A_Err_NONE;
}

static A_Err FakeGetCompDisplayStartTime(AEGP_CompH compH,
                                         A_Time* start_timePT)
{
    FAKE_COMP_ERR();
    if (!ProjectOfComp(compH)) return A_Err_PARAMETER;
    *start_timePT = CompMetaFor(compH).displayStart;
    return A_Err_NONE;
}

static A_Err FakeGetCompDisplayDropFrame(AEGP_CompH compH,
                                         A_Boolean* dropFramePB)
{
    FAKE_COMP_ERR();
    if (!ProjectOfComp(compH)) return A_Err_PARAMETER;
    *dropFramePB = CompMetaFor(compH).displayDropFrame;
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
    memset(&rqSuite, 0, sizeof(rqSuite));
    memset(&rqItemSuite, 0, sizeof(rqItemSuite));
    memset(&itemViewSuite, 0, sizeof(itemViewSuite));
    memset(&compSuite, 0, sizeof(compSuite));
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
    if (nullProjEntry != 3) projSuite.AEGP_GetProjectPath = FakeGetProjectPath;
    projSuite.AEGP_ProjectIsDirty = FakeProjectIsDirty;
    projSuite.AEGP_GetProjectBitDepth = FakeGetProjectBitDepth;
    projSuite.AEGP_GetProjectRootFolder = FakeGetProjectRootFolder;
    if (nullProjEntry != 4) projSuite.AEGP_GetProjectTimeDisplay = FakeGetProjectTimeDisplay;

    /* item */
    itemSuite.AEGP_GetFirstProjItem = FakeGetFirstProjItem;
    itemSuite.AEGP_GetNextProjItem = FakeGetNextProjItem;
    itemSuite.AEGP_GetItemType = FakeGetItemType;
    itemSuite.AEGP_GetItemName = FakeGetItemName;
    if (nullItemEntry != 3) itemSuite.AEGP_GetActiveItem = FakeGetActiveItem;
    itemSuite.AEGP_IsItemSelected = FakeIsItemSelected;
    if (nullItemEntry != 4) itemSuite.AEGP_GetTypeName = FakeGetTypeName;
    itemSuite.AEGP_GetItemID = FakeGetItemID;
    itemSuite.AEGP_GetItemFlags = FakeGetItemFlags;
    itemSuite.AEGP_GetItemParentFolder = FakeGetItemParentFolder;
    itemSuite.AEGP_GetItemDuration = FakeGetItemDuration;
    itemSuite.AEGP_GetItemCurrentTime = FakeGetItemCurrentTime;
    itemSuite.AEGP_GetItemDimensions = FakeGetItemDimensions;
    itemSuite.AEGP_GetItemPixelAspectRatio = FakeGetItemPixelAspectRatio;
    if (nullItemEntry != 2) itemSuite.AEGP_GetItemComment = FakeGetItemComment;
    itemSuite.AEGP_GetItemLabel = FakeGetItemLabel;
    if (nullItemEntry != 1) itemSuite.AEGP_GetItemMRUView = FakeGetItemMRUView;

    /* memory */
    memSuite.AEGP_NewMemHandle = FakeNewMemHandle;
    if (nullMemEntry != 1) memSuite.AEGP_FreeMemHandle = FakeFreeMemHandle;
    memSuite.AEGP_LockMemHandle = FakeLockMemHandle;
    memSuite.AEGP_UnlockMemHandle = FakeUnlockMemHandle;
    if (nullMemEntry != 2) memSuite.AEGP_GetMemHandleSize = FakeGetMemHandleSize;

    /* register */
    if (!registerIdleHookMissing) regSuite.AEGP_RegisterIdleHook = FakeRegisterIdleHook;

    /* render queue / rq item — read-only getters only */
    rqSuite.AEGP_GetRenderQueueState = FakeGetRenderQueueState;
    rqItemSuite.AEGP_GetNumRQItems = FakeGetNumRQItems;
    rqItemSuite.AEGP_GetRQItemByIndex = FakeGetRQItemByIndex;
    rqItemSuite.AEGP_GetRenderState = FakeGetRenderState;
    rqItemSuite.AEGP_GetStartedTime = FakeGetStartedTime;
    rqItemSuite.AEGP_GetElapsedTime = FakeGetElapsedTime;
    rqItemSuite.AEGP_GetLogType = FakeGetLogType;
    rqItemSuite.AEGP_GetNumOutputModulesForRQItem = FakeGetNumOutputModulesForRQItem;
    rqItemSuite.AEGP_GetComment = FakeGetComment;
    rqItemSuite.AEGP_GetCompFromRQItem = FakeGetCompFromRQItem;

    /* item view — read-only getters only */
    if (nullItemViewEntry != 1) itemViewSuite.AEGP_GetItemViewPlaybackTime = FakeGetItemViewPlaybackTime;
    if (nullItemViewEntry != 2) itemViewSuite.AEGP_GetItemViewGuidesVisible = FakeGetItemViewGuidesVisible;
    if (nullItemViewEntry != 3) itemViewSuite.AEGP_GetItemViewGuidesSnap = FakeGetItemViewGuidesSnap;
    if (nullItemViewEntry != 4) itemViewSuite.AEGP_GetItemViewGuidesLocked = FakeGetItemViewGuidesLocked;

    /* comp — read-only getters only; nullCompEntry 1..18 nulls one
       entry each (order matches probe.cpp CompEntriesOk). */
    if (nullCompEntry != 1) compSuite.AEGP_GetCompFromItem = FakeGetCompFromItem;
    if (nullCompEntry != 2) compSuite.AEGP_GetItemFromComp = FakeGetItemFromComp;
    if (nullCompEntry != 3) compSuite.AEGP_GetCompDownsampleFactor = FakeGetCompDownsampleFactor;
    if (nullCompEntry != 4) compSuite.AEGP_GetCompBGColor = FakeGetCompBGColor;
    if (nullCompEntry != 5) compSuite.AEGP_GetCompFlags = FakeGetCompFlags;
    if (nullCompEntry != 6) compSuite.AEGP_GetShowLayerNameOrSourceName = FakeGetShowLayerNameOrSourceName;
    if (nullCompEntry != 7) compSuite.AEGP_GetShowBlendModes = FakeGetShowBlendModes;
    if (nullCompEntry != 8) compSuite.AEGP_GetCompFramerate = FakeGetCompFramerate;
    if (nullCompEntry != 9) compSuite.AEGP_GetCompShutterAnglePhase = FakeGetCompShutterAnglePhase;
    if (nullCompEntry != 10) compSuite.AEGP_GetCompShutterFrameRange = FakeGetCompShutterFrameRange;
    if (nullCompEntry != 11) compSuite.AEGP_GetCompSuggestedMotionBlurSamples = FakeGetCompSuggestedMotionBlurSamples;
    if (nullCompEntry != 12) compSuite.AEGP_GetCompMotionBlurAdaptiveSampleLimit = FakeGetCompMotionBlurAdaptiveSampleLimit;
    if (nullCompEntry != 13) compSuite.AEGP_GetCompWorkAreaStart = FakeGetCompWorkAreaStart;
    if (nullCompEntry != 14) compSuite.AEGP_GetCompWorkAreaDuration = FakeGetCompWorkAreaDuration;
    if (nullCompEntry != 15) compSuite.AEGP_GetCompDisplayStartTime = FakeGetCompDisplayStartTime;
    if (nullCompEntry != 16) compSuite.AEGP_GetCompFrameDuration = FakeGetCompFrameDuration;
    if (nullCompEntry != 17) compSuite.AEGP_GetMostRecentlyUsedComp = FakeGetMostRecentlyUsedComp;
    if (nullCompEntry != 18) compSuite.AEGP_GetCompDisplayDropFrame = FakeGetCompDisplayDropFrame;

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
