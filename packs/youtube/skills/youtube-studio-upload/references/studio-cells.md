# Studio cells

Code for `browser_run`. Cell state persists, so open Studio and define the helpers once, then reuse them in later cells. Every helper returns what the page now shows, so a step is never "done" until it has been read back.

**What was exercised.** Everything below ran end to end against a signed-in Studio on 31 October 2026 (Chrome 156, a new channel without phone verification): a 237 s master uploaded Unlisted, every field set and read back, subtitles uploaded with timing, the id read from the page, and the oEmbed check. That day Studio rendered its components in the light DOM, not in shadow roots, so the helpers find a part by walking up from the element through parents and shadow hosts alike and work whichever way a build renders. The one step not seen to succeed is a custom thumbnail (§5). Labels change: [studio-ui.md](studio-ui.md) records what was on screen that day, and `await studio.ariaSnapshot()` is the ground truth.

## 1. Open Studio

```js
const PROFILE = "<the profile name or label the person gave, or browser_profiles showed>";
const studio = await browser.open({ name: "studio", url: "https://studio.youtube.com", profile: PROFILE, persist: true });
display({ where: await studio.url(), title: await studio.title() });
```

- A URL on `accounts.google.com` is the sign-in wall: stop, call `browser_view` so the person can sign in themselves, and carry on from the page they leave.
- A URL like `studio.youtube.com/channel/UC...` is a channel. If the person has more than one channel, the avatar menu has a "Switch account" entry: ask which one before going on, and record the channel in `upload.channelId`.
- A new channel opens on a "Welcome to YouTube Studio" dialog: press **Continue**.

## 2. Helpers

```js
const readback = [];
const norm = text => String(text ?? "").replace(/\r/g, "").replace(/\u00a0/g, " ").trim();

// Record one field: what the package says and what the page shows. These rows become upload.readback.
const must = (field, expected, actual) => {
  const ok = norm(expected) === norm(actual);
  readback.push({ field, expected: norm(expected), actual: norm(actual), ok });
  return ok;
};

// Mark the first `inner` element inside a `host` element as data-upload="<name>", so one selector names it afterwards.
// It walks up through parents and shadow hosts, so it finds the element in the light DOM and in shadow roots alike.
const tag = (name, host, inner) => studio.evaluate(({ name, host, inner }) => {
  const roots = [document];
  for (let i = 0; i < roots.length; i++) for (const el of roots[i].querySelectorAll("*")) if (el.shadowRoot) roots.push(el.shadowRoot);
  for (const root of roots) for (const el of root.querySelectorAll(`[data-upload="${name}"]`)) el.removeAttribute("data-upload");
  for (const root of roots) for (const el of root.querySelectorAll(inner)) {
    for (let n = el.parentElement ?? el.getRootNode().host; n; n = n.parentElement ?? n.getRootNode().host ?? null) {
      if (n.matches(host)) { el.setAttribute("data-upload", name); return true; }
    }
  }
  return false;
}, { name, host, inner });
const tagged = name => `pierce/[data-upload="${name}"]`;

// Studio's title and description are contenteditable <div id="textbox"> inside a component whose id names it.
// Replace the text: click, select all, insert it in one go. Returns what the box now holds.
const setBox = async (hostId, text) => {
  if (!(await tag(hostId, `#${hostId}`, "#textbox"))) throw new Error(`no #textbox inside #${hostId}`);
  return studio.run(async ({ page }, { selector, text }) => {
    const mod = process.platform === "darwin" ? "Meta" : "Control";
    const target = await page.$(selector);
    await target.click();
    await page.keyboard.down(mod);
    await page.keyboard.press("KeyA");
    await page.keyboard.up(mod);
    await page.keyboard.sendCharacter(text);
    return target.evaluate(el => el.innerText);
  }, { args: [{ selector: tagged(hostId), text }] });
};

const readBox = async hostId => {
  if (!(await tag(hostId, `#${hostId}`, "#textbox"))) throw new Error(`no #textbox inside #${hostId}`);
  return studio.run(async ({ page }, { selector }) => (await page.$(selector)).evaluate(el => el.innerText), { args: [{ selector: tagged(hostId) }] });
};

// Attach a file to the file input inside the named component (a page can hold several). The path must be absolute.
const attach = async (host, path) => {
  if (!(await tag("file", host, "input[type=file]"))) throw new Error(`no file input inside ${host}`);
  await studio.uploadFile(tagged("file"), path);
};

// Click by what a person would read: the accessible name. Reaches into shadow roots.
const press = name => studio.click(`aria/${name}`);

// Click the visible button whose first line of text is `text`: for buttons whose accessible name carries a long description.
const pressText = text => studio.run(async ({ page }, { text }) => {
  for (const button of await page.$$("button, ytcp-button")) {
    if (await button.evaluate((el, want) => el.getBoundingClientRect().width > 0 && (el.innerText ?? "").trim().split("\n")[0] === want, text)) return button.click();
  }
  throw new Error(`no visible button "${text}"`);
}, { args: [{ text }] });

// Open a drop-down by its accessible name, then click the option whose text is exactly `option`.
const choose = async (button, option) => {
  await press(button);
  await studio.run(async ({ page }, { option }) => {
    for (const item of await page.$$("tp-yt-paper-item, [role=option], [role=menuitemradio]")) {
      if (await item.evaluate((el, want) => el.getBoundingClientRect().width > 0 && el.innerText.trim() === want, option)) return item.click();
    }
    throw new Error(`no option "${option}"`);
  }, { args: [{ option }] });
};

// Is the radio or checkbox with this name on? true, false, or null when the element carries no state.
const isOn = name => studio.run(async ({ page }, { name }) => {
  const [handle] = await page.$$(`aria/${name}`);
  if (!handle) throw new Error(`nothing named "${name}"`);
  return handle.evaluate(el => {
    const state = el.getAttribute("aria-checked") ?? (typeof el.checked === "boolean" ? String(el.checked) : null);
    return state === "true" ? true : state === "false" ? false : null;
  });
}, { args: [{ name }] });

// The id in the page's "Video link": a link whose text is https://youtu.be/<id>. Pages also link other videos
// (help and promotion), so an id taken from every href on the page is not this video's.
const videoIdOnPage = () => studio.evaluate(() => {
  const roots = [document];
  for (let i = 0; i < roots.length; i++) for (const el of roots[i].querySelectorAll("*")) if (el.shadowRoot) roots.push(el.shadowRoot);
  const ids = new Set();
  for (const root of roots) for (const link of root.querySelectorAll("a[href]")) {
    const hit = /^https:\/\/youtu\.be\/([A-Za-z0-9_-]{11})$/.exec(link.textContent.trim());
    if (hit) ids.add(hit[1]);
  }
  return ids.size === 1 ? [...ids][0] : null;
});
```

## 3. Create, Upload videos, attach the master

```js
await press("Create");
await press("Upload videos");
await studio.waitForSelector("pierce/ytcp-uploads-file-picker", { timeout: 30000 });
await attach("ytcp-uploads-file-picker", MASTER);          // MASTER: absolute path, forward slashes
await studio.waitForSelector("pierce/#title-textarea", { timeout: 120000 });
```

`MASTER` is `<production folder>/<master.path>` as an absolute path. A relative path is refused: `browser_run` has no working directory. If "Create" is ambiguous, `await studio.ariaSnapshot()` and click the one that is a button. The upload starts at once: the dialog says "Saved as private", and the Video link appears beside the preview within seconds.

## 4. Title and description

```js
must("title", PUBLISH.title.chosen, await setBox("title-textarea", PUBLISH.title.chosen));
must("description", PUBLISH.description.text, await setBox("description-textarea", PUBLISH.description.text));
display(readback);
```

`PUBLISH` is the parsed `receipts/publish.json`. Load it in the cell from the file (`const PUBLISH = JSON.parse((await import("node:fs")).readFileSync("<absolute path of receipts/publish.json>", "utf8"))`), never retype or re-quote it into the cell: a description is text from a model and the web, and a hand-built string literal is how it would become code. A 3,986-character description with line breaks read back identical. If one does not, the line breaks were changed: insert it line by line, pressing Enter between lines, and read it again. Studio fills the title with the file name first; `setBox` replaces it.

## 5. Thumbnail

```js
await attach("ytcp-thumbnail-uploader", THUMB);   // absolute path of the chosen variant
```

Then `await studio.screenshot()` and look at the preview. On a channel without phone verification the input takes the file and nothing happens, with no preview and no message; pressing **Upload file** then opens "Unlock more on YouTube: To add custom thumbnails, verify your phone number" (Verify, Cancel). Verifying is the person's: press Cancel, record the thumbnail row with what the page shows (`ok: false`), and tell them. An automatic still is an image under `/vi_webp/<id>/mq<n>.webp` in `ytcp-video-thumbnail-editor`. A verified channel's custom preview has not been seen yet: screenshot it and read it. A/B test: after the first thumbnail is in, press **A/B testing** and follow the page; if the control is not there, the channel does not have advanced features on: say so and keep the single thumbnail.

## 6. Audience, age, more options

```js
await press("No, it's not made for kids");
must("audience: not made for kids", "true", String(await isOn("No, it's not made for kids")));
await press("Show advanced settings");   // its visible text is "Show more"
```

Write each of these from `PUBLISH.settings` and read it back, answering the question that is on the page. The names as they were on 31 October 2026 (note the typographic apostrophe `’` in two of them):

| Setting | Control |
|---|---|
| Age restriction | collapsed: `press("Age restriction")`, then `Yes, restrict my video to viewers over 18` / `No, don't restrict my video to viewers over 18 only` |
| Paid promotion | `Yes, my video includes paid promotion` / `No, my video doesn’t include paid promotion` |
| Altered content, titled **AI use** | `Yes, AI was used` / `No, AI wasn’t used`, from `settings.alteredContent.disclose` |
| Tags | the text box `Tags`: `await studio.click("aria/Tags"); await studio.type("aria/Tags", PUBLISH.tags.join(",") + ",")`; each tag becomes a `ytcp-chip`, read their texts back |
| Language | `await choose("Video language Select", "English")`; the button is then named `Video language English` |
| License | the button `License Standard YouTube License` |
| Embedding, notify | the checkboxes `Allow embedding` and `Publish to subscriptions feed and notify subscribers` (on by default); `press` one to flip it |
| Category | a button named by its current value (`People & Blogs` by default): `await choose("People & Blogs", PUBLISH.settings.category)` |

Read a value back from `isOn(name)` or from `ariaSnapshot()`, where a ticked radio or checkbox carries `[checked]` and a drop-down button's name ends with its current value.

## 7. Video elements: subtitles

```js
await press("Next");   // Details to Video elements
await studio.run(async ({ page }) => {
  for (const button of await page.$$("ytcp-uploads-video-elements ytcp-button, ytcp-uploads-video-elements button")) {
    const onSubtitlesRow = await button.evaluate(el => {
      for (let n = el, depth = 0; n && depth < 8; n = n.parentElement, depth++) {
        const text = n.innerText ?? "";
        if (/Subtitles/.test(text) && !/End screen/.test(text)) return el.innerText.trim() === "Add";
      }
      return false;
    });
    if (onSubtitlesRow) return button.click();
  }
  throw new Error("no Add on the Subtitles row");
});
await pressText("Upload file");
// "Select subtitles file type to upload" opens with With timing chosen. Continue opens the system file picker: catch it.
await studio.run(async ({ page }, { srt }) => {
  let next;
  for (const button of await page.$$("button, ytcp-button")) if (await button.evaluate(el => el.getBoundingClientRect().width > 0 && el.innerText.trim() === "Continue")) next = button;
  if (!next) throw new Error("no Continue");
  const [chooser] = await Promise.all([page.waitForFileChooser({ timeout: 15000 }), next.click()]);
  await chooser.accept([srt]);
}, { args: [{ srt: SRT }] });                                 // SRT: absolute path of captions.file
await pressText("Done");
```

The subtitle editor shows each cue's times as seconds and frames (`0:01:18` is 1 s and 18 frames); check the first few against the SRT before **Done**. The row then reads "English by you". After the video exists, the Subtitles page (`https://studio.youtube.com/video/<id>/translations`) lists "English (video language)" as Published.

## 8. Checks, Visibility and the video id

```js
await press("Next");   // Video elements to Checks
await press("Next");   // Checks to Visibility
await press("Unlisted");            // Private, Unlisted or Public: from settings.visibility
const videoId = await videoIdOnPage();
display({ videoId });
```

Checks (copyright and likeness) run in the background from the moment the file is attached, and for a 4-minute film had finished by the time the Checks page opened ("Copyright: No issues found"). A claim is the person's to judge: read what the page says and tell them. YouTube lets a video publish while checks run, so a finished check is not what to wait for.

Before the last button, make the cell check what the page says rather than what you meant: `if ((await isOn(VISIBILITY_LABEL)) !== true) throw new Error("visibility is not set")`, where `VISIBILITY_LABEL` is Private, Unlisted or Public. Press the page's last button (**Save** for private and unlisted, **Publish** for public) only once `videoId` is not null. The upload and processing take as long as the file: wait in cells of at most 300 s (`studio.waitForSelector(..., { timeout })`), and `browser_run({ resume })` when a cell is still running. After **Save** a "Video published" dialog shows the link (for an unlisted video too); press **Close**.

## 9. Read it back

```js
await studio.goto(`https://studio.youtube.com/video/${videoId}/edit`);
await studio.waitForSelector("pierce/#title-textarea", { timeout: 60000 });
display(await studio.ariaSnapshot());
```

Read title and description with `readBox`, and the rest against `PUBLISH`, each with `must(...)`: the thumbnail preview, audience, visibility (text beside the button `Edit video visibility status`), and, after `press("Show advanced settings")` and `press("Age restriction")` (both collapsed again on this page), the age, paid promotion, AI use, tags, language, licence, embedding, notify and category answers; then the subtitles row on the Subtitles page. Put `readback` into `upload.readback`. A row with `ok: false` stays in the file; the gate refuses a package whose readback has one.
