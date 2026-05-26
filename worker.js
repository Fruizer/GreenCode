// worker.js

try {
    importScripts("https://cdn.jsdelivr.net/pyodide/v0.25.0/full/pyodide.js"); 
} catch (e) {
    postMessage({ type: "ERROR", error: "404: Pyodide CDN could not be reached." });
}

let pyodideEngine = null;

self.sendTelemetry = (ops, peak_mem, line_ops_str, line_mem_str) => {
    postMessage({ 
        type: "TELEMETRY", 
        ops: ops, 
        mem: peak_mem,
        line_ops: line_ops_str ? JSON.parse(line_ops_str) : {},
        line_mem: line_mem_str ? JSON.parse(line_mem_str) : {}
    });
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
    
    proxy_definitions = """
import js  
import time
import json

def _check_telemetry():
    if __tracker['ops'] % 100 == 0:
        current_time = time.time()
        if current_time - __tracker['last_sync'] > 0.05:
            js.sendTelemetry(__tracker['ops'], __tracker['peak_mem'], json.dumps(__tracker['line_ops']), json.dumps(__tracker['line_mem']))
            __tracker['last_sync'] = current_time

def _update_mem(bytes_added, line_num=None):
    global __tracker
    __tracker['current_mem'] += bytes_added
    if __tracker['current_mem'] > __tracker['peak_mem']:
        __tracker['peak_mem'] = __tracker['current_mem']
    if line_num is not None and bytes_added > 0:
        __tracker['line_mem'][line_num] = __tracker['line_mem'].get(line_num, 0) + bytes_added

class GreenList(list):
    def __init__(self, line_num, *args):
        super().__init__(*args)
        self.line_num = line_num
        self._size = 56 + (len(self) * 8)
        _update_mem(self._size, self.line_num)
        
    def append(self, item):
        super().append(item)
        _update_mem(8, getattr(self, 'line_num', None))
        
    def pop(self, index=-1):
        if len(self) > 0:
            _update_mem(-8, getattr(self, 'line_num', None))
        return super().pop(index)
        
    def clear(self):
        freed_bytes = len(self) * 8
        super().clear()
        _update_mem(-freed_bytes, getattr(self, 'line_num', None))
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
        final_line_ops = exec_globals['__tracker'].get('line_ops', {})
        final_line_mem = exec_globals['__tracker'].get('line_mem', {})

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
    "line_mem": final_line_mem
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
