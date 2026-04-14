<?php declare(strict_types=1);

require __DIR__ . '/bootstrap.php';

try {
    $relativePath = request_relative_path($_GET['path'] ?? '');

    if ($relativePath === '') {
        throw new RuntimeException('File not found.');
    }

    $absolutePath = absolute_path($relativePath);

    if (!is_file($absolutePath)) {
        throw new RuntimeException('File not found.');
    }

    header('Content-Type: application/octet-stream');
    header('Content-Length: ' . (string) filesize($absolutePath));
    header('Content-Disposition: attachment; filename="' . basename($absolutePath) . '"');
    readfile($absolutePath);
    exit;
} catch (Throwable $error) {
    http_response_code(404);
    header('Content-Type: text/plain; charset=utf-8');
    echo $error->getMessage();
}
