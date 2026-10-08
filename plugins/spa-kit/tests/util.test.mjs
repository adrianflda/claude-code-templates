import { test } from "node:test";
import assert from "node:assert/strict";
import {
  slugify,
  parseArgs,
  firstFreePort,
  resolveProjectTarget,
} from "../bin/lib/util.mjs";

test("slugify: strips accents, punctuation and edge dashes", () => {
  assert.equal(slugify("Faro Legal"), "faro-legal");
  assert.equal(slugify("Asesoría Jurídica S.L."), "asesoria-juridica-s-l");
  assert.equal(slugify("  —Acme—  "), "acme");
  assert.equal(slugify("Ñandú & Co"), "nandu-co");
});

test("slugify: truncates to 48 characters", () => {
  const slug = slugify("a".repeat(80));
  assert.equal(slug.length, 48);
});

test("parseArgs: separates positionals from flags", () => {
  const { positional, flags } = parseArgs(["new", "./dir", "--name=Acme", "--force"]);
  assert.deepEqual(positional, ["new", "./dir"]);
  assert.equal(flags.name, "Acme");
  assert.equal(flags.force, true);
});

test("parseArgs: keeps '=' inside a flag value", () => {
  const { flags } = parseArgs(["--base=http://localhost:4400/?a=1"]);
  assert.equal(flags.base, "http://localhost:4400/?a=1");
});

test("firstFreePort: returns the base when nothing is used", () => {
  assert.equal(firstFreePort([], 4400), 4400);
});

test("firstFreePort: skips every claimed port", () => {
  assert.equal(firstFreePort([4400, 4401, 4403], 4400), 4402);
  assert.equal(firstFreePort([4400, 4401, 4402], 4400), 4403);
});

test("resolveProjectTarget: defaults to the working directory", () => {
  const r = resolveProjectTarget({ argv: ["shadcn:button"], cwd: "/site", hasComponentsJson: () => true });
  assert.equal(r.ok, true);
  assert.equal(r.dir, "/site");
});

test("resolveProjectTarget: --project wins over the working directory", () => {
  const r = resolveProjectTarget({
    argv: ["--project=/clients/acme", "shadcn:button"],
    cwd: "/somewhere/else",
    hasComponentsJson: () => true,
  });
  assert.equal(r.dir, "/clients/acme");
});

test("resolveProjectTarget: a path without components.json is refused with a usable message", () => {
  const r = resolveProjectTarget({ argv: [], cwd: "/tmp", hasComponentsJson: () => false });
  assert.equal(r.ok, false);
  assert.match(r.error, /\/tmp has no components\.json/);
  assert.match(r.error, /--project=/);
});

test("resolveProjectTarget: keeps '=' inside a project path", () => {
  const r = resolveProjectTarget({
    argv: ["--project=/a=b/site"],
    cwd: "/x",
    hasComponentsJson: () => true,
  });
  assert.equal(r.dir, "/a=b/site");
});
