<?php
require 'db.php';
$data = json_decode(file_get_contents("php://input"));

if (isset($_SESSION['user_id']) && isset($data->ops)) {
    $stmt = $pdo->prepare("INSERT INTO execution_results (user_id, filename, ops, peak_memory_bytes, energy_joules, energy_kwh) VALUES (?, ?, ?, ?, ?, ?)");
    $stmt->execute([$_SESSION['user_id'], $data->filename, $data->ops, $data->memory_peak_bytes, $data->energy_joules, $data->energy_kwh]);
    echo json_encode(['success' => true]);
} else {
    echo json_encode(['success' => false, 'error' => 'User not logged in']);
}
?>