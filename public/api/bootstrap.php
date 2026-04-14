<?php declare(strict_types=1);

const STORAGE_ROOT = '/app/storage';

function storage_root(): string
{
    $root = rtrim(STORAGE_ROOT, '/\\');

    if (!is_dir($root)) {
        mkdir($root, 0777, true);
    }

    return $root;
}

function json_response(array $payload, int $statusCode = 200): void
{
    http_response_code($statusCode);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

function request_relative_path(?string $value): string
{
    $path = trim(str_replace('\\', '/', (string) $value));
    $path = trim($path, '/');

    if ($path === '') {
        return '';
    }

    $segments = [];
    foreach (explode('/', $path) as $segment) {
        $segment = trim($segment);

        if ($segment === '' || $segment === '.') {
            continue;
        }

        if ($segment === '..') {
            throw new RuntimeException('Invalid path.');
        }

        $segments[] = $segment;
    }

    return implode('/', $segments);
}

function absolute_path(string $relativePath): string
{
    if ($relativePath === '') {
        return storage_root();
    }

    return storage_root() . DIRECTORY_SEPARATOR . str_replace('/', DIRECTORY_SEPARATOR, $relativePath);
}

function ensure_directory(string $relativePath): string
{
    $absolutePath = absolute_path($relativePath);

    if (!is_dir($absolutePath)) {
        mkdir($absolutePath, 0777, true);
    }

    return $absolutePath;
}

function format_size(int $bytes): string
{
    if ($bytes < 1024) {
        return $bytes . ' B';
    }

    $units = ['KB', 'MB', 'GB', 'TB'];
    $value = $bytes / 1024;
    $unitIndex = 0;

    while ($value >= 1024 && $unitIndex < count($units) - 1) {
        $value /= 1024;
        $unitIndex++;
    }

    return number_format($value, $value < 10 ? 1 : 0) . ' ' . $units[$unitIndex];
}

function format_date(int $timestamp): string
{
    return date('M d, Y', $timestamp);
}

function is_hidden_entry(string $entry): bool
{
    return $entry !== '' && $entry[0] === '.';
}

function file_type(string $filename): string
{
    $extension = strtolower(pathinfo($filename, PATHINFO_EXTENSION));

    $map = [
        'archive' => ['zip', 'rar', '7z', 'tar', 'gz'],
        'document' => ['txt', 'md', 'pdf', 'doc', 'docx', 'csv', 'fig', 'key', 'svg'],
        'image' => ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif'],
        'video' => ['mp4', 'mov', 'avi', 'mkv', 'webm'],
    ];

    foreach ($map as $type => $extensions) {
        if (in_array($extension, $extensions, true)) {
            return $type;
        }
    }

    return 'other';
}

function direct_item_count(string $directory): int
{
    $count = 0;
    $entries = scandir($directory);

    if ($entries === false) {
        return 0;
    }

    foreach ($entries as $entry) {
        if ($entry === '.' || $entry === '..' || is_hidden_entry($entry)) {
            continue;
        }

        $count++;
    }

    return $count;
}

function normalize_download_path(string $relativePath): string
{
    return str_replace(DIRECTORY_SEPARATOR, '/', $relativePath);
}

function build_breadcrumbs(string $relativePath): array
{
    $breadcrumbs = [
        [
            'label' => 'Home',
            'path' => '',
        ],
    ];

    if ($relativePath === '') {
        return $breadcrumbs;
    }

    $segments = explode('/', $relativePath);
    $path = '';

    foreach ($segments as $segment) {
        $path = $path === '' ? $segment : $path . '/' . $segment;
        $breadcrumbs[] = [
            'label' => $segment,
            'path' => $path,
        ];
    }

    return $breadcrumbs;
}

function root_folders(): array
{
    $folders = [];
    $root = storage_root();
    $entries = scandir($root);

    if ($entries === false) {
        return $folders;
    }

    foreach ($entries as $entry) {
        if ($entry === '.' || $entry === '..' || is_hidden_entry($entry)) {
            continue;
        }

        $fullPath = $root . DIRECTORY_SEPARATOR . $entry;
        if (!is_dir($fullPath)) {
            continue;
        }

        $itemCount = direct_item_count($fullPath);

        $folders[] = [
            'name' => $entry,
            'path' => normalize_download_path($entry),
            'itemCount' => $itemCount,
            'itemCountLabel' => $itemCount . ' items',
            'updatedLabel' => format_date((int) filemtime($fullPath)),
        ];
    }

    usort($folders, static fn (array $left, array $right): int => strcasecmp($left['name'], $right['name']));

    return $folders;
}

function directory_files(string $relativePath): array
{
    $directory = ensure_directory($relativePath);
    $entries = scandir($directory);
    $files = [];

    if ($entries === false) {
        return $files;
    }

    foreach ($entries as $entry) {
        if ($entry === '.' || $entry === '..' || is_hidden_entry($entry)) {
            continue;
        }

        $fullPath = $directory . DIRECTORY_SEPARATOR . $entry;
        if (!is_file($fullPath)) {
            continue;
        }

        $relativeFilePath = $relativePath === '' ? $entry : $relativePath . '/' . $entry;
        $size = (int) filesize($fullPath);
        $timestamp = (int) filemtime($fullPath);

        $files[] = [
            'name' => $entry,
            'path' => normalize_download_path($relativeFilePath),
            'size' => format_size($size),
            'date' => format_date($timestamp),
            'type' => file_type($entry),
            'downloadUrl' => '/api/download.php?path=' . rawurlencode(normalize_download_path($relativeFilePath)),
        ];
    }

    usort($files, static fn (array $left, array $right): int => strcasecmp($left['name'], $right['name']));

    return $files;
}

function safe_upload_name(string $filename): string
{
    $name = basename(str_replace('\\', '/', $filename));
    $name = preg_replace('/[^\w.\- ]+/u', '_', $name) ?? 'upload.bin';

    return trim($name) !== '' ? $name : 'upload.bin';
}

function unique_destination(string $directory, string $filename): string
{
    $extension = pathinfo($filename, PATHINFO_EXTENSION);
    $basename = pathinfo($filename, PATHINFO_FILENAME);
    $candidate = $directory . DIRECTORY_SEPARATOR . $filename;
    $suffix = 1;

    while (file_exists($candidate)) {
        $nextFilename = $basename . '-' . $suffix;
        if ($extension !== '') {
            $nextFilename .= '.' . $extension;
        }

        $candidate = $directory . DIRECTORY_SEPARATOR . $nextFilename;
        $suffix++;
    }

    return $candidate;
}
