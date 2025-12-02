/**
 * FlockSingleton.js
 * The Core Engine for Leader Election (Final Version with all fixes).
 */

(function() {
    // مخزن نگهداری نمونه‌ها بر اساس نام کانال (Multiton Pattern)
    const instances = new Map();

    class FlockSingleton {
        constructor(options = {}) {
            this.CHANNEL_NAME = options.channelName || 'flock_channel_v1';
            this.HEARTBEAT_INTERVAL = options.heartbeatInterval || 2000;
            this.HEARTBEAT_TTL = options.heartbeatTtl || 5000;

            this.isNode = typeof module !== 'undefined' && !!module.exports;
            this.isBrowser = typeof window !== 'undefined';

            this.members = new Map();
            this.remoteMembers = new Map();
            this.leaderId = null;
            this.isLeaderState = false;
            this.lastHeartbeatTime = Date.now();

            this.heartbeatTimer = null;
            this.checkLeaderTimer = null;

            // === NEW: مکانیزم استثنای موقت ===
            this.excludedCandidateId = null;
            this.exclusionTimer = null;
            // ===================================

            this.setupTransport();
            this.startMonitoring();
        }

        setupTransport() {
            if (typeof BroadcastChannel !== 'undefined') {
                try {
                    this.channel = new BroadcastChannel(this.CHANNEL_NAME);
                    this.channel.onmessage = (event) => this.handleMessage(event.data);
                    return;
                } catch (e) { /* Fallback */ }
            }
            if (this.isBrowser && window.localStorage) {
                window.addEventListener('storage', (event) => {
                    if (event.key === this.CHANNEL_NAME && event.newValue) {
                        try { this.handleMessage(JSON.parse(event.newValue)); } catch(e){}
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
                case 'request': if (this.isLeaderState) this.distributeRequest(data); break;

                case 'message-to-leader':
                    if (this.isLeaderState) {
                        this.distributeMessageToLeader(data);
                        this.broadcastInternal({ type: 'response', targetId: senderId, requestId: requestId, payload: null });
                    }
                    break;

                case 'response': this.distributeResponse(data); break;

                case 'broadcast':
                    this.notifyLocal(null, 'onMessage', {
                        senderId: senderId,
                        type: 'broadcast',
                        payload: payload
                    });
                    break;

                case 'direct-message':
                    if (targetId) {
                        this.notifyLocal(targetId, 'onMessage', {
                            senderId: senderId,
                            type: 'direct-message',
                            payload: payload
                        });
                    }
                    break;

                case 'request-leader-sync': if (this.isLeaderState) this.sendHeartbeat(); break;
            }
        }

        handleClaim(candidateId) {
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
                this.triggerElection();
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
                    if (m.callbacks.onLeadershipChange) {
                        m.callbacks.onLeadershipChange(id);
                    }
                });
            }
        }

        // --- متد تنظیم استثنای موقت ---
        setTemporaryExclusion(id, durationMs) {
            clearTimeout(this.exclusionTimer);
            this.excludedCandidateId = id;
            this.exclusionTimer = setTimeout(() => {
                this.excludedCandidateId = null;
            }, durationMs);
        }
        // ------------------------------

        triggerElection() {
            const candidate = this.getLocalCandidate();
            if (candidate) this.broadcastInternal({ type: 'claim', senderId: candidate.id });
        }

        startMonitoring() {
            this.checkLeaderTimer = setInterval(() => {
                const now = Date.now();
                if (!this.leaderId || (now - this.lastHeartbeatTime > this.HEARTBEAT_TTL)) {
                    if (!this.isLeaderState) {
                        this.leaderId = null;
                        this.triggerElection();
                    }
                }
            }, 1000);
        }

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

        register(member) {
            this.members.set(member.id, member);

            // FIX: اطلاع‌رسانی اولیه به عضو جدید
            if (this.leaderId) {
                setTimeout(() => {
                    if (member.callbacks.onLeadershipChange) {
                        member.callbacks.onLeadershipChange(this.leaderId);
                    }
                }, 0);
            }

            this.broadcastInternal({ type: 'request-leader-sync', senderId: member.id });
            setTimeout(() => { if (!this.leaderId) this.triggerElection(); }, 500);
        }

        unregister(id) {
            const resigningMember = this.members.get(id);
            this.members.delete(id);

            if (this.leaderId === id) {
                // FIX: صریحاً لیدر مستعفی را مطلع می‌کنیم
                if (resigningMember && resigningMember.callbacks.onLeadershipChange) {
                    resigningMember.callbacks.onLeadershipChange(null);
                }

                // FIX: فقط پیام استعفا را منتشر می‌کنیم و به handleResign اجازه می‌دهیم انتخابات را آغاز کند.
                this.broadcastInternal({ type: 'resign', senderId: id });
            }
        }

        // --- Modified: جستجوی کاندیدا با در نظر گرفتن استثنا ---
        getLocalCandidate() {
            if (this.members.size === 0) return null;

            if (this.isLeaderState && this.members.has(this.leaderId)) {
                return this.members.get(this.leaderId);
            }

            // عضو غیرلیدر را پیدا می‌کنیم که مستثنی نشده باشد.
            for (const member of this.members.values()) {
                if (member.id !== this.excludedCandidateId) {
                    return member;
                }
            }

            return null;
        }
        // ----------------------------------------------------

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

    function getFlockSingletonInstance(options = {}) {
        const channelKey = options.channelName || 'flock_channel_v1';
        if (!instances.has(channelKey)) {
            instances.set(channelKey, new FlockSingleton(options));
        }
        return instances.get(channelKey);
    }

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { getFlockSingletonInstance };
    } else if (typeof window !== 'undefined') {
        window.FlockSingletonFactory = getFlockSingletonInstance;
    }
})();