# Context

- Failing run 31535400400 on merged main: 3193 pass, one timeout in `config-dir.readers.test.ts`.
- `runReader` ждёт stdout/stderr до `proc.exited`; аварийный child может не закрыть pipe, поэтому outer test достигает 60 s.
- The probe must remain a real subprocess because in-process code cannot observe Bun SIGABRT.
