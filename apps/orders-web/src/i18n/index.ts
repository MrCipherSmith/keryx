import { createContext, useContext, useMemo } from "react";

export type Locale = "en" | "de" | "ar";
export const LOCALES: readonly Locale[] = ["en", "de", "ar"];

export type Catalog<K extends string> = Record<Locale, Record<K, string>>;
export type Translate<K extends string> = (key: K, vars?: Record<string, string | number>) => string;

export const LocaleContext = createContext<Locale>("en");

export function dirOf(locale: Locale): "ltr" | "rtl" {
  return locale === "ar" ? "rtl" : "ltr";
}

export function defineMessages<K extends string>(catalog: Catalog<K>): Catalog<K> {
  return catalog;
}

export function createT<K extends string>(catalog: Catalog<K>, locale: Locale): Translate<K> {
  return (key, vars) => {
    const template = catalog[locale][key];
    if (!vars) return template;
    return template.replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? ""));
  };
}

export function useMessages<K extends string>(catalog: Catalog<K>): Translate<K> {
  const locale = useContext(LocaleContext);
  return useMemo(() => createT(catalog, locale), [catalog, locale]);
}

export function useLocale(): Locale {
  return useContext(LocaleContext);
}
