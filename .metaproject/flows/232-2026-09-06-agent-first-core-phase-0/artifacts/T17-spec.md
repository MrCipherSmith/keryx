# Required ESLint prerequisite
Version: 0.1.0

Health policy already marks ESLint required, but package/config absent. Install dev-only ESLint plus TypeScript integration, configure source/scripts scope excluding generated assets, node_modules and nested checkouts. Start with official recommended correctness configurations. Report actual findings; do not silence substantive rules merely for a green result. Add lint script into standard check. Preserve all existing dependency ranges and avoid unrelated upgrades; root alone owns package/lock/config. Independent verifier validates required source detection, actual lint execution and meaningful failing fixture through stdin/temporary source.

Sources: https://typescript-eslint.io/getting-started/ and https://eslint.org/docs/latest/use/configure/configuration-files (read 2026-09-06). This fixes the existing required quality prerequisite, separate from phase8 product dependency modernization.
