#!/usr/bin/env node
// Records a narrated walkthrough of a running web app, once per viewport (desktop and mobile by
// default), and writes per viewport: an MP4, subtitles (.srt and .vtt) and a contact sheet.
//
//   node record-demo.cjs --tour <tour.cjs> --project <dir with playwright installed> [--only desktop|mobile]
//
// The tour file is a CommonJS module; see ../SKILL.md for its shape. Requirements: Playwright in
// the target project (@playwright/test or playwright), ffmpeg + ffprobe on PATH, and a speech
// engine for the narration: macOS `say` (default) or any command given in `tts.command`.
//
// Techniques (cursor overlay, click ring, in-page zoom, narration-driven timing with lead-in and
// lead-out, sidecar subtitles) follow what open-source recorders such as shreyaskarnik/argo and
// vribeirocmp/recording-demo-videos (both MIT) do; the code here is an independent implementation.
const { execFileSync, spawnSync } = require("node:child_process");
const { createRequire } = require("node:module");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
function fail(message) {
  console.error(`record-demo: ${message}`);
  process.exit(2);
}
function has(bin) {
  return spawnSync("which", [bin], { stdio: "ignore" }).status === 0;
}
function probeSeconds(file) {
  return Number(
    execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file])
      .toString()
      .trim(),
  );
}

const tourPath = arg("tour");
if (!tourPath) fail("missing --tour <file>");
const projectDir = path.resolve(arg("project", process.cwd()));
const only = arg("only");
const tour = require(path.resolve(tourPath));
if (!tour.baseURL || !Array.isArray(tour.segments) || tour.segments.length === 0) {
  fail("the tour must export { baseURL, segments: [...] }");
}
if (!has("ffmpeg") || !has("ffprobe")) fail("ffmpeg and ffprobe are required (brew install ffmpeg)");

const projectRequire = createRequire(path.join(projectDir, "package.json"));
let chromium;
for (const name of ["@playwright/test", "playwright"]) {
  try {
    ({ chromium } = projectRequire(name));
    break;
  } catch {
    // try the next package name
  }
}
if (!chromium) fail(`Playwright not found in ${projectDir} (install @playwright/test there)`);

const DEFAULT_VIEWPORTS = [
  { name: "desktop", width: 1280, height: 720 },
  { name: "mobile", width: 390, height: 844, mobile: true },
];
const viewports = (tour.viewports || DEFAULT_VIEWPORTS).filter((v) => !only || v.name === only);
if (viewports.length === 0) fail(`no viewport named "${only}"`);

const outDir = path.resolve(tour.outDir || process.cwd());
const name = tour.name || "demo";
const work = fs.mkdtempSync(path.join(os.tmpdir(), "demo-video-"));
fs.mkdirSync(outDir, { recursive: true });

const LEAD_IN = tour.leadInMs === undefined ? 250 : tour.leadInMs; // silence before each line
const LEAD_OUT = tour.leadOutMs === undefined ? 450 : tour.leadOutMs; // pause after each line

// ---- title and end cards become ordinary segments ----
function escapeHtml(text) {
  return String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}
function cardSegment(id, card) {
  const bg = card.background || "linear-gradient(135deg,#1f2a44,#3b2a5c)";
  const html =
    `<html><body style="margin:0;height:100vh;display:flex;flex-direction:column;align-items:center;` +
    `justify-content:center;gap:.6em;background:${bg};color:${card.color || "#fff"};` +
    `font-family:system-ui,-apple-system,sans-serif;text-align:center;padding:0 8vw;box-sizing:border-box">` +
    `<div id="t" style="font-size:clamp(30px,6.5vw,68px);font-weight:800;letter-spacing:-.02em;opacity:0;` +
    `transform:translateY(18px);transition:all .7s cubic-bezier(.2,.8,.2,1)">${escapeHtml(card.title || "")}</div>` +
    `<div id="s" style="font-size:clamp(16px,2.6vw,28px);opacity:0;transform:translateY(18px);` +
    `transition:all .7s .25s cubic-bezier(.2,.8,.2,1)">${escapeHtml(card.subtitle || "")}</div>` +
    `<script>requestAnimationFrame(()=>requestAnimationFrame(()=>{for(const i of ["t","s"]){` +
    `const e=document.getElementById(i);e.style.opacity=i==="s"?.85:1;e.style.transform="none"}}))</script></body></html>`;
  return {
    id,
    say: card.say,
    caption: false,
    hold: card.hold === undefined ? 2600 : card.hold,
    run: async (page) => {
      await page.setContent(html);
    },
  };
}
const segments = [
  ...(tour.intro ? [cardSegment("intro-card", tour.intro)] : []),
  ...tour.segments,
  ...(tour.outro ? [cardSegment("outro-card", tour.outro)] : []),
];
segments.forEach((s, i) => {
  if (!s.id) s.id = `seg${i}`;
});

// ---- narration: one clip per segment, measured so the video can wait for it ----
const customTts = tour.tts && Array.isArray(tour.tts.command) ? tour.tts.command : null;
const voice = tour.voice === undefined ? null : tour.voice;
const speak = customTts ? true : Boolean(voice) && has("say");
if (voice && !customTts && !speak) console.warn("record-demo: `say` not available, recording without narration");
const clips = {};
for (const s of segments) {
  if (!speak || !s.say) continue;
  const file = path.join(work, `${s.id}.${customTts ? "wav" : "aiff"}`);
  if (customTts) {
    const [bin, ...rest] = customTts.map((part) => part.replace("{text}", s.say).replace("{out}", file));
    execFileSync(bin, rest, { stdio: ["ignore", "ignore", "inherit"] });
  } else {
    execFileSync("say", ["-v", voice, "-r", String(tour.rate || 175), "-o", file, s.say]);
  }
  if (!fs.existsSync(file)) fail(`the speech engine produced no audio for segment "${s.id}"`);
  clips[s.id] = { file, seconds: probeSeconds(file) };
}

// ---- injected into every page: visible pointer, click ring ----
function overlayScript({ mobile, show }) {
  if (!show || window.top !== window) return;
  const KEY = "__demoVideoPointer";
  const install = () => {
    if (document.getElementById("demo-video-pointer")) return;
    const style = document.createElement("style");
    style.textContent =
      "#demo-video-pointer{position:fixed;z-index:2147483646;pointer-events:none;left:0;top:0;opacity:0;" +
      "transition:transform .32s cubic-bezier(.2,.8,.2,1),opacity .2s;will-change:transform}" +
      ".demo-video-ring{position:fixed;z-index:2147483645;pointer-events:none;border-radius:50%;" +
      "border:3px solid rgba(255,196,0,.95);box-shadow:0 0 0 2px rgba(0,0,0,.25);" +
      "animation:demo-video-ring .5s ease-out forwards}" +
      "@keyframes demo-video-ring{from{width:14px;height:14px;margin:-7px 0 0 -7px;opacity:1}" +
      "to{width:64px;height:64px;margin:-32px 0 0 -32px;opacity:0}}";
    document.documentElement.appendChild(style);
    const pointer = document.createElement("div");
    pointer.id = "demo-video-pointer";
    pointer.innerHTML = mobile
      ? '<div style="width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;background:rgba(255,255,255,.55);' +
        'border:2px solid rgba(0,0,0,.45);box-shadow:0 2px 8px rgba(0,0,0,.35)"></div>'
      : '<svg width="26" height="26" viewBox="0 0 24 24" style="filter:drop-shadow(0 2px 3px rgba(0,0,0,.45))">' +
        '<path d="M4 2l15 9-7 1.6L8.6 20z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    document.documentElement.appendChild(pointer);
    const place = (x, y) => {
      pointer.style.transform = `translate(${x}px,${y}px)`;
      pointer.style.opacity = "1";
    };
    try {
      const last = JSON.parse(sessionStorage.getItem(KEY) || "null");
      if (last) place(last.x, last.y);
    } catch {
      // storage can be unavailable; the pointer shows on the next move
    }
    document.addEventListener(
      "mousemove",
      (e) => {
        place(e.clientX, e.clientY);
        try {
          sessionStorage.setItem(KEY, JSON.stringify({ x: e.clientX, y: e.clientY }));
        } catch {
          // ignore
        }
      },
      true,
    );
    document.addEventListener(
      "mousedown",
      (e) => {
        const ring = document.createElement("div");
        ring.className = "demo-video-ring";
        ring.style.left = `${e.clientX}px`;
        ring.style.top = `${e.clientY}px`;
        document.documentElement.appendChild(ring);
        setTimeout(() => ring.remove(), 550);
      },
      true,
    );
  };
  if (document.documentElement) install();
  document.addEventListener("DOMContentLoaded", install);
}

function stamp(seconds, separator) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}${separator}${pad(ms % 1000, 3)}`;
}
// One cue per sentence, each given a share of the clip in proportion to its length.
function cuesFor(spoken, starts) {
  const cues = [];
  for (const s of spoken) {
    const sentences = s.say.match(/[^.!?…]+[.!?…]+|[^.!?…]+$/g).map((t) => t.trim()).filter(Boolean);
    const total = sentences.reduce((n, t) => n + t.length, 0);
    let at = starts[s.id] + LEAD_IN / 1000;
    for (const text of sentences) {
      const length = (clips[s.id].seconds * text.length) / total;
      cues.push({ from: at, to: at + length, text });
      at += length;
    }
  }
  return cues;
}

async function record(viewport) {
  const size = { width: viewport.width, height: viewport.height };
  const mobile = Boolean(viewport.mobile);
  const browser = await chromium.launch();
  const context = await browser.newContext({
    baseURL: tour.baseURL,
    locale: tour.locale || "en-US",
    viewport: size,
    isMobile: mobile,
    hasTouch: mobile,
    deviceScaleFactor: mobile ? 2 : 1,
    recordVideo: { dir: work, size },
  });
  await context.addInitScript(overlayScript, { mobile, show: tour.cursor !== false });
  const page = await context.newPage();
  const t0 = Date.now();
  const starts = {};

  const h = {
    viewport: viewport.name,
    isMobile: mobile,
    context,
    wait: (ms) => page.waitForTimeout(ms),
    // Smooth scroll by `px` (negative scrolls up). Works on desktop and touch viewports.
    scroll: async (px, ms = Math.min(4000, Math.abs(px) * 3)) => {
      const steps = Math.max(1, Math.round(ms / 40));
      for (let i = 0; i < steps; i += 1) {
        await page.evaluate((dy) => window.scrollBy(0, dy), px / steps);
        await page.waitForTimeout(40);
      }
    },
    // Types like a person so the viewer can follow.
    type: (locator, text, delay = 45) => locator.pressSequentially(text, { delay }),
    // Glides the pointer to the element, pauses so the eye catches up, then clicks.
    click: async (locator) => {
      await locator.scrollIntoViewIfNeeded();
      const box = await locator.boundingBox();
      if (box) {
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 16 });
        await page.waitForTimeout(380);
      }
      await locator.click();
    },
    // Glow around an element for `ms`, to point at something without clicking it.
    highlight: async (locator, ms = 1400) => {
      await locator.scrollIntoViewIfNeeded();
      await locator.evaluate((el, duration) => {
        const before = { boxShadow: el.style.boxShadow, transition: el.style.transition };
        el.style.transition = "box-shadow .25s";
        el.style.boxShadow = "0 0 0 4px rgba(255,196,0,.95), 0 0 0 9px rgba(255,196,0,.35)";
        setTimeout(() => {
          el.style.boxShadow = before.boxShadow;
          setTimeout(() => (el.style.transition = before.transition), 300);
        }, duration);
      }, ms);
      await page.waitForTimeout(ms);
    },
    // Zooms the page towards an element (CSS transform); zoomOut() restores it.
    zoom: async (locator, scale = 1.6) => {
      await locator.scrollIntoViewIfNeeded();
      const box = await locator.boundingBox();
      if (!box) return;
      await page.evaluate(
        ({ x, y, s }) => {
          const root = document.documentElement;
          root.style.transition = "transform .7s cubic-bezier(.2,.8,.2,1)";
          root.style.transformOrigin = `${x + window.scrollX}px ${y + window.scrollY}px`;
          root.style.transform = `scale(${s})`;
        },
        { x: box.x + box.width / 2, y: box.y + box.height / 2, s: scale },
      );
      await page.waitForTimeout(800);
    },
    zoomOut: async () => {
      await page.evaluate(() => {
        document.documentElement.style.transform = "none";
      });
      await page.waitForTimeout(800);
    },
    // Caption burned into the page (video only; removed on the next navigation).
    caption: async (text) => {
      await page.evaluate((t) => {
        let el = document.getElementById("demo-video-caption");
        if (!el) {
          el = document.createElement("div");
          el.id = "demo-video-caption";
          el.style.cssText =
            "position:fixed;left:50%;bottom:4%;transform:translateX(-50%);z-index:2147483647;" +
            "background:rgba(20,20,30,.88);color:#fff;font:600 clamp(14px,2.2vw,20px)/1.3 system-ui,sans-serif;" +
            "padding:.6em 1.1em;border-radius:14px;max-width:88%;text-align:center;pointer-events:none";
          document.body.appendChild(el);
        }
        el.textContent = t;
      }, text);
    },
  };

  for (const s of segments) {
    const started = Date.now();
    starts[s.id] = (started - t0) / 1000;
    if (s.run) await s.run(page, h);
    if (tour.captions && s.caption !== false && (s.caption || s.say)) await h.caption(s.caption || s.say);
    const spokenMs = clips[s.id] ? LEAD_IN + clips[s.id].seconds * 1000 + LEAD_OUT : 0;
    const left = Math.max(spokenMs, s.hold || 0) - (Date.now() - started);
    if (left > 0) await page.waitForTimeout(left);
  }
  await page.waitForTimeout(600);

  const video = page.video();
  await context.close();
  const webm = await video.path();
  await browser.close();

  const base = path.join(outDir, `${name}-${viewport.name}`);
  const out = `${base}.mp4`;
  const args = ["-y", "-loglevel", "error", "-i", webm];
  const spoken = segments.filter((s) => clips[s.id]);
  const even = "scale=trunc(iw/2)*2:trunc(ih/2)*2"; // yuv420p needs even dimensions
  if (spoken.length > 0) {
    for (const s of spoken) args.push("-i", clips[s.id].file);
    const delays = spoken.map(
      (s, i) => `[${i + 1}:a]adelay=${Math.round(starts[s.id] * 1000 + LEAD_IN)}:all=1[a${i}]`,
    );
    const mix = `${spoken.map((_, i) => `[a${i}]`).join("")}amix=inputs=${spoken.length}:normalize=0[aout]`;
    args.push("-filter_complex", `[0:v]${even}[v];${delays.join(";")};${mix}`, "-map", "[v]", "-map", "[aout]");
    args.push("-c:a", "aac", "-b:a", "160k");
  } else {
    args.push("-vf", even);
  }
  args.push("-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", "-movflags", "+faststart", out);
  execFileSync("ffmpeg", args);

  if (spoken.length > 0) {
    const cues = cuesFor(spoken, starts);
    fs.writeFileSync(
      `${base}.srt`,
      cues.map((c, i) => `${i + 1}\n${stamp(c.from, ",")} --> ${stamp(c.to, ",")}\n${c.text}\n`).join("\n"),
    );
    fs.writeFileSync(
      `${base}.vtt`,
      `WEBVTT\n\n${cues.map((c) => `${stamp(c.from, ".")} --> ${stamp(c.to, ".")}\n${c.text}\n`).join("\n")}`,
    );
  }

  const seconds = probeSeconds(out);
  // Contact sheet so the result can be reviewed without playing the video.
  const sheet = `${base}-sheet.png`;
  const every = Math.max(1, seconds / 12);
  execFileSync("ffmpeg", [
    "-y", "-loglevel", "error", "-i", out,
    "-vf", `fps=1/${every.toFixed(2)},scale=${mobile ? 200 : 426}:-1,tile=${mobile ? "6x2" : "4x3"}`,
    "-frames:v", "1", sheet,
  ]);
  return { viewport: viewport.name, out, sheet, seconds: Number(seconds.toFixed(1)), narrated: spoken.length > 0 };
}

(async () => {
  const results = [];
  for (const viewport of viewports) {
    results.push(await record(viewport));
  }
  const limit = tour.maxSeconds || 120;
  for (const r of results) {
    const over = r.seconds > limit ? `  (over the ${limit}s limit)` : "";
    console.log(`${r.viewport}: ${r.out}  ${r.seconds}s  narrated=${r.narrated}${over}`);
    console.log(`  review sheet: ${r.sheet}${r.narrated ? "  (+ .srt and .vtt subtitles)" : ""}`);
  }
  if (results.some((r) => r.seconds > limit)) process.exitCode = 3;
})().catch((error) => {
  console.error(`record-demo: failed: ${String(error.message).split("\n").slice(0, 6).join(" | ")}`);
  process.exit(1);
});
