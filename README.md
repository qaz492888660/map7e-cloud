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

## Deploy To Railway

This project is ready to deploy on Railway with Docker.

### 1. Import the GitHub repository

1. Push this project to GitHub.
2. In Railway, click `New Project`.
3. Choose `Deploy from GitHub repo`.
4. Select the repository for this project.
5. Railway will detect the `Dockerfile` and build the app automatically.

### 2. Mount a persistent Volume

The application stores uploaded files in `/app/storage`.

1. Open your Railway project.
2. Add a `Volume`.
3. Mount the Volume to:

   `/app/storage`

4. Redeploy the service after the Volume is attached.

This keeps uploaded files persistent across deployments.

### 3. Access the app

After deployment finishes, open the Railway generated domain.

The following features should work:

- homepage loading
- folder browsing
- file listing
- file upload
- file download

### 4. Redeploy after changes

When you push new commits to the connected GitHub repository, Railway can rebuild and redeploy automatically.

You can also trigger a manual redeploy from the Railway dashboard if needed.
