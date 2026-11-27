---
name: demo-video
description: Records a short narrated demo video of a running web app by driving it with Playwright, in both a desktop and a mobile viewport. Use when the user asks for a demo video, product tour, walkthrough recording or screen recording of a web app to show to someone. Not for automated tests (playwright-suite) or one-off screenshots (playwright-cli).
---

# Demo video

Produces one MP4 per viewport (desktop 1280x720 and mobile 390x844 by default) of a scripted
walkthrough, with an optional spoken narration timed to the screens. The recorder is
`scripts/record-demo.cjs` in this skill's folder; you write only a small tour file per app.

## Before recording

1. **The app must be running** and reachable; ask for the URL if it is not obvious. Record against
   demo or seed data, never real customer data: everything on screen ends up in the video.
2. **Decide with the user, in one question at most:** who the video is for, the language, the
   length (default: under 2 minutes), and narration (voice, on-screen captions, or both).
3. **Find how to log in and what the main flows are** by reading the app's routes, tests or
   README. Reuse the selectors an existing Playwright suite already uses.
4. **Keep the tour read-only** (log in, navigate, open things) unless the user asks to show an
   action. If the tour changes data, say so and say how to restore it.
5. Requirements: Playwright installed in some project on disk (`--project`), `ffmpeg` and
   `ffprobe` on PATH, and macOS `say` for the voice. List the installed voices for the language
   with `say -v '?'` and pick one that matches the audience's variant.

## Write the tour file

Keep it outside the product repo unless the user wants it committed (a temp folder is fine).

```js
// tour.cjs
module.exports = {
  name: "myapp-tour",            // output files: myapp-tour-desktop.mp4, myapp-tour-mobile.mp4
  baseURL: "http://localhost:3000",
  outDir: "/path/the/user/can/open",
  locale: "en-US",               // browser locale, e.g. "es-ES"
  voice: "Samantha",             // a `say` voice in the narration language; null = no spoken narration
  rate: 175,                     // words per minute
  captions: false,               // true = burn each segment's text into the page as a caption
  maxSeconds: 120,               // the recorder exits 3 when a video is longer
  cursor: true,                  // visible pointer (touch dot on mobile) and a ring on every click
  intro: { title: "MyApp", subtitle: "What it is in one line", say: "Hi, Jesse." },  // title card
  outro: { title: "Thanks", subtitle: "myapp.example" },                             // end card
  // tts: { command: ["python3", "/path/tts.py", "--text", "{text}", "--out", "{out}"] },  // other voice engine (WAV)
  // viewports: [{ name: "desktop", width: 1280, height: 720 }, { name: "mobile", width: 390, height: 844, mobile: true }],
  segments: [
    {
      id: "intro",
      say: "Hi, Jesse. This is MyApp.",
      run: async (page, h) => { await page.goto("/login"); },
    },
    {
      id: "login",
      say: "Each family signs in with its own account.",
      run: async (page, h) => {
        await h.type(page.getByLabel("Email"), "demo@example.test");
        await h.type(page.getByLabel("Password"), process.env.DEMO_PASSWORD);
        await page.getByRole("button", { name: "Sign in" }).click();
        await page.waitForURL("**/home");
        await h.scroll(600);
      },
    },
  ],
};
```

Each segment runs its `run(page, h)` steps and then holds until its narration has finished, so the
voice and the screen stay in step without manual timing. Helpers in `h`:

| Helper | Use |
| --- | --- |
| `click(locator)` | Glides the pointer to the element, pauses, clicks. Prefer it to `locator.click()` so the viewer sees where the click goes. |
| `type(locator, text)` | Types at human speed. |
| `scroll(px)` | Smooth scroll; negative goes up. |
| `highlight(locator, ms)` | Glow around an element without clicking it. |
| `zoom(locator, scale)` / `zoomOut()` | Zooms the page towards an element and back. Use once or twice per video, on the thing that matters. |
| `caption(text)` | On-screen caption until the next navigation. |
| `wait(ms)`, `isMobile`, `viewport`, `context` | Pauses and branching; `h.context.clearCookies()` switches accounts. |

Per viewport the recorder writes `<name>-<viewport>.mp4`, `.srt` and `.vtt` subtitles (one cue per
sentence, from the real timings) and `<name>-<viewport>-sheet.png`.

The default voice is macOS `say`: offline, robotic. For a more natural voice set `tts.command` to
any program that writes a WAV for `{text}` to `{out}`. Kokoro (Apache-2.0, runs locally after one
model download of about 120 MB for the int8 ONNX files, Spanish voices `ef_dora`, `em_alex`, `em_santa`) is the
usual choice; it needs a Python or Node package installed first, so ask before installing it. Do
not use engines that send the text to an online service unless the user agrees.

Rules for a tour that works in both viewports:
- Select by role, label or text, never by layout. If the mobile layout hides navigation behind a
  menu, navigate with `page.goto(path)` or branch on `h.isMobile`.
- One idea per segment, one or two short sentences. Write the narration for the listener: say
  what they are seeing and why it matters, in their language, and name them if it is personal.
- Wait for the result of every action (`waitForURL`, a locator) before moving on; a `goto` right
  after a click can cancel the request the click started.
- Do not put secrets in the tour file; read them from the environment.

## Record

```bash
node <this skill>/scripts/record-demo.cjs --tour tour.cjs --project <dir with playwright>
# one viewport only:  --only desktop   |   --only mobile
```

It prints each output file with its duration and a contact sheet (`*-sheet.png`, twelve frames).

## Check before handing it over

- Read both contact sheets: every segment shows the intended screen, nothing is a login wall,
  an error page or a blank frame, and the mobile frames are not a squeezed desktop layout.
- Duration within the limit (exit code 3 means too long: shorten the narration, not the pauses).
- You cannot hear the audio. Verify that the track exists and is not silent
  (`ffmpeg -i out.mp4 -af volumedetect -vn -f null -`), and tell the user plainly that
  pronunciation and pacing are theirs to judge; product and personal names are the usual problem.
- Report the file paths, the durations, what the tour shows, and whether it changed any data.

## Limits

- Narration uses the operating system's voices: fine for an informal demo, not studio quality.
- The video is a headless Chromium recording: no browser chrome; the pointer is an overlay drawn
  by the recorder, and the zoom is a CSS transform, so pages with fixed headers can look odd
  while zoomed.
- No music, no automatic trimming of waits, no camera motion blur. Tools that do those
  (shreyaskarnik/argo, vijaykumargowdakk/showpilot) need a heavier toolchain.
- Videos are large binaries: do not commit them to the repo unless the user asks.
