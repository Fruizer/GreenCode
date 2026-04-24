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

const C_CPU = 1.5e-9;
const C_MEM = 2.25e-9;
const C_BASE = 0.0005;

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

    if (!dropzone || !fileInput) return;

    dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('dropzone-active'); });
    dropzone.addEventListener('dragleave', () => { dropzone.classList.remove('dropzone-active'); });
    dropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropzone.classList.remove('dropzone-active');
        handleFiles(e.dataTransfer.files);
    });

    fileInput.addEventListener('change', (e) => { handleFiles(e.target.files); });
}

async function handleFiles(files) {
    uploadedFiles = []; 
    for (let file of files) {
        if (file.name.endsWith('.py')) {
            const text = await file.text();
            uploadedFiles.push({ name: file.name, content: text });
        }
    }
    
    const countDisplay = document.getElementById('fileCountDisplay');
    if (countDisplay) countDisplay.innerText = `${uploadedFiles.length} file(s) ready for analysis.`;
    logToTerminal(`Loaded ${uploadedFiles.length} file(s) into memory.`, "INFO");
}

// ==========================================
// LEXICAL ANALYSIS & WORKER EXECUTION
// ==========================================
function instrumentPythonCodeJS(rawCode) {
    const lines = rawCode.split('\n');
    let instrumentedCode = ['__tracker = {"ops": 0, "current_mem": 0, "peak_mem": 0}'];
    
    for (let i = 0; i < lines.length; i++) {
        let line = lines[i];
        
        if (line.match(/=\s*\[(.*?)\]/)) {
            line = line.replace(/=\s*\[(.*?)\]/g, "= GreenList([$1])");
        }
        
        instrumentedCode.push(line);
        
        if (line.match(/^\s*(for|while|def)\b.*:/)) {
            let nextLineIndent = "    "; 
            for (let j = i + 1; j < lines.length; j++) {
                if (lines[j].trim() !== "") {
                    let match = lines[j].match(/^(\s+)/);
                    if (match) nextLineIndent = match[1];
                    else nextLineIndent = line.match(/^(\s*)/)[1] + "    ";
                    break;
                }
            }
            instrumentedCode.push(nextLineIndent + "__tracker['ops'] += 1");
            instrumentedCode.push(nextLineIndent + "_check_telemetry()"); 
        }
    }
    return instrumentedCode.join('\n');
}

function runWorkerTask(scriptName, rawCode, onTelemetry) {
    return new Promise((resolve, reject) => {
        const worker = new Worker('worker.js?v=' + Date.now());
        activeWorkers.push({ worker: worker, name: scriptName, resolve: resolve, reject: reject }); 

        const instrumented = instrumentPythonCodeJS(rawCode);

        worker.onmessage = function(e) {
            const { type, data, error, ops, mem } = e.data;
            
            if (type === "TELEMETRY") {
                if (onTelemetry) onTelemetry(ops, mem); 
            } else if (type === "READY") {
                worker.postMessage({ userCode: instrumented });
            } else if (type === "RESULT") {
                cleanupWorker(worker);
                resolve({ name: scriptName, data: data });
            } else if (type === "ERROR") {
                cleanupWorker(worker);
                if (error.includes("Boot Failed") || error.includes("404")) reject(error); 
                else resolve({ name: scriptName, data: { ops: 0, memory_peak_bytes: 0, duration_sec: 0, error: error }}); 
            }
        };
        worker.onerror = (err) => { cleanupWorker(worker); reject(err.message); };
    });
}

function cleanupWorker(workerInstance) {
    workerInstance.terminate();
    activeWorkers = activeWorkers.filter(w => w.worker !== workerInstance);
}

function forceStopWorkers() {
    if (activeWorkers.length === 0) return;
    activeWorkers.forEach(w => {
        w.worker.terminate();
        w.resolve({ name: w.name, data: { ops: 0, memory_peak_bytes: 0, duration_sec: 0, error: "USER FORCED STOP - Execution Terminated." }});
    });
    activeWorkers = []; 
    logToTerminal("SYSTEM FORCED STOP. All background threads killed.", "WARN");
    document.getElementById('forceStopBtn').classList.add('hidden');
    updateStatus("SYSTEM IDLE", "text-emerald-300");
}

// ==========================================
// ANALYSIS TRIGGER BUTTONS
// ==========================================
async function runEditorAnalysis() {
    const code = document.getElementById('codeInput').value;
    if (!code) return logToTerminal("Editor is empty.", "WARN");
    
    document.getElementById('terminalBody').innerHTML = "";
    logToTerminal("Starting Editor Analysis...", "INFO");
    await executeBatch([{ name: "editor_script.py", content: code }]);
}

async function runFileAnalysis() {
    if (uploadedFiles.length === 0) return alert("Please select or drop files first.");
    
    document.getElementById('terminalBody').innerHTML = "";
    logToTerminal(`Starting Batch Analysis for ${uploadedFiles.length} file(s)...`, "INFO");
    await executeBatch(uploadedFiles);
}

// ==========================================
// REAL-TIME BATCH EXECUTION
// ==========================================
async function executeBatch(scriptArray) {
    updateStatus("ANALYZING...", "text-yellow-300 animate-pulse");
    document.getElementById('forceStopBtn').classList.remove('hidden'); 
    const startTime = Date.now();

    analysisResults = scriptArray.map(script => ({
        name: script.name,
        ops: 0, bytes: 0, joules: 0, kwh: 0, error: null,
        status: 'RUNNING', // Tracks active status for the suggestions UI
        history: Array(25).fill(0) 
    }));
    
    currentDetailIndex = 0;
    renderAnalysisTable();
    updateCarouselUI();

    try {
        const tasks = scriptArray.map((script, index) => {
            return runWorkerTask(script.name, script.content, (ops, mem) => {
                const res = analysisResults[index];
                const t_exec = (Date.now() - startTime) / 1000;
                
                res.ops = ops;
                res.bytes = mem;
                res.joules = (ops * C_CPU) + (mem * t_exec * C_MEM) + C_BASE;
                res.kwh = res.joules / 3600000;

                res.history.shift();
                res.history.push(ops);

                updateTableRow(index, res);
                if (currentDetailIndex === index) updateLiveUI(res);
            });
        });

        const results = await Promise.all(tasks);
        
        for (let i = 0; i < results.length; i++) {
            const finalRes = results[i].data;
            const resState = analysisResults[i];
            
            if (finalRes.error) {
                resState.error = finalRes.error;
                logToTerminal(`[${resState.name}] Error: ${finalRes.error}`, "ERR");
                
                // If the error was a manual Force Stop, save the partial telemetry data
                if (finalRes.error.includes("USER FORCED STOP")) {
                    logToTerminal(`[${resState.name}] Saving partial telemetry to database...`, "INFO");
                    await saveResultToDatabase(resState.name, resState.ops, resState.bytes, resState.joules, resState.kwh);
                }

            } else {
                resState.status = 'COMPLETED'; // Clears the loading message
                resState.ops = finalRes.ops || resState.ops;
                resState.bytes = finalRes.memory_peak_bytes || resState.bytes;
                const t_exec_final = finalRes.duration_sec || ((Date.now() - startTime) / 1000);
                resState.joules = (resState.ops * C_CPU) + (resState.bytes * t_exec_final * C_MEM) + C_BASE;
                resState.kwh = resState.joules / 3600000;
                
                resState.history.shift();
                resState.history.push(resState.ops);

                logToTerminal(`[${resState.name}] Success: ${resState.ops} Ops`, "SUCCESS");
                
                // Passes the actual filename to the database saving function
                await saveResultToDatabase(resState.name, resState.ops, resState.bytes, resState.joules, resState.kwh);
            }
        }
        
        updateCarouselUI(); 

    } catch (err) {
        logToTerminal("Batch Execution Failed: " + err, "ERR");
    } finally {
        document.getElementById('forceStopBtn').classList.add('hidden');
        updateStatus("SYSTEM IDLE", "text-emerald-300");
    }
}

// ==========================================
// UI RENDERING & LIVE UPDATES
// ==========================================
function renderAnalysisTable() {
    const tbody = document.getElementById('analysisTableBody');
    if (!tbody) return;
    tbody.innerHTML = "";

    analysisResults.forEach((res, index) => {
        const bgClass = index % 2 === 0 ? "bg-white" : "bg-gray-50";
        tbody.innerHTML += `
            <tr id="row-${index}" class="${bgClass} border-b border-gray-100 cursor-pointer hover:bg-emerald-50" onclick="jumpToDetail(${index})">
                <td class="py-3 px-4 font-bold text-gray-700">${res.name}</td>
                <td class="py-3 px-4 text-blue-600 font-mono op-cell">${res.ops} Ops</td>
                <td class="py-3 px-4 text-purple-600 font-mono byte-cell">${res.bytes} B</td>
                <td class="py-3 px-4 text-emerald-600 font-bold font-mono joule-cell">${res.joules.toFixed(6)} J</td>
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
        row.querySelector('.joule-cell').innerText = `${res.joules.toFixed(6)} J`;
        row.querySelector('.kwh-cell').innerText = `${res.kwh.toExponential(3)} kWh`;
    }
}

function updateLiveUI(res) {
    document.getElementById('detailJoules').innerText = `${res.joules.toFixed(6)} J`;
    document.getElementById('detailOps').innerText = res.ops;

    if (energyChart) {
        energyChart.data.datasets[0].data = res.history;
        energyChart.update('none'); 
    }
}

function updateCarouselUI() {
    if (analysisResults.length === 0) return;
    const current = analysisResults[currentDetailIndex];

    // Remove the gray placeholder text formatting when a script is selected
    const filenameEl = document.getElementById('detailFilename');
    filenameEl.innerText = current.name;
    filenameEl.classList.remove('text-gray-400');
    filenameEl.classList.add('text-gray-800');

    updateLiveUI(current);
    generateSuggestions(current);
}

function prevDetail() {
    if (currentDetailIndex > 0) {
        currentDetailIndex--;
        updateCarouselUI();
    }
}

function nextDetail() {
    if (currentDetailIndex < analysisResults.length - 1) {
        currentDetailIndex++;
        updateCarouselUI();
    }
}

function jumpToDetail(index) {
    currentDetailIndex = index;
    updateCarouselUI();
}

function generateSuggestions(data) {
    let text = "";

    // 1. Always evaluate the metrics first (this retains advice even if stopped)
    if (data.bytes > 1000) text += "⚠️ High memory allocation detected. Avoid appending to large lists recursively. Try using Generators or List Comprehensions.\n\n";
    if (data.ops > 5000) text += "⚠️ High CPU operations. Check for nested loops [ O(n^2) ]. Consider using dictionaries for lookups instead of iterating through lists.\n\n";

    // 2. Append the current execution status or errors
    if (data.status === 'RUNNING') {
        text += "⏳ Compiling and executing... Live telemetry active.";
    } else if (data.error) {
        text += "🛑 " + data.error; 
    } else if (data.ops === 0) {
        text = "⚠️ No operations detected. Ensure you are using loops or assignments.";
    } else {
        if (text === "") text = "✅ Excellent! Your algorithm is highly efficient and Green-compliant.";
    }

    const suggestionEl = document.getElementById('suggestionText');
    suggestionEl.innerText = text.trim();
    suggestionEl.classList.remove('text-gray-600');
    suggestionEl.classList.add('text-black');
}

// ==========================================
// UTILITIES, CHART & DATABASE
// ==========================================
function setupChart() {
    const ctx = document.getElementById('energyChart');
    if (!ctx) return;
    
    energyChart = new Chart(ctx.getContext('2d'), {
        type: 'line',
        data: {
            labels: Array(25).fill(''),
            datasets: [{
                label: 'Algorithmic Load (Ops)',
                data: Array(25).fill(0),
                borderColor: '#10b981',
                backgroundColor: 'rgba(16, 185, 129, 0.2)',
                borderWidth: 2, fill: true, tension: 0.4, pointRadius: 0
            }]
        },
        options: { responsive: true, maintainAspectRatio: false, scales: { y: { beginAtZero: true } }, animation: { duration: 0 } }
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
    if(!s) return;
    s.innerText = text;
    s.className = `text-[10px] ${colorClass} font-black tracking-widest uppercase`;
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
}

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

        tableBody.innerHTML = ''; 
        if (data.length === 0) {
            tableBody.innerHTML = '<tr><td colspan="5" class="py-8 text-center opacity-50 italic">No execution history found for this account.</td></tr>';
            return;
        }
        
        let currentGroup = ""; 

        data.forEach(row => {
            const dateObj = new Date(row.created_at);
            const datePart = dateObj.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
            const timePart = dateObj.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
            const groupKey = `${datePart} at ${timePart}`;

            if (groupKey !== currentGroup) {
                currentGroup = groupKey;
                const headerTr = document.createElement('tr');
                headerTr.className = "bg-emerald-100/60 border-y border-emerald-200/80";
                headerTr.innerHTML = `
                    <td colspan="5" class="py-2 px-4 text-emerald-900 font-black text-[11px] uppercase tracking-widest">
                        ⏱ Computed on: <span class="text-emerald-700">${groupKey}</span>
                    </td>
                `;
                tableBody.appendChild(headerTr);
            }

            const tr = document.createElement('tr');
            tr.className = "bg-white border-b border-gray-100 hover:bg-emerald-50 transition-all";
            const displayFilename = row.filename ? row.filename : "script.py"; 
            
            const preciseJoules = parseFloat(row.energy_joules);
            const preciseKwh = parseFloat(row.energy_kwh) || (preciseJoules / 3600000);
            
            tr.innerHTML = `
                <td class="py-3 px-4 text-gray-800 font-bold text-xs truncate max-w-[150px]">${displayFilename}</td>
                <td class="py-3 px-4 font-mono text-blue-700">${row.ops} Ops</td>
                <td class="py-3 px-4 font-mono text-purple-700">${row.peak_memory_bytes} B</td>
                <td class="py-3 px-4 text-center font-black text-emerald-600">${preciseJoules.toFixed(6)} J</td>
                <td class="py-3 px-4 text-center font-mono text-gray-600">${preciseKwh.toExponential(3)} kWh</td>
            `;
            tableBody.appendChild(tr);
        });
    } catch (e) {
        tableBody.innerHTML = '<tr><td colspan="5" class="py-8 text-center text-red-500 italic font-bold">Error connecting to database.</td></tr>';
        console.error("Supabase fetch error:", e);
    }
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

async function logoutUser() {
    await supabaseClient.auth.signOut();
    window.location.href = 'login.html';
}

async function saveResultToDatabase(filename, ops, memory, joules, kwh) {
    try {
        const { data: { user } } = await supabaseClient.auth.getUser();
        if (!user) {
            console.warn("User not logged in. History will not be saved.");
            return;
        }

        const { error } = await supabaseClient.from('history').insert([{
            user_id: user.id,
            filename: filename,
            ops: ops,
            peak_memory_bytes: memory,
            energy_joules: joules,
            energy_kwh: kwh
        }]);

        if (error) throw error;
        console.log(`Successfully synced ${filename} data to Supabase.`);
    } catch (e) {
        console.error("Failed to sync with database:", e);
    }
}