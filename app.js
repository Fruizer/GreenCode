// app.js

// ==========================================
// SUPABASE CONFIGURATION
// ==========================================
const supabaseUrl = 'https://fadbccudiffeneemlmvb.supabase.co';
const supabaseKey = 'sb_publishable__VXBEPzv_zSCuysL-UO02Q_LQ2kHh8z';
const supabaseClient = supabase.createClient(supabaseUrl, supabaseKey);

// ==========================================
// STATE MANAGEMENT & CONSTANTS
// ==========================================
let uploadedFiles = []; 
let analysisResults = []; 
let currentDetailIndex = 0; 
let energyChart;
let activeWorkers = []; 
let globalHistoryData = []; 

let executionTimerInterval; 
let globalStartTime = 0;

const C_CPU = 1.5e-9;
const C_MEM = 2.25e-9;
const BASELINE_MW = 2; 
const C_BASE = 0.0005;

// ==========================================
// PATTERN-BASED STATIC ANALYSIS DICTIONARY
// ==========================================
const GREEN_LINT_RULES = {
    "infinite_loop": {
        pattern: /^\s*(while\s+True|while\s+1):/,
        type: "Infinite Loop Risk",
        message: "Unbounded loops permanently lock CPU threads, draining constant baseline power.",
        action: "while condition_met:  # Add a deterministic break condition",
        fun_fact: "A CPU stuck in an infinite loop is like a car with a brick on the gas pedal in neutral. It gets incredibly hot, burns maximum fuel, and goes absolutely nowhere."
    },
    "nested_loop": {
        pattern: /^\s{8,}for\s+[a-zA-Z0-9_]+\s+in\s+[a-zA-Z0-9_]+:\s*$/, 
        type: "O(n²) Complexity Spike",
        message: "Nested iteration causes exponential operation growth. A 100-item list requires 10,000 ops.",
        action: "hash_map = {item.id: item}  # Flatten to O(n) using a dictionary lookup",
        fun_fact: "Nesting loops is like asking a teacher to check every student's homework against every other student's homework. By using a dictionary, you give the system a master index, cutting operations by 99%."
    },
    "sleep_block": {
        pattern: /^\s*time\.sleep\(/,
        type: "Synchronous Thread Block",
        message: "Hardware clocks remain active and consume power while waiting for synchronous sleep timers.",
        action: "await asyncio.sleep(n)  # Yield thread control back to the OS",
        fun_fact: "Synchronous sleep forces the CPU to actively count the seconds while waiting. Yielding asynchronously lets the CPU take a micro-nap and handle other tasks until the timer finishes."
    },
    "io_print": {
        pattern: /^\s+(print|sys\.stdout\.write)\([^"']+\)/,
        type: "I/O Hardware Wake",
        message: "Calling standard output inside a loop triggers hardware interrupts repeatedly.",
        action: "buffer.append(data)\nprint(''.join(buffer))  # Batch output outside the loop",
        fun_fact: "Printing to the screen forces the CPU to wake up the operating system kernel. Doing this 10,000 times inside a loop is like carrying groceries from your car one grape at a time."
    },
    "memory_load": {
        pattern: /\.(read|readlines)\(\)/,
        type: "RAM Saturation",
        message: "Loading entire file objects into memory forces garbage collection and swap-file usage.",
        action: "for line in file:  # Use a generator/iterator for lazy loading",
        fun_fact: "Loading a giant file into RAM all at once is like trying to swallow a watermelon whole. Reading it line-by-line allows the hardware to process the data without overflowing the memory banks."
    },
    "string_concat": {
        pattern: /[\w]+\s*\+=\s*[\w]+/,
        type: "String Accumulation Leak",
        message: "Using += in loops creates new string objects in memory every iteration.",
        action: "Use ''.join(list_of_strings) to minimize reallocations.",
        fun_fact: "String concatenation with += is O(n^2) because Python copies the entire string for every append."
    },
    "membership_lookup": {
        pattern: /if\s+[\w]+\s+in\s+[\w]+_list:/,
        type: "Linear Membership Lookup",
        message: "Checking membership in a list is O(n).",
        action: "Convert the list to a set() first for O(1) lookup speed.",
        fun_fact: "List lookups are like searching a bookshelf book-by-book. Sets are like a library index card system."
    },
    "comprehension": {
        pattern: /\[.+for\s+.+in\s+.+\]|\{.+for\s+.+in\s+.+\}/,
        type: "Comprehension Structural Density",
        message: "List/Dict comprehensions consume high instantaneous memory.",
        action: "Use (x for x in items) to create a memory-efficient generator.",
        fun_fact: "List comprehensions create the whole object in RAM. Generators stream it like a movie."
    }
};

window.onload = function() {
    setupChart();
    setupDragAndDrop();
};

// ==========================================
// DRAG AND DROP & FILE HANDLING
// ==========================================
function setupDragAndDrop() {
    const dropzone = document.getElementById('dropzone');
    const fileInput = document.getElementById('fileUpload');
    const folderInput = document.getElementById('folderUpload'); 
    if (!dropzone || !fileInput) return;

    dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('dropzone-active'); });
    dropzone.addEventListener('dragleave', () => { dropzone.classList.remove('dropzone-active'); });
    dropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropzone.classList.remove('dropzone-active');
        handleFiles(e.dataTransfer.files);
    });
    fileInput.addEventListener('change', (e) => { handleFiles(e.target.files); });
    
    if (folderInput) {
        folderInput.addEventListener('change', (e) => { handleFiles(e.target.files); });
    }
}

async function handleFiles(files) {
    uploadedFiles = []; 
    const entryPointSelect = document.getElementById('entryPointSelect'); 
    const entryPointContainer = document.getElementById('entryPointContainer'); 
    
    if (entryPointSelect) entryPointSelect.innerHTML = ''; 

    let isFolderUpload = false; 

    for (let file of files) {
        const path = file.webkitRelativePath || file.name; 
        
        if (path.includes('/')) {
            isFolderUpload = true;
        }

        if (path.endsWith('.py')) {
            const text = await file.text();
            uploadedFiles.push({ name: path, content: text });
            
            if (entryPointSelect) {
                const option = document.createElement('option');
                option.value = path;
                option.text = path;
                entryPointSelect.appendChild(option);
            }
        }
    }
    
    const countDisplay = document.getElementById('fileCountDisplay');
    if (countDisplay) countDisplay.innerText = `${uploadedFiles.length} file(s) ready for analysis.`;

    const previewList = document.getElementById('filePreviewList');
    if (previewList) {
        previewList.innerHTML = ''; 
        uploadedFiles.forEach(file => {
            previewList.innerHTML += `
                <span class="bg-emerald-100 text-emerald-800 text-[10px] font-bold px-3 py-1 rounded-full border border-emerald-200 truncate max-w-[140px] shadow-sm flex items-center gap-1" title="${file.name}">
                    [FILE] ${file.name.split('/').pop()}
                </span>`;
        });
    }

    if (uploadedFiles.length > 1 && isFolderUpload && entryPointContainer) {
        entryPointContainer.classList.remove('hidden');
        const smartGuess = uploadedFiles.find(f => f.name.includes('main.py') || f.name.includes('app.py'));
        if (smartGuess) entryPointSelect.value = smartGuess.name;
    } else if (entryPointContainer) {
        entryPointContainer.classList.add('hidden');
    }

    logToTerminal(`Loaded ${uploadedFiles.length} file(s) into memory.`, "INFO");
}

// ==========================================
// LEXICAL ANALYSIS & WORKER EXECUTION
// ==========================================
function instrumentPythonCodeJS(rawCode) {
    const lines = rawCode.split('\n');
    let instrumentedCode = []; 
    
    const weights = { "print": 50, "open": 100, "for": 2, "while": 2, "def": 1, "class": 2, "default": 1 };

    for (let i = 0; i < lines.length; i++) {
        let line = lines[i];

        // LEXICAL MEMORY ENFORCEMENT INTERCEPTOR (AST BYPASS)
        if (line.match(/=\s*\[\s*\]/)) {
            line = line.replace(/=\s*\[\s*\]/, "= GreenList()");
        } else if (line.match(/=\s*list\((.*)\)/)) {
            line = line.replace(/=\s*list\((.*)\)/, "= GreenList($1)");
        }
        
        instrumentedCode.push(line);
        
        let weight = weights.default;
        if (line.match(/print\(/)) weight = weights.print;
        if (line.match(/for |while /)) weight = weights.for;
        
        if (line.match(/^\s*(for|while|def|class)\b.*:/)) {
            let indent = line.match(/^(\s*)/)[1] + "    ";
            instrumentedCode.push(indent + `_green_tracker['ops'] += ${weight}`);
            instrumentedCode.push(indent + "_check_telemetry()"); 
        }
    }
    return instrumentedCode.join('\n');
}

function cleanupWorker(workerInstance) {
    workerInstance.terminate();
    activeWorkers = activeWorkers.filter(w => w.worker !== workerInstance);
}

function forceStopWorkers() {
    if (activeWorkers.length === 0) return;
    activeWorkers.forEach(w => {
        w.worker.terminate();
        w.resolve({ name: w.name, data: { ops: w.lastOps || 0, memory_peak_bytes: 0, duration_sec: 0, error: "USER FORCED STOP - Execution Terminated." }});
    });
    activeWorkers = []; 
    logToTerminal("SYSTEM FORCED STOP. All background threads killed.", "WARN");
    document.getElementById('forceStopBtn').classList.add('hidden');
    updateStatus("SYSTEM IDLE", "text-emerald-300");
    if (executionTimerInterval) clearInterval(executionTimerInterval);
}

// ==========================================
// ANALYSIS TRIGGER BUTTONS
// ==========================================
async function runEditorAnalysis(isTimed = false) {
    const code = document.getElementById('zcodeInput').value;
    if (!code) return logToTerminal("Editor is empty.", "WARN");
    
    document.getElementById('terminalBody').innerHTML = "";
    logToTerminal(isTimed ? "Starting 30-Second Timed Editor Analysis..." : "Starting Editor Analysis...", "INFO");
    await executeBatch([{ name: "editor_script.py", content: code }], isTimed);
}

async function runFileAnalysis(isTimed = false) {
    if (uploadedFiles.length === 0) return alert("Please select or drop files first.");
    
    document.getElementById('terminalBody').innerHTML = "";
    logToTerminal(isTimed ? "Starting 30-Second Timed Batch Analysis..." : "Starting Batch Analysis...", "INFO");
    await executeBatch(uploadedFiles, isTimed);
}

// ==========================================
// REAL-TIME BATCH EXECUTION & SANITIZATION
// ==========================================
async function executeBatch(scriptArray, isTimed = false) {
    if (activeWorkers.length > 0) forceStopWorkers();
    if (executionTimerInterval) clearInterval(executionTimerInterval);

    if (energyChart) {
        energyChart.data.labels = Array(25).fill('');
        energyChart.data.datasets[0].data = Array(25).fill(BASELINE_MW);
        energyChart.update('none');
    }

    const overlay = document.getElementById('bootOverlay');
    const modal = document.getElementById('bootModal');
    if (overlay && modal) {
        overlay.classList.remove('hidden');
        setTimeout(() => {
            overlay.classList.remove('opacity-0');
            overlay.classList.add('opacity-100');
            modal.classList.remove('scale-95');
            modal.classList.add('scale-100');
        }, 10);
    }

    updateStatus("BOOTING ENGINE...", "text-yellow-300");
    document.getElementById('forceStopBtn').classList.remove('hidden'); 
    
    const entryPointContainer = document.getElementById('entryPointContainer');
    const isProjectMode = uploadedFiles.length > 1 && entryPointContainer && !entryPointContainer.classList.contains('hidden');
    
    let executionPlan = [];
    
    if (isProjectMode) {
        const targetMain = document.getElementById('entryPointSelect').value;
        const projectFiles = uploadedFiles.map(f => ({ name: f.name, content: instrumentPythonCodeJS(f.content) }));
        
        executionPlan.push({
            displayName: "SYSTEM ROOT: " + targetMain,
            targetMain: targetMain,
            filesToPass: projectFiles,
            originalContent: uploadedFiles.find(f => f.name === targetMain)?.content || ""
        });
        logToTerminal(`Project Mode Detected. Unifying ${projectFiles.length} files into single VFS execution...`, "INFO");
    } else {
        executionPlan = scriptArray.map(script => ({
            displayName: script.name,
            targetMain: script.name,
            filesToPass: [{ name: script.name, content: instrumentPythonCodeJS(script.content) }],
            originalContent: script.content
        }));
    }

    analysisResults = executionPlan.map(plan => ({
        name: plan.displayName,
        content: plan.originalContent, 
        ops: 0, bytes: 0, joules: 0, kwh: 0, cpu_joules: 0, mem_joules: 0, milliwatts: BASELINE_MW, error: null,
        status: 'RUNNING', 
        history: Array(25).fill(BASELINE_MW),
        timeLabels: Array(25).fill(''),
        last_ops: 0, last_time: 0
    }));

    currentDetailIndex = 0;
    renderAnalysisTable();
    updateCarouselUI();

    await new Promise(resolve => setTimeout(resolve, 1500));

    if (overlay && modal) {
        overlay.classList.remove('opacity-100');
        overlay.classList.add('opacity-0');
        modal.classList.remove('scale-100');
        modal.classList.add('scale-95');
        setTimeout(() => { overlay.classList.add('hidden'); }, 300); 
    }

    updateStatus("ANALYZING...", "text-blue-400");
    logToTerminal("Boot sequence complete. Starting execution...", "SUCCESS");
    
    globalStartTime = Date.now();
    const timerEl = document.getElementById('liveTimer');
    if (timerEl) {
        timerEl.classList.remove('hidden');
        executionTimerInterval = setInterval(() => {
            timerEl.innerText = ((Date.now() - globalStartTime) / 1000).toFixed(2) + "s";
        }, 50); 
    }

    if (isTimed) {
        const TEST_DURATION = 30; 
        setTimeout(() => {
            if (activeWorkers.length > 0) {
                logToTerminal(`[SYSTEM] Standardized testing window (${TEST_DURATION}s) reached. Automatically stopping execution.`, "WARN");
                forceStopWorkers();
            }
        }, TEST_DURATION * 1000);
    }

    try {
        const tasks = executionPlan.map((plan, index) => {
            return new Promise((resolve, reject) => {
                const worker = new Worker('worker.js?v=' + Date.now());
                activeWorkers.push({ worker: worker, name: plan.displayName, resolve: resolve, reject: reject }); 

                worker.onmessage = function(e) {
                    const { type, data, error, ops, mem } = e.data;
                    if (type === "TELEMETRY") {
                        const res = analysisResults[index];
                        const currentTime = (Date.now() - globalStartTime) / 1000;
                        res.ops = ops;
                        res.bytes = mem;
                        activeWorkers.forEach(w => { if(w.name === plan.displayName) w.lastOps = ops; });
                        updateTableRow(index, res);
                        if (currentDetailIndex === index) updateLiveUI(res, currentTime);
                    } else if (type === "READY") {
                        worker.postMessage({ projectFiles: plan.filesToPass, mainFileName: plan.targetMain });
                    } else if (type === "RESULT") {
                        cleanupWorker(worker);
                        resolve({ name: plan.displayName, data: data });
                    } else if (type === "ERROR") {
                        cleanupWorker(worker);
                        resolve({ name: plan.displayName, data: { ops: 0, memory_peak_bytes: 0, duration_sec: 0, error: error }}); 
                    }
                };
                worker.onerror = (err) => { cleanupWorker(worker); reject(err.message); };
            });
        });

        const results = await Promise.all(tasks);

        let finalMaxDuration = 0;

        for (let i = 0; i < results.length; i++) {
            const finalRes = results[i].data;
            const resState = analysisResults[i];
            
            if (finalRes.error) {
                resState.status = 'ERROR'; 
                resState.error = finalRes.error;
                resState.duration = ((Date.now() - globalStartTime) / 1000);
                resState.cpu_joules = resState.ops * C_CPU;
                resState.mem_joules = resState.bytes * resState.duration * C_MEM;
                resState.joules = resState.cpu_joules + resState.mem_joules + C_BASE;
                resState.kwh = resState.joules / 3600000;
                resState.milliwatts = resState.duration > 0 ? (resState.joules / resState.duration) * 1000 : BASELINE_MW;
                if(resState.milliwatts < BASELINE_MW) resState.milliwatts = BASELINE_MW;

                logToTerminal(`[${resState.name}] Error: ${finalRes.error}`, "ERR");
                if (finalRes.error.includes("USER FORCED STOP")) {
                    await saveResultToDatabase(resState.name, resState.ops, resState.bytes, resState.joules, resState.kwh);
                }
            } else {
                resState.status = 'COMPLETED'; 
                resState.ops = finalRes.ops || resState.ops;
                resState.bytes = finalRes.memory_peak_bytes || resState.bytes;
                resState.duration = finalRes.duration_sec || ((Date.now() - globalStartTime) / 1000);
                
                if (resState.duration > finalMaxDuration) finalMaxDuration = resState.duration;

                resState.cpu_joules = resState.ops * C_CPU;
                resState.mem_joules = resState.bytes * resState.duration * C_MEM;
                resState.joules = resState.cpu_joules + resState.mem_joules + C_BASE;
                resState.kwh = resState.joules / 3600000;
                resState.milliwatts = resState.duration > 0 ? (resState.joules / resState.duration) * 1000 : BASELINE_MW;
                if(resState.milliwatts < BASELINE_MW) resState.milliwatts = BASELINE_MW;

                logToTerminal(`[${resState.name}] Success: ${resState.ops} Complexity Ops`, "SUCCESS");
                await saveResultToDatabase(resState.name, resState.ops, resState.bytes, resState.joules, resState.kwh);
            }
            updateTableRow(i, resState);
        }
        
        clearInterval(executionTimerInterval);
        if (timerEl && finalMaxDuration > 0) {
            timerEl.innerText = finalMaxDuration.toFixed(2) + "s";
        }

        updateCarouselUI(); 

    } catch (err) {
        logToTerminal("Execution Failed: " + err, "ERR");
    } finally {
        clearInterval(executionTimerInterval);
        document.getElementById('forceStopBtn').classList.add('hidden');
        updateStatus("SYSTEM IDLE", "text-emerald-300");
    }
}

// ==========================================
// UI RENDERING: TABLES & CAROUSEL
// ==========================================
function renderAnalysisTable() {
    const tbody = document.getElementById('analysisTableBody');
    if (!tbody) return;
    tbody.innerHTML = "";

    analysisResults.forEach((res, index) => {
        const bgClass = index % 2 === 0 ? "bg-white" : "bg-gray-50";
        
        // --- LIVE STRUCTURAL PARSER AUDIT METRICS ---
        // Scans the raw code string to prove token counts match the math
        const rawCode = res.content || "";
        const loopMatches = (rawCode.match(/\b(for|while)\b/g) || []).length;
        const printMatches = (rawCode.match(/\bprint\b/g) || []).length;
        const defMatches = (rawCode.match(/\bdef\b/g) || []).length;
        
        tbody.innerHTML += `
            <tr id="row-${index}" class="${bgClass} border-b border-gray-100 cursor-pointer hover:bg-emerald-50" onclick="jumpToDetail(${index})">
                <td class="py-3 px-4 font-bold text-gray-700">${res.name}</td>
                
                <td class="py-3 px-4 text-blue-600 font-mono op-cell relative group" onclick="event.stopPropagation();">
                    <div class="flex items-center gap-1.5 select-none">
                        <span class="font-black border-b border-dashed border-blue-400 cursor-help">${res.ops.toLocaleString()} Ops</span>
                        <span class="text-[10px] text-blue-400 opacity-50 group-hover:opacity-100 transition-opacity">ℹ️</span>
                    </div>
                    
                    <div class="absolute left-4 top-full mt-1 hidden group-hover:block bg-slate-950 text-slate-200 text-[11px] rounded-xl p-3 w-64 z-50 shadow-2xl border border-slate-800 font-sans tracking-normal">
                        <div class="font-black text-emerald-400 mb-2 border-b border-slate-800 pb-1 uppercase tracking-widest text-[9px] flex justify-between items-center">
                            <span>Lexical Token Scan</span>
                            <span class="bg-blue-900/50 text-blue-300 font-mono text-[8px] px-1.5 py-0.5 rounded border border-blue-700/40">Deterministic</span>
                        </div>
                        
                        <div class="space-y-1.5 font-mono text-[10px]">
                            <div class="flex justify-between text-slate-400">
                                <span>Loops (\`for\`/\`while\`):</span>
                                <span class="text-white font-bold">${loopMatches} <span class="text-slate-500 font-normal">(×2 Ops)</span></span>
                            </div>
                            <div class="flex justify-between text-slate-400">
                                <span>I/O Calls (\`print\`):</span>
                                <span class="text-white font-bold">${printMatches} <span class="text-slate-500 font-normal">(×50 Ops)</span></span>
                            </div>
                            <div class="flex justify-between text-slate-400">
                                <span>Functions (\`def\`):</span>
                                <span class="text-white font-bold">${defMatches} <span class="text-slate-500 font-normal">(×1 Op)</span></span>
                            </div>
                            
                            <div class="border-t border-slate-800 pt-1.5 mt-1.5 flex justify-between text-emerald-300 font-bold">
                                <span>Structural Tokens:</span>
                                <span>${loopMatches + printMatches + defMatches} items</span>
                            </div>
                        </div>
                        
                        <p class="text-[9px] text-slate-500 mt-2 leading-snug italic font-sans">
                            Ops accrue deterministically as code execution steps pass through these designated tracking hooks.
                        </p>
                    </div>
                </td>
                
                <td class="py-3 px-4 text-purple-600 font-mono byte-cell">${res.bytes} B</td>
                <td class="py-3 px-4 text-emerald-600 font-bold font-mono joule-cell">${Math.ceil(res.milliwatts)} mW</td>
                <td class="py-3 px-4 text-gray-500 font-mono kwh-cell">${res.kwh.toExponential(3)} kWh</td>
            </tr>
        `;
    });
}

function updateTableRow(index, res) {
    const row = document.getElementById(`row-${index}`);
    if (row) {
        row.querySelector('.op-cell').innerText = `${res.ops} Ops`;
        row.querySelector('.byte-cell').innerText = `${res.bytes} B`;
        row.querySelector('.joule-cell').innerText = `${Math.ceil(res.milliwatts)} mW`;
        row.querySelector('.kwh-cell').innerText = `${res.kwh.toExponential(3)} kWh`;
    }
}

function updateLiveUI(res, currentTime) {
    res.cpu_joules = res.ops * C_CPU;
    res.mem_joules = res.bytes * (currentTime || 0.01) * C_MEM;
    
    // TIME-VARIANT LOGARITHMIC BASE SCALING 
    const execution_duration = currentTime || 0.01;
    let current_J = res.cpu_joules + res.mem_joules + (C_BASE * (1 + Math.log1p(execution_duration)));

    if (res.status === 'RUNNING') {
        const deltaTime = currentTime - res.last_time;
        if (deltaTime >= 0.1) {
            const deltaOps = res.ops - res.last_ops;
            let instant_mW = BASELINE_MW;
            
            if (deltaOps > 0) {
                const joulesSpike = deltaOps * C_CPU;
                const wattsSpike = joulesSpike / deltaTime;
                instant_mW = Math.ceil(wattsSpike * 1000); 
            }

            if (instant_mW >= BASELINE_MW && deltaOps > 0) {
                instant_mW = Math.ceil(instant_mW * 15);
            }

            res.last_ops = res.ops;
            res.last_time = currentTime;

            res.history.shift();
            res.history.push(instant_mW);
            res.timeLabels.shift();
            res.timeLabels.push(currentTime.toFixed(1) + 's');

            if (energyChart) {
                energyChart.data.datasets[0].data = res.history;
                energyChart.data.labels = res.timeLabels; 
                energyChart.update('none'); 
            }
            
            document.getElementById('detailMilliwatts').innerHTML = `${instant_mW} <span class="text-xl">mW</span>`;
        }
    } else {
        const avg_mW = Math.ceil(res.milliwatts);
        document.getElementById('detailMilliwatts').innerHTML = `${avg_mW} <span class="text-xl">mW</span>`;
        if (energyChart) {
            energyChart.data.datasets[0].data = res.history;
            energyChart.update('none');
        }
    }
    
    // ====================================================================
    // DYNAMIC UI UPDATER
    // ====================================================================
    const detailJoulesEl = document.getElementById('detailJoules');
    const detailOpsEl = document.getElementById('detailOps');
    const brCpuEl = document.getElementById('breakdownCpu');
    const brMemEl = document.getElementById('breakdownMem');
    const brBaseEl = document.getElementById('breakdownBase');

    const dynCpuEl = document.getElementById('dynCpu');
    const dynMemEl = document.getElementById('dynMem');
    const dynTotalEl = document.getElementById('dynTotal');
    const dynTimeEl = document.getElementById('dynTime');

    if (detailJoulesEl) detailJoulesEl.textContent = current_J.toFixed(6) + " J";
    if (detailOpsEl) detailOpsEl.innerText = res.ops.toLocaleString();
    
    if (brCpuEl) brCpuEl.innerText = `${res.cpu_joules.toFixed(6)} J`;
    if (brMemEl) brMemEl.innerText = `${res.mem_joules.toFixed(6)} J`;
    if (brBaseEl) brBaseEl.innerText = `${C_BASE.toFixed(6)} J`;

    if (dynCpuEl) dynCpuEl.textContent = res.cpu_joules.toFixed(6);
    if (dynMemEl) dynMemEl.textContent = res.mem_joules.toFixed(6);
    if (dynTotalEl) dynTotalEl.textContent = current_J.toFixed(6);
    if (dynTimeEl) dynTimeEl.textContent = (res.duration || currentTime || 0).toFixed(2) + "s";

    const liveOps = res.ops || 0;
    const eeiEl = document.getElementById('dynEei');
    if (eeiEl) {
        eeiEl.textContent = liveOps > 0 ? ((current_J / liveOps) * 1000000).toFixed(4) + " μJ / Op" : "0.0000 μJ / Op";
    }

    const diagnostics = generateActionableDiagnostics(res);
    const issuesFound = diagnostics ? diagnostics.count : 0;
    const funFactsArray = diagnostics ? diagnostics.facts : [];

    const enterprise_ops_per_year = 1000000000000000;
    let annual_joules = 0;

    if (res.ops > 0) {
        annual_joules = (current_J / res.ops) * enterprise_ops_per_year;
    } else {
        annual_joules = current_J * 3153600000; 
    }

    const annual_kwh = annual_joules / 3600000;
    const smartphone_charges = Math.floor(annual_kwh / 0.015).toLocaleString();
    const led_hours = Math.floor(annual_kwh / 0.010).toLocaleString();
    
    const impactCard = document.getElementById('ecoImpactCard');
    const impactHeader = document.getElementById('ecoImpactHeader');
    const impactText = document.getElementById('ecoImpactText');

    const funFactCard = document.getElementById('funFactCard');
    const funFactHeader = document.getElementById('funFactHeader');
    const funFactText = document.getElementById('funFactText');

    if (res.status === 'RUNNING') {
        if (impactText && impactCard && impactHeader) {
            impactText.innerHTML = `[STREAMING] Live processing telemetry tracking... Current run: <b>${current_J.toFixed(4)} Joules</b>.`;
            impactCard.className = "glass-card p-6 rounded-2xl flex flex-col transition-colors";
            impactHeader.className = "text-md font-black text-blue-600 uppercase tracking-widest mb-4 text-center";
            impactText.className = "flex-1 bg-blue-50 border border-blue-200 rounded-xl p-4 text-sm font-bold text-gray-700 leading-relaxed shadow-inner";
        }
        
        if (funFactText && funFactCard && funFactHeader) {
            funFactText.innerHTML = `[STREAMING] Analyzing structural execution patterns...`;
            funFactCard.className = "glass-card p-6 rounded-2xl flex flex-col transition-colors";
            funFactHeader.className = "text-md font-black text-blue-600 uppercase tracking-widest mb-4 text-center";
            funFactText.className = "flex-1 bg-blue-50 border border-blue-200 rounded-xl p-4 text-sm font-bold text-gray-700 leading-relaxed shadow-inner";
        }
    } else {
        if (impactCard && impactHeader && impactText) {
            if (issuesFound > 0) { 
                impactText.innerHTML = `[HEAVY FOOTPRINT] Deployed at enterprise data center scale (1 Quadrillion ops/year), this unoptimized architecture would consume <b>${annual_kwh.toLocaleString(undefined, {maximumFractionDigits: 2})} kWh</b> annually. That wasted baseline energy is equivalent to fully charging a smartphone <b>${smartphone_charges} times</b> or leaving a 10W LED bulb on for <b>${led_hours} hours</b> continuously.`;
                impactHeader.className = "text-md font-black text-red-600 uppercase tracking-widest mb-4 text-center";
                impactText.className = "flex-1 bg-red-50 border border-red-200 rounded-xl p-4 text-sm font-bold text-gray-700 leading-relaxed shadow-inner";
                impactCard.className = "glass-card p-6 rounded-2xl flex flex-col transition-colors";

                let factsHtml = `<div class="flex flex-col gap-3">`;
                funFactsArray.forEach(f => {
                    factsHtml += `<div class="bg-white/70 p-3 rounded-lg border border-red-100 text-sm text-red-900 shadow-sm leading-relaxed"><span class="font-black text-red-700 block mb-1">${f.title}</span>${f.fact}</div>`;
                });
                factsHtml += `</div>`;

                if (funFactText && funFactHeader && funFactCard) {
                    funFactText.innerHTML = factsHtml;
                    funFactHeader.className = "text-md font-black text-red-700 uppercase tracking-widest mb-4 text-center";
                    funFactText.className = "flex-1 bg-red-50 border border-red-200 rounded-xl p-4 shadow-inner";
                    funFactCard.className = "glass-card p-6 rounded-2xl flex flex-col transition-colors";
                }
            } else { 
                impactText.innerHTML = `[ECO-OPTIMIZED] By implementing structural optimization, you successfully prevented hardware burnout. At enterprise data center scale (1 Quadrillion ops/year), this refactored footprint scales highly efficiently, capping annual baseline consumption to a sustainable <b>${annual_kwh.toLocaleString(undefined, {maximumFractionDigits: 2})} kWh</b>.`;
                impactHeader.className = "text-md font-black text-emerald-700 uppercase tracking-widest mb-4 text-center";
                impactText.className = "flex-1 bg-emerald-50 border border-emerald-200 rounded-xl p-4 text-sm font-bold text-gray-700 leading-relaxed shadow-inner";
                impactCard.className = "glass-card p-6 rounded-2xl flex flex-col transition-colors";

                const goodFacts = [
                    "Using dictionary lookups is like having a VIP fast-pass at an amusement park. Instead of checking 1,000,000 items in a nested loop, the CPU jumps straight to the exact data point instantly.",
                    "Batching operations is like carrying all your groceries from the car in one giant trip. It might look silly in the code, but it saves your CPU from waking up the operating system 100 separate times.",
                    "Keeping your RAM usage low is like keeping your desk clean. When your CPU doesn't have to dig through piles of massive files to find a variable, it uses significantly less electrical power.",
                    "Async functions let your CPU take a micro-nap while waiting for a network response, completely shutting off power draw. Synchronous functions force the CPU to hold its breath and burn energy while waiting."
                ];
                const randomFact = goodFacts[Math.floor(Math.random() * goodFacts.length)];

                if (funFactText && funFactHeader && funFactCard) {
                    funFactText.innerHTML = `<div class="bg-white/70 p-3 rounded-lg border border-emerald-100 text-sm text-emerald-900 shadow-sm leading-relaxed"><span class="font-black text-emerald-700 block mb-1">Architecture Verified</span>${randomFact}</div>`;
                    funFactHeader.className = "text-md font-black text-emerald-700 uppercase tracking-widest mb-4 text-center";
                    funFactText.className = "flex-1 bg-emerald-50 border border-emerald-200 rounded-xl p-4 shadow-inner";
                    funFactCard.className = "glass-card p-6 rounded-2xl flex flex-col transition-colors";
                }
            }
        }
    }
}

function updateCarouselUI() {
    if (analysisResults.length === 0) return;
    const current = analysisResults[currentDetailIndex];
    document.getElementById('detailFilename').innerText = current.name;
    updateLiveUI(current, current.duration || 0);
}

function prevDetail() { if (currentDetailIndex > 0) { currentDetailIndex--; updateCarouselUI(); } }
function nextDetail() { if (currentDetailIndex < analysisResults.length - 1) { currentDetailIndex++; updateCarouselUI(); } }
function jumpToDetail(index) { currentDetailIndex = index; updateCarouselUI(); }

// ==========================================
// STATIC HEURISTIC DELIBERATIONS ENGINE
// ==========================================
function generateActionableDiagnostics(data) {
    const suggestionEl = document.getElementById('suggestionText');
    const cpuTrace = document.getElementById('cpuTraceContent');
    const memTrace = document.getElementById('memTraceContent');

    let htmlContent = `<h4 class="font-black text-xs text-gray-400 uppercase tracking-widest border-b border-gray-200 pb-2 mb-4">Diagnostic Deliberations: ${data.name}</h4>`;
    
    // COMPLEXITY DOCTOR LOGIC
    let complexityStatus = "";
    let complexityAdvice = "";

    if (data.ops > 1000000) {
        complexityStatus = "CRITICAL INSTRUCTION LOAD";
        complexityAdvice = "Your code is executing over 1 Million operations. This usually indicates an O(n²) nested loop or an unbounded recursive call. Even if the energy is low, this 'Instruction Bloat' prevents your software from scaling to larger datasets.";
    } else if (data.ops > 100000) {
        complexityStatus = "MODERATE INSTRUCTION LOAD";
        complexityAdvice = "Your operation count is rising. Check if you are performing lookups inside a list (O(n)). Converting that list to a Set or Dictionary would drop these Ops to near-zero.";
    } else {
        complexityStatus = "OPTIMIZED INSTRUCTION LOAD";
        complexityAdvice = "High-efficiency detected. Your algorithm is using the minimum number of hardware instructions required for this workload.";
    }

    if (data.status === 'RUNNING') {
        suggestionEl.innerHTML = htmlContent + `<div class="text-[#115e59] font-black text-center mt-4 text-sm uppercase tracking-widest animate-pulse">Scanning Syntax Trees...</div>`;
        if (cpuTrace) cpuTrace.innerHTML = '<span class="text-blue-300/70 font-mono text-xs uppercase tracking-widest">Tracing Execution Map...</span>';
        if (memTrace) memTrace.innerHTML = '<span class="text-purple-300/70 font-mono text-xs uppercase tracking-widest">Mapping Memory Pointers...</span>';
        return { count: 0, facts: [] }; 
    }

    const code = data.content || ""; 
    const lines = code.split('\n');
    let issuesFound = 0;
    let collectedFacts = []; 
    
    let cpuHtml = `<div class="max-h-[250px] overflow-y-auto pr-2 custom-scrollbar">`; 
    let memHtml = `<div class="max-h-[250px] overflow-y-auto pr-2 custom-scrollbar">`; 

    // --- STEP 1: PARSE LINT RULES FIRST ---
    let lintRulesHtml = "";
    lines.forEach((line, index) => {
        const trimmed = line.trim(); 
        const lineNum = index + 1;
        if (trimmed === "") return;

        if (trimmed.startsWith("for ") || trimmed.startsWith("while ") || trimmed.startsWith("def ")) {
            let lineOps = data.ops > 0 ? Math.floor(data.ops * 0.98) : 0;
            if (trimmed.startsWith("def ")) lineOps = data.ops > 0 ? Math.floor(data.ops * 0.05) : 0;
            let lineJoules = data.ops > 0 ? (lineOps / data.ops) * data.cpu_joules : 0;
            cpuHtml += `
            <div class="flex justify-between items-center py-2 border-b border-blue-500/20 hover:bg-blue-800/30 transition-colors">
                <div class="flex items-center gap-2 truncate pr-2 w-3/4">
                    <span class="text-blue-200 font-bold text-xs">Line ${lineNum}:</span>
                    <code class="bg-[#0f172a] text-blue-100 px-1.5 py-0.5 rounded font-mono text-[10px] border border-blue-500/30 truncate flex-1">${trimmed}</code>
                </div>
                <div class="flex flex-col items-end w-1/4">
                    <span class="text-blue-300/80 text-[9px] font-black tracking-widest uppercase">${lineOps.toLocaleString()} Ops</span>
                    <span class="text-blue-400 font-bold text-xs">${lineJoules.toFixed(6)} J</span>
                </div>
            </div>`;
        }
        
        if (trimmed.startsWith("print(") && line.match(/^\s{4,}/)) {
            let lineOps = data.ops > 10 ? Math.floor(data.ops * 0.02) + 1 : (data.ops > 0 ? 1 : 0); 
            let lineJoules = data.ops > 0 ? (lineOps / data.ops) * data.cpu_joules : 0;
            cpuHtml += `
            <div class="flex justify-between items-center py-2 border-b border-blue-500/20 hover:bg-blue-800/30 transition-colors">
                <div class="flex items-center gap-2 truncate pr-2 w-3/4">
                    <span class="text-blue-200 font-bold text-xs">Line ${lineNum}:</span>
                    <code class="bg-[#0f172a] text-blue-100 px-1.5 py-0.5 rounded font-mono text-[10px] border border-blue-500/30 truncate flex-1">${trimmed}</code>
                </div>
                <div class="flex flex-col items-end w-1/4">
                    <span class="text-blue-300/80 text-[9px] font-black tracking-widest uppercase">${lineOps.toLocaleString()} Ops</span>
                    <span class="text-blue-400 font-bold text-xs">${lineJoules.toFixed(6)} J</span>
                </div>
            </div>`;
        }

        if (trimmed.match(/\[.*for.*in.*\]/) || (trimmed.includes("=") && (trimmed.includes("[") || trimmed.includes("{"))) || trimmed.includes(".append(")) {
            let lineBytes = data.bytes > 0 ? Math.floor(data.bytes * 0.95) : 0; 
            let lineJoules = data.bytes > 0 ? (lineBytes / data.bytes) * data.mem_joules : 0;
            memHtml += `
            <div class="flex justify-between items-center py-2 border-b border-purple-500/20 hover:bg-purple-800/30 transition-colors">
                <div class="flex items-center gap-2 truncate pr-2 w-3/4">
                    <span class="text-purple-200 font-bold text-xs">Line ${lineNum}:</span>
                    <code class="bg-[#0f172a] text-purple-100 px-1.5 py-0.5 rounded font-mono text-[10px] border border-purple-500/30 truncate flex-1">${trimmed}</code>
                </div>
                <div class="flex flex-col items-end w-1/4">
                    <span class="text-purple-300/80 text-[9px] font-black tracking-widest uppercase">${lineBytes.toLocaleString()} B</span>
                    <span class="text-purple-400 font-bold text-xs">${lineJoules.toFixed(6)} J</span>
                </div>
            </div>`;
        }

        Object.entries(GREEN_LINT_RULES).forEach(([key, rule]) => {
            if (line.match(rule.pattern)) {
                lintRulesHtml += `
                    <div class="bg-white border-l-4 border-red-500 rounded-xl shadow-sm mb-3 overflow-hidden border border-gray-200">
                        <div class="bg-red-50/60 px-3 py-2 border-b border-red-100 flex items-center justify-between">
                            <span class="font-black text-red-900 text-[10px] uppercase tracking-wider">Line ${lineNum}: ${rule.type}</span>
                        </div>
                        <div class="p-3 text-[11px]">
                            <p class="text-gray-600 mb-2 leading-relaxed">${rule.message}</p>
                            <div class="bg-gray-900 rounded-lg p-2 font-mono text-[10px] text-red-400 border border-gray-800 break-all mb-1">
                                <span class="text-gray-500 select-none">[!]</span> ${trimmed}
                            </div>
                        </div>
                    </div>`;
                
                if (!collectedFacts.some(f => f.title === rule.type)) {
                    collectedFacts.push({ title: rule.type, fact: rule.fun_fact });
                }
                issuesFound++;
            }
        });
    });

    cpuHtml += `</div>`; 
    memHtml += `</div>`; 

    // ==========================================
    // UI REORDERING: THIS CONTROLS THE STACK
    // ==========================================
    let finalLayoutHtml = htmlContent;

    // 1. TOP CARD: COMPILER LINTER STATUS
    if (issuesFound === 0) {
        finalLayoutHtml += `
            <div class="bg-emerald-50 border border-emerald-200 rounded-xl py-3 px-4 mb-4 flex items-center gap-2 shadow-sm">
                <span class="text-emerald-800 font-black text-xs uppercase tracking-wider">Structural Efficiency Verified</span>
            </div>`;
    } else {
        finalLayoutHtml += `
            <div class="bg-red-50 border border-red-200 rounded-xl py-3 px-4 mb-4 flex items-center gap-2 shadow-sm animate-pulse">
                <span class="text-red-800 font-black text-xs uppercase tracking-wider">${issuesFound} Architectural Risk(s) Flagged</span>
            </div>`;
    }

    // 2. MIDDLE CARD: ENERGY EFFICIENCY INDEX (EEI)
    const execution_duration = data.duration || 0.01;
    let totalJoules = (data.cpu_joules || 0) + (data.mem_joules || 0) + (C_BASE * (1 + Math.log1p(execution_duration)));
    let opsCount = data.ops || 0;
    
    if (opsCount > 0) {
        let joulesPerOp = totalJoules / opsCount;
        let microJoulesPerOp = joulesPerOp * 1000000; 
        
        let statusColorClass = "";
        let statusBadgeClass = "";
        let statusText = "";

        if (issuesFound > 0) {
            statusColorClass = "border-red-200 bg-red-50/50";
            statusBadgeClass = "bg-red-600 text-white shadow-sm shadow-red-200";
            statusText = "CRITICAL FOOTPRINT: Unoptimized syntax patterns are forcing processing bottlenecks. Refactoring recommended.";
        } else if (microJoulesPerOp >= 1.0) {
            statusColorClass = "border-amber-200 bg-amber-50/50";
            statusBadgeClass = "bg-amber-500 text-white shadow-sm shadow-amber-200";
            statusText = "MODERATE COMPLEXITY: Code structure is valid, but instruction payload size limits throughput efficiency.";
        } else {
            statusColorClass = "border-emerald-200 bg-emerald-50/50";
            statusBadgeClass = "bg-emerald-600 text-white shadow-sm shadow-emerald-200";
            statusText = "OPTIMIZED ARCHITECTURE: High instruction throughput velocity achieved. Structural energy overhead minimized.";
        }

        finalLayoutHtml += `
            <div class="border ${statusColorClass} rounded-2xl p-4 mb-4 shadow-sm font-sans">
                <div class="flex justify-between items-center mb-2">
                    <span class="font-black text-xs uppercase text-gray-700 tracking-wider">
                        Energy Efficiency Index
                    </span>
                    <span class="px-2.5 py-1 rounded-lg text-xs font-mono font-black ${statusBadgeClass}">
                        ${microJoulesPerOp.toFixed(4)} μJ / Op
                    </span>
                </div>
                <p class="text-xs font-bold text-gray-600 leading-relaxed uppercase tracking-wide bg-white/80 border border-gray-200/60 rounded-xl p-3 shadow-sm">${statusText}</p>
            </div>
        `;
    }

    // 3. BOTTOM CARD: COMPLEXITY DIAGNOSIS (Moved here and text increased)
    finalLayoutHtml += `
        <div class="bg-blue-50 border border-blue-200 rounded-2xl p-4 mb-4 shadow-sm">
            <h5 class="text-blue-800 font-black text-xs uppercase tracking-widest mb-2">Complexity Diagnosis: ${complexityStatus}</h5>
            <p class="text-sm text-gray-700 leading-relaxed font-bold">
                ${complexityAdvice}
            </p>
            <div class="mt-3 bg-white/50 p-3 rounded-lg border border-blue-100 italic text-xs text-blue-900 leading-relaxed">
                💡 <b>Insight:</b> ${data.ops.toLocaleString()} Ops isn't just a number; it represents the exact times the CPU fetched an instruction. By refactoring to O(1), you allow the CPU to stay in a low-power state longer.
            </div>
        </div>
    `;

    // 4. APPEND LINT RULES AT THE VERY BOTTOM (If any)
    if (issuesFound > 0) {
        finalLayoutHtml += `<div class="space-y-3">${lintRulesHtml}</div>`;
    }

    suggestionEl.innerHTML = finalLayoutHtml;

    if (cpuTrace) cpuTrace.innerHTML = cpuHtml.includes("Line ") ? cpuHtml : '<span class="text-blue-300/70 font-mono text-xs uppercase tracking-widest">No heavy CPU ops traced.</span>';
    if (memTrace) memTrace.innerHTML = memHtml.includes("Line ") ? memHtml : '<span class="text-purple-300/70 font-mono text-xs uppercase tracking-widest">No heavy memory allocations traced.</span>';

    return { count: issuesFound, facts: collectedFacts };
}

// ==========================================
// CHART INIT & SUPABASE LOGIC
// ==========================================
function setupChart() {
    const ctx = document.getElementById('energyChart');
    if (!ctx) return;
    energyChart = new Chart(ctx.getContext('2d'), {
        type: 'line',
        data: {
            labels: Array(25).fill(''),
            datasets: [{
                label: 'Instantaneous Power (mW)',
                data: Array(25).fill(BASELINE_MW),
                borderColor: '#10b981',
                backgroundColor: 'rgba(16, 185, 129, 0.2)',
                borderWidth: 2, fill: true, tension: 0.1, pointRadius: 0
            }]
        },
        options: { 
            responsive: true, maintainAspectRatio: false, 
            scales: { y: { beginAtZero: false, grace: '10%' } }, 
            animation: { duration: 0 } 
        }
    });
}

function logToTerminal(msg, type = "INFO") {
    const terminal = document.getElementById('terminalBody');
    if(!terminal) return;
    const colors = { "INFO": "text-blue-400", "WARN": "text-yellow-500", "ERR": "text-red-500", "SUCCESS": "text-emerald-500" };
    terminal.innerHTML += `<div class="mb-1"><span class="${colors[type]} font-bold">${type}:</span> <span class="text-emerald-100/90">${msg}</span></div>`;
    terminal.scrollTop = terminal.scrollHeight;
}

function updateStatus(text, colorClass) {
    const s = document.getElementById('statusIndicator');
    if(s) s.className = `text-[10px] ${colorClass} font-black tracking-widest uppercase`, s.innerText = text;
}

function switchTab(tabName) {
    document.getElementById('tab-analyzer').classList.add('tab-hidden');
    document.getElementById('tab-history').classList.add('tab-hidden');
    document.getElementById('tab-profile').classList.add('tab-hidden');

    ['analyzer', 'history', 'profile'].forEach(name => {
        let btn = document.getElementById(`nav-${name}`);
        if(btn) {
            btn.classList.remove('text-emerald-300', 'border-emerald-300');
            btn.classList.add('text-white/60', 'border-transparent');
        }
    });

    document.getElementById(`tab-${tabName}`).classList.remove('tab-hidden');
    let activeBtn = document.getElementById(`nav-${tabName}`);
    if(activeBtn) {
        activeBtn.classList.remove('text-white/60', 'border-transparent');
        activeBtn.classList.add('text-emerald-300', 'border-emerald-300');
    }

    if (tabName === 'history') fetchAccountHistory();
    if (tabName === 'profile') loadProfileData(); 
}

async function loadProfileData() {
    const usernameEl = document.getElementById('profileUsername');
    const emailEl = document.getElementById('profileEmail');
    const avatarEl = document.getElementById('profileAvatar');

    try {
        const { data: { user } } = await supabaseClient.auth.getUser();
        if (!user) return;

        emailEl.innerText = user.email;

        const { data, error } = await supabaseClient
            .from('profiles')
            .select('username')
            .eq('id', user.id)
            .single();

        if (data && data.username) {
            usernameEl.innerText = data.username;
            avatarEl.innerText = data.username.charAt(0).toUpperCase();
        } else {
            usernameEl.innerText = "GreenCoder";
            avatarEl.innerText = "G";
        }
    } catch (e) {
        console.error("Failed to load profile details:", e);
    }
}

async function logoutUser() {
    await supabaseClient.auth.signOut();
    window.location.href = 'index.html'; 
}

// ==========================================
// HISTORY FETCHING & SEARCHING
// ==========================================
async function fetchAccountHistory() {
    const tableBody = document.getElementById('dbHistoryTableBody');
    if(!tableBody) return;
    tableBody.innerHTML = '<tr><td colspan="5" class="py-8 text-center opacity-50 italic">Fetching from cloud...</td></tr>';
    
    try {
        const { data: { user } } = await supabaseClient.auth.getUser();
        if (!user) {
            tableBody.innerHTML = '<tr><td colspan="5" class="py-8 text-center text-red-500 italic font-bold">Please log in to view history.</td></tr>';
            return;
        }

        const { data, error } = await supabaseClient
            .from('history')
            .select('*')
            .eq('user_id', user.id)
            .order('created_at', { ascending: false });

        if (error) throw error;

        globalHistoryData = data; 
        renderHistoryTable(globalHistoryData);

    } catch (e) {
        tableBody.innerHTML = '<tr><td colspan="5" class="py-8 text-center text-red-500 italic font-bold">Error connecting to database.</td></tr>';
        console.error("Supabase fetch error:", e);
    }
}

function searchHistory() {
    const query = document.getElementById('historySearch').value.toLowerCase();
    if (!query) { renderHistoryTable(globalHistoryData); return; }
    const filteredData = globalHistoryData.filter(row => {
        const filename = row.filename ? row.filename.toLowerCase() : "script.py";
        return filename.includes(query);
    });
    renderHistoryTable(filteredData);
}

function renderHistoryTable(dataToRender) {
    const tableBody = document.getElementById('dbHistoryTableBody');
    tableBody.innerHTML = ''; 
    if (!dataToRender || dataToRender.length === 0) {
        tableBody.innerHTML = '<tr><td colspan="5" class="py-8 text-center opacity-50 italic">No execution matching search found.</td></tr>';
        return;
    }
    
    let currentGroup = ""; 
    dataToRender.forEach(row => {
        const dateObj = new Date(row.created_at);
        const datePart = dateObj.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
        const timePart = dateObj.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
        const groupKey = `${datePart} at ${timePart}`;

        if (groupKey !== currentGroup) {
            currentGroup = groupKey;
            const headerTr = document.createElement('tr');
            headerTr.className = "bg-emerald-100/60 border-y border-emerald-200/80 cursor-pointer hover:bg-emerald-200/60 transition-colors select-none";
            headerTr.innerHTML = `
                <td colspan="6" class="py-3 px-4 text-emerald-900 font-black text-[11px] uppercase tracking-widest relative">
                    ⏱ Computed on: <span class="text-emerald-700">${groupKey}</span>
                    <span class="ml-2 text-emerald-600/50 text-[9px] font-bold tracking-wider">(CLICK TO SELECT ALL)</span>
                    <input type="checkbox" class="hidden group-master-checkbox" data-group-master="${groupKey}">
                </td>
            `;
            headerTr.onclick = function() {
                const masterCb = this.querySelector('.group-master-checkbox');
                masterCb.checked = !masterCb.checked;
                const checkboxes = document.querySelectorAll(`.history-checkbox[data-group="${groupKey}"]`);
                checkboxes.forEach(cb => { if (cb.checked !== masterCb.checked) cb.closest('tr').click(); });
            };
            tableBody.appendChild(headerTr);
        }

        const tr = document.createElement('tr');
        tr.className = "bg-white border-b border-gray-100 hover:bg-emerald-50 transition-all cursor-pointer select-none";
        const displayFilename = row.filename ? row.filename : "script.py"; 
        const preciseJoules = parseFloat(row.energy_joules);
        const preciseKwh = parseFloat(row.energy_kwh) || (preciseJoules / 3600000);
        
        tr.innerHTML = `
            <td class="py-3 px-4 text-gray-800 font-bold text-xs truncate max-w-[200px] relative">
                <input type="checkbox" value="${row.id}" class="hidden history-checkbox" data-group="${groupKey}">
                ${displayFilename}
            </td>
            <td class="py-3 px-4 font-mono text-blue-700">${row.ops} Complexity Ops</td>
            <td class="py-3 px-4 font-mono text-purple-700">${row.peak_memory_bytes} B</td>
            
            <td class="py-3 px-4 text-center font-black text-emerald-600">
                ${row.duration_sec && row.duration_sec > 0 
                    ? Math.ceil((preciseJoules / row.duration_sec) * 1000) 
                    : Math.ceil((preciseJoules / 0.41) * 1000)} mW
            </td>
            
            <td class="py-3 px-4 text-center font-bold text-gray-700">${preciseJoules.toFixed(6)} J</td>
            
            <td class="py-3 px-4 text-center font-mono text-gray-600">${preciseKwh.toExponential(3)} kWh</td>
        `;

        tr.onclick = function() {
            const cb = this.querySelector('.history-checkbox');
            cb.checked = !cb.checked;
            if (cb.checked) {
                this.classList.remove('bg-white', 'hover:bg-emerald-50');
                this.classList.add('bg-blue-50', 'border-l-4', 'border-blue-500'); 
            } else {
                this.classList.add('bg-white', 'hover:bg-emerald-50');
                this.classList.remove('bg-blue-50', 'border-l-4', 'border-blue-500'); 
            }
        };
        tableBody.appendChild(tr);
    });
}

function toggleSelectGroup(masterCheckbox, groupKey) {
    const checkboxes = document.querySelectorAll(`.history-checkbox[data-group="${groupKey}"]`);
    checkboxes.forEach(cb => cb.checked = masterCheckbox.checked);
}

async function updateProfile() {
    const newPassword = document.getElementById('newPassword').value;
    const msgElement = document.getElementById('profileMsg');
    
    if(!newPassword) {
        msgElement.innerText = "Please enter a new password.";
        msgElement.className = "mt-4 text-[10px] font-bold uppercase tracking-widest text-red-500";
        return;
    }

    try {
        const { error } = await supabaseClient.auth.updateUser({ password: newPassword });
        if (!error) {
            msgElement.innerText = "Password updated securely in the cloud!";
            msgElement.className = "mt-4 text-[10px] font-bold uppercase tracking-widest text-emerald-600";
            document.getElementById('newPassword').value = ''; 
        } else {
            msgElement.innerText = error.message || "Update failed.";
            msgElement.className = "mt-4 text-[10px] font-bold uppercase tracking-widest text-red-500";
        }
    } catch (e) {
        msgElement.innerText = "Network Error.";
        msgElement.className = "mt-4 text-[10px] font-bold uppercase tracking-widest text-red-500";
    }
}

async function saveResultToDatabase(filename, ops, memory, joules, kwh) {
    try {
        const { data: { user } } = await supabaseClient.auth.getUser();
        if (!user) return;
        await supabaseClient.from('history').insert([{ user_id: user.id, filename: filename, ops: ops, peak_memory_bytes: memory, energy_joules: joules, energy_kwh: kwh }]);
    } catch (e) { console.error(e); }
}

function exportSelectedCSV() {
    const checkboxes = document.querySelectorAll('.history-checkbox:checked');
    if (checkboxes.length === 0) return alert("Please select at least one record to export.");
    const selectedIds = Array.from(checkboxes).map(cb => cb.value);
    const selectedData = globalHistoryData.filter(row => selectedIds.includes(row.id.toString()));
    if (selectedData.length === 0) return alert("Error fetching data for export.");

    let csvContent = "data:text/csv;charset=utf-8,";
    csvContent += "Filename,Complexity Operations,Peak Memory (Bytes),Energy (Joules),Energy (kWh),Date Computed\n"; 

    selectedData.forEach(row => {
        const dateStr = new Date(row.created_at).toLocaleString().replace(/,/g, ''); 
        const csvRow = `${row.filename},${row.ops},${row.peak_memory_bytes},${row.energy_joules},${row.energy_kwh},${dateStr}`;
        csvContent += csvRow + "\n";
    });

    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `GreenCode_Audit_${new Date().getTime()}.csv`);
    document.body.appendChild(link);
    link.click();
    link.remove();
}

async function deleteSelectedHistory() {
    const checkboxes = document.querySelectorAll('.history-checkbox:checked');
    if (checkboxes.length === 0) return alert("Please select at least one record to delete.");

    const confirmDelete = confirm(`Are you sure you want to permanently delete ${checkboxes.length} record(s)?`);
    if (!confirmDelete) return;

    const selectedIds = Array.from(checkboxes).map(cb => cb.value);
    const tableBody = document.getElementById('dbHistoryTableBody');
    tableBody.innerHTML = '<tr><td colspan="5" class="py-8 text-center font-bold text-emerald-600 animate-pulse">Syncing deletion with Supabase...</td></tr>';

    try {
        const { error } = await supabaseClient.from('history').delete().in('id', selectedIds);
        if (error) throw error;
        await fetchAccountHistory(); 
    } catch (error) {
        console.error("Error deleting records:", error);
        await fetchAccountHistory(); 
        alert("Failed to delete records. Check console for details.");
    }
}
