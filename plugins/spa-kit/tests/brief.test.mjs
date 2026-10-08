import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normaliseBrief,
  renderContentModule,
  renderSiteModule,
  BRIEF_EXAMPLE,
} from "../bin/lib/brief.mjs";

const minimal = () => ({
  business: { name: "Acme", description: "Acme does a thing.", url: "https://acme.test" },
  brand: { color: "#0A5FFF" },
  hero: { headline: "One clear sentence." },
});

test("the shipped example brief is itself valid", () => {
  const brief = normaliseBrief(structuredClone(BRIEF_EXAMPLE));
  assert.equal(brief.business.name, "Acme Robotics");
  assert.ok(brief.sections.length > 0);
});

test("missing required fields are named, all of them at once", () => {
  assert.throws(
    () => normaliseBrief({ business: {}, brand: {}, hero: {} }),
    (err) => {
      assert.match(err.message, /business\.name/);
      assert.match(err.message, /business\.description/);
      assert.match(err.message, /business\.url/);
      assert.match(err.message, /brand\.color/);
      assert.match(err.message, /hero\.headline/);
      return true;
    },
  );
});

test("defaults are filled in as documented", () => {
  const brief = normaliseBrief(minimal());
  assert.equal(brief.business.locale, "en_US");
  assert.equal(brief.business.tagline, "");
  assert.equal(brief.brand.mode, "dark");
  assert.deepEqual(brief.routes, ["/"]);
  assert.equal(brief.footer.note, "© Acme");
  assert.deepEqual(brief.nav, []);
  assert.equal(brief.hero.subhead, "Acme does a thing.", "subhead falls back to the description");
});

test("a trailing slash on the site URL is removed", () => {
  const raw = minimal();
  raw.business.url = "https://acme.test/";
  assert.equal(normaliseBrief(raw).business.url, "https://acme.test");
});

test("interface strings follow the locale, and unknown locales fall back to English", () => {
  const es = normaliseBrief({ ...minimal(), business: { ...minimal().business, locale: "es_ES" } });
  assert.equal(es.ui.skipToContent, "Saltar al contenido");

  const fr = normaliseBrief({ ...minimal(), business: { ...minimal().business, locale: "fr-FR" } });
  assert.equal(fr.ui.primaryNav, "Principale");

  const unknown = normaliseBrief({
    ...minimal(),
    business: { ...minimal().business, locale: "eu_ES" },
  });
  assert.equal(unknown.ui.skipToContent, "Skip to content");
});

test("explicit ui strings override the locale defaults", () => {
  const brief = normaliseBrief({ ...minimal(), ui: { skipToContent: "Jump" } });
  assert.equal(brief.ui.skipToContent, "Jump");
  assert.equal(brief.ui.primaryNav, "Primary", "unspecified strings keep their default");
});

test("the prose warning fires below the 400-character margin and not above it", () => {
  const withProse = (chars) => {
    const raw = minimal();
    raw.hero.subhead = "x".repeat(chars);
    return normaliseBrief(raw);
  };

  const thin = withProse(300);
  assert.ok(
    thin.warnings.some((w) => /characters of prose/.test(w)),
    "a brief under the margin must warn",
  );
  // The message must state both real numbers, not one of them.
  const message = thin.warnings.find((w) => /characters of prose/.test(w));
  assert.match(message, /300/);
  assert.match(message, /400/);

  const thick = withProse(500);
  assert.equal(
    thick.warnings.some((w) => /characters of prose/.test(w)),
    false,
    "a brief above the margin must not warn",
  );
});

test("a brief with no sections says so", () => {
  const brief = normaliseBrief(minimal());
  assert.ok(brief.warnings.some((w) => /no sections/.test(w)));
});

test("renderContentModule emits valid TypeScript carrying the content", () => {
  const brief = normaliseBrief(structuredClone(BRIEF_EXAMPLE));
  const ts = renderContentModule(brief);
  assert.match(ts, /export const content: SiteContent =/);
  assert.match(ts, /export interface SiteContent/);
  assert.ok(ts.includes(brief.hero.headline), "the headline must survive into the module");
  assert.ok(ts.includes(brief.sections[0].body), "section bodies must survive");
  assert.doesNotMatch(ts, /undefined/);
});

test("renderSiteModule carries the SEO source of truth", () => {
  const brief = normaliseBrief({ ...minimal(), routes: ["/", "/pricing"] });
  const ts = renderSiteModule(brief);
  assert.match(ts, /name: "Acme"/);
  assert.match(ts, /\?\? "https:\/\/acme\.test"/);
  assert.match(ts, /indexableRoutes: \["\/", "\/pricing"\] as const/);
  assert.match(ts, /export function absoluteUrl/);
});

test("content and quotes are escaped rather than breaking the module", () => {
  const raw = minimal();
  raw.hero.headline = 'He said "yes" — then ${injected} and `backticks`';
  const ts = renderContentModule(normaliseBrief(raw));
  // JSON.stringify is the escape mechanism; the payload must come back intact.
  const marker = "export const content: SiteContent = ";
  const start = ts.indexOf(marker) + marker.length;
  const payload = ts.slice(start, ts.lastIndexOf("}") + 1);
  const parsed = JSON.parse(payload);
  assert.equal(parsed.hero.headline, raw.hero.headline);

  // The content is emitted inside a double-quoted JSON string, so backticks and
  // ${...} are inert there. What must hold is that the quotes are escaped.
  assert.match(payload, /\\"yes\\"/);
});
