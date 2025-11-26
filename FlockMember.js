/**
 * FlockMember.js
 * Universal Member Class with Request Retry Queue
 */

(function() {
    // Dependency Injection Logic
    let singleton;
    if (typeof require === 'function' && typeof module !== 'undefined') {
        singleton = require('./FlockSingleton.js');
    } else if (typeof window !== 'undefined') {
        if (!window.FlockSingleton) {
            throw new Error("FlockSingleton.js must be loaded before FlockMember.js");
        }
        singleton = window.FlockSingleton;
    }

    class FlockMember {
        constructor(options = {}) {
            this.id = 'mem_' + Math.random().toString(36).substr(2, 9);
            this.debug = options.debug || false;
            this.callbacks = {};
            this.pendingRequests = new Map(); // Requests waiting for response
            this.retryQueue = new Map();     // Requests that timed out due to leader death
            this.MAX_RETRIES = 3;

            if(this.debug) console.log(`[${this.id}] Member Created`);
            singleton.register(this);
        }

        // اصلاح شده برای هندل کردن زمان‌بندی و انتقال به صف ارسال مجدد
        sendRequest(data, callback) {
            const reqId = Math.random().toString(36).substr(2);

            const promise = new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    if (this.pendingRequests.has(reqId)) {
                        this.pendingRequests.delete(reqId);
                        // درخواست به جای Reject شدن، به صف ارسال مجدد می‌رود
                        this._addRequestToRetryQueue(reqId, data, resolve, reject, callback);
                    }
                }, singleton.HEARTBEAT_TTL + 500); // 5.5 ثانیه انتظار برای پاسخ

                this.pendingRequests.set(reqId, { resolve, reject, timeout });

                singleton.broadcastInternal({
                    type: 'request',
                    senderId: this.id,
                    requestId: reqId,
                    payload: data
                });
            });

            if (callback) {
                promise.then(res => callback(null, res)).catch(err => callback(err));
            }
            return promise;
        }

        // --- Listener Overrides ---
        onMessage(cb) { this.callbacks.onMessage = cb; }
        onRequest(cb) { this.callbacks.onRequest = cb; }

        // اصلاح شده برای اجرای منطق ارسال مجدد پس از تغییر لیدر
        onLeadershipChange(cb) {
            this.callbacks.onLeadershipChange = (isLeader) => {
                if (!isLeader) {
                    this._retryPendingRequests();
                }
                if (cb) cb(isLeader);
            };
        }

        // --- Leader Actions ---
        sendToMember(id, data) {
            if(this.isLeader()) singleton.broadcastInternal({ type: 'direct-message', senderId: this.id, targetId: id, payload: data });
        }
        broadcastToMembers(data) {
            if(this.isLeader()) singleton.broadcastInternal({ type: 'broadcast', senderId: this.id, payload: data });
        }

        isLeader() { return singleton.leaderId === this.id; }
        getMembersInfo() { return this.isLeader() ? singleton.getGlobalMembers() : []; }
        resign() { singleton.unregister(this.id); }

        // --- Retry Queue Logic ---

        _addRequestToRetryQueue(reqId, data, resolve, reject, callback) {
            if (this.debug) console.log(`[${this.id}] Request ${reqId} timed out. Adding to retry queue.`);
            this.retryQueue.set(reqId, { data, resolve, reject, callback, retries: 0 });
        }

        _retryPendingRequests() {
            if (this.retryQueue.size === 0) return;

            // اگر خودم لیدر شدم، درخواست‌هایی که برای لیدر قبلی فرستادم، دیگر پاسخ داده نخواهند شد.
            if (this.isLeader()) {
                if (this.debug) console.log(`[${this.id}] I am the new leader, clearing retry queue.`);
                this.retryQueue.clear();
                return;
            }

            if (this.debug) console.log(`[${this.id}] New leader detected. Retrying ${this.retryQueue.size} requests.`);

            // برای جلوگیری از Loop، ابتدا صف را کپی و پاک می‌کنیم.
            const requestsToRetry = Array.from(this.retryQueue.entries());
            this.retryQueue.clear();

            requestsToRetry.forEach(([reqId, reqInfo]) => {
                reqInfo.retries++;
                if (reqInfo.retries > this.MAX_RETRIES) {
                    reqInfo.reject(new Error(`Request ${reqId} failed after ${this.MAX_RETRIES} retries.`));
                    return;
                }

                // ارسال مجدد درخواست
                this._resendRequest(reqId, reqInfo);
            });
        }

        _resendRequest(reqId, reqInfo) {
            // ساخت promise جدید و timeout جدید
            const newPromise = new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    if (this.pendingRequests.has(reqId)) {
                        this.pendingRequests.delete(reqId);
                        // شکست مجدد: اضافه کردن به صف برای تلاش بعدی (با افزایش retries)
                        this.retryQueue.set(reqId, reqInfo);
                    }
                }, singleton.HEARTBEAT_TTL + 500);

                this.pendingRequests.set(reqId, { resolve, reject, timeout });

                // ارسال به شبکه
                singleton.broadcastInternal({
                    type: 'request',
                    senderId: this.id,
                    requestId: reqId,
                    payload: reqInfo.data
                });
            });

            // پیوند دادن Promise جدید به resolve/reject اولیه کاربر
            newPromise.then(reqInfo.resolve).catch(reqInfo.reject);
        }

        // فراخوانی شده توسط Singleton برای حل و فصل درخواست‌ها
        resolvePending(reqId, data, isFinal) {
            if (this.pendingRequests.has(reqId)) {
                const p = this.pendingRequests.get(reqId);
                clearTimeout(p.timeout);

                if (isFinal) {
                    p.resolve(data);
                    this.pendingRequests.delete(reqId);
                } else {
                    // اگر پاسخی در طول فرآیند ارسال مجدد رسید، آن را نهایی می‌کنیم.
                    p.resolve(data);
                    this.pendingRequests.delete(reqId);
                }
            }
        }
    }

    // Export Logic (UMD-like)
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = FlockMember; // CommonJS (Node.js)
    } else if (typeof window !== 'undefined') {
        window.FlockMember = FlockMember; // Browser Global
    }
})();