/**
 * FlockSingleton.js
 * Universal Leader Election Engine (Multiton Pattern for multiple channels)
 * Features: Auto-Election, Heartbeats, Retry Support, Node/Browser Support
 */

(function() {
    // مخزن نگهداری نمونه‌ها بر اساس نام کانال (Multiton Map)
    const instances = new Map();

    class FlockSingleton {
        constructor(options = {}) {
            // تنظیمات
            this.CHANNEL_NAME = options.channelName || 'flock_channel_v1';
            this.HEARTBEAT_INTERVAL = options.heartbeatInterval || 2000;
            this.HEARTBEAT_TTL = options.heartbeatTtl || 5000;

            // محیط اجرا
            this.isNode = typeof module !== 'undefined' && !!module.exports;
            this.isBrowser = typeof window !== 'undefined';

            // وضعیت
            this.members = new Map();
            this.remoteMembers = new Map();
            this.leaderId = null;
            this.isLeaderState = false;
            this.lastHeartbeatTime = Date.now();

            // تایمرها
            this.heartbeatTimer = null;
            this.checkLeaderTimer = null;

            // راه‌اندازی فوری
            this.setupTransport();
            this.startMonitoring();
        }

        setupTransport() {
            // 1. BroadcastChannel
            if (typeof BroadcastChannel !== 'undefined') {
                try {
                    this.channel = new BroadcastChannel(this.CHANNEL_NAME);
                    this.channel.onmessage = (event) => this.handleMessage(event.data);
                    return;
                } catch (e) { /* Fallback */ }
            }

            // 2. LocalStorage
            if (this.isBrowser && window.localStorage) {
                window.addEventListener('storage', (event) => {
                    if (event.key === this.CHANNEL_NAME && event.newValue) {
                        try {
                            this.handleMessage(JSON.parse(event.newValue));
                        } catch(e){}
                    }
                });
                this.useLocalStorage = true;
            }
        }

        broadcastInternal(payload) {
            const msg = { ...payload, _ts: Date.now() };

            if (this.channel) {
                this.channel.postMessage(msg);
            } else if (this.useLocalStorage) {
                localStorage.setItem(this.CHANNEL_NAME, JSON.stringify(msg));
                setTimeout(() => localStorage.removeItem(this.CHANNEL_NAME), 50);
            }
            // بازخورد داخلی برای پردازش پیام‌های خودمان
            this.handleMessage(msg);
        }

        handleMessage(data) {
            if (!data || !data.type) return;
            const { type, senderId, targetId, payload, requestId } = data;

            if (senderId) this.remoteMembers.set(senderId, Date.now());

            switch (type) {
                case 'claim': this.handleClaim(senderId); break;
                case 'heartbeat': this.handleHeartbeat(senderId); break;
                case 'resign': this.handleResign(senderId); break;

                case 'request':
                    if (this.isLeaderState) this.distributeRequest(data);
                    break;

                case 'message-to-leader':
                    if (this.isLeaderState) {
                        this.distributeMessageToLeader(data);
                        // پاسخ ساختگی برای پاک کردن Timeout فرستنده
                        this.broadcastInternal({ type: 'response', targetId: senderId, requestId: requestId, payload: null });
                    }
                    break;

                case 'response':
                    this.distributeResponse(data);
                    break;

                case 'broadcast': this.notifyLocal(null, 'onMessage', payload); break;
                case 'direct-message': if (targetId) this.notifyLocal(targetId, 'onMessage', payload); break;
                case 'request-leader-sync': if (this.isLeaderState) this.sendHeartbeat(); break;
            }
        }

        // --- منطق انتخابات (Election Logic) ---
        handleClaim(candidateId) {
            // اگر من لیدر هستم و کسی ادعا کرد، قدرت‌نمایی می‌کنم
            if (this.isLeaderState && candidateId !== this.leaderId) this.sendHeartbeat();
            else this.setLeader(candidateId);
        }

        handleHeartbeat(leaderId) {
            this.lastHeartbeatTime = Date.now();
            if (this.leaderId !== leaderId) this.setLeader(leaderId);
        }

        handleResign(oldId) {
            if (this.leaderId === oldId) {
                this.leaderId = null;
                this.triggerElection(); // انتخابات فوری
            }
        }

        setLeader(id) {
            if (this.leaderId !== id) {
                this.leaderId = id;
                const amILeader = this.members.has(id);
                this.isLeaderState = amILeader;

                if (amILeader) this.startHeartbeatLoop();
                else this.stopHeartbeatLoop();

                this.members.forEach(m => {
                    if (m.callbacks.onLeadershipChange) m.callbacks.onLeadershipChange(amILeader);
                });
            }
        }

        triggerElection() {
            const candidate = this.getLocalCandidate();
            if (candidate) {
                this.broadcastInternal({ type: 'claim', senderId: candidate.id });
            }
        }

        startMonitoring() {
            // نظارت دائمی بر زنده بودن لیدر
            this.checkLeaderTimer = setInterval(() => {
                const now = Date.now();
                // اگر لیدر نداریم یا لیدر منقضی شده
                if (!this.leaderId || (now - this.lastHeartbeatTime > this.HEARTBEAT_TTL)) {
                    if (!this.isLeaderState) {
                        this.leaderId = null;
                        this.triggerElection();
                    }
                }
            }, 1000);
        }

        // --- Leader Loop ---
        startHeartbeatLoop() {
            if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
            this.sendHeartbeat();
            this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), this.HEARTBEAT_INTERVAL);
        }
        stopHeartbeatLoop() {
            if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
        sendHeartbeat() {
            const me = this.getLocalCandidate();
            if (me) this.broadcastInternal({ type: 'heartbeat', senderId: me.id });
        }

        // --- Registry ---
        register(member) {
            this.members.set(member.id, member);

            // 1. پرسش: لیدر کیست؟
            this.broadcastInternal({ type: 'request-leader-sync', senderId: member.id });

            // 2. اگر پاسخی نیامد، خودکار کاندید شو (Auto Trigger)
            setTimeout(() => {
                if (!this.leaderId) this.triggerElection();
            }, 500);
        }

        unregister(id) {
            this.members.delete(id);
            if (this.leaderId === id) {
                this.broadcastInternal({ type: 'resign', senderId: id });
                this.setLeader(null);
            }
        }

        // --- Routing Helpers ---
        getLocalCandidate() {
            if (this.members.size === 0) return null;
            if (this.isLeaderState && this.members.has(this.leaderId)) return this.members.get(this.leaderId);
            return this.members.values().next().value;
        }
        distributeRequest(data) {
            const leader = this.members.get(this.leaderId);
            if (leader && leader.callbacks.onRequest) {
                leader.callbacks.onRequest(data.payload, (res) => {
                    this.broadcastInternal({ type: 'response', targetId: data.senderId, requestId: data.requestId, payload: res });
                });
            }
        }
        distributeMessageToLeader(data) {
            const leader = this.members.get(this.leaderId);
            if (leader && leader.callbacks.onMessage) {
                leader.callbacks.onMessage({ senderId: data.senderId, payload: data.payload, type: 'leader-message' });
            }
        }
        distributeResponse(data) {
            const m = this.members.get(data.targetId);
            if (m) m.resolvePending(data.requestId, data.payload, true);
        }
        notifyLocal(id, event, data) {
            if (id) {
                const m = this.members.get(id);
                if (m && m.callbacks[event]) m.callbacks[event](data);
            } else {
                this.members.forEach(m => { if (m.callbacks[event]) m.callbacks[event](data); });
            }
        }
        getGlobalMembers() {
            const now = Date.now();
            const activeRemote = Array.from(this.remoteMembers.entries())
                .filter(([_, t]) => now - t < this.HEARTBEAT_TTL).map(([id]) => id);
            return [...new Set([...activeRemote, ...Array.from(this.members.keys())])];
        }
    }

    // --- Factory Function (اصلاح شده برای Multiton) ---
    function getFlockSingletonInstance(options = {}) {
        const channelKey = options.channelName || 'flock_channel_v1';

        // اگر برای این کانال قبلاً موتوری ساخته نشده، بساز
        if (!instances.has(channelKey)) {
            instances.set(channelKey, new FlockSingleton(options));
        }

        return instances.get(channelKey);
    }

    // Export Logic
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { getFlockSingletonInstance };
    } else if (typeof window !== 'undefined') {
        window.getFlockSingletonInstance = getFlockSingletonInstance;
    }
})();