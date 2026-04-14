<?php declare(strict_types=1);

require __DIR__ . '/bootstrap.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_response([
        'error' => 'Method not allowed.',
    ], 405);
}

try {
    $relativePath = request_relative_path($_POST['path'] ?? '');
    $targetDirectory = ensure_directory($relativePath);

    if (!isset($_FILES['files'])) {
        throw new RuntimeException('No files uploaded.');
    }

    $names = $_FILES['files']['name'];
    $tmpNames = $_FILES['files']['tmp_name'];
    $errors = $_FILES['files']['error'];
    $count = is_array($names) ? count($names) : 0;
    $uploadedFiles = [];

    for ($index = 0; $index < $count; $index++) {
        if (($errors[$index] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK) {
            continue;
        }

        $safeName = safe_upload_name((string) $names[$index]);
        $destination = unique_destination($targetDirectory, $safeName);

        if (!move_uploaded_file((string) $tmpNames[$index], $destination)) {
            throw new RuntimeException('Unable to save uploaded file.');
        }

        $uploadedFiles[] = basename($destination);
    }

    if ($uploadedFiles === []) {
        throw new RuntimeException('No files were uploaded.');
    }

    json_response([
        'uploaded' => $uploadedFiles,
    ]);
} catch (Throwable $error) {
    json_response([
        'error' => $error->getMessage(),
    ], 400);
}
