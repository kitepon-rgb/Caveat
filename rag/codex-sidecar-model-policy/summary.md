# Codex sidecar advisory model policy（2026-07-13）

出典: [[raw/openai-latest-model]], [[raw/codex-pricing]]
取得日: 2026-07-13
確度: confirmed（OpenAI公式一次情報）

## 結論候補

- GPT-5.6の用途区分は、Sol=品質最優先、Terra=日常の品質/費用バランス、Luna=軽量・高頻度である。
- Caveat hook advisoryは短い第二意見を自動・高頻度で返すため、常用候補の第一位は `gpt-5.6-luna` × low。
- `gpt-5.6-terra` × lowは、Lunaの有効解率または誤助言率が受入基準を満たさない場合の品質候補とする。
- `gpt-5.6-sol` は複雑作業向けであり、自動advisory常用には原則使わず、品質上限を調べる限定対照に留める。
- 現行 `gpt-5.4-mini` × lowは費用baselineとして残し、最新familyへの移行が実測で正当化されるまで削除しない。

## 公式コスト指標

Pro 5xのlocal message目安（5時間）はSol 75–450、Terra 100–550、Luna 250–1400、旧5.4 mini 300–1750。token creditの入力単価はSol 125、Terra 62.5、Luna 25、旧mini 18.75 credits/MTok（cached/outputはそれぞれSol 12.5/750、Terra 6.25/375、Luna 2.5/150、旧mini 1.875/113）。advisoryは入力contextに対して出力を短く制限するため入力単価を主な費用軸にするが、実際の消費はcontext、reasoning、tool use、cacheにも依存する。

## 採用前検証

Stopとtool-errorを別stratumにした複数のsynthetic/public scenarioを、旧mini/Luna/Terraのlowでactual codex-sidecar経路に通す。runごとのclean root、固定seedの実行順、masked Sonnet 5 judge、versioned usage receiptを使い、schema完遂、既知の誤助言、有効な次の一手、latency、input/cached/output/reasoning tokensを別々に記録する。Luna不合格時だけTerraを検討し、両者不合格ならminiを維持する。Solは自動採用対象外とし、別の明示H gateなしには呼ばない。

この時点の現行hookはStop/tool-error本文をproviderへ渡していなかった。上記のsynthetic/public
context付き比較は、明示入力を持つ将来契約のfeasibilityであり、当時のincident advisory精度を
直接証明しないものとしてprivacy/H gateと実hook characterizationを別途実施した。

## 2026-07-13 実測

local-only artifact `~/.caveat/local-eval/sidecar-advisory/evaluation-adoption-final.json`（digest `5c150302723997b784131cfb0aa792fb72ec4b5c8fb5a17c8f3ec017d278939e`）で、Stop/tool-error各4 independent runsのLunaは8/8完遂、known-bad 0、valid-action 8/8、0.1225 credits/run、平均7.5秒、p95 9.1秒だった。miniは4/8完遂、valid-actionは全分母4/8、0.1467 credits/run、平均10.1秒、p95 17.3秒。Terraはfeasibility 4/4、0.2818 credits/runで、Luna合格後の追加評価は行っていない。Solも未実行。

したがって`gpt-5.6-luna` lowを採用し、2026-07-13にproduction advisory presetへ反映した。
その後、生signal本文は送らず、閉じたtool/failure種別とStop countだけを`caveat-hook-signal`
blockで渡す契約を実装した。local-only paired artifact
`~/.caveat/local-eval/sidecar-advisory/hook-signal-ab/evaluation.json`（digest
`f800e340e938f5da21f6eac10428e9f6dab529a7d47b091e4144e758857c6c36`）では、control/signal各4、
両条件4/4完遂、valid solution 0/4→4/4、known-bad 1/4→0/4、cost 0.129121→0.134215
credits/run（+0.005094、約3.9%）。候補選択feasibilityに限る小標本であり、実incidentへ一般化しない。
masked judgeのassistant primaryは`claude-sonnet-5`、terminal usageには補助
`claude-haiku-4-5-20251001`も記録された。

採用後のactual hook smokeは、Stopと`PostToolUseFailure -> detached worker`を隔離したsynthetic
Caveat homeで別々に実行し、pending reminder、matched outbound `turn/start`のexact signal block、
raw sentinel/session ID非到達、`thread/start` effective policy、同一thread/turn completedまで確認した。
