/*******************************************************************/
/*                                                                 */
/* ae-a8n minimal read-only AEGP probe — PiPL resource             */
/*                                                                 */
/* Original resource declaration for this repository's probe       */
/* plug-in (Issue #17, CAP038). Declares Kind 'AEgx' (AEGP         */
/* general plug-in), display name and the Mach-O entry-point       */
/* symbol exported by src/probe.c.                                  */
/*******************************************************************/

#include "AEConfig.h"

#ifndef AE_OS_WIN
	#include "AE_General.r"
#endif

resource 'PiPL' (16000) {
	{
		/* array properties: 7 elements */
		/* [1] */
		Kind {
			AEGP
		},
		/* [2] */
		Name {
			"NativeProbe"
		},
		/* [3] */
		Category {
			"General Plugin"
		},
		/* [4] */
		Version {
			65536
		},
		/* [5] */
#ifdef AE_OS_WIN
		CodeWin64X86 {"AEProbePluginEntry"},
#elif defined(AE_OS_MAC)
		CodeMacIntel64 {"AEProbePluginEntry"},
		CodeMacARM64 {"AEProbePluginEntry"},
#endif
	}
};
