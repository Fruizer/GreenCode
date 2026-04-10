======================================================
GreenCode Analyzer - Local Setup & Installation Guide
======================================================

PROJECT OVERVIEW
----------------
GreenCode Analyzer is a web-based, hardware-agnostic energy profiling tool. 
It uses Lexical Analysis and a Web Worker-isolated Pyodide (WebAssembly) engine 
to evaluate the algorithmic Time Complexity (Ops) and Space Complexity (Peak Memory) 
of Python 3.x scripts, converting them into estimated Joules and kWh.

PREREQUISITES
-------------
1. XAMPP (or any local server with Apache and MySQL/MariaDB)
2. Google Chrome, Microsoft Edge, or Mozilla Firefox (Latest versions)
3. The downloaded `pyodide_engine` files (if running completely offline).

======================================================
STEP 1: FOLDER STRUCTURE SETUP
======================================================
1. Open your XAMPP installation folder and navigate to the `htdocs` directory 
   (Windows: C:\xampp\htdocs\ | Mac: /Applications/XAMPP/htdocs/).
2. Create a new folder named `greencode`.
3. Place all the project files into the `greencode` folder exactly like this:

htdocs/
└── greencode/
    ├── index.html          (Main dashboard)
    ├── login.html          (Authentication page)
    ├── app.js              (Frontend logic & UI)
    ├── worker.js           (Web Worker thread & Python environment)
    ├── pyodide_engine/     (Must contain pyodide.js and associated .wasm files)*
    └── api/                (Backend PHP files)
        ├── db.php
        ├── get_history.php
        ├── login.php
        ├── logout.php
        ├── save_result.php
        ├── signup.php
        └── update_profile.php

*Note on Pyodide: If you do not have the pyodide files downloaded locally, 
open `worker.js` and change `importScripts("./pyodide_engine/pyodide.js");` 
to `importScripts("https://cdn.jsdelivr.net/pyodide/v0.24.1/full/pyodide.js");`.

======================================================
STEP 2: START LOCAL SERVERS
======================================================
1. Open the XAMPP Control Panel.
2. Click "Start" next to the [Apache] module.
3. Click "Start" next to the [MySQL] module.
(Wait until both module backgrounds turn green).

======================================================
STEP 3: DATABASE CONFIGURATION
======================================================
We need to create the database so the login and history features work.

1. Open your web browser and go to: http://localhost/phpmyadmin
2. Click on the "Databases" tab at the top.
3. Under "Create database", type: `greencode_db` and click "Create".
4. On the left sidebar, click on your newly created `greencode_db`.
5. Click on the "SQL" tab at the top of the screen.
6. Copy and paste the following SQL code into the text box and click "Go" (bottom right):

CREATE TABLE users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(50) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE execution_results (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    filename VARCHAR(255) DEFAULT 'script.py',
    ops INT NOT NULL,
    peak_memory_bytes INT NOT NULL,
    energy_joules DOUBLE NOT NULL,
    energy_kwh DOUBLE NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

======================================================
STEP 4: RUNNING THE APPLICATION
======================================================
1. Open your web browser.
2. Go to the following URL: http://localhost/greencode/login.html
3. Click "Create Account" to register a new test user.
4. Log in and start analyzing your Python scripts!

TROUBLESHOOTING
---------------
- Browser Cache Issues: If you update `app.js` or `worker.js` and the changes aren't showing up, Google Chrome might be using an old cached version. Press `F12` to open Developer Tools, right-click the browser's "Refresh" button, and select "Empty Cache and Hard Reload".
- Database Errors: Ensure XAMPP's MySQL is running. If you used a custom MySQL password during your XAMPP installation, update the `$password = '';` variable inside `api/db.php`.