/** Convert the legacy wiki module key to the name written by current Keryx. */
export function normalizeMetaprojectModules<T>(modules: Record<string, T>): Record<string, T> {
  const wiki = modules.wiki;
  if (wiki === undefined || modules.gdwiki !== undefined) return modules;
  const { wiki: _legacy, ...current } = modules;
  return { ...current, gdwiki: wiki };
}
