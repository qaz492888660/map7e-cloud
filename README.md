# Map7e Cloud Static Resource Library

`map7e-cloud` is now a static download edition of the project. The UI keeps the existing ocean-themed glassmorphism design, but the product behavior is now a pure resource library: visitors can browse file metadata and download files directly, without any online upload capability.

## What Changed

- The site is now a static download center / resource library.
- All downloadable assets belong in `public/files/`.
- The visible file list is maintained in `public/files/files.json`.
- The frontend reads `/files/files.json` directly with no PHP or upload API.
- Online upload is no longer supported.

## Important Paths

- `public/index.html`: static browser entrypoint
- `public/components/CloudStoragePage.vue`: main resource library page
- `public/files/files.json`: static manifest for the file list
- `public/assets/ocean-background.svg`: ocean background artwork
- `vercel.json`: static rewrites for Vercel deployment

## File Library Format

Maintain `public/files/files.json` with entries like:

```json
{
  "name": "Deployment Manual",
  "path": "/files/manual.pdf",
  "size": "2.1 MB",
  "date": "2026-04-13",
  "type": "document",
  "description": "Reference notes for managing the static download library."
}
```

Required fields:

- `name`
- `path`
- `size`
- `date`
- `type`

Optional field:

- `description`

## Adding Download Files

1. Put the real asset files inside `public/files/`.
2. Add or update the matching entries in `public/files/files.json`.
3. Redeploy to publish the updated catalog.

The download buttons on the page link directly to each file path, for example `/files/manual.pdf`.

## Vercel Deployment

This project is designed for Vercel static deployment.

1. Push the repository to GitHub.
2. Import the repo into Vercel.
3. Deploy it as a static site.
4. `vercel.json` rewrites `/`, `/assets/*`, `/components/*`, and `/files/*` to the `public/` directory.

No PHP runtime, Docker image, Railway volume, or server-side upload endpoint is required.

## Local Preview

Any simple static file server is enough. For example:

```powershell
python -m http.server 8080 --directory public
```

Then open `http://localhost:8080`.

## Notes

- Replace the sample `files.json` entries with your real downloadable files before production use.
- If you want a different background illustration, replace `public/assets/ocean-background.svg` or update the URL in `public/components/CloudStoragePage.vue`.
