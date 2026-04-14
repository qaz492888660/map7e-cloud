# Map7e Cloud Directory Library

`map7e-cloud` is now a static directory-based download library. The interface keeps the ocean-themed glassmorphism look, restores clickable folder navigation, and does not depend on uploads or server-side APIs.

## What It Does

- The homepage opens at the root directory.
- Three clickable root folders are provided by default:
  - `albums`
  - `docs`
  - `resources`
- In the UI, those folders are labeled as the Chinese directory names required by the product.
- Clicking a folder enters that directory and shows only that folder's files.
- The breadcrumb path at the top is clickable. Selecting the home item returns to the root directory.
- The search box filters only the file names inside the current directory.
- Every file is downloaded directly from a static `/downloads/...` path.
- Upload is not supported.

## Important Paths

- `public/index.html`: static browser entrypoint
- `public/components/CloudStoragePage.vue`: main Vue component for folder navigation
- `public/files/library.json`: static directory manifest
- `public/downloads/albums/`: sample files for the albums directory
- `public/downloads/docs/`: sample files for the docs directory
- `public/downloads/resources/`: sample files for the resources directory
- `vercel.json`: static rewrites for Vercel deployment

## Library Manifest Format

The app reads `/files/library.json` directly. The manifest must contain:

- `title`
- `rootFolders`
- `folders`

Example structure:

```json
{
  "title": "Map7e Cloud Resource Library",
  "updatedAt": "2026-04-14",
  "rootFolders": [
    {
      "slug": "albums",
      "name": "Album Directory",
      "description": "Ocean artwork, preview images, and sample gallery assets.",
      "updatedLabel": "2026-04-14"
    }
  ],
  "folders": {
    "albums": {
      "name": "Album Directory",
      "description": "Static images and gallery notes for direct download.",
      "files": [
        {
          "name": "ocean-postcard.svg",
          "path": "/downloads/albums/ocean-postcard.svg",
          "size": "3 KB",
          "date": "2026-04-14",
          "type": "image",
          "description": "Ocean postcard style artwork for gallery previews."
        }
      ]
    }
  }
}
```

## Adding Files

1. Put real downloadable files inside one of these folders:
   - `public/downloads/albums/`
   - `public/downloads/docs/`
   - `public/downloads/resources/`
2. Add the matching file records to `public/files/library.json`.
3. Keep each file `path` pointed at the real static file, for example `/downloads/resources/test.txt`.
4. Redeploy the site.

## Vercel Deployment

This project is designed for Vercel static deployment.

1. Push the repository to GitHub.
2. Import the repository into Vercel.
3. Deploy as a static site.
4. `vercel.json` rewrites these routes to the `public/` directory:
   - `/`
   - `/assets/*`
   - `/components/*`
   - `/files/*`
   - `/downloads/*`

No PHP runtime, upload endpoint, Docker image, Railway volume, or database is required.

## Local Preview

Any simple static file server is enough. For example:

```powershell
python -m http.server 8080 --directory public
```

Then open `http://localhost:8080`.

## Notes

- Replace the sample downloads with your real files before production use.
- If you want a different background illustration, replace `public/assets/ocean-background.svg` or update the URL in `public/components/CloudStoragePage.vue`.
