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

struct FakeProject
{
    std::string name;    /* ASCII/UTF-8 project name */
    bool dirty = false;
    AEGP_ProjBitDepth bitDepth = AEGP_ProjBitDepth_8;
    FakeNameSpec rootName;
    std::vector<FakeNameSpec> itemNames;
    std::vector<AEGP_ItemType> itemTypes;
};

struct FakeHost
{
    /* ---- configuration ---- */
    int numProjects = 0;
    int numProjectsErr = A_Err_NONE;
    std::vector<FakeProject> projects;
    int itemNameErr = A_Err_NONE; /* when != NONE, GetItemName fails */

    bool failAcquireUtility = false;
    bool failAcquireProj = false;
    bool failAcquireItem = false;
    bool failAcquireMemory = false;
    bool failAcquireRegister = false;
    bool registerWithAegpFails = false;
    bool registerIdleHookFails = false;
    bool registerIdleHookMissing = false; /* entry left NULL in suite */
    bool nullWriteToDebugLog = false;
    int nullProjEntry = 0; /* 1 = AEGP_GetNumProjects NULL, 2 = GetProjectByIndex NULL */
    int nullMemEntry = 0;  /* 1 = FreeMemHandle NULL, 2 = GetMemHandleSize NULL */

    /* ---- observed state ---- */
    std::vector<std::string> log; /* raw infoZ strings passed to WriteToDebugLog */
    int acquireCount[8] = {0};
    int releaseCount[8] = {0};
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
