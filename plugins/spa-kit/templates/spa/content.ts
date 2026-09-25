/**
 * Site content. Overwritten by `spa-kit new --brief=...` and `spa-kit apply`.
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
  hero: { headline: string; subhead: string; primary: Cta | null; secondary: Cta | null };
  sections: Section[];
  footer: { note: string; links: NavItem[] };
}

export const content: SiteContent = {
  ui: { skipToContent: "Skip to content", primaryNav: "Primary", footerNav: "Footer" },
  nav: [],
  hero: {
    headline: "__SPA_HEADLINE__",
    subhead: "__SPA_DESCRIPTION__",
    primary: null,
    secondary: null,
  },
  sections: [],
  footer: { note: "© __SPA_NAME__", links: [] },
};
