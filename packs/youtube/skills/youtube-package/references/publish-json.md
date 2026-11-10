# receipts/publish.json

The one file the three publish skills share. `youtube-package` writes it, `youtube-thumbnail` fills `thumbnail.variants`, `youtube-studio-upload` reads it and appends `upload`. `scripts/publish-check.mjs check` is its schema: every rule below is a finding there, so the script is the truth when this page and it disagree.

Path: `<production>/receipts/publish.json`. The production id is the folder name, and `production` in the file must equal it. All other paths are production-relative (`renders/...`, `receipts/...`): no `..`, no drive, no backslash.

## Who writes what

| Key | Written by | Notes |
|---|---|---|
| `version`, `production`, `createdAt` | package | `version` is `1` |
| `master` | package | the final render this package is for; copy from the `render` result and its `-final` receipt |
| `title` | package | at least 3 scored options; `chosen` is one of them, word for word |
| `thumbnail.brief` | package | what the image says and shows |
| `thumbnail.variants`, `chosen`, `abTest` | thumbnail | filled after the stills pass the phone sheet; one variant is a complete package; `abTest` is present only when the person chose to run a test |
| `description` | package | `text` is exactly what gets pasted; `chapters` mirrors its chapter lines |
| `tags` | package | may be `[]` |
| `captions` | package | the SRT to upload, or `{ "file": null, "reason": "..." }` |
| `settings` | package | visibility, audience, category, language, license, the altered-content decision |
| `endScreen`, `shorts` | package | optional |
| `upload` | studio-upload | `videoId`, `url`, `visibility`, `readback[]`; absent until something was uploaded |

## Shape

```jsonc
{
  "version": 1,
  "production": "dimension-video-space-film",
  "createdAt": "2026-10-30T12:30:00.000Z",

  "master": {
    "path": "renders/final-ab12cd34.mp4",
    "durationSeconds": 240,                      // from the render result; chapters are checked against it
    "editRevision": "ab12cd34...",               // the render receipt's editRevision
    "renderReceipt": "receipts/render-20261030T120000-ab12cd34-final.json",
    "sha256": "..."                              // the receipt's output.sha256, when it has one
  },

  "title": {
    "chosen": "The Video Editor That Can't Insert B-roll Without Your Yes",
    "options": [
      {
        "text": "...", "chars": 58, "pattern": "contrast",
        "scores": { "accuracy": 5, "clarity": 4, "curiosity": 4, "search": 4, "length": 4, "risk": 5 },
        "total": 26                               // the six scores added; ship at 22 or more, accuracy and risk 4 or more
      }
    ]
  },

  "thumbnail": {
    "brief": { "concept": "...", "focalSubject": "the words", "text": "CUT IS DATA", "palette": ["#ffdd33", "#0b0b10"], "emotion": "confident" },
    "variants": [                                  // one variant is a valid package (id "a"); a thumbnail test needs 2 or 3, and 3 is recommended
      { "id": "a", "role": "subject-led", "path": "renders/thumbnails/<production>-a.png", "format": "png", "width": 1280, "height": 720, "bytes": 162196, "sha256": "...", "phoneCheck": true, "composition": "media/motion/thumb-a" }
    ],
    "chosen": "b",                                // the id of the variant to upload as the thumbnail
    "abTest": { "run": true, "target": "thumbnail", "order": ["b", "a", "c"] }  // omit for a plain upload; target: thumbnail | title | title-and-thumbnail; with a title test add "titles": [chosen title, then 1 or 2 other scored options]
  },

  "description": {
    "primaryKeyword": "video editor",
    "text": "...the whole description, hook first, chapters as one block, sources, credits, hashtags last...",
    "chapters": [ { "seconds": 0, "timestamp": "00:00", "title": "Cold open" } ],
    "sources": [ { "label": "The cut is data", "url": "https://example.com/the-cut-is-data", "kind": "claim", "ref": "receipts/claims.json#0" } ],
    "hashtags": ["#VideoEditing", "#AIAgents", "#Dimension"]
  },

  "tags": ["video editor", "ai video editing"],

  "captions": { "file": "renders/captions-en.srt", "language": "en", "source": "export_edl srt", "reviewed": true },

  "settings": {
    "visibility": "public",                       // public | unlisted | private | scheduled (+ scheduledAt)
    "madeForKids": false,
    "ageRestricted": false,
    "category": "Science & Technology",           // Studio's own names
    "language": "en",
    "license": "standard",                        // cc-by only when every asset is owned or cc0
    "playlist": null,                             // an existing playlist's exact title, or null
    "allowEmbedding": true,
    "notifySubscribers": false,
    "paidPromotion": false,
    "alteredContent": {
      "disclose": true,                           // the answer to Studio's AI use question (Attributes)
      "assessedAt": "2026-10-30T12:25:00.000Z",
      "assets": [
        { "id": "music-bed", "verdict": "disclose", "category": "ai-music", "reason": "..." },
        { "id": "vo-main", "verdict": "no-disclosure", "category": "own-voice-clone", "confirmedByPerson": true, "reason": "..." }
      ]
    }
  },

  "endScreen": { "enabled": true, "note": "last 20 s: subscribe and the latest video" },
  "shorts": [ { "title": "A cut is a file", "fromSeconds": 20, "toSeconds": 70, "hook": "The cut is a file.", "hashtags": ["#VideoEditing"] } ],

  "upload": {                                      // written by youtube-studio-upload
    "videoId": "abcdefghijk", "url": "https://youtu.be/abcdefghijk", "visibility": "public", "uploadedAt": "...",
    "profile": "the saved browser profile the person chose",
    "readback": [ { "field": "title", "expected": "...", "actual": "...", "ok": true } ],
    "oembed": { "status": 200, "title": "..." }
  }
}
```

## Closed vocabularies

`pattern` is free text (see [title-and-description.md](title-and-description.md) for the usual ones). `variants[].id` is `a`, `b` or `c`; a package with one thumbnail uses `a`. `alteredContent.assets[].verdict` is `disclose` or `no-disclosure`, and `category` takes one of:

| verdict | categories |
|---|---|
| `disclose` | `real-person-says-or-does`, `altered-real-footage`, `realistic-scene-did-not-occur`, `ai-music`, `voice-of-someone-else` |
| `no-disclosure` | `not-realistic`, `minor-edit`, `own-voice-clone`, `production-assistance`, `unaltered-real` |

`own-voice-clone` needs `confirmedByPerson: true`, which you set only after the person said the voice is their own. Every asset record in `media/` whose license is `generated`, `commentary` or `unknown` needs an entry; the gate names the ones that do not have one.

## Stages

`check --stage package` skips the thumbnail variants (the thumbnail skill has not run yet); everything else is enforced. `check` (the default stage, `upload`) refuses a package with no measured variant, and it re-reads every file it names: a thumbnail whose bytes or hash changed since it was measured, a master that no longer matches its render receipt, and a caption file that runs past the end of the film are findings. The variant count belongs to the A/B test and not to every package: one variant with no `thumbnail.abTest` (or `abTest.run: false`) is clean, with no error and no warning. When `abTest.run` is true and its target is `thumbnail` or `title-and-thumbnail`, the gate asks for 2 or 3 variants (2 draws a warning, since 3 is the recommended number for a test). A `title` test has its own rule on titles and asks nothing of the thumbnails.

## What the gate does not decide

It cannot tell whether a title overpromises, a thumbnail misleads, or a generated clip looks real. Those are the person's and your judgement; the gate only makes sure the judgement was recorded and the numbers around it are right.
