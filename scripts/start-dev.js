// Dev launcher for Chorus.
// Replaces an inline `node -e "..."` in the start script that Defender's
// SuspExec heuristic flagged because it pattern-matched a malware launcher.
'use strict';

const { execSync, spawn } = require('child_process');
const path = require('path');

delete process.env.ELECTRON_RUN_AS_NODE;

const root = path.resolve(__dirname, '..');
execSync('node build.js', { stdio: 'inherit', cwd: root });

const electron = require('electron');
const child = spawn(electron, ['.'], { stdio: 'inherit', cwd: root });
child.on('exit', (code) => process.exit(code ?? 0));
