/**
 * @description MeshCentral-AutoOnboard
 * @license Apache-2.0
 *
 * Automatically runs an ordered sequence of PowerShell/BAT/Bash scripts on every
 * brand-new device the very first time its agent checks in, with per-step retry
 * (with backoff), automatic resume when an offline device reconnects, a stale/stuck
 * job safety net, and a dashboard with execution history.
 *
 * Structure and wire-protocol patterns are adapted from the proven approach used by
 * MeshCentral-ScriptTask (https://github.com/ryanblenis/MeshCentral-ScriptTask).
 *
 * This single file is loaded BOTH server-side (Node.js) and, for the functions
 * listed in obj.exports, inside the browser as part of the MeshCentral web app -
 * that's why some functions below use obj.meshServer/obj.db (server-only) while
 * others use document/pluginHandler (browser-only). This dual-context pattern
 * mirrors MeshCentral's plugin architecture.
 */
"use strict";

module.exports.autoonboard = function (parent) {
    var obj = {};
    obj.parent = parent;
    obj.meshServer = parent.parent;
    obj.db = null;
    obj.intervalTimer = null;
    obj.VIEWS = __dirname + '/views/';

    // ---- functions safe to run in the BROWSER (web UI) context ----
    obj.exports = [
        'onDeviceRefreshEnd',
        'resizeContent',
        'adminData',
        'nodeData',
        'queueUpdate',
        'seedDone',
        'noStepsError'
    ];

    // =====================================================================
    // SERVER-SIDE (Node.js) — lifecycle
    // =====================================================================

    obj.server_startup = function () {
        obj.db = require(__dirname + '/db.js').CreateDB(obj.meshServer);
        var path = require('path'), fs = require('fs');
        obj.filesDir = path.join(path.dirname(obj.meshServer.getConfigFilePath('plugin-autoonboard.db')), 'plugin-autoonboard-files');
        try { fs.mkdirSync(obj.filesDir, { recursive: true }); } catch (e) { console.log('PLUGIN: AutoOnboard: could not create files dir: ', e); }
        obj.uploads = {}; // uploadId -> { name, tmpPath, stream, sizeBytes }
        obj.resetQueueTimer();
    };

    obj.resetQueueTimer = function () {
        clearInterval(obj.intervalTimer);
        obj.intervalTimer = setInterval(obj.queueRun, 60 * 1000); // every minute
    };

    function nowSec() { return Math.floor(Date.now() / 1000); }

    function isAdmin(user) { return (user != null) && ((user.siteadmin & 0xFFFFFFFF) == 1); }

    function applyVars(content, q) {
        if (content == null) return content;
        return content.split('{{deviceName}}').join(q.deviceName || '').split('{{nodeId}}').join(q.node || '');
    }

    function agentName(nodeId) {
        try {
            var a = obj.meshServer.webserver.wsagents[nodeId];
            if (a == null) return null;
            return a.name || a.dbName || null;
        } catch (e) { return null; }
    }

    function psQuote(s) { return "'" + String(s == null ? '' : s).replace(/'/g, "''") + "'"; }

    // Wraps a block of PowerShell so it runs in the context of the currently
    // logged-in interactive user instead of SYSTEM, using the RunAsUser module
    // (https://github.com/KelvinTegelaar/RunAsUser) - the standard, maintained
    // community solution for this; MeshCentral's own "Must run as user" option is
    // a known, long-standing bug (does not actually switch context).
    function wrapRunAsUserPS(body) {
        return [
            '$ErrorActionPreference = "Stop"',
            'if (-not (Get-Module -ListAvailable -Name RunAsUser)) {',
            '  try { Install-Module RunAsUser -Force -Scope AllUsers -ErrorAction Stop -Confirm:$false }',
            '  catch {',
            '    try { Install-Module RunAsUser -Force -Scope CurrentUser -ErrorAction Stop -Confirm:$false }',
            '    catch { Write-Output "AUTOONBOARD: could not install RunAsUser module: $_"; exit 1 }',
            '  }',
            '}',
            'Import-Module RunAsUser -ErrorAction Stop',
            '$__aoResult = Invoke-ASCurrentUser -scriptblock {',
            body,
            '} -CaptureOutput',
            'Write-Output $__aoResult'
        ].join("\r\n");
    }

    // Builds the PS1 that Start-Process-launches a deployed file as SYSTEM.
    // Only used when runAsUser is false (or absent).  When runAsUser is true the
    // agent uses launchFileAsUser() (Windows Task Scheduler) instead – no PS1 needed.
    function buildFileRunScript(step, destPath) {
        return 'Start-Process -FilePath ' + psQuote(destPath) +
            (step.runArgs ? (' -ArgumentList ' + psQuote(step.runArgs)) : '') +
            ' -Wait -PassThru | ForEach-Object { "Exit code: " + $_.ExitCode }';
    }

    // =====================================================================
    // SERVER-SIDE — the onboarding engine
    // =====================================================================

    // Fires (per MeshCentral core) whenever an agent's core becomes stable - this
    // happens on every connect/reconnect, not only on first-ever enrollment, so we
    // dedupe using our own queue collection (no queue doc yet == genuinely new device).
    obj.hook_agentCoreIsStable = function (agent, webserver) {
        try {
            var nodeId = agent.dbNodeKey;
            var meshId = agent.dbMeshKey;
            if (nodeId == null || obj.db == null) return;
            obj.db.getQueueByNode(nodeId).then(function (q) {
                if (q == null) {
                    return obj.db.getSettings().then(function (settings) {
                        if (settings.autoStartEnabled === false) return; // master switch off
                        return obj.db.getEnabledSteps().then(function (steps) {
                            if (steps.length === 0) return; // no steps configured — don't create a hanging queue
                            return obj.db.createQueue(nodeId, meshId, agentName(nodeId) || nodeId, 'pending').then(function (newQ) {
                                obj.pushQueueUpdate();
                                return obj.dispatchStep(newQ);
                            });
                        });
                    });
                } else if (q.status === 'waiting_offline' || q.status === 'pending') {
                    // device just (re)connected - try to resume right away instead of
                    // waiting for the next minute's sweep
                    return obj.dispatchStep(q);
                }
            }).catch(function (e) { console.log('PLUGIN: AutoOnboard: hook_agentCoreIsStable error: ', e); });
        } catch (e) { console.log('PLUGIN: AutoOnboard: hook_agentCoreIsStable exception: ', e); }
    };

    // Dispatch (or re-dispatch) the current step of a queue entry.
    obj.dispatchStep = function (q) {
        return obj.db.getEnabledSteps().then(function (steps) {
            if (steps.length === 0) {
                // No steps configured — if queue is stuck in an active state, mark it failed
                // so the dashboard doesn't show "pending" forever with no explanation.
                if (q.status === 'pending' || q.status === 'running' || q.status === 'waiting_offline') {
                    return obj.db.updateQueue(q._id, { status: 'failed', lastError: 'Нет настроенных шагов адаптации. Добавьте шаги в My Server → Plugins → AutoOnboard.' })
                        .then(function () { obj.pushQueueUpdate(); });
                }
                return Promise.resolve();
            }
            if (q.currentStepIndex >= steps.length) {
                return obj.finishQueue(q, 'completed');
            }
            var step = steps[q.currentStepIndex];
            var agent = obj.meshServer.webserver.wsagents[q.node];
            if (agent == null) {
                if (q.status !== 'waiting_offline') {
                    return obj.db.updateQueue(q._id, { status: 'waiting_offline' }).then(function () { obj.pushQueueUpdate(); });
                }
                return Promise.resolve();
            }
            if (step.kind === 'file') return obj.dispatchFileStep(q, step, agent);
            return obj.dispatchScriptStep(q, step, agent);
        });
    };

    obj.dispatchScriptStep = function (q, step, agent) {
        var dispatchId = require('crypto').randomBytes(8).toString('hex');
        var dispatchTime = nowSec();
        var content = applyVars(step.content, q);
        if (step.runAsUser && (step.filetype || 'ps1') === 'ps1') content = wrapRunAsUserPS(content);
        var msg = {
            action: 'plugin', plugin: 'autoonboard', pluginaction: 'triggerStep',
            queueId: q._id, stepId: step._id, stepIndex: q.currentStepIndex,
            dispatchId: dispatchId, dispatchTime: dispatchTime,
            content: content, filetype: step.filetype || 'ps1',
            timeoutMin: step.timeoutMin || 10
        };
        try { agent.send(JSON.stringify(msg)); } catch (e) { return Promise.resolve(); }
        return obj.db.updateQueue(q._id, { status: 'running', dispatchTime: dispatchTime, dispatchId: dispatchId, retryNotBefore: null })
            .then(function () { obj.pushQueueUpdate(); });
    };

    obj.dispatchFileStep = function (q, step, agent) {
        var fs = require('fs');
        var finish = function (msg) {
            var dispatchId = require('crypto').randomBytes(8).toString('hex');
            var dispatchTime = nowSec();
            msg = Object.assign({
                action: 'plugin', plugin: 'autoonboard', pluginaction: 'triggerFileStep',
                queueId: q._id, stepId: step._id, stepIndex: q.currentStepIndex,
                dispatchId: dispatchId, dispatchTime: dispatchTime,
                destPath: applyVars(step.destPath, q), skipIfExists: !!step.skipIfExists,
                runAfter: !!step.runAfter, timeoutMin: step.timeoutMin || 10
            }, msg);
            try { agent.send(JSON.stringify(msg)); } catch (e) { return Promise.resolve(); }
            return obj.db.updateQueue(q._id, { status: 'running', dispatchTime: dispatchTime, dispatchId: dispatchId, retryNotBefore: null })
                .then(function () { obj.pushQueueUpdate(); });
        };
        // Build the "run after copy" payload depending on whether the step
        // wants user-context (Task Scheduler path) or SYSTEM (Start-Process PS1 path).
        function makeRunExtra(resolvedDest) {
            if (!step.runAfter) return {};
            if (step.runAsUser) {
                // Agent will use win-tasks / SCHTASKS (same as File Manager) – no PS1
                return { runAfterAsUser: true, runArgs: step.runArgs || '' };
            }
            return { runScript: buildFileRunScript(step, resolvedDest) };
        }

        if (step.sourceMode === 'url') {
            var resolvedDest = applyVars(step.destPath, q);
            return finish(Object.assign({ sourceMode: 'url', sourceUrl: step.sourceUrl }, makeRunExtra(resolvedDest)));
        }
        // sourceMode 'server' - read the stored file from disk
        return obj.db.getFile(step.fileId).then(function (fileDoc) {
            if (fileDoc == null) {
                return obj.db.addHistory({
                    queueId: q._id, node: q.node, deviceName: q.deviceName, stepId: step._id, stepName: step.name,
                    stepIndex: q.currentStepIndex, attempt: 1, dispatchTime: nowSec(), completeTime: nowSec(),
                    success: false, output: null, error: 'Файл для этого шага не найден на сервере (возможно, был удалён).'
                }).then(function () { return obj.finishQueue(q, 'failed', { lastError: 'Файл для шага не найден на сервере.' }); });
            }
            var bytes;
            try { bytes = fs.readFileSync(require('path').join(obj.filesDir, fileDoc.storedName)); }
            catch (e) {
                return obj.finishQueue(q, 'failed', { lastError: 'Не удалось прочитать файл на сервере: ' + e });
            }
            var resolvedDest = applyVars(step.destPath, q);
            return finish(Object.assign({ sourceMode: 'server', fileDataB64: bytes.toString('base64'), sha256: fileDoc.sha256 }, makeRunExtra(resolvedDest)));
        });
    };

    obj.finishQueue = function (q, status, extraFields) {
        var fields = Object.assign({ status: status, completedAt: nowSec() }, extraFields || {});
        return obj.db.updateQueue(q._id, fields).then(function () {
            obj.pushQueueUpdate();
            if (status === 'completed' || status === 'failed') obj.fireWebhook(q, status);
        });
    };

    obj.fireWebhook = function (q, status) {
        obj.db.getSettings().then(function (s) {
            if (!s.webhookUrl) return;
            try {
                var u = require('url').parse(s.webhookUrl);
                var lib = (u.protocol === 'https:') ? require('https') : require('http');
                var payload = JSON.stringify({ event: 'autoonboard_' + status, node: q.node, deviceName: q.deviceName, queueId: q._id, time: nowSec() });
                var reqo = lib.request({
                    hostname: u.hostname, port: u.port, path: u.path || '/', method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
                }, function (res) { res.on('data', function () { }); });
                reqo.on('error', function (e) { console.log('PLUGIN: AutoOnboard: webhook error: ', e.message); });
                reqo.write(payload);
                reqo.end();
            } catch (e) { console.log('PLUGIN: AutoOnboard: webhook exception: ', e); }
        }).catch(function () { });
    };

    // Periodic sweep: (1) dispatch anything whose retry delay has elapsed or whose
    // device is now back online, (2) re-dispatch steps stuck in "running" long past
    // their own timeout (agent likely died/restarted without reporting back).
    obj.queueRun = function () {
        obj.db.getDueQueues().then(function (list) {
            list.forEach(function (q) {
                if (q.status === 'waiting_offline') {
                    if (obj.meshServer.webserver.wsagents[q.node] != null) obj.dispatchStep(q);
                } else {
                    obj.dispatchStep(q);
                }
            });
        }).catch(function (e) { console.log('PLUGIN: AutoOnboard: queueRun error: ', e); });

        Promise.all([obj.db.getRunningQueues(), obj.db.getEnabledSteps()]).then(function (res) {
            var running = res[0], steps = res[1];
            var t = nowSec();
            running.forEach(function (q) {
                var step = steps[q.currentStepIndex];
                var timeoutSec = ((step && step.timeoutMin) || 10) * 60;
                var staleAt = (q.dispatchTime || q.updatedAt || 0) + timeoutSec + 300; // +5min safety buffer
                if (staleAt < t && obj.meshServer.webserver.wsagents[q.node] != null) obj.dispatchStep(q);
            });
        }).catch(function (e) { console.log('PLUGIN: AutoOnboard: stale sweep error: ', e); });

        if (Math.round(Math.random() * 100) == 99) obj.db.deleteOldHistory().catch(function () { });
    };

    // =====================================================================
    // SERVER-SIDE — HTTP (admin panel / device tab page render)
    // =====================================================================

    obj.handleAdminReq = function (req, res, user) {
        // MeshCentral's goPlugin() opens /pluginadmin.ashx?pin=autoonboard with NO extra params.
        // Treat that (and explicit ?admin=1) as the admin panel.
        // Only ?user=1 routes to the per-device tab iframe.
        if (req.query.user == '1') { res.render(obj.VIEWS + 'user', {}); return; }
        // Everything else → admin panel (bare URL or ?admin=1)
        if (isAdmin(user)) { res.render(obj.VIEWS + 'admin', {}); return; }
        res.sendStatus(401);
    };

    // =====================================================================
    // SERVER-SIDE — websocket action router (both browser UI and agent replies
    // arrive here as { action:'plugin', plugin:'autoonboard', pluginaction:... })
    // =====================================================================

    obj.pushQueueUpdate = function () {
        var targets = ['*', 'server-users'];
        obj.meshServer.DispatchEvent(targets, obj, { nolog: true, action: 'plugin', plugin: 'autoonboard', pluginaction: 'queueUpdate' });
    };

    obj.sendAdminData = function () {
        return Promise.all([obj.db.getSteps(), obj.db.getSettings(), obj.db.getAllQueue(), obj.db.getRecentHistory(300), obj.db.getFiles()])
            .then(function (res) {
                var targets = ['*', 'server-users'];
                obj.meshServer.DispatchEvent(targets, obj, {
                    nolog: true, action: 'plugin', plugin: 'autoonboard', pluginaction: 'adminData',
                    steps: res[0], settings: res[1], queue: res[2], history: res[3], files: res[4]
                });
            });
    };

    obj.sendNodeData = function (nodeId) {
        return obj.db.getQueueByNode(nodeId).then(function (q) {
            return (q ? obj.db.getHistoryForQueue(q._id) : Promise.resolve([])).then(function (hist) {
                var targets = ['*', 'server-users'];
                obj.meshServer.DispatchEvent(targets, obj, {
                    nolog: true, action: 'plugin', plugin: 'autoonboard', pluginaction: 'nodeData',
                    nodeId: nodeId, queue: q || null, history: hist
                });
            });
        });
    };

    obj.serveraction = function (command, myparent, grandparent) {
        var isUserSession = (myparent && myparent.user != null);
        var admin = isUserSession && isAdmin(myparent.user);

        switch (command.pluginaction) {

            // ---- agent replies ----
            case 'stepComplete':
                obj.db.getQueueById(command.queueId).then(function (q) {
                    if (q == null) return;
                    return obj.db.getStep(command.stepId).then(function (step) {
                        var success = (command.errVal == null);
                        var attemptNo = ((q.attempts && q.attempts[command.stepId]) || 0) + 1;
                        return obj.db.addHistory({
                            queueId: q._id, node: q.node, deviceName: q.deviceName,
                            stepId: command.stepId, stepName: step ? step.name : '(удалён)', stepIndex: command.stepIndex,
                            attempt: attemptNo, dispatchTime: command.dispatchTime, completeTime: nowSec(),
                            success: success, output: command.retVal, error: command.errVal
                        }).then(function () {
                            if (success) {
                                var newAttempts = Object.assign({}, q.attempts); delete newAttempts[command.stepId];
                                return obj.db.updateQueue(q._id, { currentStepIndex: q.currentStepIndex + 1, attempts: newAttempts, status: 'pending', retryNotBefore: null, lastError: null })
                                    .then(function () { return obj.db.getQueueById(q._id); })
                                    .then(function (q2) { obj.pushQueueUpdate(); return obj.dispatchStep(q2); });
                            }
                            var attempts = Object.assign({}, q.attempts);
                            attempts[command.stepId] = attemptNo;
                            var maxRetries = step ? step.maxRetries : 3;
                            if (attemptNo < maxRetries) {
                                var delayMin = (step && step.retryDelayMin) || 5;
                                return obj.db.updateQueue(q._id, { attempts: attempts, status: 'pending', retryNotBefore: nowSec() + delayMin * 60, lastError: command.errVal })
                                    .then(function () { obj.pushQueueUpdate(); });
                            } else if (step && step.continueOnFail) {
                                return obj.db.updateQueue(q._id, { currentStepIndex: q.currentStepIndex + 1, attempts: attempts, status: 'pending', retryNotBefore: null, lastError: command.errVal })
                                    .then(function () { return obj.db.getQueueById(q._id); })
                                    .then(function (q2) { obj.pushQueueUpdate(); return obj.dispatchStep(q2); });
                            } else {
                                return obj.finishQueue(q, 'failed', { attempts: attempts, lastError: command.errVal });
                            }
                        });
                    });
                }).catch(function (e) { console.log('PLUGIN: AutoOnboard: stepComplete error: ', e); });
                break;

            // ---- browser UI: data loading ----
            case 'loadAdminData':
                if (!admin) return;
                obj.sendAdminData();
                break;
            case 'loadNodeStatus':
                if (!isUserSession) return;
                obj.sendNodeData(command.nodeId);
                break;

            // ---- browser UI: step (sequence) CRUD - admin only ----
            case 'addStep':
                if (!admin) return;
                obj.db.addStep({ kind: command.kind || 'script', name: command.name, content: command.content, filetype: command.filetype }).then(function () { obj.sendAdminData(); });
                break;
            case 'updateStep':
                if (!admin) return;
                obj.db.updateStep(command.id, command.fields || {}).then(function () { obj.sendAdminData(); });
                break;
            case 'deleteStep':
                if (!admin) return;
                obj.db.deleteStep(command.id).then(function () { obj.sendAdminData(); });
                break;
            case 'reorderSteps':
                if (!admin) return;
                obj.db.reorderSteps(command.orderedIds || []).then(function () { obj.sendAdminData(); });
                break;
            case 'saveSettings':
                if (!admin) return;
                obj.db.saveSettings(command.fields || {}).then(function () { obj.sendAdminData(); });
                break;

            // ---- browser UI: file upload (chunked, base64-over-websocket) & file mgmt ----
            case 'uploadFileStart': {
                if (!admin) return;
                var fs = require('fs'), path = require('path'), crypto = require('crypto');
                var uploadId = command.uploadId || crypto.randomBytes(8).toString('hex');
                var tmpPath = path.join(obj.filesDir, '.tmp_' + uploadId);
                try {
                    var stream = fs.createWriteStream(tmpPath);
                    var hash = crypto.createHash('sha256');
                    obj.uploads[uploadId] = { name: command.name, tmpPath: tmpPath, stream: stream, hash: hash, sizeBytes: 0, ok: true };
                    stream.on('error', function (e) { console.log('PLUGIN: AutoOnboard: upload stream error: ', e); if (obj.uploads[uploadId]) obj.uploads[uploadId].ok = false; });
                } catch (e) { console.log('PLUGIN: AutoOnboard: uploadFileStart error: ', e); }
                try { myparent.send(JSON.stringify({ action: 'plugin', plugin: 'autoonboard', pluginaction: 'uploadAck', uploadId: uploadId, ok: true })); } catch (e) { }
                break;
            }
            case 'uploadFileChunk': {
                if (!admin) return;
                var up = obj.uploads[command.uploadId];
                if (up == null || !up.ok) return;
                try {
                    var buf = Buffer.from(command.chunkB64 || '', 'base64');
                    up.stream.write(buf);
                    up.hash.update(buf);
                    up.sizeBytes += buf.length;
                } catch (e) { up.ok = false; console.log('PLUGIN: AutoOnboard: uploadFileChunk error: ', e); }
                break;
            }
            case 'uploadFileEnd': {
                if (!admin) return;
                var up2 = obj.uploads[command.uploadId];
                if (up2 == null) return;
                var uid = command.uploadId;
                up2.stream.end(function () {
                    delete obj.uploads[uid];
                    if (!up2.ok) { try { require('fs').unlinkSync(up2.tmpPath); } catch (e) { } return; }
                    var sha256 = up2.hash.digest('hex');
                    var storedName = sha256 + '_' + (up2.name || 'file').replace(/[^A-Za-z0-9_.-]/g, '_');
                    var finalPath = require('path').join(obj.filesDir, storedName);
                    try {
                        require('fs').renameSync(up2.tmpPath, finalPath);
                        obj.db.addFile({ name: up2.name, sizeBytes: up2.sizeBytes, sha256: sha256, storedName: storedName }).then(function () { obj.sendAdminData(); });
                    } catch (e) { console.log('PLUGIN: AutoOnboard: uploadFileEnd finalize error: ', e); }
                });
                break;
            }
            case 'deleteFile':
                if (!admin) return;
                obj.db.getFile(command.id).then(function (f) {
                    if (f != null) { try { require('fs').unlinkSync(require('path').join(obj.filesDir, f.storedName)); } catch (e) { } }
                    return obj.db.deleteFile(command.id);
                }).then(function () { obj.sendAdminData(); });
                break;

            // ---- browser UI: seed pre-existing devices as already-onboarded ----
            case 'seedExisting':
                if (!admin) return;
                var ids = Object.keys(obj.meshServer.webserver.wsagents || {});
                Promise.all(ids.map(function (nodeId) {
                    return obj.db.getQueueByNode(nodeId).then(function (q) {
                        if (q != null) return Promise.resolve();
                        var agent = obj.meshServer.webserver.wsagents[nodeId];
                        return obj.db.createQueue(nodeId, agent ? agent.dbMeshKey : null, agentName(nodeId) || nodeId, 'seeded')
                            .then(function (nq) { return obj.db.updateQueue(nq._id, { completedAt: nowSec() }); });
                    });
                })).then(function () {
                    obj.sendAdminData();
                    try {
                        myparent.send(JSON.stringify({ action: 'plugin', plugin: 'autoonboard', pluginaction: 'seedDone', count: ids.length }));
                    } catch (e) { }
                });
                break;

            // ---- browser UI: queue actions ----
            case 'retryNow':
                if (!isUserSession) return;
                obj.db.getQueueById(command.queueId).then(function (q) {
                    if (q == null) return;
                    return obj.db.updateQueue(q._id, { status: 'pending', retryNotBefore: null }).then(function () { return obj.db.getQueueById(q._id); }).then(obj.dispatchStep);
                }).then(function () { obj.sendAdminData(); });
                break;
            case 'restartOnboarding':
                if (!isUserSession) return;
                obj.db.getQueueById(command.queueId).then(function (q) {
                    if (q == null) return;
                    return obj.db.updateQueue(q._id, { currentStepIndex: 0, attempts: {}, status: 'pending', retryNotBefore: null, completedAt: null, lastError: null })
                        .then(function () { return obj.db.getQueueById(q._id); }).then(obj.dispatchStep);
                }).then(function () { obj.sendAdminData(); });
                break;
            case 'skipStep':
                if (!isUserSession) return;
                obj.db.getQueueById(command.queueId).then(function (q) {
                    if (q == null) return;
                    return obj.db.updateQueue(q._id, { currentStepIndex: q.currentStepIndex + 1, status: 'pending', retryNotBefore: null })
                        .then(function () { return obj.db.getQueueById(q._id); }).then(obj.dispatchStep);
                }).then(function () { obj.sendAdminData(); });
                break;
            case 'deleteQueueEntry':
                if (!admin) return;
                obj.db.deleteQueue(command.queueId).then(function () { obj.sendAdminData(); });
                break;
            case 'runOnboardingNow':
                if (!isUserSession) return;
                obj.db.getEnabledSteps().then(function (steps) {
                    if (steps.length === 0) {
                        // No steps configured — tell the browser immediately, don't create a hanging queue
                        obj.meshServer.DispatchEvent(['*', 'server-users'], obj, { nolog: true, action: 'plugin', plugin: 'autoonboard', pluginaction: 'noStepsError', nodeId: command.nodeId });
                        return;
                    }
                    return obj.db.getQueueByNode(command.nodeId).then(function (q) {
                        if (q != null) {
                            return obj.db.updateQueue(q._id, { currentStepIndex: 0, attempts: {}, status: 'pending', retryNotBefore: null, completedAt: null, lastError: null })
                                .then(function () { return obj.db.getQueueById(q._id); }).then(obj.dispatchStep);
                        }
                        var agent = obj.meshServer.webserver.wsagents[command.nodeId];
                        return obj.db.createQueue(command.nodeId, agent ? agent.dbMeshKey : null, agentName(command.nodeId) || command.nodeId, 'pending').then(obj.dispatchStep);
                    }).then(function () { obj.sendNodeData(command.nodeId); obj.sendAdminData(); });
                });
                break;

            default:
                console.log('PLUGIN: AutoOnboard: unknown action: ' + command.pluginaction);
                break;
        }
    };

    // =====================================================================
    // BROWSER (web UI) context
    // =====================================================================

    obj.onDeviceRefreshEnd = function () {
        pluginHandler.registerPluginTab({ tabTitle: 'AutoOnboard', tabId: 'pluginAutoOnboard' });
        QA('pluginAutoOnboard', '<iframe id="pluginIframeAutoOnboard" style="width: 100%; height: 700px; overflow: auto" scrolling="yes" frameBorder=0 src="/pluginadmin.ashx?pin=autoonboard&user=1" />');
    };
    obj.resizeContent = function () {
        var iFrame = document.getElementById('pluginIframeAutoOnboard');
        if (iFrame) iFrame.style.height = '700px';
    };
    obj.adminData = function (message) { if (typeof pluginHandler.autoonboard.onAdminData == 'function') pluginHandler.autoonboard.onAdminData(message); };
    obj.nodeData = function (message) { if (typeof pluginHandler.autoonboard.onNodeData == 'function') pluginHandler.autoonboard.onNodeData(message); };
    obj.queueUpdate = function (message) { if (typeof pluginHandler.autoonboard.onQueueUpdate == 'function') pluginHandler.autoonboard.onQueueUpdate(message); };
    obj.seedDone = function (message) { if (typeof pluginHandler.autoonboard.onSeedDone == 'function') pluginHandler.autoonboard.onSeedDone(message); };
    obj.noStepsError = function (message) { if (typeof pluginHandler.autoonboard.onNoStepsError == 'function') pluginHandler.autoonboard.onNoStepsError(message); };

    return obj;
};
