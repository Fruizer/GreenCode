// worker.js

// 1. Pull the Pyodide engine from the CDN instead of a local folder
try {
    importScripts("https://cdn.jsdelivr.net/pyodide/v0.25.0/full/pyodide.js"); 
} catch (e) {
    postMessage({ type: "ERROR", error: "404: Pyodide CDN could not be reached." });
}

let pyodideEngine = null;

// Expose a telemetry function to the Python environment
self.sendTelemetry = (ops, peak_mem) => {
    postMessage({ type: "TELEMETRY", ops: ops, mem: peak_mem });
};

async function loadPyodideEngine() {
    try {
        // 2. Initialize it using the CDN's index URL
        pyodideEngine = await loadPyodide({ 
            indexURL: "https://cdn.jsdelivr.net/pyodide/v0.25.0/full/" 
        });
        postMessage({ type: "READY" });
    } catch (err) {
        postMessage({ type: "ERROR", error: "Boot Failed: " + err.message });
    }
}
loadPyodideEngine();

self.onmessage = async (event) => {
    const { userCode } = event.data;

    if (!pyodideEngine) {
        postMessage({ type: "ERROR", error: "Engine booting..." });
        return;
    }

    try {
        // ========================================================
        // AUTOMATIC IMPORT PACKAGE LOADER
        // ========================================================
        // This scans the userCode for statements like 'import re' or 'import math'
        // and safely pre-loads them into the WebAssembly instance before running.
        await pyodideEngine.loadPackagesFromImports(userCode);
    } catch (packageErr) {
        postMessage({ type: "ERROR", error: "Package Load Failure: " + packageErr.message });
        return;
    }

    const analysisScript = `
import sys
import time
import io
import json

MAX_OUTPUT_CHARS = 50000
output_capture = io.StringIO()
sys.stdout = output_capture

# Input Automation
input_counter = 0
def automated_input(prompt=""):
    global input_counter
    input_counter += 1
    if input_counter > 50: return "End"
    return "Rock"

start_time = time.time()
error_msg = ""
final_ops = 0
final_peak_mem = 0

try:
    sys.setrecursionlimit(5000)
    
    # FIXED: Added import time and the 50ms throttle check
    proxy_definitions = """
import js  
import time

def _check_telemetry():
    # Only check the system clock every 100 ops to keep overhead low
    if __tracker['ops'] % 100 == 0:
        current_time = time.time()
        # Only send data to frontend a maximum of once every 50ms
        if current_time - __tracker['last_sync'] > 0.05:
            js.sendTelemetry(__tracker['ops'], __tracker['peak_mem'])
            __tracker['last_sync'] = current_time

def _update_mem(bytes_added):
    global __tracker
    __tracker['current_mem'] += bytes_added
    if __tracker['current_mem'] > __tracker['peak_mem']:
        __tracker['peak_mem'] = __tracker['current_mem']

class GreenList(list):
    def __init__(self, iterable=()):
        super().__init__(iterable)
        self._size = 56 + (len(self) * 8)
        _update_mem(self._size)
        
    def append(self, item):
        super().append(item)
        _update_mem(8)
        
    def pop(self, index=-1):
        if len(self) > 0:
            _update_mem(-8)
        return super().pop(index)
        
    def clear(self):
        freed_bytes = len(self) * 8
        super().clear()
        _update_mem(-freed_bytes)
"""

    full_code = proxy_definitions + "\\n" + ${JSON.stringify(userCode)}
    
    exec_globals = {
        'input': automated_input,
        '__name__': '__main__'
    }
    
    exec(full_code, exec_globals)
    
    if '__tracker' in exec_globals:
        final_ops = exec_globals['__tracker'].get('ops', 0)
        final_peak_mem = exec_globals['__tracker'].get('peak_mem', 0)

except Exception as e:
    error_msg = str(e)
finally:
    end_time = time.time()

sys.stdout = sys.__stdout__

result = {
    "output": output_capture.getvalue()[:MAX_OUTPUT_CHARS],
    "error": error_msg,
    "ops": final_ops, 
    "memory_peak_bytes": final_peak_mem, 
    "duration_sec": end_time - start_time
}
json.dumps(result)
`;

    try {
        let rawResult = await pyodideEngine.runPythonAsync(analysisScript); 
        postMessage({ type: "RESULT", data: JSON.parse(rawResult) });
    } catch (err) {
        postMessage({ type: "ERROR", error: "CRITICAL FAILURE: " + err.toString() });
    }
};
