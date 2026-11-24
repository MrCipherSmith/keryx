export interface ProjectConfig {
  name: string;
  path: string;
  references: string[];
  host?: string;
}

const KEY = "keryx.desktop.projectConfigs";
export const absolutePath = (path: unknown): path is string => typeof path === "string" && path.startsWith("/") && !/\p{Cc}/u.test(path);

export function validProject(value: unknown): value is ProjectConfig {
  if (!value || typeof value !== "object") return false;
  const { name, path, references, host } = value as Partial<ProjectConfig>;
  return typeof name === "string" && name.trim().length > 0 && !/\p{Cc}/u.test(name)
    && absolutePath(path) && Array.isArray(references) && references.length <= 16 && references.every(absolutePath)
    && (host === undefined || (typeof host === "string" && /^[A-Za-z0-9._][A-Za-z0-9._-]*$/.test(host)));
}

export function projectConfigs(): ProjectConfig[] {
  try { const items: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]"); return Array.isArray(items) ? items.filter(validProject) : []; }
  catch { return []; }
}

export function rememberProject(project: ProjectConfig) {
  localStorage.setItem(KEY, JSON.stringify([project, ...projectConfigs().filter(other => other.path !== project.path || other.host !== project.host)]));
}
