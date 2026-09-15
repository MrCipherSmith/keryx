// The skill-routing tokenizer (flow 257, T18 boundary fix) — shared primitive,
// not owned by either side that scores with it.
//
// WHY THIS FILE EXISTS, AND WHY HERE
//
// `normalizeRouteText`/`routeTokens` were written once, in
// `src/commands/skills.ts` (an ADAPTER module — see `src/lib/import-zones.ts`),
// for `scoreBundledSkillRoute`/`scoreProjectSkillRoute`. `src/gdskills/
// bundled-eval.ts` (a CORE owner) then imported both, so its
// `description:collision` check (flow 257 T11, AC6) could judge two skill
// descriptions on the IDENTICAL tokenisation the router itself scores them
// with — the same "one implementation, not a second guess" discipline
// `expandQueryTokens`'s own comment already states for the synonym table.
// That import — core importing an adapter module — is `owner-imports-client`,
// the ONE import-policy rule the spec states with NO exception
// (`import-policy.ts`'s `findingFor`), and `import-policy.live.test.ts` caught
// it: a new `gdskills/bundled-eval.ts -> commands/skills.ts` pair broke both
// the exact allowlist and the "wiki is the only such debt" assertion.
//
// The fix is not a bigger allowlist — the rule has none, on purpose, and
// growing the wiki-only exception to cover a second, unrelated file would
// hide a real new boundary crossing behind an existing one. The fix is to
// stop the tokenizer from living on either side of the boundary it is being
// asked to cross: `src/lib/` is the "shared" zone
// (`import-zones.ts`: "independent primitives … below both core and client
// … a valid TARGET for anyone"), which is exactly this shape — a pure text
// transform with no provider registry, no model call and no CLI/MCP
// dependency, needed identically by an adapter (the router) and a core owner
// (the collision check). Moving it here makes both of the original import
// sites (`commands/skills.ts` importing this module, `gdskills/
// bundled-eval.ts` importing this module) land on a "shared" target, which
// `findingFor` never flags from either core or adapter — not a new bypass to
// track, an edge the policy has no opinion about at all.
//
// ONE TOKENIZER, STILL
//
// `src/commands/routing-baseline.test.ts`'s "no second copy of the ranking
// exists" guard is about a second SCORER (a `top()` reimplementation), not
// about this tokenizer's file path — but the property it protects applies
// here too: `src/commands/skills.ts` re-exports `normalizeRouteText` and
// `routeTokens` from here rather than restating them, so there remains
// exactly one definition of each, imported by every caller on both sides of
// the boundary.

/**
 * Short, high-frequency words carry no routing signal; excluding them stops
 * "для"/"the" from creating spurious matches. Kept small on purpose.
 */
const ROUTE_STOPWORDS = new Set([
  "the", "and", "for", "with", "this", "that", "your", "are", "from", "into",
  "out", "run", "use", "used", "make", "get", "can", "please", "help", "want",
  "для", "при", "что", "как", "это", "под", "над", "или", "все", "мне", "нам",
  "нужно", "надо", "мой", "моя", "мои", "чтобы", "его", "them",
]);

/**
 * Bundled skills carry mostly English metadata, so a Russian intent would
 * never reach them by token overlap. Map Russian intent stems to the English
 * tokens the catalog uses. Prefix match (not exact) absorbs Russian
 * inflection (задача/задачу/задачи → task). Applied to the QUERY only.
 */
const RU_SYNONYM_PREFIXES: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["ревью", ["review"]],
  ["ревьюер", ["review", "reviewer"]],
  ["проверк", ["verify", "check"]],
  ["провер", ["verify", "check"]],
  ["реализ", ["implement"]],
  ["имплемент", ["implement"]],
  ["внедр", ["implement"]],
  ["задач", ["task", "tasks"]],
  ["тикет", ["issue", "ticket"]],
  ["тест", ["test", "tests", "testing"]],
  ["верифи", ["verify", "verification"]],
  ["качеств", ["quality"]],
  ["документ", ["documentation", "docs", "document"]],
  ["требован", ["requirements"]],
  ["пакет", ["package"]],
  ["спецификац", ["specification", "spec"]],
  ["безопас", ["security"]],
  ["секьюр", ["security"]],
  ["утечк", ["security", "exfiltration", "leak"]],
  ["уязвим", ["security", "vulnerability"]],
  ["контекст", ["context"]],
  ["план", ["plan", "planning"]],
  ["роадмап", ["roadmap"]],
  ["дорожн", ["roadmap"]],
  ["рефактор", ["refactor"]],
  ["миграц", ["migration", "migrate"]],
  ["производитель", ["performance"]],
  ["перформанс", ["performance"]],
  ["здоров", ["health"]],
  ["хотспот", ["hotspot"]],
  ["мертв", ["dead"]],
  ["мёртв", ["dead"]],
  ["граф", ["graph"]],
  ["вики", ["wiki"]],
  ["память", ["memory"]],
  ["скил", ["skill"]],
  ["созда", ["create"]],
  ["деплой", ["deploy"]],
  ["разверт", ["deploy"]],
  ["разверн", ["deploy"]],
  ["зависим", ["dependency", "dependencies"]],
  ["интервью", ["interview"]],
  ["опрос", ["interview"]],
  ["брейншторм", ["brainstorm"]],
  ["идеи", ["brainstorm", "idea"]],
  ["продукт", ["product", "prd"]],
  ["фло", ["flow"]],
  ["оркестр", ["orchestrator", "orchestrate"]],
  ["анализ", ["analyze", "analysis"]],
  ["проанализ", ["analyze", "analysis"]],
  ["ревьюир", ["review"]],
];

/**
 * Exported so the synonym table can be asserted as a CLOSED contract by
 * `src/commands/route-synonyms.test.ts` (via `expandQueryTokens`, which wraps
 * this with `expand: true`). Tested only through end-to-end routing, the
 * table's failure mode is invisible in one direction: a prefix mapped to an
 * ADDITIONAL wrong token changes nothing a positive corpus pair can see. That
 * is the exact defect that started this work — `провер` expanded to
 * check+verify+REVIEW and every check request reached a review skill.
 */
export function routeTokens(normalized: string, expand = false): Set<string> {
  const tokens = new Set(
    normalized
      .split(" ")
      .filter((token) => token.length >= 3 && !ROUTE_STOPWORDS.has(token)),
  );
  if (expand) {
    for (const token of [...tokens]) {
      for (const [prefix, synonyms] of RU_SYNONYM_PREFIXES) {
        if (token.startsWith(prefix)) {
          for (const synonym of synonyms) {
            tokens.add(synonym);
          }
        }
      }
    }
  }
  return tokens;
}

export function normalizeRouteText(value: string): string {
  return value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    // Keep any Unicode letter/number (Cyrillic included); collapse the rest to
    // spaces. Stripping to [a-z0-9] used to erase non-Latin queries entirely,
    // which then matched every entry via `.includes("")`.
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}
