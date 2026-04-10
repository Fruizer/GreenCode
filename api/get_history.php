<?php
require 'db.php';

if (!isset($_SESSION['user_id'])) {
    echo json_encode(['success' => false, 'error' => 'Not logged in']);
    exit;
}

$stmt = $pdo->prepare("SELECT filename, ops, peak_memory_bytes, energy_joules, energy_kwh, created_at FROM execution_results WHERE user_id = ? ORDER BY created_at DESC");
$stmt->execute([$_SESSION['user_id']]);
$results = $stmt->fetchAll(PDO::FETCH_ASSOC);

echo json_encode(['success' => true, 'results' => $results]);
?>