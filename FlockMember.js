/**
 * FlockMember.js
 * Public API for User
 */

(function() {
    let getSingletonFactory;

    if (typeof require === 'function' && typeof module !== 'undefined') {
        try {
            const singletonModule = require('./FlockSingleton.js');
            getSingletonFactory = singletonModule.getFlockSingletonInstance;
        } catch (e) {
            console.error("FlockMember Error: Could not require './FlockSingleton.js'.");
        }
    } else if (typeof window !== 'undefined') {
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

            // ذخیره آخرین لیدر شناخته شده برای جلوگیری از ارسال تکراری هنگام کشف اولیه
            this.lastKnownLeaderId = null;

            this.singleton = getSingletonFactory(options);

            this.RETRY_CHECK_INTERVAL = 5000;
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

                this.pendingRequests.set(reqId, {
                    isMessage: false,
                    type: 'request',
                    data: data,
                    resolve,
                    reject,
                    callback,
                    timeout
                });

                this.singleton.broadcastInternal({ type: 'request', senderId: this.id, requestId: reqId, payload: data });

                if (this.debug) console.log(`[${this.id}] 📤 Sending Request ${reqId}. Timeout: ${requestTimeoutMs}ms`);
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

            this.pendingRequests.set(reqId, {
                isMessage: true,
                type: 'message-to-leader',
                data: data,
                timeout
            });

            this.singleton.broadcastInternal({ type: 'message-to-leader', senderId: this.id, requestId: reqId, payload: data });

            if (this.debug) console.log(`[${this.id}] 📤 Sending MessageToLeader ${reqId}.`);
        }

        onMessage(cb) { this.callbacks.onMessage = cb; }
        onRequest(cb) { this.callbacks.onRequest = cb; }

        onLeadershipChange(cb) {
            this.callbacks.onLeadershipChange = (newLeaderId) => {
                if (this.debug) console.log(`[${this.id}] 👑 Leadership update: ${this.lastKnownLeaderId} -> ${newLeaderId}`);

                // منطق هوشمند برای Retry:
                const amILeader = (newLeaderId === this.id);
                const isJustDiscovery = (this.lastKnownLeaderId === null && newLeaderId !== null);

                // فقط اگر "خودم لیدر شدم" یا "لیدر واقعاً عوض شد (نه کشف اولیه)" پیام‌ها را باز ارسال کن.
                // اگر isJustDiscovery باشد، یعنی پیام اولیه ما احتمالاً رسیده است، پس عجله نکن.
                if (amILeader || !isJustDiscovery) {
                    this._movePendingToRetry();
                    this._processRetryQueue();
                } else {
                    if (this.debug) console.log(`[${this.id}] Leader discovered. Waiting for ack on pending requests (No immediate retry).`);
                }

                this.lastKnownLeaderId = newLeaderId;
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
            if (!this.isLeader()) return;
            if (this.debug) console.log(`[${this.id}] ✋ Ceding leadership.`);

            this.singleton.setTemporaryExclusion(this.id, 1500);
            this.singleton.broadcastInternal({ type: 'resign', senderId: this.id });
        }

        isLeader() { return this.singleton.leaderId === this.id; }
        getMembersInfo() { return this.isLeader() ? this.singleton.getGlobalMembers() : []; }

        resign() {
            if (this.debug) console.log(`[${this.id}] 👋 Resigning permanently.`);
            this.singleton.unregister(this.id);
            if (this.retryTimer) clearInterval(this.retryTimer);
        }

        // --- Internal Helpers ---

        _startRetryLoop() {
            if (this.retryTimer) clearInterval(this.retryTimer);
            this.retryTimer = setInterval(() => {
                if (this.singleton.leaderId && this.retryQueue.size > 0) {
                    if (this.debug) console.log(`[${this.id}] 🔄 Retry Loop: Processing ${this.retryQueue.size} items...`);
                    this._processRetryQueue();
                }
            }, this.RETRY_CHECK_INTERVAL);
        }

        _addToRetryQueue(reqId, data, type, resolve, reject, callback) {
            if (this.debug) console.log(`[${this.id}] 🚨 ${type} ${reqId} timed out. Added to Retry Queue.`);
            this.retryQueue.set(reqId, { type, data, resolve, reject, callback, retries: 0 });
        }

        _processRetryQueue() {
            if (this.retryQueue.size === 0) return;

            if (this.debug) console.log(`[${this.id}] ⚙️ Processing Retry Queue (${this.retryQueue.size} items).`);

            const items = Array.from(this.retryQueue.entries());
            this.retryQueue.clear();

            items.forEach(([reqId, item]) => {
                item.retries++;
                if (item.retries > this.MAX_RETRIES) {
                    if (this.debug) console.error(`[${this.id}] ❌ ${item.type} ${reqId} failed after ${this.MAX_RETRIES} attempts. Dropping.`);
                    if (item.reject) item.reject(new Error(`Max retries reached`));
                    return;
                }
                this._resendItem(reqId, item);
            });
        }

        _movePendingToRetry() {
            if (this.pendingRequests.size === 0) return;

            if (this.debug) console.log(`[${this.id}] 📦 Moving ${this.pendingRequests.size} PENDING requests to Retry Queue.`);

            this.pendingRequests.forEach((p, reqId) => {
                clearTimeout(p.timeout);
                this.retryQueue.set(reqId, {
                    type: p.type,
                    data: p.data,
                    resolve: p.resolve,
                    reject: p.reject,
                    callback: p.callback,
                    retries: 0
                });
            });
            this.pendingRequests.clear();
        }

        _resendItem(reqId, item) {
            if (this.debug) console.log(`[${this.id}] 🔁 Resending ${item.type} ${reqId} (Try ${item.retries}/${this.MAX_RETRIES})`);

            const timeout = setTimeout(() => {
                if (this.pendingRequests.has(reqId)) {
                    this.pendingRequests.delete(reqId);
                    this.retryQueue.set(reqId, item);
                    if (this.debug) console.log(`[${this.id}] ⚠️ Resent item ${reqId} timed out again.`);
                }
            }, this.singleton.HEARTBEAT_TTL + 500);

            this.pendingRequests.set(reqId, {
                isMessage: (item.type === 'message-to-leader'),
                type: item.type,
                data: item.data,
                resolve: item.resolve,
                reject: item.reject,
                callback: item.callback,
                timeout
            });

            this.singleton.broadcastInternal({ type: item.type, senderId: this.id, requestId: reqId, payload: item.data });
        }

        resolvePending(reqId, data, isFinal) {
            if (this.pendingRequests.has(reqId)) {
                if (this.debug) console.log(`[${this.id}] ✅ Received response/ack for ${reqId}.`);
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