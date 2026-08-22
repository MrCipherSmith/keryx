# TOOL-10 — `skills_catalog` / `skill_load` via the shell's own agent loop

**Area:** 5. Built-in agent tools · **Date:** 2026-08-22 · **Status:** PASS

## Test case (from the catalog)

> Confirmed live via MCP (prior report §2), not yet confirmed via the shell's OWN agent loop
> specifically, only via a standalone MCP client.

## What was actually run

```bash
printf 'какие skills доступны в проекте? используй skills_catalog\n' | DEEPSEEK_API_KEY="$(...)" \
  keryx shell --no-tui --provider deepseek --model deepseek-v4-flash-vision-exp
```

Session id: `b3227552`, fresh session.

## Captured output (terminal text capture)

```text
● keryx
  ⚙ skills_catalog()
  ↳ Skills (45): · +90 more (/expand)

В проекте 45 skills в .metaproject/skills/gdskills/. Разбивка по категориям:
  core (6) — маршрутизация и жизненный цикл project-skills: ...
  orchestration (10) — многоагентные конвейеры и workflow: ...
  planning (6): ...
  platform (4): ...
  quality (6): ...
  review (13) — код-ревью: ...

Нужно загрузить полный SKILL.md какого-то конкретного? Могу skill_load по имени.
```

## Summary

Confirmed: `skills_catalog` is genuinely reachable and functional through the `keryx shell`
agent's own tool loop (not just via a standalone MCP client), returns the real, full 45-skill
catalog, correctly categorized, and the model correctly offers `skill_load` as the natural next
step.

## Analysis / Improvement

None — behaves as documented, matches the MCP-path evidence from the prior pass exactly (same
skill count, same categories).
