# SDK coverage matrix (generated)

Release: 26.5 (macOS)
Symbols: 4677 across 70 headers; unknown/unsupported: 552

| Class | Symbols | State |
| --- | ---: | --- |
| build-test-lifecycle | 74 | build-probe-only — Sample projects compile (Sweetie/Checkout, macOS arm64). Load/execution UNVERIFIED. |
| external-command | 3766 | inventory-only — Selector strings attributed from headers. No adapter, no real-host dispatch evidence. |
| host-callback | 154 | inventory-only — Callback slots/types enumerated. Lifetime/thread-safety rules documented, unexercised. |
| in-host-plugin-command | 131 | inventory-only — In-plugin command surface enumerated. Not reachable from devtools yet. |
| unsupported-or-unknown | 552 | unsupported-or-unknown — Extractor could not attribute; see unknownByReason. Requires per-family review (CAP047). |

## Per-header symbol counts

| Header | Symbols |
| --- | ---: |
| A.h | 40 |
| AEConfig.h | 0 |
| AEFX_SuiteHandlerTemplate.h | 0 |
| AE_AdvEffectSuites.h | 54 |
| AE_BlendModes.h | 2 |
| AE_CacheOnLoadSuite.h | 2 |
| AE_ChannelSuites.h | 6 |
| AE_ComputeCacheSuite.h | 19 |
| AE_CreatorInfo.h | 1 |
| AE_Effect.h | 234 |
| AE_EffectCB.h | 84 |
| AE_EffectCBSuites.h | 148 |
| AE_EffectGPUSuites.h | 17 |
| AE_EffectPixelFormat.h | 2 |
| AE_EffectSuites.h | 73 |
| AE_EffectSuitesHelper.h | 8 |
| AE_EffectSuitesOld.h | 38 |
| AE_EffectUI.h | 46 |
| AE_EffectVers.h | 4 |
| AE_GeneralPlug.h | 988 |
| AE_GeneralPlugOld.h | 2280 |
| AE_GeneralPlugPanels.h | 18 |
| AE_GeneralPlugPost.h | 0 |
| AE_GeneralPlugPre.h | 0 |
| AE_HashSuite.h | 3 |
| AE_Hook.h | 12 |
| AE_IO.h | 89 |
| AE_IO_ColorMetadata.h | 3 |
| AE_IO_FileExt.h | 1 |
| AE_Macros.h | 0 |
| AE_PluginData.h | 6 |
| FIEL_Public.h | 3 |
| Mach-O_prefix.h | 0 |
| PF_Masks.h | 2 |
| PR_Public.h | 43 |
| PT_Public.h | 12 |
| PrSDKAESupport.h | 100 |
| PrSDKPixelFormat.h | 0 |
| SP/SPAccess.h | 17 |
| SP/SPAdapts.h | 12 |
| SP/SPBasic.h | 8 |
| SP/SPBckDbg.h | 6 |
| SP/SPBlocks.h | 4 |
| SP/SPCOM.h | 0 |
| SP/SPCaches.h | 4 |
| SP/SPConfig.h | 0 |
| SP/SPErrorCodes.h | 0 |
| SP/SPErrors.h | 0 |
| SP/SPFiles.h | 40 |
| SP/SPHost.h | 0 |
| SP/SPInterf.h | 6 |
| SP/SPMData.h | 1 |
| SP/SPObject.h | 0 |
| SP/SPPiPL.h | 13 |
| SP/SPPlugs.h | 61 |
| SP/SPProps.h | 17 |
| SP/SPRuntme.h | 43 |
| SP/SPSTSPrp.h | 0 |
| SP/SPStrngs.h | 4 |
| SP/SPSuites.h | 16 |
| SP/SPTypes.h | 19 |
| SP/artemis/config/platform.hpp | 0 |
| SP/photoshop/config/platform.hpp | 0 |
| SimpleSuiteHelper.h | 0 |
| SuiteHelper.h | 0 |
| adobesdk/DrawbotSuite.h | 51 |
| adobesdk/config/AdobesdkTypes.h | 6 |
| adobesdk/config/PostConfig.h | 0 |
| adobesdk/config/PreConfig.h | 0 |
| adobesdk/drawbotsuite/DrawbotSuiteTypes.h | 11 |

## Caveats

- The count is the number of symbol rows this extractor can attribute structurally. It is not a claim that the SDK's public surface is fully enumerated.
- unsupported-or-unknown is dominated by plain data types, which have no call direction to classify. It is not a count of missing callables.
- Headers marked deprecated (the *Old.h variants) do not reduce the denominator; their symbols are counted in their functional class and flagged separately.
- Classification is rule-based and provisional. Rule tallies are reported so a reviewer can see exactly which rule produced each class.
- No behavioural claim about any AE build is implied. Nothing here was executed against After Effects.

No row in this matrix is verifiedOnRealHost. Build-probe-only means the SDK sample compiles; it does not mean AE loads the plugin.
