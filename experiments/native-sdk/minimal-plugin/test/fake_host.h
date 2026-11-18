/*******************************************************************/
/*                                                                 */
/* ae-a8n NativeProbe — fake AEGP host for unit tests              */
/*                                                                 */
/* Original test code. Implements just enough of SPBasicSuite and */
/* the AEGP suite tables (as plain C structs of function pointers) */
/* to exercise probe.cpp's init / idle-hook / memory paths without */
/* After Effects. NOT a reimplementation of AE semantics — only    */
/* the contract surface the probe uses.                            */
/*******************************************************************/

#ifndef AE_PROBE_FAKE_HOST_H
#define AE_PROBE_FAKE_HOST_H

#include <AE_GeneralPlug.h>

#include <initializer_list>
#include <map>
#include <memory>
#include <string>
#include <vector>

/* Complete the SDK's opaque handle types so the fake can allocate
   them. The SDK only ever uses these through pointers. */
struct _Up_OpaqueMem
{
    struct FakeMemRec* rec;
};
struct _AEGP_Item
{
    int projIndex; /* -1 = project root folder */
    int itemIndex; /* -1 for root folder */
};
struct _AEGP_Project
{
    int index;
};
struct _AEGP_RenderQueueItem
{
    int index;
};
struct _AEGP_ItemView
{
    int index;
};
struct _AEGP_Comp
{
    int projIndex;
    int itemIndex;
};
struct _AEGP_Layer
{
    int projIndex;
    int itemIndex;  /* the comp item this layer belongs to */
    int layerIndex;
};

struct FakeMemRec
{
    std::vector<A_UTF16Char> units; /* payload code units */
    AEGP_MemSize sizeBytes = 0;    /* reported size; 0 = units.size()*2 */
    bool sizeOverride = false;
    int lockCount = 0;
    bool freed = false;
    int failMode = 0; /* 0 ok, 1 = size query fails, 2 = lock fails */
};

/* One queued name result for AEGP_GetItemName. */
struct FakeNameSpec
{
    std::vector<A_UTF16Char> units;
    AEGP_MemSize sizeBytes = 0;
    bool sizeOverride = false;
    int failMode = 0; /* 0 ok, 1 = size fails, 2 = lock fails, 3 = err return, 4 = NULL handle + NONE */
};

/* Per-layer read-only metadata returned by the Issue #64
   AEGP_LayerSuite9 getters. Indexed by layer position in the comp. */
struct FakeLayerMeta
{
    FakeNameSpec name;
    FakeNameSpec sourceName;
    AEGP_LayerFlags flags = 0;
    AEGP_LayerQuality quality = AEGP_LayerQual_BEST;
    AEGP_ObjectType objectType = AEGP_ObjectType_AV;
    A_Boolean is3D = FALSE;
    A_Boolean is2D = TRUE;
    A_Time currentTime = {0, 30};
    A_Time inPoint = {0, 30};
    A_Time duration = {90, 30};
    AEGP_LayerIDVal id = 0;
    AEGP_LabelID label = AEGP_Label_NO_LABEL;
    AEGP_LayerSamplingQuality samplingQuality = AEGP_LayerSamplingQual_BILINEAR;
    A_long sourceItemID = -1;
    A_Boolean videoOn = TRUE;
    A_Boolean audioOn = FALSE;
    A_Boolean hasTrackMatte = FALSE;
    A_Boolean isTrackMatte = FALSE;
    int trackMatteLayerIndex = -1; /* -1 → GetTrackMatteLayer returns NULL */
};

/* Per-comp read-only metadata returned by the Issue #64
   AEGP_CompSuite13 getters. Parallel to itemMeta by item index;
   defaults are sane comp values. */
struct FakeCompMeta
{
    A_FpLong fps = 30.0;
    A_Time frameDuration = {1, 30};
    AEGP_DownsampleFactor dsf = {1, 1};
    AEGP_ColorVal bgColor = {1.0, 0.0, 0.0, 0.0};
    AEGP_CompFlags flags = 0;
    A_Boolean showLayerNames = TRUE;
    A_Boolean showBlendModes = FALSE;
    A_Ratio shutterAngle = {180, 1};
    A_Ratio shutterPhase = {0, 1};
    A_Time shutterStart = {0, 30};
    A_Time shutterDuration = {1, 30};
    A_long mbSamples = 16;
    A_long mbAdaptiveLimit = 128;
    A_Time workAreaStart = {0, 30};
    A_Time workAreaDuration = {90, 30};
    A_Time displayStart = {0, 30};
    A_Boolean displayDropFrame = FALSE;
    std::vector<FakeLayerMeta> layers;
};

/* Per-item extended metadata returned by the Issue #63 read-only
   getters. Parallel to itemNames/itemTypes by index; missing entries
   fall back to FakeItemMeta defaults. */
struct FakeItemMeta
{
    A_long id = -1; /* -1 → fake derives 1000 + item index */
    AEGP_ItemFlags flags = 0;
    A_Boolean selected = FALSE;
    AEGP_LabelID label = AEGP_Label_NO_LABEL;
    A_Time duration = {90, 30};
    A_Time currentTime = {0, 30};
    A_long width = 640;
    A_long height = 360;
    A_Ratio par = {1, 1};
    bool hasView = false;      /* AEGP_GetItemMRUView returns a view */
    FakeNameSpec comment;      /* empty units → empty-string handle */
    FakeCompMeta compMeta;     /* meaningful only for COMP items */
};

struct FakeProject
{
    std::string name;    /* ASCII/UTF-8 project name */
    std::string path;    /* ASCII/UTF-8 project path; empty = untitled */
    bool dirty = false;
    AEGP_ProjBitDepth bitDepth = AEGP_ProjBitDepth_8;
    AEGP_TimeDisplay3 timeDisplay = {};
    FakeNameSpec rootName;
    std::vector<FakeNameSpec> itemNames;
    std::vector<AEGP_ItemType> itemTypes;
    std::vector<FakeItemMeta> itemMeta;
};

struct FakeHost
{
    /* ---- configuration ---- */
    int numProjects = 0;
    int numProjectsErr = A_Err_NONE;
    std::vector<FakeProject> projects;
    int itemNameErr = A_Err_NONE;     /* when != NONE, GetItemName fails */
    int projectNameErr = A_Err_NONE;  /* when != NONE, GetProjectName fails */
    int projectPathErr = A_Err_NONE;  /* when != NONE, GetProjectPath fails */
    int getProjectByIndexErr = A_Err_NONE; /* when != NONE, GetProjectByIndex fails */

    int numRQItems = 0;          /* items the fake render queue reports */
    int rqStateErr = A_Err_NONE; /* when != NONE, GetRenderQueueState fails */
    int rqItemsErr = A_Err_NONE; /* when != NONE, GetNumRQItems fails */
    int rqItemByIndexErr = A_Err_NONE; /* when != NONE, GetRQItemByIndex fails */

    /* Issue #63 extended read-only getters. */
    int projectTimeDisplayErr = A_Err_NONE; /* GetProjectTimeDisplay fails */
    int activeItemErr = A_Err_NONE;         /* GetActiveItem fails */
    int itemMetaErr = A_Err_NONE; /* all extended ItemSuite9 detail getters fail */
    int itemViewQueryErr = A_Err_NONE; /* ItemViewSuite2 getters fail */
    int compQueryErr = A_Err_NONE;     /* CompSuite13 getters fail */
    int layerQueryErr = A_Err_NONE;    /* LayerSuite9 getters fail */
    int activeItemProject = -1; /* -1 → GetActiveItem returns NULL item */
    int activeItemIndex = -1;

    bool failAcquireUtility = false;
    bool failAcquireProj = false;
    bool failAcquireItem = false;
    bool failAcquireMemory = false;
    bool failAcquireRegister = false;
    bool failAcquireRQ = false;
    bool failAcquireRQItem = false;
    bool failAcquireItemView = false;
    bool failAcquireComp = false;
    bool failAcquireLayer = false;
    bool registerWithAegpFails = false;
    bool registerIdleHookFails = false;
    bool registerIdleHookMissing = false; /* entry left NULL in suite */
    bool nullWriteToDebugLog = false;
    int nullProjEntry = 0; /* 1 = GetNumProjects NULL, 2 = GetProjectByIndex NULL, 3 = GetProjectPath NULL, 4 = GetProjectTimeDisplay NULL */
    int nullMemEntry = 0;  /* 1 = FreeMemHandle NULL, 2 = GetMemHandleSize NULL */
    int nullItemEntry = 0; /* 1 = GetItemMRUView NULL, 2 = GetItemComment NULL, 3 = GetActiveItem NULL, 4 = GetTypeName NULL */
    int nullItemViewEntry = 0; /* 1..4 = the four ItemViewSuite2 getters NULL */
    int nullCompEntry = 0; /* 1..18 = the CompSuite13 entries the probe calls NULL */
    int nullLayerEntry = 0; /* 1..22 = the LayerSuite9 entries the probe calls NULL */
    int mruCompProject = -1; /* -1 → GetMostRecentlyUsedComp returns NULL */
    int mruCompIndex = -1;

    /* ---- observed state ---- */
    std::vector<std::string> log; /* raw infoZ strings passed to WriteToDebugLog */
    int acquireCount[10] = {0};
    int releaseCount[10] = {0};
    int idleHookRegistrations = 0;
    AEGP_IdleHook idleHook = NULL;
    AEGP_PluginID idleHookPluginId = 0;
    int registerWithAegpCalls = 0;
    AEGP_PluginID lastGetItemNamePluginId = -1; /* plugin id seen by GetItemName */
    std::string registeredName;

    /* mem-handle accounting */
    std::vector<std::unique_ptr<FakeMemRec>> memRecs;
    int memHandlesFreed = 0;

    /* suite table instances (zeroed, then populated) */
    AEGP_UtilitySuite6 utilSuite;
    AEGP_ProjSuite6 projSuite;
    AEGP_ItemSuite9 itemSuite;
    AEGP_MemorySuite1 memSuite;
    AEGP_RegisterSuite5 regSuite;
    AEGP_RenderQueueSuite1 rqSuite;
    AEGP_RQItemSuite4 rqItemSuite;
    AEGP_ItemViewSuite2 itemViewSuite;
    AEGP_CompSuite13 compSuite;
    AEGP_LayerSuite9 layerSuite;
    SPBasicSuite basicSuite;

    FakeHost();
    /* (Re)populate the suite tables from the current flags. Called by
       the constructor; call again after changing suite-related flags
       (failAcquire*, null*Entry, registerIdleHookMissing,
       nullWriteToDebugLog). */
    void PopulateSuites();

    /* helpers for tests */
    static std::vector<A_UTF16Char> U16(const char* utf8Z);
    static std::vector<A_UTF16Char> U16Codepoints(std::initializer_list<unsigned int> cps);
    FakeNameSpec MakeNameSpec(const std::vector<A_UTF16Char>& units,
                              AEGP_MemSize sizeBytes = 0,
                              bool sizeOverride = false,
                              int failMode = 0);
    FakeProject& AddProject(const char* name);
    void SetItemNames(int projIndex, std::initializer_list<FakeNameSpec> names);
    int CountLogContaining(const char* needleZ) const;
    bool LogContains(const char* needleZ) const;
    int StartCount() const;
};

/* Build a ready-to-use FakeHost: suites populated, SPBasicSuite wired. */
std::unique_ptr<FakeHost> MakeFakeHost();

#endif /* AE_PROBE_FAKE_HOST_H */
