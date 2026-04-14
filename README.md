# Map7e Cloud Local Preview

Project structure:

- `public/index.php`: browser entrypoint
- `public/components/CloudStoragePage.vue`: premium Vue 3 cloud storage UI
- `public/api/files.php`: local file listing endpoint
- `public/api/upload.php`: local upload endpoint
- `storage/`: sample local files and folders

Run locally:

```powershell
php -S localhost:8080 -t public
```

Then open:

`http://localhost:8080`

Notes:

- A local fallback ocean image is included at `public/assets/ocean-background.svg`.
- If you have a specific ocean image you want to use instead, replace that asset or update the URL in `public/components/CloudStoragePage.vue`.
