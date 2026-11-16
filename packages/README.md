# packages/

npm パッケージとして配布・消費されるコードを置く領域。

| package | 内容 |
| --- | --- |
| `@ae-devtools/capability-catalog` | capability ID grammar / manifest / coverage・drift gate / handshake（Issue #11） |
| `@ae-devtools/native-adapter` | native SDK adapter negotiation contract + coverage-derived kits（Issue #19） |
| `@ido-bata/ae-devtools-cli` | 開発者向け CLI + JSX toolchain（`ae-devtools`, `jsx-toolchain` bins。Issue #92） |

`experiments/` は研究・probe 用の領域であり、配布物は `packages/` に置く。
