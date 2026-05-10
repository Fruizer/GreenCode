// worker.js

// 1. Pull the Pyodide engine from the CDN instead of a local folder
try {
    importScripts("https://cdn.jsdelivr.net/pyodide/v0.25.0/full/pyodide.js"); 
} catch (e) {
    postMessage({ type: "ERROR", error: "404: Pyodide CDN could not be reached." });
}

let pyodideEngine = null;

// --- UPGRADED: Expose telemetry function to accept live traces ---
self.sendTelemetry = (ops, peak_mem, line_ops_str, line_mem_str) => {
    postMessage({ type: "TELEMETRY", ops: ops, mem: peak_mem, line_ops: line_ops_str, line_mem: line_mem_str });
};

async function loadPyodideEngine() {
    try {
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
final_line_ops = {}
final_line_mem = {}

try:
    sys.setrecursionlimit(5000)
    
    # === START TRIPLE QUOTE ===
    proxy_definitions = """
import js
import json

def _check_telemetry():
    # Stream data AND traces to the frontend every 250 operations
    if __tracker['ops'] % 250 == 0:
        ops_json = json.dumps(__tracker.get('line_ops', {}))
        mem_json = json.dumps(__tracker.get('line_memory', {}))
        js.sendTelemetry(__tracker['ops'], __tracker['peak_mem'], ops_json, mem_json)

def _update_mem(bytes_added):
    global __tracker
    __tracker['current_mem'] += bytes_added
    if __tracker['current_mem'] > __tracker['peak_mem']:
        __tracker['peak_mem'] = __tracker['current_mem']
        
    active_line = __tracker.get('active_line', 'unknown')
    if active_line != 'unknown' and bytes_added > 0:
        if 'line_memory' not in __tracker:
            __tracker['line_memory'] = {}
        __tracker['line_memory'].setdefault(active_line, 0)
        __tracker['line_memory'][active_line] += bytes_added

class GreenList(list):
    def __init__(self, *args):
        super().__init__(*args)
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
    # === END TRIPLE QUOTE ===

    full_code = proxy_definitions + "\\n" + ${JSON.stringify(userCode)}
    
    exec_globals = {
        'input': automated_input,
        '__name__': '__main__'
    }
    
    exec(full_code, exec_globals)
    
    if '__tracker' in exec_globals:
        final_ops = exec_globals['__tracker'].get('ops', 0)
        final_peak_mem = exec_globals['__tracker'].get('peak_mem', 0)
        final_line_ops = exec_globals['__tracker'].get('line_ops', {})
        final_line_mem = exec_globals['__tracker'].get('line_memory', {})

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
    "duration_sec": end_time - start_time,
    "line_ops": final_line_ops,
    "line_memory": final_line_mem
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
