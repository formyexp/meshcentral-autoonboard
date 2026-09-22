/**
 * @description MeshCentral-AutoOnboard agent-side (meshcore) module
 * @license Apache-2.0
 *
 * Adapted from the proven script-execution approach used by MeshCentral-ScriptTask
 * (https://github.com/ryanblenis/MeshCentral-ScriptTask), renamed to its own
 * plugin/pluginaction namespace and with an added client-side timeout safety net.
 */
"use strict";
var mesh;
var _sessionid;

var debug_flag = false;
var runningJobs = {}; // dispatchId -> { pid, timer }

function dbg(str) {
    if (debug_flag !== true) return;
    try {
        var fs = require('fs');
        var logStream = fs.createWriteStream('autoonboard.txt', { flags: 'a' });
        logStream.write('\n' + new Date().toLocaleString() + ': ' + str);
        logStream.end('\n');
    } catch (e) { }
}

function consoleaction(args, rights, sessionid, parent) {
    _sessionid = sessionid;
    if (typeof args['_'] == 'undefined') {
        args['_'] = [];
        args['_'][1] = args.pluginaction;
    }
    var fnname = args['_'][1];
    mesh = parent;

    switch (fnname) {
        case 'triggerStep':
            runScript(args);
            break;
        case 'triggerFileStep':
            runFileStep(args);
            break;
        case 'debug':
            debug_flag = !debug_flag;
            return 'Debugging is now ' + (debug_flag ? 'on' : 'off');
        default:
            dbg('Unknown action: ' + fnname);
            break;
    }
}

function finalizeJob(job, retVal, errVal) {
    if (errVal != null && errVal.stack != null) errVal = errVal.stack;
    var rj = runningJobs[job.dispatchId];
    if (rj != null) {
        if (rj.timer != null) { try { clearTimeout(rj.timer); } catch (e) { } }
        delete runningJobs[job.dispatchId];
    }
    try {
        mesh.SendCommand({
            action: 'plugin',
            plugin: 'autoonboard',
            pluginaction: 'stepComplete',
            queueId: job.queueId,
            stepId: job.stepId,
            stepIndex: job.stepIndex,
            dispatchId: job.dispatchId,
            dispatchTime: job.dispatchTime,
            retVal: retVal,
            errVal: errVal,
            sessionid: _sessionid,
            tag: 'console'
        });
    } catch (e) { dbg('Could not send stepComplete: ' + e); }
}

function armTimeout(job) {
    var timeoutMs = (job.timeoutMin && job.timeoutMin > 0 ? job.timeoutMin : 10) * 60 * 1000;
    var timer = setTimeout(function () {
        var rj = runningJobs[job.dispatchId];
        if (rj == null) return; // already finished
        try {
            if (rj.pid != null) {
                if (process.platform == 'win32') {
                    try { require('child_process').execFile(process.env['windir'] + '\\system32\\taskkill.exe', ['/PID', '' + rj.pid, '/T', '/F']); } catch (e) { }
                } else {
                    try { process.kill(rj.pid, 'SIGKILL'); } catch (e) { }
                }
            }
        } catch (e) { }
        finalizeJob(job, null, 'Timeout: script did not finish within ' + job.timeoutMin + ' minute(s).');
    }, timeoutMs);
    runningJobs[job.dispatchId] = { pid: null, timer: timer };
}

function setRunningPid(dispatchId, pid) {
    if (runningJobs[dispatchId] != null) runningJobs[dispatchId].pid = pid;
}

function runPowerShell(job) {
    if (process.platform != 'win32') return runPowerShellNonWin(job);
    const fs = require('fs');
    var rand = Math.random().toString(32).replace('0.', '');
    var oName = 'ao' + rand + '.txt';
    var pName = 'ao' + rand + '.ps1';
    try {
        fs.writeFileSync(pName, job.content);
        var errstr = '';
        var child = require('child_process').execFile(process.env['windir'] + '\\system32\\WindowsPowerShell\\v1.0\\powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy Bypass']);
        setRunningPid(job.dispatchId, child.pid);
        child.stderr.on('data', function (chunk) { errstr += chunk; });
        child.stdout.on('data', function (chunk) { });
        child.stdin.write('.\\' + pName + ' | Out-File ' + oName + ' -Encoding UTF8\r\n');
        child.on('exit', function (procRetVal) {
            var outstr = '';
            if (errstr != '') { cleanup(); finalizeJob(job, null, errstr); return; }
            if (procRetVal == 1) { cleanup(); finalizeJob(job, null, 'Process terminated unexpectedly.'); return; }
            try { outstr = fs.readFileSync(oName, 'utf8').toString(); } catch (e) { outstr = (procRetVal) ? 'Failure' : 'Success'; }
            try { outstr = outstr.trim(); } catch (e) { }
            if (!outstr) outstr = (procRetVal) ? 'Failure' : 'Success';
            cleanup();
            finalizeJob(job, outstr);
        });
        child.stdin.write('exit\r\n');
        function cleanup() { try { fs.unlinkSync(oName); } catch (e) { } try { fs.unlinkSync(pName); } catch (e) { } }
    } catch (e) {
        dbg('Error (PowerShell): ' + e);
        finalizeJob(job, null, '' + e);
    }
}

function runPowerShellNonWin(job) {
    const fs = require('fs');
    var path = '';
    var pathTests = ['/usr/local/mesh', '/tmp', '/usr/local/mesh_services/meshagent', '/var/tmp'];
    pathTests.forEach(function (p) { if (path == '' && fs.existsSync(p)) path = p; });
    path = path + '/';
    var rand = Math.random().toString(32).replace('0.', '');
    var oName = 'ao' + rand + '.txt';
    var pName = 'ao' + rand + '.ps1';
    var pwshout = '', pwsherr = '';
    try {
        var childp = require('child_process').execFile('/bin/sh', ['sh']);
        childp.stderr.on('data', function (c) { pwsherr += c; });
        childp.stdout.on('data', function (c) { pwshout += c; });
        childp.stdin.write('which pwsh\n');
        childp.stdin.write('exit\n');
        childp.waitExit();
    } catch (e) { finalizeJob(job, null, "Couldn't determine pwsh in env: " + e); return; }
    if (pwsherr != '') { finalizeJob(job, null, 'PowerShell env determination error: ' + pwsherr); return; }
    if (pwshout.trim() == '') { finalizeJob(job, null, 'PowerShell is not installed'); return; }
    try {
        fs.writeFileSync(path + pName, '#!' + pwshout + '\n' + job.content.split('\r\n').join('\n').split('\r').join('\n'));
        var errstr = '';
        var child = require('child_process').execFile('/bin/sh', ['sh']);
        setRunningPid(job.dispatchId, child.pid);
        child.stderr.on('data', function (c) { errstr += c; });
        child.stdout.on('data', function (c) { });
        child.stdin.write('cd ' + path + '\n');
        child.stdin.write('chmod a+x ' + pName + '\n');
        child.stdin.write('./' + pName + ' > ' + oName + '\n');
        child.on('exit', function (procRetVal) {
            var outstr = '';
            if (errstr != '') { cleanup(); finalizeJob(job, null, errstr); return; }
            if (procRetVal == 1) { cleanup(); finalizeJob(job, null, 'Process terminated unexpectedly.'); return; }
            try { outstr = fs.readFileSync(path + oName, 'utf8').toString(); } catch (e) { outstr = (procRetVal) ? 'Failure' : 'Success'; }
            try { outstr = outstr.trim(); } catch (e) { }
            if (!outstr) outstr = (procRetVal) ? 'Failure' : 'Success';
            cleanup();
            finalizeJob(job, outstr);
        });
        child.stdin.write('exit\n');
        function cleanup() { try { fs.unlinkSync(path + oName); } catch (e) { } try { fs.unlinkSync(path + pName); } catch (e) { } }
    } catch (e) {
        dbg('Error (PowerShellNonWin): ' + e);
        finalizeJob(job, null, '' + e);
    }
}

function runBat(job) {
    if (process.platform != 'win32') { finalizeJob(job, null, 'Platform not supported.'); return; }
    const fs = require('fs');
    var rand = Math.random().toString(32).replace('0.', '');
    var oName = 'ao' + rand + '.txt';
    var pName = 'ao' + rand + '.bat';
    try {
        fs.writeFileSync(pName, job.content);
        var errstr = '';
        var child = require('child_process').execFile(process.env['windir'] + '\\system32\\cmd.exe');
        setRunningPid(job.dispatchId, child.pid);
        child.stderr.on('data', function (c) { errstr += c; });
        child.stdout.on('data', function (c) { });
        child.stdin.write(pName + ' > ' + oName + '\r\n');
        child.stdin.write('exit\r\n');
        child.on('exit', function (procRetVal) {
            var outstr = '';
            function cleanup() { try { fs.unlinkSync(oName); } catch (e) { } try { fs.unlinkSync(pName); } catch (e) { } }
            if (errstr != '') { cleanup(); finalizeJob(job, null, errstr); return; }
            if (procRetVal == 1) { cleanup(); finalizeJob(job, null, 'Process terminated unexpectedly.'); return; }
            try { outstr = fs.readFileSync(oName, 'utf8').toString(); } catch (e) { outstr = (procRetVal) ? 'Failure' : 'Success'; }
            try { outstr = outstr.trim(); } catch (e) { }
            if (!outstr) outstr = (procRetVal) ? 'Failure' : 'Success';
            cleanup();
            finalizeJob(job, outstr);
        });
    } catch (e) {
        dbg('Error (BAT): ' + e);
        finalizeJob(job, null, '' + e);
    }
}

function runBash(job) {
    if (process.platform == 'win32') { finalizeJob(job, null, 'Platform not supported.'); return; }
    const fs = require('fs');
    var path = '';
    var pathTests = ['/usr/local/mesh', '/tmp', '/usr/local/mesh_services/meshagent', '/var/tmp'];
    pathTests.forEach(function (p) { if (path == '' && fs.existsSync(p)) path = p; });
    path = path + '/';
    var rand = Math.random().toString(32).replace('0.', '');
    var oName = 'ao' + rand + '.txt';
    var pName = 'ao' + rand + '.sh';
    try {
        fs.writeFileSync(path + pName, job.content);
        var errstr = '';
        var child = require('child_process').execFile('/bin/sh', ['sh']);
        setRunningPid(job.dispatchId, child.pid);
        child.stderr.on('data', function (c) { errstr += c; });
        child.stdout.on('data', function (c) { });
        child.stdin.write('cd ' + path + '\n');
        child.stdin.write('chmod a+x ' + pName + '\n');
        child.stdin.write('./' + pName + ' > ' + oName + '\n');
        child.stdin.write('exit\n');
        child.on('exit', function (procRetVal) {
            var outstr = '';
            function cleanup() { try { fs.unlinkSync(path + oName); } catch (e) { } try { fs.unlinkSync(path + pName); } catch (e) { } }
            if (errstr != '') { cleanup(); finalizeJob(job, null, errstr); return; }
            if (procRetVal == 1) { cleanup(); finalizeJob(job, null, 'Process terminated unexpectedly.'); return; }
            try { outstr = fs.readFileSync(path + oName, 'utf8').toString(); } catch (e) { outstr = (procRetVal) ? 'Failure' : 'Success'; }
            try { outstr = outstr.trim(); } catch (e) { }
            if (!outstr) outstr = (procRetVal) ? 'Failure' : 'Success';
            cleanup();
            finalizeJob(job, outstr);
        });
    } catch (e) {
        dbg('Error (bash): ' + e);
        finalizeJob(job, null, '' + e);
    }
}

function runScript(job) {
    if (runningJobs[job.dispatchId] != null) { dbg('Duplicate dispatch for ' + job.dispatchId + ', ignoring.'); return; }
    armTimeout(job);
    dbg('Running step ' + job.stepIndex + ' (' + job.dispatchId + ')');
    switch (job.filetype) {
        case 'bat': runBat(job); break;
        case 'bash': runBash(job); break;
        case 'ps1':
        default: runPowerShell(job); break;
    }
}

function downloadToFile(url, destPath, cb, redirectsLeft) {
    if (redirectsLeft == null) redirectsLeft = 5;
    try {
        var lib = (String(url).indexOf('https:') === 0) ? require('https') : require('http');
        const fs = require('fs');
        var file = fs.createWriteStream(destPath);
        var req = lib.get(url, function (res) {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
                file.close();
                try { fs.unlinkSync(destPath); } catch (e) { }
                res.resume();
                return downloadToFile(res.headers.location, destPath, cb, redirectsLeft - 1);
            }
            if (res.statusCode !== 200) { file.close(); try { fs.unlinkSync(destPath); } catch (e) { } cb('HTTP ' + res.statusCode); return; }
            res.pipe(file);
            file.on('finish', function () { file.close(function () { cb(null); }); });
        });
        req.on('error', function (e) { try { fs.unlinkSync(destPath); } catch (e2) { } cb('' + e); });
    } catch (e) { cb('' + e); }
}

// Places a file on disk (from base64 payload, or downloaded from a URL), optionally
// verifies its checksum, and optionally runs a follow-up PS1 (built server-side,
// e.g. "Start-Process <destPath>", possibly wrapped for RunAsUser) via the same
// PowerShell runner used for ordinary script steps.
function runFileStep(job) {
    if (runningJobs[job.dispatchId] != null) { dbg('Duplicate dispatch for ' + job.dispatchId + ', ignoring.'); return; }
    armTimeout(job);
    const fs = require('fs');
    const path = require('path');
    try {
        if (job.skipIfExists && fs.existsSync(job.destPath)) {
            finalizeJob(job, 'Пропущено: файл уже существует по пути назначения (' + job.destPath + ').');
            return;
        }
        try { fs.mkdirSync(path.dirname(job.destPath), { recursive: true }); } catch (e) { }

        var afterWrite = function () {
            if (job.sha256) {
                try {
                    var crypto = require('crypto');
                    var buf = fs.readFileSync(job.destPath);
                    var actual = crypto.createHash('sha256').update(buf).digest('hex');
                    if (actual.toLowerCase() != String(job.sha256).toLowerCase()) {
                        finalizeJob(job, null, 'Контрольная сумма файла не совпала после копирования (файл мог повредиться при передаче).');
                        return;
                    }
                } catch (e) { finalizeJob(job, null, 'Не удалось проверить контрольную сумму: ' + e); return; }
            }
            if (job.runAfter && job.runScript) {
                dbg('Running post-copy script for ' + job.dispatchId);
                // build a plain job object explicitly (avoid Object.assign/spread - not
                // guaranteed available in the agent's embedded JS engine)
                var runJob = {
                    dispatchId: job.dispatchId, queueId: job.queueId, stepId: job.stepId,
                    stepIndex: job.stepIndex, dispatchTime: job.dispatchTime,
                    content: job.runScript, filetype: 'ps1'
                };
                runPowerShell(runJob);
            } else {
                finalizeJob(job, 'Файл размещён: ' + job.destPath);
            }
        };

        if (job.sourceMode === 'url') {
            downloadToFile(job.sourceUrl, job.destPath, function (err) {
                if (err) { finalizeJob(job, null, 'Ошибка скачивания файла: ' + err); return; }
                afterWrite();
            });
        } else {
            fs.writeFileSync(job.destPath, Buffer.from(job.fileDataB64 || '', 'base64'));
            afterWrite();
        }
    } catch (e) {
        dbg('Error (file step): ' + e);
        finalizeJob(job, null, '' + e);
    }
}

module.exports = { consoleaction: consoleaction };
