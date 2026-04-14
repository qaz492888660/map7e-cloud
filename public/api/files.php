<?php declare(strict_types=1);

require __DIR__ . '/bootstrap.php';

try {
    $relativePath = request_relative_path($_GET['path'] ?? '');
    $currentLabel = $relativePath === '' ? 'Home' : basename(str_replace('/', DIRECTORY_SEPARATOR, $relativePath));

    json_response([
        'currentPath' => $relativePath,
        'currentLabel' => $currentLabel,
        'breadcrumbs' => build_breadcrumbs($relativePath),
        'rootFolders' => root_folders(),
        'files' => directory_files($relativePath),
    ]);
} catch (Throwable $error) {
    json_response([
        'error' => $error->getMessage(),
    ], 400);
}
