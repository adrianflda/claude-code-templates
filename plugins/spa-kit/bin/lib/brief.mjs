/**
 * The brief: the single declarative input that decides what a client site looks
 * like and says. Same brief in, same site out — which is what makes generation
 * repeatable for an agent rather than a creative act each time.
 */

export const BRIEF_EXAMPLE = {
  business: {
    name: "Acme Robotics",
    tagline: "Industrial automation",
    description:
      "Acme Robotics builds and services robotic cells for mid-sized manufacturers, with installation in under six weeks.",
    sector: "manufacturing",
    locale: "en_US",
    url: "https://acmerobotics.com",
  },
  brand: { color: "#0A5FFF", mode: "dark" },
  nav: [
    { label: "Capabilities", href: "#capabilities" },
    { label: "Process", href: "#process" },
    { label: "Contact", href: "#contact" },
  ],
  hero: {
    headline: "Industrial automation that pays for itself in eighteen months.",
    subhead:
      "We design, install and maintain robotic cells for manufacturers who cannot afford a stopped line.",
    primary: { label: "Book an assessment", href: "#contact" },
    secondary: { label: "See our process", href: "#process" },
  },
  sections: [
    {
      id: "capabilities",
      label: "Capabilities",
      title: "What we install",
      body: "Pick-and-place cells, palletising, machine tending and end-of-line inspection, integrated with the PLCs you already run.",
    },
  ],
  footer: { note: "© Acme Robotics" },
  routes: ["/"],
};

/**
 * Interface strings that are not content but still must not be in the wrong
 * language. Extend per locale; unknown locales fall back to English.
 */
const UI_STRINGS = {
  en: { skipToContent: "Skip to content", primaryNav: "Primary", footerNav: "Footer" },
  es: { skipToContent: "Saltar al contenido", primaryNav: "Principal", footerNav: "Pie de página" },
  fr: { skipToContent: "Aller au contenu", primaryNav: "Principale", footerNav: "Pied de page" },
  de: { skipToContent: "Zum Inhalt springen", primaryNav: "Hauptnavigation", footerNav: "Fußzeile" },
  pt: { skipToContent: "Ir para o conteúdo", primaryNav: "Principal", footerNav: "Rodapé" },
};

function uiStringsFor(locale) {
  const language = String(locale).split(/[-_]/)[0].toLowerCase();
  return UI_STRINGS[language] ?? UI_STRINGS.en;
}

const REQUIRED = [
  ["business.name", (b) => b.business?.name],
  ["business.description", (b) => b.business?.description],
  ["business.url", (b) => b.business?.url],
  ["brand.color", (b) => b.brand?.color],
  ["hero.headline", (b) => b.hero?.headline],
];

/** Fills defaults and fails loudly on anything that cannot be defaulted. */
export function normaliseBrief(raw) {
  const missing = REQUIRED.filter(([, get]) => !get(raw)).map(([path]) => path);
  if (missing.length > 0) {
    throw new Error(`brief is missing required fields: ${missing.join(", ")}`);
  }

  const business = {
    name: raw.business.name,
    tagline: raw.business.tagline ?? "",
    description: raw.business.description,
    sector: raw.business.sector ?? "",
    locale: raw.business.locale ?? "en_US",
    url: String(raw.business.url).replace(/\/$/, ""),
  };

  const brand = {
    color: raw.brand.color,
    mode: raw.brand.mode ?? "dark",
  };

  const sections = (raw.sections ?? []).map((s, i) => ({
    id: s.id ?? `section-${i + 1}`,
    label: s.label ?? "",
    title: s.title ?? "",
    body: s.body ?? "",
  }));

  const hero = {
    headline: raw.hero.headline,
    subhead: raw.hero.subhead ?? business.description,
    primary: raw.hero.primary ?? null,
    secondary: raw.hero.secondary ?? null,
  };

  const ui = { ...uiStringsFor(business.locale), ...(raw.ui ?? {}) };

  const brief = {
    business,
    ui,
    brand,
    nav: raw.nav ?? [],
    hero,
    sections,
    footer: { note: raw.footer?.note ?? `© ${business.name}`, links: raw.footer?.links ?? [] },
    routes: raw.routes ?? ["/"],
  };

  // The SEO probe requires 300+ characters of visible prose in the raw HTML.
  // Catch it here, where the fix is editing the brief, rather than three steps
  // later as a failing oracle.
  const prose = [hero.headline, hero.subhead, ...sections.map((s) => `${s.title} ${s.body}`)]
    .join(" ")
    .trim();
  brief.proseLength = prose.length;
  brief.warnings = [];
  if (prose.length < 400) {
    brief.warnings.push(
      `only ${prose.length} characters of prose; the SEO probe requires 300+ in the rendered page and this leaves no margin. Add sections or lengthen the bodies.`,
    );
  }
  if (brief.sections.length === 0) {
    brief.warnings.push("no sections: the page will be a bare hero.");
  }

  return brief;
}

/** The TypeScript content module a generated project renders from. */
export function renderContentModule(brief) {
  const json = JSON.stringify(
    {
      ui: brief.ui,
      nav: brief.nav,
      hero: brief.hero,
      sections: brief.sections,
      footer: brief.footer,
    },
    null,
    2,
  );

  return `/**
 * Site content.
 *
 * Generated from brief.json. Edit either this file directly or the brief and
 * re-apply it with \`spa-kit apply <dir>\`, which overwrites this file.
 *
 * Constraints the toolchain enforces on whatever ends up here:
 *  - the hero headline is the page's only <h1>;
 *  - the rendered page must carry 300+ characters of visible prose, because AI
 *    crawlers read raw HTML and quote from it.
 */

export interface NavItem {
  label: string;
  href: string;
}

export interface Cta {
  label: string;
  href: string;
}

export interface Section {
  id: string;
  label: string;
  title: string;
  body: string;
}

export interface SiteContent {
  ui: { skipToContent: string; primaryNav: string; footerNav: string };
  nav: NavItem[];
  hero: {
    headline: string;
    subhead: string;
    primary: Cta | null;
    secondary: Cta | null;
  };
  sections: Section[];
  footer: { note: string; links: NavItem[] };
}

export const content: SiteContent = ${json};
`;
}

/** The SEO source of truth a generated project compiles against. */
export function renderSiteModule(brief) {
  const routes = brief.routes.map((r) => JSON.stringify(r)).join(", ");
  return `/** Single source of truth for anything the SEO/AEO tools assert against. */
export const site = {
  name: ${JSON.stringify(brief.business.name)},
  /** Absolute origin. Every canonical, sitemap entry and JSON-LD @id derives from it. */
  url: process.env["NEXT_PUBLIC_SITE_URL"] ?? ${JSON.stringify(brief.business.url)},
  description: ${JSON.stringify(brief.business.description)},
  locale: ${JSON.stringify(brief.business.locale)},
  /**
   * Routes that must be indexable. Generated from brief.json; the SEO probe
   * walks this list and fails if a route loses its canonical, its metadata, its
   * JSON-LD or its server-rendered body text.
   */
  indexableRoutes: [${routes}] as const,
} as const;

export function absoluteUrl(path: string): string {
  return new URL(path, site.url).toString();
}
`;
}
