/**
 * FlockMember.js
 * Public API for User (Final Version with Retry Loop Fix and Enhanced Debug Logs).
 */

(function() {
    let getSingletonFactory;

    // 1. Resolve Dependency (FlockSingleton)
    if (typeof require === 'function' && typeof module !== 'undefined') {
        // Node.js
        try {
            const singletonModule = require('./FlockSingleton.js');
            getSingletonFactory = singletonModule.getFlockSingletonInstance;
        } catch (e) {
            console.error("FlockMember Error: Could not require './FlockSingleton.js'. Make sure files are in the same directory.");
        }
    } else if (typeof window !== 'undefined') {
        // Browser
        if (window.FlockSingletonFactory) {
            getSingletonFactory = window.FlockSingletonFactory;
        } else {
            throw new Error("FlockMember Error: FlockSingleton.js must be loaded BEFORE FlockMember.js");
        }
    }

    class FlockMember {
        constructor(options = {}) {
            this.id = 'mem_' + Math.random().toString(36).substr(2, 9);
            this.debug = options.debug || false;

            this.callbacks = {};
            this.pendingRequests = new Map();
            this.retryQueue = new Map();
            this.MAX_RETRIES = 3;

            this.singleton = getSingletonFactory(options);

            this.RETRY_CHECK_INTERVAL = 5000; // 5 ثانیه
            this.retryTimer = null;
            this._startRetryLoop();

            if(this.debug) console.log(`[${this.id}] 🚀 Member joined channel: ${this.singleton.CHANNEL_NAME}`);

            this.singleton.register(this);
        }

        // --- Public API ---

        sendRequest(data, options = {}, callback = null) {
            if (typeof options === 'function') { callback = options; options = {}; }
            const reqId = Math.random().toString(36).substr(2);
            const requestTimeoutMs = options.timeout || (this.singleton.HEARTBEAT_TTL + 500);

            const promise = new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    if (this.pendingRequests.has(reqId)) {
                        this.pendingRequests.delete(reqId);
                        this._addToRetryQueue(reqId, data, 'request', resolve, reject, callback);
                    }
                }, requestTimeoutMs);
                this.pendingRequests.set(reqId, { isMessage: false, resolve, reject, timeout });
                this.singleton.broadcastInternal({ type: 'request', senderId: this.id, requestId: reqId, payload: data });
                if (this.debug) console.log(`[${this.id}] Sending Request ${reqId}. Timeout set for ${requestTimeoutMs}ms.`);
            });

            if (callback) { promise.then(res => callback(null, res)).catch(err => callback(err)); }
            return promise;
        }

        sendMessageToLeader(data) {
            const reqId = Math.random().toString(36).substr(2);
            const timeout = setTimeout(() => {
                if (this.pendingRequests.has(reqId)) {
                    this.pendingRequests.delete(reqId);
                    this._addToRetryQueue(reqId, data, 'message-to-leader', null, null, null);
                }
            }, this.singleton.HEARTBEAT_TTL + 500);

            this.pendingRequests.set(reqId, { isMessage: true, timeout });
            this.singleton.broadcastInternal({ type: 'message-to-leader', senderId: this.id, requestId: reqId, payload: data });
            if (this.debug) console.log(`[${this.id}] Sending MessageToLeader ${reqId}.`);
        }

        onMessage(cb) { this.callbacks.onMessage = cb; }
        onRequest(cb) { this.callbacks.onRequest = cb; }

        onLeadershipChange(cb) {
            this.callbacks.onLeadershipChange = (newLeaderId) => {
                if (this.debug) console.log(`[${this.id}] 👑 Leadership changed. New Leader ID: ${newLeaderId}`);
                this._processRetryQueue();
                if (cb) cb(newLeaderId);
            };
        }

        sendToMember(id, data) {
            if(this.isLeader()) this.singleton.broadcastInternal({ type: 'direct-message', senderId: this.id, targetId: id, payload: data });
        }
        broadcastToMembers(data) {
            if(this.isLeader()) this.singleton.broadcastInternal({ type: 'broadcast', senderId: this.id, payload: data });
        }

        cedeLeadership() {
            if (!this.isLeader()) {
                if (this.debug) console.log(`[${this.id}] Cannot cede leadership, I am not the leader.`);
                return;
            }
            const EXCLUSION_TIME_MS = 1500;

            if (this.debug) console.log(`[${this.id}] ✋ Ceding leadership. Temporarily excluding self (${EXCLUSION_TIME_MS}ms) from next election.`);

            this.singleton.setTemporaryExclusion(this.id, EXCLUSION_TIME_MS);
            this.singleton.broadcastInternal({ type: 'resign', senderId: this.id });
        }

        isLeader() { return this.singleton.leaderId === this.id; }
        getMembersInfo() { return this.isLeader() ? this.singleton.getGlobalMembers() : []; }

        resign() {
            if (this.debug) console.log(`[${this.id}] 👋 Resigning and permanently leaving the flock.`);

            this.singleton.unregister(this.id);
            if (this.retryTimer) clearInterval(this.retryTimer);
        }

        // --- Internal Helpers (Retry Logic) ---

        _startRetryLoop() {
            if (this.retryTimer) clearInterval(this.retryTimer);
            this.retryTimer = setInterval(() => {
                if (this.singleton.leaderId && this.retryQueue.size > 0) {
                    if (this.debug) console.log(`[${this.id}] 🔄 Retry Loop triggered. Processing queue...`);
                    this._processRetryQueue();
                }
            }, this.RETRY_CHECK_INTERVAL);
        }

        _addToRetryQueue(reqId, data, type, resolve, reject, callback) {
            if (this.debug) console.log(`[${this.id}] 🚨 ${type} ${reqId} timed out. Queued for retry.`);
            this.retryQueue.set(reqId, { type, data, resolve, reject, callback, retries: 0 });
        }

        _processRetryQueue() {
            if (this.retryQueue.size === 0) return;

            if (this.isLeader()) {
                if (this.debug) console.log(`[${this.id}] I became leader. Clearing retry queue.`);
                this.retryQueue.clear();
                return;
            }

            if (this.debug) console.log(`[${this.id}] Retrying ${this.retryQueue.size} items.`);
            const items = Array.from(this.retryQueue.entries());
            this.retryQueue.clear();
            items.forEach(([reqId, item]) => {
                item.retries++;
                if (item.retries > this.MAX_RETRIES) {
                    if (this.debug) console.log(`[${this.id}] ❌ Request ${reqId} failed after ${this.MAX_RETRIES} retries. Dropping.`);
                    if (item.reject) item.reject(new Error(`Request ${reqId} failed after ${this.MAX_RETRIES} retries.`));
                    return;
                }
                this._resendItem(reqId, item);
            });
        }

        _resendItem(reqId, item) {
            if (this.debug) console.log(`[${this.id}] Retrying ${item.type} ${reqId} (Attempt ${item.retries}/${this.MAX_RETRIES}).`);

            const timeout = setTimeout(() => {
                if (this.pendingRequests.has(reqId)) {
                    this.pendingRequests.delete(reqId);
                    this.retryQueue.set(reqId, item);
                    if (this.debug) console.log(`[${this.id}] Retried item ${reqId} timed out again. Re-queued.`);
                }
            }, this.singleton.HEARTBEAT_TTL + 500);

            this.pendingRequests.set(reqId, {
                isMessage: (item.type === 'message-to-leader'),
                resolve: item.resolve,
                reject: item.reject,
                timeout
            });

            this.singleton.broadcastInternal({ type: item.type, senderId: this.id, requestId: reqId, payload: item.data });
        }

        resolvePending(reqId, data, isFinal) {
            if (this.pendingRequests.has(reqId)) {
                if (this.debug) console.log(`[${this.id}] Received response for ${reqId}.`);
                const p = this.pendingRequests.get(reqId);
                clearTimeout(p.timeout);
                if (p.isMessage) { this.pendingRequests.delete(reqId); }
                else if (isFinal && p.resolve) { p.resolve(data); this.pendingRequests.delete(reqId); }
            }
        }
    }

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = FlockMember;
    } else if (typeof window !== 'undefined') {
        window.FlockMember = FlockMember;
    }
})();