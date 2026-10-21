### Known exceptions are not blocked work

For released work whose remaining refusal is known, show `flow check-complete
<id>` and ask the operator; do not mark it blocked just because clean closure
is impossible. Repair a retargeted base with `flow base set <id> --base
<branch> --reason "<why>"`. Record subsequent fix PRs with `flow implemented
<id> --pr <url> --fix-of <round-ref>`.

Use `flow complete <id> --accept-gate <gate|review:condition>` once per current
refusal, with `--reason "<why>"`. This requests fresh operator confirmation,
not an automatic override. In shell call `flow_complete_exceptions`; elsewhere
use the controlling terminal or the existing host-question protocol
(`--answered-by <host:ref>`). Never invent the operator's words. Nested and
unattended contexts cannot confirm. AC integrity/confirmation, tasks, owner,
committed folder and required completion-token gates cannot be excepted.
Preserve failed outcomes and operator words; report **completed with
exceptions**, not clean. Status/list, journal and product index retain it.

