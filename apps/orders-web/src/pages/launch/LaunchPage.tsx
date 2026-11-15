import { useMessages } from "../../i18n";
import { launchMessages } from "./launch.messages";
import { Testimonial } from "./Testimonial";

const BRANDS = ["Brightloop", "Lumora", "Nexora", "Voltix", "Orbitly"];

const FEATURES = [
  { icon: "M13 10V3L4 14h7v7l9-11h-7z", titleKey: "f1Title", bodyKey: "f1Body" },
  { icon: "M12 11c0-1.1.9-2 2-2V7a4 4 0 00-8 0v2h2", titleKey: "f2Title", bodyKey: "f2Body" },
  { icon: "M3 17l6-6 4 4 8-8", titleKey: "f3Title", bodyKey: "f3Body" },
] as const;

export function LaunchPage() {
  const t = useMessages(launchMessages);

  return (
    <main className="mx-auto max-w-5xl px-4 py-16 font-sans">
      <section className="rounded-2xl bg-white p-10 text-center shadow-lg">
        <h1 className="bg-gradient-to-r from-purple-500 to-blue-500 bg-clip-text font-sans text-5xl font-bold text-transparent">
          {t("heroTitle")}
        </h1>
        <p className="mx-auto mt-4 max-w-xl text-lg text-slate-600">{t("heroLead")}</p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <a href="/signup" className="rounded-2xl bg-indigo-500 px-6 py-3 font-semibold text-white shadow-lg">
            {t("getStarted")}
          </a>
          <a href="/tour" className="rounded-2xl bg-indigo-100 px-6 py-3 font-semibold text-indigo-700 shadow-lg">
            {t("learnMore")}
          </a>
        </div>
        <ul className="mt-10 flex flex-wrap justify-center gap-8 text-2xl font-bold text-slate-800">
          <li>{t("statMerchants")}</li>
          <li>{t("statUptime")}</li>
        </ul>
        <p className="mt-8 text-sm uppercase tracking-wide text-slate-500">{t("trustedBy")}</p>
        <ul className="mt-3 flex flex-wrap justify-center gap-8 text-xl font-semibold text-slate-400">
          {BRANDS.map((brand) => (
            <li key={brand}>{brand}</li>
          ))}
        </ul>
      </section>

      <section className="mt-12 rounded-2xl bg-white p-8 shadow-lg">
        <div className="grid gap-6 md:grid-cols-3">
          {FEATURES.map((f) => (
            <article key={f.titleKey} className="rounded-2xl bg-white p-6 shadow-lg">
              <div className="inline-flex rounded-xl bg-indigo-100 p-3 text-indigo-500">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <path d={f.icon} />
                </svg>
              </div>
              <h2 className="mt-4 font-sans text-xl font-bold text-slate-900">{t(f.titleKey)}</h2>
              <p className="mt-2 text-slate-600">{t(f.bodyKey)}</p>
            </article>
          ))}
        </div>
      </section>

      <div className="mt-12">
        <Testimonial quote={t("quote")} author={t("quoteAuthor")} />
      </div>

      <form className="mt-12 flex flex-wrap items-end gap-3 rounded-2xl bg-white p-6 shadow-lg">
        <label className="flex flex-1 flex-col gap-1 text-sm font-semibold text-slate-700">
          {t("newsletterLabel")}
          <input type="email" className="min-h-11 rounded-2xl border border-slate-300 px-4" />
        </label>
        <button type="submit" className="min-h-11 rounded-2xl bg-indigo-500 px-6 font-semibold text-white shadow-lg">
          {t("submit")}
        </button>
      </form>
    </main>
  );
}
