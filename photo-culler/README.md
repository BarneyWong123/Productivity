# CullCraft

AI photo culling and editing for photographers, running entirely in your browser. Photos never leave your computer.

## What it does

- **Culls a shoot automatically.** Every frame is scored on focus (measured on the eyes when there are faces), blinks, expression, exposure and overall composition. Bursts and near-identical shots are grouped into stacks, the strongest frame of each stack becomes a **Pick**, the rest become **Duplicates**, and technically broken frames become **Rejects**, each with the reason.
- **Reads RAW.** Sony ARW, Nikon NEF, Canon CR2, Adobe DNG, Pentax PEF and more, via the full-size preview embedded in the RAW file. RAW+JPEG pairs are collapsed to the RAW.
- **Fast review.** Keyboard-driven grid and full-screen viewer, side-by-side compare with the best of the stack, face/eye overlay, and score breakdown.
- **Learns your culling taste.** Every pick/reject you override is recorded; a small logistic-regression model re-weights focus, composition, eyes, exposure and expression to match your decisions (kept in your browser, grows with every shoot).
- **Optional AI review of close calls.** For stacks where the top frames score within a few points, a vision LLM (any OpenRouter model, your own key) picks the winner and explains why. Only those contenders are sent, as 512px previews.
- **Learns your editing style.** Edit a few photos by hand; CullCraft records how your edits differ from its own auto-correction and applies that look to every pick.
- **Exports to Lightroom.** `.xmp` sidecars with star ratings, colour labels (green pick, yellow duplicate, red reject) and develop settings, a ZIP of your picks, and a CSV report.

## Run it

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

Neither model was trained specifically to cull photos. Their outputs are combined with weights that start from sensible defaults (`cull.js`) and are re-learned from your own decisions (`learn.js`). The optional close-call reviewer (`review.js`) uses a general vision LLM via OpenRouter.

## Keyboard

| Key | Action |
| --- | --- |
| ← → ↑ ↓ | Move |
| P / X / D | Pick / Reject / Duplicate (press again to return to the AI's decision) |
| U | Clear your flag and rating |
| 1–5, 0 | Star rating |
| Enter / Space | Open or close the viewer |
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

`app.js` UI · `analyze.js` pixel metrics and faces · `ai.js` CLIP · `cull.js` scoring and stacks · `edit.js` editing and style learning · `export.js` XMP/ZIP/CSV · `raw.js` RAW previews · `sample.js` demo shoot · `learn.js` taste learning · `review.js` OpenRouter close-call review
