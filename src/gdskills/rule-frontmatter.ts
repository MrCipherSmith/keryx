import { frontmatterList, frontmatterScalar } from "./skill-frontmatter";

export type RuleFrontmatter = {
  description: string;
  globs: string[];
  alwaysApply: boolean;
  taskTypes: string[];
};

/**
 * The `description`, `globs`, `alwaysApply` and `taskTypes` (also spelled
 * `task_types`) of a rule's front matter, read with the same YAML subset the
 * skills use. Anything it cannot read is the empty value: a rule without front
 * matter is one that nothing selects by glob.
 */
export function parseRuleFrontmatter(text: string): RuleFrontmatter {
  const taskTypes = frontmatterList(text, "taskTypes");
  return {
    description: frontmatterScalar(text, "description") ?? "",
    globs: frontmatterList(text, "globs"),
    alwaysApply: /^true$/i.test(frontmatterScalar(text, "alwaysApply") ?? ""),
    taskTypes: taskTypes.length > 0 ? taskTypes : frontmatterList(text, "task_types"),
  };
}
