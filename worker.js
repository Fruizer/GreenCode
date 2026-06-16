// worker.js
try {
    importScripts("https://cdn.jsdelivr.net/pyodide/v0.25.0/full/pyodide.js"); 
} catch (e) {
    postMessage({ type: "ERROR", error: "404: Pyodide CDN could not be reached." });
}

let pyodideEngine = null;

self.sendTelemetry = (ops, peak_mem) => {
    postMessage({ type: "TELEMETRY", ops: ops, mem: peak_mem });
};

async function loadPyodideEngine() {
    try {
        pyodideEngine = await loadPyodide({ indexURL: "https://cdn.jsdelivr.net/pyodide/v0.25.0/full/" });
        postMessage({ type: "READY" });
    } catch (err) {
        postMessage({ type: "ERROR", error: "Boot Failed: " + err.message });
    }
}
loadPyodideEngine();

self.onmessage = async (event) => {
    const { projectFiles, mainFileName } = event.data;

    if (!pyodideEngine) {
        postMessage({ type: "ERROR", error: "Engine booting..." });
        return;
    }

    try {
        for (let file of projectFiles) {
            const safeName = file.name.split('/').pop(); 
            pyodideEngine.FS.writeFile(safeName, file.content);
        }

        const mainFileObj = projectFiles.find(f => f.name === mainFileName || f.name.endsWith(mainFileName));
        const mainFileContent = mainFileObj ? mainFileObj.content : "";
        await pyodideEngine.loadPackagesFromImports(mainFileContent);
        
    } catch (err) {
        postMessage({ type: "ERROR", error: "VFS Mount Failure: " + err.message });
        return;
    }

    const safeMainName = mainFileName.split('/').pop();

    const analysisScript = `
import sys
import time
import io
import json
import builtins
import js

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
builtins.input = automated_input

start_time = time.time()
error_msg = ""
final_ops = 0
final_peak_mem = 0

try:
    sys.setrecursionlimit(5000)
    
    # Initialize Global Tracker in Builtins so ALL imported files share memory
    if not hasattr(builtins, '_green_tracker'):
        builtins._green_tracker = {"ops": 0, "current_mem": 0, "peak_mem": 0, "last_sync": 0, "last_ops_sync": 0}

    # Fixed the Telemetry sync math
    def _check_telemetry():
        if builtins._green_tracker['ops'] - builtins._green_tracker['last_ops_sync'] >= 100:
            builtins._green_tracker['last_ops_sync'] = builtins._green_tracker['ops']
            current_time = time.time()
            if current_time - builtins._green_tracker['last_sync'] > 0.05:
                js.sendTelemetry(builtins._green_tracker['ops'], builtins._green_tracker['peak_mem'])
                builtins._green_tracker['last_sync'] = current_time
    builtins._check_telemetry = _check_telemetry

    def _update_mem(bytes_added):
        builtins._green_tracker['current_mem'] += bytes_added
        if builtins._green_tracker['current_mem'] > builtins._green_tracker['peak_mem']:
            builtins._green_tracker['peak_mem'] = builtins._green_tracker['current_mem']
    builtins._update_mem = _update_mem

    class GreenList(list):
        def __init__(self, iterable=()):
            super().__init__(iterable)
            self._size = 56 + (len(self) * 8)
            builtins._update_mem(self._size)
        def append(self, item):
            super().append(item)
            builtins._update_mem(8)
        def pop(self, index=-1):
            if len(self) > 0: builtins._update_mem(-8)
            return super().pop(index)
        def clear(self):
            freed_bytes = len(self) * 8
            super().clear()
            builtins._update_mem(-freed_bytes)
    builtins.GreenList = GreenList

    # Execute the target file natively
    main_code = open('${safeMainName}').read()
    exec(main_code, globals())
    
    final_ops = builtins._green_tracker.get('ops', 0)
    final_peak_mem = builtins._green_tracker.get('peak_mem', 0)

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
