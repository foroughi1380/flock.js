/**
 * FlockMember.js
 * Universal Member Class
 * Features: Retry Queue, One-way Messages, Auto-Discovery
 */

(function() {
    let getFactory;

    // تشخیص محیط و دریافت Factory
    if (typeof require === 'function' && typeof module !== 'undefined') {
        const mod = require('./FlockSingleton.js');
        getFactory = mod.getFlockSingletonInstance;
    } else if (typeof window !== 'undefined') {
        if (!window.getFlockSingletonInstance) throw new Error("FlockSingleton.js missing");
        getFactory = window.getFlockSingletonInstance;
    }

    class FlockMember {
        constructor(options = {}) {
            this.id = 'mem_' + Math.random().toString(36).substr(2, 9);
            this.debug = options.debug || false;

            // Callbacks
            this.callbacks = {};

            // Queues
            this.pendingRequests = new Map();
            this.retryQueue = new Map();
            this.MAX_RETRIES = 3;

            // دریافت موتور سینگلتون مربوط به این کانال خاص
            this.singleton = getFactory({
                channelName: options.channelName,
                heartbeatInterval: options.heartbeatInterval,
                heartbeatTtl: options.heartbeatTtl
            });

            if(this.debug) console.log(`[${this.id}] Member joined channel: ${this.singleton.CHANNEL_NAME}`);

            // ثبت نام خودکار (این باعث شروع پروسه انتخاب لیدر می‌شود)
            this.singleton.register(this);
        }

        /**
         * ارسال درخواست با قابلیت تنظیم زمان انتظار (Timeout)
         * @param {any} data - داده‌های درخواست
         * @param {Object|Function} options - (اختیاری) تنظیمات یا کال‌بک. مثلا { timeout: 20000 }
         * @param {Function} callback - (اختیاری) کال‌بک سنتی
         */
        sendRequest(data, options = {}, callback = null) {
            // هندل کردن آرگومان‌ها (اگر options تابع بود، یعنی کاربر timeout نداده و مستقیم callback داده)
            if (typeof options === 'function') {
                callback = options;
                options = {};
            }

            const reqId = Math.random().toString(36).substr(2);

            // زمان انتظار: یا کاربر مشخص کرده، یا پیش‌فرض (TTL + 500ms)
            // اگر عملیات سنگین دارید، عدد بزرگتری بفرستید
            const requestTimeoutMs = options.timeout || (this.singleton.HEARTBEAT_TTL + 500);

            const promise = new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    if (this.pendingRequests.has(reqId)) {
                        this.pendingRequests.delete(reqId);

                        // نکته مهم: اگر تایم‌اوت دستی کاربر (مثلا 20 ثانیه) تمام شد،
                        // باز هم می‌فرستیم به Retry Queue. چون شاید واقعا لیدر مرده بوده.
                        // اما اگر لیدر فقط کند بوده، اینجا دیگه کاریش نمیشه کرد (Timeout واقعی).
                        this._addToRetryQueue(reqId, data, 'request', resolve, reject, callback);
                    }
                }, requestTimeoutMs);

                this.pendingRequests.set(reqId, { isMessage: false, resolve, reject, timeout });

                this.singleton.broadcastInternal({
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

        // --- ارسال پیام یک‌طرفه به لیدر (Message) با قابلیت Retry ---
        sendMessageToLeader(data) {
            const reqId = Math.random().toString(36).substr(2);

            // اینجا هم Timeout می‌گذاریم تا اگر لیدر نبود، در صف نگه داریم
            const timeout = setTimeout(() => {
                if (this.pendingRequests.has(reqId)) {
                    this.pendingRequests.delete(reqId);
                    this._addToRetryQueue(reqId, data, 'message-to-leader', null, null, null);
                }
            }, this.singleton.HEARTBEAT_TTL + 500);

            this.pendingRequests.set(reqId, { isMessage: true, timeout });

            this.singleton.broadcastInternal({
                type: 'message-to-leader',
                senderId: this.id,
                requestId: reqId,
                payload: data
            });
        }

        // --- Listeners ---
        onMessage(cb) { this.callbacks.onMessage = cb; }
        onRequest(cb) { this.callbacks.onRequest = cb; }

        onLeadershipChange(cb) {
            this.callbacks.onLeadershipChange = (isLeader) => {
                // اگر لیدر عوض شد، صف را خالی کن (ارسال مجدد)
                this._processRetryQueue();
                if (cb) cb(isLeader);
            };
        }

        // --- Leader Actions ---
        sendToMember(id, data) {
            if(this.isLeader()) this.singleton.broadcastInternal({ type: 'direct-message', senderId: this.id, targetId: id, payload: data });
        }
        broadcastToMembers(data) {
            if(this.isLeader()) this.singleton.broadcastInternal({ type: 'broadcast', senderId: this.id, payload: data });
        }

        isLeader() { return this.singleton.leaderId === this.id; }
        getMembersInfo() { return this.isLeader() ? this.singleton.getGlobalMembers() : []; }
        resign() { this.singleton.unregister(this.id); }

        // --- Internal: Retry Queue Logic ---

        _addToRetryQueue(reqId, data, type, resolve, reject, callback) {
            if (this.debug) console.log(`[${this.id}] ${type} ${reqId} timed out. Queued for retry.`);
            this.retryQueue.set(reqId, { type, data, resolve, reject, callback, retries: 0 });
        }

        _processRetryQueue() {
            if (this.retryQueue.size === 0) return;

            // اگر خودم لیدر شدم، درخواست‌های قبلی من به لیدر (که خودم هستم) معنا ندارد، پس پاک می‌کنیم
            if (this.isLeader()) {
                if (this.debug) console.log(`[${this.id}] I became leader. Clearing retry queue.`);
                this.retryQueue.clear();
                return;
            }

            if (this.debug) console.log(`[${this.id}] New leader found. Retrying ${this.retryQueue.size} items.`);

            const items = Array.from(this.retryQueue.entries());
            this.retryQueue.clear();

            items.forEach(([reqId, item]) => {
                item.retries++;
                if (item.retries > this.MAX_RETRIES) {
                    if (item.reject) item.reject(new Error(`Failed after ${this.MAX_RETRIES} retries`));
                    return;
                }

                // ارسال مجدد
                this._resendItem(reqId, item);
            });
        }

        _resendItem(reqId, item) {
            const timeout = setTimeout(() => {
                if (this.pendingRequests.has(reqId)) {
                    this.pendingRequests.delete(reqId);
                    this.retryQueue.set(reqId, item); // دوباره به صف برمی‌گردد
                }
            }, this.singleton.HEARTBEAT_TTL + 500);

            this.pendingRequests.set(reqId, {
                isMessage: (item.type === 'message-to-leader'),
                resolve: item.resolve,
                reject: item.reject,
                timeout
            });

            this.singleton.broadcastInternal({
                type: item.type,
                senderId: this.id,
                requestId: reqId,
                payload: item.data
            });
        }

        resolvePending(reqId, data, isFinal) {
            if (this.pendingRequests.has(reqId)) {
                const p = this.pendingRequests.get(reqId);
                clearTimeout(p.timeout);

                if (p.isMessage) {
                    this.pendingRequests.delete(reqId); // موفقیت پیام یک‌طرفه
                } else if (isFinal && p.resolve) {
                    p.resolve(data); // موفقیت درخواست
                    this.pendingRequests.delete(reqId);
                }
            }
        }
    }

    // Export Logic
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = FlockMember;
    } else if (typeof window !== 'undefined') {
        window.FlockMember = FlockMember;
    }
})();