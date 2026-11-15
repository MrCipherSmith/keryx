import { useMessages } from "../../i18n";
import { homeMessages } from "./home.messages";

const SECTIONS = [
  { titleKey: "listTitle", bodyKey: "listBody" },
  { titleKey: "drawerTitle", bodyKey: "drawerBody" },
  { titleKey: "customersTitle", bodyKey: "customersBody" },
] as const;

export function HomePage() {
  const t = useMessages(homeMessages);

  return (
    <main className="mx-auto max-w-3xl px-4 py-12">
      <h1 className="font-display text-[40px] leading-tight text-ink">{t("title")}</h1>
      <p className="mt-4 text-[20px] text-muted">{t("lead")}</p>
      <a
        href="/orders"
        className="mt-8 inline-flex min-h-11 items-center rounded-control bg-accent px-5 text-accent-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        {t("cta")}
      </a>

      <section className="mt-16" aria-labelledby="home-sections">
        <h2 id="home-sections" className="font-display text-[28px] text-ink">
          {t("sectionTitle")}
        </h2>
        <dl className="mt-6 divide-y divide-line border-y border-line">
          {SECTIONS.map(({ titleKey, bodyKey }) => (
            <div key={titleKey} className="py-4">
              <dt className="font-medium text-ink">{t(titleKey)}</dt>
              <dd className="mt-1 text-muted">{t(bodyKey)}</dd>
            </div>
          ))}
        </dl>
      </section>
    </main>
  );
}
