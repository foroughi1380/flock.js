/**
 * FlockSingleton.js
 * Universal Leader Election Engine (CommonJS & Browser Global compatible)
 */

(function() {
    class FlockSingleton {
        constructor() {
            if (FlockSingleton.instance) {
                return FlockSingleton.instance;
            }
            FlockSingleton.instance = this;

            // Environment Flags
            this.isNode = typeof module !== 'undefined' && !!module.exports;
            this.isBrowser = typeof window !== 'undefined';

            // Config
            this.HEARTBEAT_INTERVAL = 2000;
            this.HEARTBEAT_TTL = 5000;
            this.CHANNEL_NAME = 'flock_channel_v1';

            this.members = new Map();
            this.remoteMembers = new Map();
            this.leaderId = null;
            this.isLeaderState = false;
            this.lastHeartbeatTime = Date.now();
            this.heartbeatTimer = null;
            this.checkLeaderTimer = null;

            this.setupTransport();
            this.startMonitoring();
        }

        setupTransport() {
            // 1. BroadcastChannel (Node v15+ & Modern Browsers)
            if (typeof BroadcastChannel !== 'undefined') {
                try {
                    this.channel = new BroadcastChannel(this.CHANNEL_NAME);
                    this.channel.onmessage = (event) => this.handleMessage(event.data);
                    return;
                } catch (e) { /* Fallback */ }
            }

            // 2. LocalStorage Fallback (Browser Only)
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

            // Loopback for local processing
            this.handleMessage(msg);
        }

        handleMessage(data) {
            if (!data || !data.type) return;
            const { type, senderId, targetId, payload } = data;

            if (senderId) this.remoteMembers.set(senderId, Date.now());

            switch (type) {
                case 'claim': this.handleClaim(senderId); break;
                case 'heartbeat': this.handleHeartbeat(senderId); break;
                case 'resign': this.handleResign(senderId); break;
                case 'request': if (this.isLeaderState) this.distributeRequest(data); break;
                case 'response': this.distributeResponse(data); break;
                case 'broadcast': this.notifyLocal(null, 'onMessage', payload); break;
                case 'direct-message': if (targetId) this.notifyLocal(targetId, 'onMessage', payload); break;
                case 'request-leader-sync': if (this.isLeaderState) this.sendHeartbeat(); break;
            }
        }

        // --- Election Logic ---
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

                // Notify all members about the leadership change
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
            // Check for leader timeout every second
            this.checkLeaderTimer = setInterval(() => {
                if (!this.leaderId || (Date.now() - this.lastHeartbeatTime > this.HEARTBEAT_TTL)) {
                    if (!this.isLeaderState) {
                        this.leaderId = null;
                        this.triggerElection();
                    }
                }
            }, 1000);
        }

        // --- Leader Tools ---
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
            this.broadcastInternal({ type: 'request-leader-sync', senderId: member.id });
            setTimeout(() => { if (!this.leaderId) this.triggerElection(); }, 500);
        }
        unregister(id) {
            this.members.delete(id);
            if (this.leaderId === id) {
                this.broadcastInternal({ type: 'resign', senderId: id });
                this.setLeader(null);
            }
        }

        // --- Helpers ---
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
        distributeResponse(data) {
            const m = this.members.get(data.targetId);
            if (m) m.resolvePending(data.requestId, data.payload, true); // Resolve immediately (final response)
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

    // Export Logic (UMD-like)
    const instance = new FlockSingleton();

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = instance; // CommonJS (Node.js)
    } else if (typeof window !== 'undefined') {
        window.FlockSingleton = instance; // Browser Global
    }
})();