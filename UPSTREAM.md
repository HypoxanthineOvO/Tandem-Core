# Upstream

Tandem Core is an independent MIT-licensed fork of https://github.com/deepseek-ai/deepseek-harness.

The imported baseline is `6d64d332f06fe1454059270f20c8d4f67db71876`. The integration source was `2501530cedcdc727e7b7403e79611d9d2b3cdc33` plus its pending image-handling and subagent-control fixes.

On 2026-11-15, GitHub's public commits API (`repos/deepseek-ai/deepseek-harness/commits/6d64d332`) returned HTTP 422, `No commit found for SHA`. This candidate therefore uses a new single-commit snapshot rather than publishing the integration repository's private history. The baseline identifier is attribution, not a claim that this object is reachable in current public upstream history.

All imported tracked and nonignored untracked source files were byte-compared before sanitization: 16451 files; SHA-256 of the sorted compact JSON `[path, sha256]` manifest: `a2185c8f1092837039e0e7e9b9fa8dcc3dca7973958ac98c55e878b36bbb0100`. Pending tracked binary diff SHA-256: `21be7cdacb7e6ceccf7a46fbb80476793f99ad58b6574f7515720f18f758ea5b`.

DeepSeek AI's LICENSE, THIRD_PARTY_NOTICES.md and BRAND_GUIDELINES.md are retained. Tandem Core is not affiliated with or endorsed by DeepSeek AI. The CLI and internal package identifiers remain compatible with the upstream plugin ecosystem.
