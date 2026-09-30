// Everything the bot writes to a pull request is public and permanent. A finding is model
// output about untrusted code: it can quote a secret that was in the diff, or repeat an
// instruction planted there. Such a finding is withheld, never masked and posted.

import { guardOutput } from "../../security/guard";
import { detectInjection } from "../../security/detect/injection";
import { scanContent } from "../../security/service";

export type ScreenVerdict = { ok: true } | { ok: false; categories: string[]; reason: string };

export async function screenCommentBody(cwd: string, body: string): Promise<ScreenVerdict> {
  if (body.trim() === "") {
    return { ok: false, categories: ["empty"], reason: "the comment body is empty" };
  }
  const categories = new Set<string>();

  const guard = await guardOutput({ cwd, content: body, target: "external", source: "generated" });
  if (!guard.allowed) categories.add("security-gate");
  if (guard.redacted !== undefined && guard.redacted !== body) categories.add("secret");
  for (const finding of guard.decision.findings) categories.add(finding.category);

  if (detectInjection(body).length > 0) categories.add("prompt-injection");

  const { decision } = await scanContent(cwd, { content: body, source: "generated", target: "external" });
  for (const finding of decision.findings) categories.add(finding.category);

  if (categories.size === 0) return { ok: true };
  const list = [...categories].sort();
  return {
    ok: false,
    categories: list,
    reason: `the security output check flagged this comment (${list.join(", ")}); it was withheld, not masked`,
  };
}

export type WithheldComment<T> = { item: T; categories: string[]; reason: string };

export async function screenComments<T extends { body: string }>(
  cwd: string,
  items: readonly T[],
): Promise<{ kept: T[]; withheld: WithheldComment<T>[] }> {
  const kept: T[] = [];
  const withheld: WithheldComment<T>[] = [];
  for (const item of items) {
    const verdict = await screenCommentBody(cwd, item.body);
    if (verdict.ok) kept.push(item);
    else withheld.push({ item, categories: verdict.categories, reason: verdict.reason });
  }
  return { kept, withheld };
}
