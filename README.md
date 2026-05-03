# Transform Directus Images on Upload

A Directus hook extension that automatically re-encodes and resizes images the moment they are uploaded — saving disk space and bandwidth without requiring any change to your Directus collections, app code, or upload flow.

When a file is uploaded through any Directus interface (Admin app, REST/GraphQL API, SDK, etc.), the hook intercepts it, converts it to a configurable target format (default: AVIF), optionally shrinks oversized images down to a maximum dimension, and replaces the stored file in place.

## How it works

The extension listens for the `files.upload` action. For each upload it:

1. Checks the file's MIME type. Only `image/*` files in a Sharp-supported format (`jpg`, `jpeg`, `png`, `webp`, `tiff`, `avif`) are processed — everything else passes through untouched.
2. Generates an optimized variant via Directus' built-in `AssetsService`, applying the configured format and quality. If `EXTENSIONS_TRANSFORM_ON_UPLOAD_MAX_WIDTH` and/or `EXTENSIONS_TRANSFORM_ON_UPLOAD_MAX_HEIGHT` is set, it also resizes per the configured [sharp `fit` mode](https://sharp.pixelplumbing.com/api-resize/#parameters); otherwise the original dimensions are kept.
3. Compares the new file size against the original. If the optimization would produce a _larger_ file (common for already-compressed assets), the original is kept.
4. Otherwise the file on disk is overwritten with the optimized stream, the file extension and MIME type in the database row are updated to the new format, and stale `width`/`height` metadata is cleared so Directus re-reads them.

The hook runs as an internal process (no user accountability) and disables event emission on the rewrite to prevent infinite recursion. It also retries reading the freshly uploaded asset with linear backoff, since some storage adapters need a moment to flush the bytes before they are readable.

## Installation

Refer to the Official Guide for details on installing the extension from the Marketplace or manually.

## Configuration

All settings are optional and read from environment variables on Directus startup. Set them in your Directus `.env` (or wherever you manage env vars):

| Variable                                             | Default  | Description                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EXTENSIONS_TRANSFORM_ON_UPLOAD_QUALITY`             | `50`     | Encoder quality, `1`–`100`. Lower = smaller files, more visible artifacts. AVIF and WebP look good at much lower numbers than JPEG.                                                                                                                                                                                                                   |
| `EXTENSIONS_TRANSFORM_ON_UPLOAD_TARGET_FORMAT`       | `avif`   | Output format. One of: `avif`, `webp`, `jpg`, `jpeg`, `png`, `tiff`. Invalid values disable the hook.                                                                                                                                                                                                                                                 |
| `EXTENSIONS_TRANSFORM_ON_UPLOAD_MAX_WIDTH`           | _unset_  | Maximum output width in pixels. If only this is set, the height auto-scales to preserve the original aspect ratio. See [sharp resize docs](https://sharp.pixelplumbing.com/api-resize/).                                                                                                                                                              |
| `EXTENSIONS_TRANSFORM_ON_UPLOAD_MAX_HEIGHT`          | _unset_  | Maximum output height in pixels. If only this is set, the width auto-scales to preserve the original aspect ratio. See [sharp resize docs](https://sharp.pixelplumbing.com/api-resize/)                                                                                                                                                               |
| `EXTENSIONS_TRANSFORM_ON_UPLOAD_FIT`                 | `inside` | How width and height combine when both are set. One of: `inside`, `outside`, `cover`, `contain`, `fill`. `inside` (default) preserves aspect ratio and fits within the box; `fill` ignores aspect ratio and stretches to exact dimensions. Invalid values fall back to `inside`. See [sharp resize docs](https://sharp.pixelplumbing.com/api-resize/) |
| `EXTENSIONS_TRANSFORM_ON_UPLOAD_WITHOUT_ENLARGEMENT` | `true`   | When `true`, images smaller than the target dimensions are not upscaled. Set to `false` to allow upscaling — usually paired with `EXTENSIONS_TRANSFORM_ON_UPLOAD_FIT=fill` to force exact output sizes.                                                                                                                                               |
| `EXTENSIONS_TRANSFORM_ON_UPLOAD_MAX_ATTEMPTS`        | `10`     | How many times to retry reading the freshly uploaded asset before giving up. Each retry adds a linear backoff (1 s, 2 s, 3 s, …). Raise this on slow storage backends if you see "asset not found" errors.                                                                                                                                            |

### Recipes

The width/height/fit triplet maps directly to [sharp's resize options](https://sharp.pixelplumbing.com/api-resize/), so any combination sharp supports works here. A few common shapes:

#### 1. Compress only — no resize

Omit both `EXTENSIONS_TRANSFORM_ON_UPLOAD_MAX_WIDTH` and `EXTENSIONS_TRANSFORM_ON_UPLOAD_MAX_HEIGHT`. Original dimensions are kept; only the format/quality re-encode runs.

```env
EXTENSIONS_TRANSFORM_ON_UPLOAD_QUALITY=70
EXTENSIONS_TRANSFORM_ON_UPLOAD_TARGET_FORMAT=avif
```

#### 2. Cap longest side (typical "shrink huge uploads")

Set both `EXTENSIONS_TRANSFORM_ON_UPLOAD_MAX_WIDTH` and `EXTENSIONS_TRANSFORM_ON_UPLOAD_MAX_HEIGHT` to the same number with the default `EXTENSIONS_TRANSFORM_ON_UPLOAD_FIT=inside`. Aspect ratio is preserved; landscape images cap on width, portrait on height. Smaller images are untouched.

```env
EXTENSIONS_TRANSFORM_ON_UPLOAD_QUALITY=70
EXTENSIONS_TRANSFORM_ON_UPLOAD_TARGET_FORMAT=avif
EXTENSIONS_TRANSFORM_ON_UPLOAD_MAX_WIDTH=2560
EXTENSIONS_TRANSFORM_ON_UPLOAD_MAX_HEIGHT=2560
```

#### 3. Constrain only one axis — auto-scale the other

Set just one. sharp auto-scales the other to preserve aspect ratio. Good for "all images max 1920 px wide" feeds.

```env
EXTENSIONS_TRANSFORM_ON_UPLOAD_QUALITY=70
EXTENSIONS_TRANSFORM_ON_UPLOAD_TARGET_FORMAT=avif
EXTENSIONS_TRANSFORM_ON_UPLOAD_MAX_WIDTH=1920
```

#### 4. Force exact dimensions (stretch, ignore aspect ratio)

Set both, switch `EXTENSIONS_TRANSFORM_ON_UPLOAD_FIT` to `fill`, and set `EXTENSIONS_TRANSFORM_ON_UPLOAD_WITHOUT_ENLARGEMENT=false` so even small images are upscaled. Output will be exactly `EXTENSIONS_TRANSFORM_ON_UPLOAD_MAX_WIDTH × EXTENSIONS_TRANSFORM_ON_UPLOAD_MAX_HEIGHT`. Distorts non-matching aspect ratios.

```env
EXTENSIONS_TRANSFORM_ON_UPLOAD_MAX_WIDTH=1024
EXTENSIONS_TRANSFORM_ON_UPLOAD_MAX_HEIGHT=1024
EXTENSIONS_TRANSFORM_ON_UPLOAD_FIT=fill
EXTENSIONS_TRANSFORM_ON_UPLOAD_WITHOUT_ENLARGEMENT=false
```

#### 5. Square thumbnails (crop to fill)

Set both, use `EXTENSIONS_TRANSFORM_ON_UPLOAD_FIT=cover`. sharp scales the image to cover the box and crops the overflow — output is exactly `EXTENSIONS_TRANSFORM_ON_UPLOAD_MAX_WIDTH × EXTENSIONS_TRANSFORM_ON_UPLOAD_MAX_HEIGHT` with no distortion.

```env
EXTENSIONS_TRANSFORM_ON_UPLOAD_MAX_WIDTH=512
EXTENSIONS_TRANSFORM_ON_UPLOAD_MAX_HEIGHT=512
EXTENSIONS_TRANSFORM_ON_UPLOAD_FIT=cover
```

For the full behaviour table of every `fit` mode (`inside`, `outside`, `cover`, `contain`, `fill`), see [sharp's resize parameters reference](https://sharp.pixelplumbing.com/api-resize/#parameters).

## Usage

There is nothing to invoke. Once installed and Directus is running:

- Upload an image through the Admin app, the `/files` REST endpoint, the GraphQL `upload_files` mutation, or any SDK call — it is processed automatically.
- The file in the database (`directus_files` row) and on the storage adapter is replaced with the optimized version. `filename_download`, `filename_disk`, and `type` are updated to reflect the new extension and MIME type.
- The file's UUID/key is preserved, so any existing references (relations, M2A, embedded URLs) keep working.

### What gets processed

- Format must be one of `jpg`, `jpeg`, `png`, `webp`, `tiff`, `avif`.
- Anything else (SVG, GIF, HEIC, PDF, video, audio, raw files…) is left untouched.
- If the optimized result would be larger than the original, the original is kept and the file is left as-is.

### Verifying it works

After uploading a large JPEG:

1. Check the file in the Directus Admin — the extension and MIME type should match your `EXTENSIONS_TRANSFORM_ON_UPLOAD_TARGET_FORMAT`.
2. The reported file size should be smaller than the source.
3. If `EXTENSIONS_TRANSFORM_ON_UPLOAD_MAX_WIDTH` and/or `EXTENSIONS_TRANSFORM_ON_UPLOAD_MAX_HEIGHT` is set, width/height should reflect the resized dimensions according to the configured `EXTENSIONS_TRANSFORM_ON_UPLOAD_FIT` mode.

## Caveats

- **Lossy by default.** The defaults (AVIF, q=50) target storage savings, not archival fidelity. If you serve the originals to designers or printers, raise the quality or change the target format.
- **No EXIF preservation guarantee.** Re-encoding through Sharp drops most metadata. If you rely on EXIF (camera info, GPS, color profiles), test before deploying.
- **Synchronous to the upload.** Optimization happens in-line with the upload request; very large images add latency to the response.
- **Storage flush retry.** The hook retries reading the freshly written asset with linear backoff (1 s, 2 s, 3 s, …) up to `EXTENSIONS_TRANSFORM_ON_UPLOAD_MAX_ATTEMPTS` times (default `10`). Raise the env var on unusually slow storage backends if you see "asset not found" failures.
- **One-way.** The original bytes are replaced. Keep your own archive if you need the source.

## Development

```bash
npm install
npm run dev      # watch + rebuild, no minification
npm run build    # production build to dist/
npm run validate # validate the extension manifest
```

The source lives in `src/index.ts` and is built to `dist/index.js` per the `directus:extension` block in `package.json`.

## License

See [LICENSE](./LICENSE).
