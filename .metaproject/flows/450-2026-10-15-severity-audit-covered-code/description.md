# Severity audit holds a test gap in covered code; raises only an unpinned behaviour change

Status: draft
Source: user description (origin: human-request)

## Problem

`keryx review severity-audit` raises a finding from minor to major whenever a mutant it cites survived (flow 428 AC6; flow 446 AC4 exempted only presentation mutants). A survivor proves one thing: no assertion pins that mutated behaviour. It does not show wrong behaviour in the product. The canonical rubric (`review-orchestrator/SKILL.md` → Severity (canonical)) puts a major at a named trigger and a wrong observable outcome, and puts "the code is right, the cost lands on the next editor" at minor.

Measured on vantage-frontend PR 7643 (package `--r03`, 14 Oct 2026): the testing reviewer filed three test-quality findings as minor; the audit raised all three to major because 9 of 24 mutants survived. In the same run 15 mutants were killed, so the suite exercises the changed code. The project's own ladder (`.claude/rules/reviewing.md`) calls this a minor ("test gaps whose underlying operations are covered") and the human reference review rated all three minor. The report itself says "this is not a claim of three existing production bugs". The defect does not depend on the project having a ladder: the canonical rubric alone gives minor.

What the original intent (flow 428 AC6) wanted is still right in one case: a behaviour change that no test pins at all is an unanswered testing gate, and that is a major.

## Expected Outcome

A surviving behaviour mutant raises a finding to major only when the mutated file has no killed mutant in any recorded pass, that is, nothing in the suite exercises that code. When the same file has at least one killed mutant, the suite covers the code, the survivor is a gap in covered code, and the severity is held with a note that names the survivor and the kill count. Presentation holds, the `unproven` cap and the blocker rule are unchanged. The held note shows in the same places as the presentation hold.

## Outcome criteria

- Запрос (дословно): «согласен, тогда заводи флоу и реализуй нормальную шкалу» (source: helyx 206321, 2026-10-15T05:04Z)
- Эффект (формализация агента): выживший мутант больше не делает из test-gap находки major, если тесты покрывают этот код; major остаётся для изменения поведения, которое не закрепляет ни один тест. Шкала одна для всех проектов и совпадает с канонической.
- Как наблюдать (предложение агента): повторное `keryx review severity-audit` на пакете с данными PR 7643 (15 убито, 9 выжило) оставляет F-001..F-003 на minor с заметкой held; в отчёте и в `keryx review status` строка held названа.

## Out of Scope

- A project-level ladder file or config key (the canonical rubric is the default; a project layer can come later).
- The MAE child count cap (32), a separate defect.
- Changing which mutants a testing reviewer proposes.
