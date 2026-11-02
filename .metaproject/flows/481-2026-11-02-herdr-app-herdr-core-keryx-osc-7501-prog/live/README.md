# Live verification under an isolated herdr-core session (T11: AC13, AC14)

Run 2026-11-02 12:55–13:03 (+04:00), hc 0.1.16, dev keryx from this worktree at f3a30d440
(`bun run src/cli.ts`), provider deepseek/deepseek-chat, `--ask`.

## Isolation

The operator's own session runs inside an hc terminal (`HC_TERMINAL_ID=t13` in the shell that
drove this run), so every hc call went through `hci.sh`, which removes `HC_SOCKET`,
`HC_TERMINAL_SOCKET`, `HC_SCOPE`, `HC_TERMINAL_ID`, sets `HC_SESSION=keryx481` and a scratch
`XDG_CONFIG_HOME`. `hc server status` showed a fresh core (uptime 9 s, 0 terminals); its state dir
`~/.local/state/herdr-core/keryx481` did not exist before and was removed after `hc server stop`.
`XDG_STATE_HOME` was left alone: a scratch path would push the core socket past macOS's 104-byte
limit for unix socket paths. `keryx-wrapper.sh` is the `keryx` the isolated core saw on PATH: it
restores `XDG_CONFIG_HOME` (provider credentials), runs from a scratch project and fixes
provider/model/`--ask` for `shell` so no picker can hold the start.

To rerun: make a scratch directory with `xdg-config/`, `project/` and `bin/keryx` (a link to
`keryx-wrapper.sh`), export `K481_SCRATCH` as its path, and drive the session with `hci.sh`.
`hc` and `bun` come from PATH (`K481_HC`, `K481_BUN` override); the worktree defaults to the
checkout holding the scripts (`K481_WORKTREE` overrides). The run above used the scripts with
those values fixed to the author's paths.

The template and the Herdr app entry were installed into the scratch config with the dev
`keryx herdr install` (`programs created`, `icon created`, `template created`); `hc templates`
then listed `keryx` (`command: keryx shell`).

## Results (`events.jsonl` is the core's own event stream, recorded from k1's first block on)

- AC13
  - start → idle: k4 (`keryx-wrapper.sh shell`): `{"app":"keryx","state":"idle"}`, turn 0,
    `reported: true` (seq 19).
  - turn sent with `hc send --wait`: k1 `working` → `done`, the send returned
    `{"started":true,"status":"done"}` (seq 11–13).
  - shell approval → blocked: k1 `{"app":"keryx","kind":"permission","msg":"hc get \"$HC_TERMINAL_ID\" --json 2>&1 | head -50","state":"blocked"}`;
    Deny → `working` → `done` (seq 7–10).
  - exit → no status: k4 `/exit` → `status: null` (seq 21) 20 ms before `finished`, exit 0.
    k1, k2 and k3 also exited 0.
  - screen: no `7501`/`state=` text in any saved `hc read` screen; the approval dock and the
    composer render intact (`k1-screen-after-hc-message.txt`).
- AC14
  - template: `hc run --bg --name k2 keryx "Reply with the single word READY…"` returned
    `first_message: {"sent":true,"started":true}`; the core waited for `idle` (seq 31), typed the
    template body and task, and the turn ran `working` → `done`, reply `READY`
    (`k2-template-screen.txt`).
  - positional prompt: `hc run --bg --name k3 <keryx> shell "Reply with the single word READY…"`
    → `idle` → `working` → `done`, the prompt is the first `❯` line, reply `READY`
    (`k3-positional-screen.txt`).
- AC8, seen live: `hc send k1 '<hc from="t7 review">All 12 tests pass. …</hc>'` echoed as
  `◂ t7 review ❯ All 12 tests pass. …`; the model answered that the message came from agent t7
  through herdr-core, not from the user.

## Findings for the docs (T10)

1. A template named `keryx` shadows the program: with the template installed,
   `hc run keryx shell` ran the TEMPLATE with the task `shell` (k1). To run the program itself
   with a prompt, use `hc run --bg --name <n> keryx "<task>"` (the template, which types the task)
   or the program by path.
2. The template's first message is its body plus the task; with no real task (k1, task `shell`)
   the agent said it had no task and asked for one instead of guessing — the intended behaviour.
