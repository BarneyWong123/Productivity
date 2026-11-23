# CullCraft

AI photo culling and editing for photographers, running entirely in your browser. Photos never leave your computer.

## What it does

- **Culls a shoot automatically.** Every frame is scored on focus (measured on the eyes when there are faces), blinks, expression, exposure and overall composition. Bursts and near-identical shots are grouped into stacks, the strongest frame of each stack becomes a **Pick**, the rest become **Duplicates**, and technically broken frames become **Rejects**, each with the reason.
- **Reads RAW.** Sony ARW, Nikon NEF, Canon CR2, Adobe DNG, Pentax PEF and more, via the full-size preview embedded in the RAW file. RAW+JPEG pairs are collapsed to the RAW.
- **Fast review.** Keyboard-driven grid and full-screen viewer, side-by-side compare with the best of the stack, face/eye overlay, and score breakdown.
- **Learns your culling taste.** Every pick/reject you override is recorded; a small logistic-regression model re-weights focus, composition, eyes, exposure and expression to match your decisions (kept in your browser, grows with every shoot).
- **Learns your editing style.** Edit a few photos by hand; CullCraft records how your edits differ from its own auto-correction and applies that look to every pick.
- **Exports to Lightroom.** `.xmp` sidecars with star ratings, colour labels (green pick, yellow duplicate, red reject) and develop settings, a ZIP of your picks, and a CSV report.

## Culling like a pro

- **Shoot types**: Wedding & portrait, Events, Sports & action, Landscape & travel. Each weighs focus, eyes, people, expression, exposure and composition differently.
- **Eye focus first**: focus is measured on the eyes, averaged over every main face (a group shot with one soft face isn't "sharp"). Frames where the background is sharp but the eyes aren't are flagged "Focus missed the eyes".
- **More people is better**: within a moment, the frame with the most people present and eyes open wins.
- **Protect emotional moments**: a slightly soft frame of someone laughing or crying is kept, not rejected.
- **Scenes and Highlights**: the shoot is split into scenes at long time gaps (ceremony, portraits, reception), and the top ~5% of picks (at least one per scene) are marked as Highlights.
- **Key Faces**: full-resolution crops of every face in the inspector; click one to check focus at 100%.
- **Survey view (S)**: every frame of a moment side by side.
- **Lightroom-style filters**: combine flags, rating, edited, number of people, who decided, problem type, and sort by time/score/rating/name.
- **Multi-select**: Shift/⌘-click or ⌘A, then pick/reject/rate/apply a look/paste edits to all of them.
- **Autosave**: every flag, rating and edit is saved in your browser as you go and restored when you reopen the same photos.
- **Looks**: Natural, Bright & airy, Dark & moody, Warm film, Vivid, Classic B&W, applied on top of per-photo correction; copy/paste settings with ⌘C/⌘V.

## Measured accuracy

Tested with the app's own analysis code on public labelled datasets:

| Test | Data | Result (default strictness) |
| --- | --- | --- |
| Blink detection | 400 held-out face photos, 200 eyes open / 200 closed ([closed-open-eyes](https://huggingface.co/datasets/MichalMlodawski/closed-open-eyes), AI-generated faces) | 197/200 closed caught, **0/200 open wrongly flagged** (99.3%) |
| Picking the sharp frame | 174 **real** photo pairs, each a sharp shot and the same scene with real camera shake ([RealBlur-J](https://huggingface.co/datasets/rimchang/RealBlur), CC BY 4.0), culled as one shoot | sharp frame picked in **157/174** stacks, **1/174** sharp photos wrongly rejected, 83/174 shaken frames rejected |
| Face focus | 60 faces × sharp / slightly soft / blurred, culled as one shoot | sharp picked **60/60**, blurred rejected 60/60, no sharp face rejected |

The real-photo test found and fixed two problems: night and low-light frames were being rejected as "underexposed", and the sharpness score couldn't tell a sharp frame from a nearly sharp one within a burst.

## Run it

Hosted: deployed on Vercel (see the deployment URL). Or locally:

It needs to be served over http (browsers block modules from `file://`). From this folder:

```bash
python3 -m http.server 8000
```

Then open <http://localhost:8000> in Chrome or Edge (best: also lets CullCraft write sidecars straight into your shoot folder). Firefox and Safari work too.

The first shoot you open downloads the AI models (~95 MB) once; after that they're cached by the browser.

## AI models

| Job | Model | Source |
| --- | --- | --- |
| Faces, eye open/closed, smile | MediaPipe Face Landmarker (blendshapes) | Google, Apache 2.0 |
| Composition / appeal, scene similarity | CLIP ViT-B/32 (zero-shot, quantised) | OpenAI weights via Xenova/transformers.js |
| Focus, exposure, duplicates | Measured directly (Laplacian, histogram, perceptual hash) | — |

Neither model was trained specifically to cull photos. Their outputs are combined with weights that start from sensible defaults (`cull.js`) and are re-learned from your own decisions (`learn.js`).

## Keyboard

| Key | Action |
| --- | --- |
| ← → ↑ ↓ | Move |
| P / X / D | Pick / Reject / Duplicate (press again to return to the AI's decision) |
| U | Clear your flag and rating |
| 1–5, 0 | Star rating |
| Enter / Space | Open or close the viewer |
| S | Survey: all frames of the moment |
| Z / click photo | 100% zoom from the original file |
| Shift+F / double-click | Full screen |
| ⌘C / ⌘V | Copy / paste edit settings |
| ⌘A, Shift-click, ⌘-click | Multi-select |
| C | Compare with the best of the stack |
| F | Show face and eye boxes |
| E | Edit panel |
| A | Auto-correct |
| \ (hold) | Show the original |
| Esc | Back to grid |

## Lightroom workflow

1. Export → **Write sidecars into shoot folder** (Chrome/Edge), or **Lightroom sidecars only** and copy the `.xmp` files next to your originals.
2. In Lightroom Classic select the photos → **Metadata → Read Metadata from Files**.
3. Filter by colour label or rating.

## Files

`app.js` UI · `analyze.js` pixel metrics and faces · `ai.js` CLIP · `cull.js` scoring and stacks · `edit.js` editing and style learning · `export.js` XMP/ZIP/CSV · `raw.js` RAW previews · `sample.js` demo shoot · `learn.js` taste learning · `persist.js` autosave
