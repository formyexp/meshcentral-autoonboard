/**
 * @description MeshCentral-AutoOnboard database module (NeDB)
 * @license Apache-2.0
 *
 * Single NeDB collection, documents distinguished by "type":
 *   'step'     - one entry in the ordered onboarding sequence (kind: 'script' | 'file')
 *   'queue'    - one per-device onboarding progress record
 *   'history'  - append-only execution log entries (for the dashboard)
 *   'file'     - metadata for a file uploaded to the server (bytes live on disk)
 *   'settings' - single singleton document (_id: 'settings')
 */
"use strict";

var Datastore = null;
try { Datastore = require('@seald-io/nedb'); } catch (ex) { }
if (Datastore == null) { try { Datastore = require('@yetzt/nedb'); } catch (ex) { } }
if (Datastore == null) { try { Datastore = require('nedb'); } catch (ex) { } }

module.exports.CreateDB = function (meshserver) {
    var obj = {};

    obj.store = new Datastore({ filename: meshserver.getConfigFilePath('plugin-autoonboard.db'), autoload: true });
    try { obj.store.setAutocompactionInterval(60000); } catch (e) { }
    obj.store.ensureIndex({ fieldName: 'type' });
    obj.store.ensureIndex({ fieldName: 'node' });

    function nowSec() { return Math.floor(Date.now() / 1000); }

    obj.find = function (query) {
        return new Promise(function (resolve, reject) {
            obj.store.find(query, function (err, docs) { if (err) reject(err); else resolve(docs); });
        });
    };
    obj.findOne = function (query) {
        return new Promise(function (resolve, reject) {
            obj.store.findOne(query, function (err, doc) { if (err) reject(err); else resolve(doc); });
        });
    };
    obj.insert = function (doc) {
        return new Promise(function (resolve, reject) {
            obj.store.insert(doc, function (err, newDoc) { if (err) reject(err); else resolve(newDoc); });
        });
    };
    obj.updateRaw = function (query, update, options) {
        options = options || {};
        return new Promise(function (resolve, reject) {
            obj.store.update(query, update, options, function (err, numAffected, affectedDocs) {
                if (err) reject(err); else resolve(affectedDocs);
            });
        });
    };
    obj.removeRaw = function (query, options) {
        options = options || {};
        return new Promise(function (resolve, reject) {
            obj.store.remove(query, options, function (err, n) { if (err) reject(err); else resolve(n); });
        });
    };

    // ---------------- Steps (ordered onboarding script sequence) ----------------
    obj.getSteps = function () {
        return obj.find({ type: 'step' }).then(function (r) {
            r.sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
            return r;
        });
    };
    obj.getEnabledSteps = function () {
        return obj.getSteps().then(function (r) { return r.filter(function (s) { return s.enabled !== false; }); });
    };
    obj.getStep = function (id) { return obj.findOne({ _id: id, type: 'step' }); };
    obj.addStep = function (data) {
        return obj.getSteps().then(function (steps) {
            var maxOrder = steps.reduce(function (m, s) { return Math.max(m, s.order || 0); }, -1);
            var doc = Object.assign({
                type: 'step',
                kind: 'script', // 'script' | 'file'
                name: 'Новый шаг',
                order: maxOrder + 1,
                maxRetries: 3,
                retryDelayMin: 5,
                timeoutMin: 10,
                continueOnFail: false,
                enabled: true,
                runAsUser: false,
                // script kind fields
                content: '',
                filetype: 'ps1',
                // file kind fields
                fileId: null,
                destPath: '',
                sourceMode: 'server', // 'server' | 'url'
                sourceUrl: '',
                skipIfExists: false,
                runAfter: false,
                runArgs: '',
                createdAt: nowSec()
            }, data || {});
            return obj.insert(doc);
        });
    };
    obj.updateStep = function (id, fields) { return obj.updateRaw({ _id: id, type: 'step' }, { $set: fields }, {}); };
    obj.deleteStep = function (id) { return obj.removeRaw({ _id: id, type: 'step' }, {}); };
    obj.reorderSteps = function (orderedIds) {
        var proms = orderedIds.map(function (id, idx) { return obj.updateRaw({ _id: id, type: 'step' }, { $set: { order: idx } }, {}); });
        return Promise.all(proms);
    };

    // ---------------- Queue (per-device onboarding progress) ----------------
    obj.getQueueByNode = function (node) { return obj.findOne({ type: 'queue', node: node }); };
    obj.getQueueById = function (id) { return obj.findOne({ _id: id, type: 'queue' }); };
    obj.getAllQueue = function () {
        return obj.find({ type: 'queue' }).then(function (r) {
            r.sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
            return r;
        });
    };
    obj.createQueue = function (node, meshId, deviceName, status) {
        var t = nowSec();
        var doc = {
            type: 'queue',
            node: node,
            meshId: meshId,
            deviceName: deviceName,
            status: status || 'pending', // pending | running | waiting_offline | completed | failed | seeded
            currentStepIndex: 0,
            attempts: {},
            retryNotBefore: null,
            dispatchTime: null,
            startedAt: t,
            updatedAt: t,
            completedAt: null,
            lastError: null
        };
        return obj.insert(doc);
    };
    obj.updateQueue = function (id, fields) {
        fields = Object.assign({}, fields, { updatedAt: nowSec() });
        return obj.updateRaw({ _id: id }, { $set: fields }, {});
    };
    obj.deleteQueue = function (id) { return obj.removeRaw({ _id: id }, {}); };
    obj.getStuckQueues = function (staleBeforeTs) {
        // status running, dispatched a while ago, no completion yet -> consider stuck (agent likely died mid-script)
        return obj.find({ type: 'queue', status: 'running', dispatchTime: { $lte: staleBeforeTs } });
    };
    obj.getDueQueues = function () {
        var t = nowSec();
        return obj.find({
            type: 'queue',
            status: { $in: ['pending', 'waiting_offline'] },
            $or: [{ retryNotBefore: null }, { retryNotBefore: { $lte: t } }]
        });
    };
    obj.getRunningQueues = function () { return obj.find({ type: 'queue', status: 'running' }); };

    // ---------------- History (execution log for dashboard) ----------------
    obj.addHistory = function (entry) {
        entry = Object.assign({}, entry, { type: 'history', ts: nowSec() });
        return obj.insert(entry);
    };
    obj.getHistoryForQueue = function (queueId) {
        return obj.find({ type: 'history', queueId: queueId }).then(function (r) {
            r.sort(function (a, b) { return a.ts - b.ts; });
            return r;
        });
    };
    obj.getRecentHistory = function (limit) {
        return obj.find({ type: 'history' }).then(function (r) {
            r.sort(function (a, b) { return b.ts - a.ts; });
            return r.slice(0, limit || 300);
        });
    };
    obj.deleteOldHistory = function () {
        var oldTime = nowSec() - (86400 * 90);
        return obj.removeRaw({ type: 'history', ts: { $lte: oldTime } }, { multi: true });
    };

    // ---------------- Files (uploaded blobs stored on disk, metadata here) ----------------
    obj.addFile = function (data) {
        var doc = Object.assign({ type: 'file', name: '', sizeBytes: 0, sha256: '', storedName: '', uploadedAt: nowSec() }, data || {});
        return obj.insert(doc);
    };
    obj.getFiles = function () {
        return obj.find({ type: 'file' }).then(function (r) {
            r.sort(function (a, b) { return (b.uploadedAt || 0) - (a.uploadedAt || 0); });
            return r;
        });
    };
    obj.getFile = function (id) { return obj.findOne({ _id: id, type: 'file' }); };
    obj.deleteFile = function (id) { return obj.removeRaw({ _id: id, type: 'file' }, {}); };

    // ---------------- Settings (singleton) ----------------
    obj.getSettings = function () {
        return obj.findOne({ _id: 'settings' }).then(function (s) {
            return s || { _id: 'settings', type: 'settings', webhookUrl: '', autoStartEnabled: true };
        });
    };
    obj.saveSettings = function (fields) {
        return obj.findOne({ _id: 'settings' }).then(function (existing) {
            if (existing) return obj.updateRaw({ _id: 'settings' }, { $set: fields }, {});
            return obj.insert(Object.assign({ _id: 'settings', type: 'settings', webhookUrl: '', autoStartEnabled: true }, fields));
        });
    };

    return obj;
};
