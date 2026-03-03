<?php

declare(strict_types=1);

$root = __DIR__;
$dataDir = $root . '/data';
$dataFile = $dataDir . '/store.json';
$secret = getenv('BEERMEETS_SECRET') ?: 'beermeets-dev-secret';
$key = hash('sha256', $secret, true);

function ensureDataFile(string $dataDir, string $dataFile): void {
    if (!is_dir($dataDir)) mkdir($dataDir, 0777, true);
    if (!file_exists($dataFile)) {
        file_put_contents($dataFile, json_encode(['registrations' => [], 'ratings' => [], 'users' => []], JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE));
    }
}

function readStore(string $dataDir, string $dataFile): array {
    ensureDataFile($dataDir, $dataFile);
    $raw = file_get_contents($dataFile) ?: '{}';
    $parsed = json_decode($raw, true);
    if (!is_array($parsed)) $parsed = [];
    return [
        'registrations' => is_array($parsed['registrations'] ?? null) ? $parsed['registrations'] : [],
        'ratings' => is_array($parsed['ratings'] ?? null) ? $parsed['ratings'] : [],
        'users' => is_array($parsed['users'] ?? null) ? $parsed['users'] : [],
    ];
}

function writeStore(string $dataFile, array $store): void {
    file_put_contents($dataFile, json_encode($store, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE));
}

function jsonOut(int $status, array $payload): never {
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($payload, JSON_UNESCAPED_UNICODE);
    exit;
}

function cleanName(mixed $v): string { return trim((string)($v ?? '')); }
function cleanEmail(mixed $v): string { return mb_strtolower(trim((string)($v ?? ''))); }

function encryptText(string $plain, string $key): string {
    $iv = random_bytes(12);
    $tag = '';
    $cipher = openssl_encrypt($plain, 'aes-256-gcm', $key, OPENSSL_RAW_DATA, $iv, $tag);
    return base64_encode($iv) . ':' . base64_encode($tag) . ':' . base64_encode($cipher ?: '');
}

function decryptText(string $payload, string $key): string {
    $parts = explode(':', $payload);
    if (count($parts) !== 3) return '';
    [$ivB64, $tagB64, $dataB64] = $parts;
    $iv = base64_decode($ivB64, true);
    $tag = base64_decode($tagB64, true);
    $data = base64_decode($dataB64, true);
    if ($iv === false || $tag === false || $data === false) return '';
    $plain = openssl_decrypt($data, 'aes-256-gcm', $key, OPENSSL_RAW_DATA, $iv, $tag);
    return $plain === false ? '' : $plain;
}

function sanitizeUser(array $u): array {
    return [
        'id' => $u['id'],
        'name' => $u['name'],
        'registrationLocked' => (bool)($u['registrationLocked'] ?? false),
        'createdAt' => $u['createdAt'] ?? null,
        'registrationLockedAt' => $u['registrationLockedAt'] ?? null,
        'hasEmail' => !empty($u['encryptedEmail']),
    ];
}

function readJsonBody(): array {
    $raw = file_get_contents('php://input') ?: '';
    if ($raw === '') return [];
    $data = json_decode($raw, true);
    return is_array($data) ? $data : [];
}

header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET,POST,PUT,DELETE,OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');
if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') {
    http_response_code(204);
    exit;
}

$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

if (!str_starts_with($path, '/api/')) {
    require $root . '/index.php';
    exit;
}

$store = readStore($dataDir, $dataFile);

$findUserByName = function(string $name) use (&$store): array|null {
    $lower = mb_strtolower($name);
    foreach ($store['users'] as $u) {
        if (mb_strtolower((string)$u['name']) === $lower) return $u;
    }
    return null;
};

$findUserIndexByName = function(string $name) use (&$store): int {
    $lower = mb_strtolower($name);
    foreach ($store['users'] as $i => $u) {
        if (mb_strtolower((string)$u['name']) === $lower) return $i;
    }
    return -1;
};

if ($method === 'POST' && $path === '/api/users/register') {
    $b = readJsonBody();
    $name = cleanName($b['name'] ?? '');
    $email = cleanEmail($b['email'] ?? '');
    $password = (string)($b['password'] ?? '');

    if ($name === '') jsonOut(400, ['error' => 'Name is required']);
    if (!filter_var($email, FILTER_VALIDATE_EMAIL)) jsonOut(400, ['error' => 'Invalid email']);
    if (mb_strlen($password) < 4) jsonOut(400, ['error' => 'Password must be at least 4 chars']);
    if ($findUserByName($name)) jsonOut(409, ['error' => 'User already exists']);

    $user = [
        'id' => bin2hex(random_bytes(16)),
        'name' => $name,
        'encryptedPassword' => encryptText($password, $key),
        'encryptedEmail' => encryptText($email, $key),
        'registrationLocked' => false,
        'createdAt' => (int)(microtime(true) * 1000),
    ];
    $store['users'][] = $user;
    writeStore($dataFile, $store);
    jsonOut(201, sanitizeUser($user));
}

if ($method === 'POST' && ($path === '/api/users/login' || $path === '/api/login')) {
    $b = readJsonBody();
    $name = cleanName($b['name'] ?? '');
    $password = (string)($b['password'] ?? '');
    if ($name === '' || $password === '') jsonOut(400, ['error' => 'Name and password are required']);

    $user = $findUserByName($name);
    if (!$user) jsonOut(404, ['error' => 'User not found. Please register first.']);

    $stored = decryptText((string)($user['encryptedPassword'] ?? ''), $key);
    if ($stored === '' || !hash_equals($stored, $password)) jsonOut(401, ['error' => 'Invalid password']);

    setcookie('beermeets_user', $user['name'], ['expires' => time() + 60*60*24*30, 'path' => '/', 'samesite' => 'Lax']);
    jsonOut(200, sanitizeUser($user));
}

if ($method === 'POST' && $path === '/api/logout') {
    setcookie('beermeets_user', '', ['expires' => time() - 3600, 'path' => '/', 'samesite' => 'Lax']);
    jsonOut(200, ['ok' => true]);
}

if ($method === 'GET' && $path === '/api/session') {
    $username = cleanName($_COOKIE['beermeets_user'] ?? '');
    if ($username === '') jsonOut(401, ['error' => 'No active session']);
    $user = $findUserByName($username);
    if (!$user) jsonOut(401, ['error' => 'Session user not found']);
    jsonOut(200, sanitizeUser($user));
}

if ($method === 'POST' && $path === '/api/registration/lock') {
    $b = readJsonBody();
    $name = cleanName($b['name'] ?? '');
    if ($name === '') jsonOut(400, ['error' => 'Name is required']);
    $idx = $findUserIndexByName($name);
    if ($idx < 0) jsonOut(404, ['error' => 'User not found']);
    $store['users'][$idx]['registrationLocked'] = true;
    $store['users'][$idx]['registrationLockedAt'] = (int)(microtime(true) * 1000);
    writeStore($dataFile, $store);
    jsonOut(200, ['ok' => true, 'user' => sanitizeUser($store['users'][$idx])]);
}

if ($method === 'GET' && $path === '/api/registrations') {
    $brewerName = cleanName($_GET['brewerName'] ?? '');
    if ($brewerName === '') jsonOut(200, $store['registrations']);
    $filtered = array_values(array_filter($store['registrations'], fn($r) => mb_strtolower((string)$r['brewerName']) === mb_strtolower($brewerName)));
    jsonOut(200, $filtered);
}

if ($method === 'POST' && $path === '/api/registrations') {
    $b = readJsonBody();
    $brewerName = cleanName($b['brewerName'] ?? '');
    $beerName = cleanName($b['beerName'] ?? '');
    $beerStyle = cleanName($b['beerStyle'] ?? '');
    $beerAbv = (float)($b['beerAbv'] ?? NAN);
    if ($brewerName === '' || $beerName === '' || $beerStyle === '' || is_nan($beerAbv) || $beerAbv < 0 || $beerAbv > 25) {
        jsonOut(400, ['error' => 'Invalid registration data']);
    }
    $user = $findUserByName($brewerName);
    if (!$user) jsonOut(404, ['error' => 'User not found']);
    if (!empty($user['registrationLocked'])) jsonOut(403, ['error' => 'Registration is locked for this user']);

    $record = [
        'id' => bin2hex(random_bytes(16)),
        'brewerName' => $brewerName,
        'beerName' => $beerName,
        'beerStyle' => $beerStyle,
        'beerAbv' => $beerAbv,
        'createdAt' => (int)(microtime(true) * 1000),
    ];
    $store['registrations'][] = $record;
    writeStore($dataFile, $store);
    jsonOut(201, $record);
}

if ($method === 'PUT' && preg_match('#^/api/registrations/([^/]+)$#', $path, $m)) {
    $id = $m[1];
    $b = readJsonBody();
    $brewerName = cleanName($b['brewerName'] ?? '');
    $beerName = cleanName($b['beerName'] ?? '');
    $beerStyle = cleanName($b['beerStyle'] ?? '');
    $beerAbv = (float)($b['beerAbv'] ?? NAN);
    if ($brewerName === '' || $beerName === '' || $beerStyle === '' || is_nan($beerAbv) || $beerAbv < 0 || $beerAbv > 25) {
        jsonOut(400, ['error' => 'Invalid update data']);
    }
    $user = $findUserByName($brewerName);
    if (!$user) jsonOut(404, ['error' => 'User not found']);
    if (!empty($user['registrationLocked'])) jsonOut(403, ['error' => 'Registration is locked for this user']);

    $idx = -1;
    foreach ($store['registrations'] as $i => $r) if ((string)$r['id'] === $id) { $idx = $i; break; }
    if ($idx < 0) jsonOut(404, ['error' => 'Beer not found']);
    if (mb_strtolower((string)$store['registrations'][$idx]['brewerName']) !== mb_strtolower($brewerName)) jsonOut(403, ['error' => 'Cannot edit another brewer beer']);

    $store['registrations'][$idx]['beerName'] = $beerName;
    $store['registrations'][$idx]['beerStyle'] = $beerStyle;
    $store['registrations'][$idx]['beerAbv'] = $beerAbv;
    $store['registrations'][$idx]['updatedAt'] = (int)(microtime(true) * 1000);
    writeStore($dataFile, $store);
    jsonOut(200, $store['registrations'][$idx]);
}

if ($method === 'GET' && $path === '/api/ratings') jsonOut(200, $store['ratings']);

if ($method === 'POST' && $path === '/api/ratings/batch') {
    $b = readJsonBody();
    $judgeName = cleanName($b['judgeName'] ?? '');
    $incoming = is_array($b['ratings'] ?? null) ? $b['ratings'] : [];

    $knownBrewers = array_unique(array_map(fn($r) => mb_strtolower((string)$r['brewerName']), $store['registrations']));
    if ($judgeName === '' || !in_array(mb_strtolower($judgeName), $knownBrewers, true)) jsonOut(400, ['error' => 'Unknown judge']);
    if (count($incoming) !== count($store['registrations']) || count($incoming) === 0) jsonOut(400, ['error' => 'Must provide ratings for all registered beers']);

    $ids = [];
    $prepared = [];
    $regIds = array_column($store['registrations'], 'id');
    foreach ($incoming as $row) {
      $beerId = (string)($row['beerId'] ?? '');
      $overall = (float)($row['overall'] ?? NAN);
      $aroma = array_key_exists('aroma', $row) && $row['aroma'] !== null && $row['aroma'] !== '' ? (float)$row['aroma'] : null;
      $appearance = array_key_exists('appearance', $row) && $row['appearance'] !== null && $row['appearance'] !== '' ? (float)$row['appearance'] : null;
      $flavor = array_key_exists('flavor', $row) && $row['flavor'] !== null && $row['flavor'] !== '' ? (float)$row['flavor'] : null;
      $mouthfeel = array_key_exists('mouthfeel', $row) && $row['mouthfeel'] !== null && $row['mouthfeel'] !== '' ? (float)$row['mouthfeel'] : null;

      if (!in_array($beerId, $regIds, true) || is_nan($overall) || $overall < 0 || $overall > 10) jsonOut(400, ['error' => 'Invalid rating data']);
      foreach ([$aroma, $appearance, $flavor, $mouthfeel] as $opt) {
        if ($opt !== null && ($opt < 1 || $opt > 10)) jsonOut(400, ['error' => 'Invalid rating data']);
      }
      if (in_array($beerId, $ids, true)) jsonOut(400, ['error' => 'Duplicate beer rating']);
      $ids[] = $beerId;
      $prepared[] = [
        'id' => bin2hex(random_bytes(16)),
        'judgeName' => $judgeName,
        'beerId' => $beerId,
        'overall' => $overall,
        'aroma' => $aroma,
        'appearance' => $appearance,
        'flavor' => $flavor,
        'mouthfeel' => $mouthfeel,
        'createdAt' => (int)(microtime(true) * 1000),
      ];
    }

    if (count($ids) !== count($store['registrations'])) jsonOut(400, ['error' => 'Missing beer ratings']);

    $store['ratings'] = array_values(array_filter($store['ratings'], fn($r) => mb_strtolower((string)$r['judgeName']) !== mb_strtolower($judgeName)));
    $store['ratings'] = array_merge($store['ratings'], $prepared);
    writeStore($dataFile, $store);
    jsonOut(201, ['inserted' => count($prepared)]);
}

if ($method === 'DELETE' && $path === '/api/all') {
    writeStore($dataFile, ['registrations' => [], 'ratings' => [], 'users' => []]);
    jsonOut(200, ['ok' => true]);
}

jsonOut(404, ['error' => 'Not found']);
