
declare module 'flock-election' {

    // Interfaces for configuration options
    interface FlockOptions {
        channelName?: string;
        heartbeatInterval?: number;
        heartbeatTtl?: number;
        debug?: boolean;
    }

    interface RequestOptions {
        timeout?: number;
    }

    interface MessageEnvelope {
        senderId: string;
        type: 'leader-message' | 'broadcast' | 'direct-message';
        payload: any;
    }

    // The main class exported by the module
    export default class FlockMember {
        constructor(options?: FlockOptions);

        // --- Core Communication ---
        sendRequest(
            data: any,
            options?: RequestOptions,
            callback?: (error: Error | null, response: any) => void
        ): Promise<any>;

        sendMessageToLeader(data: any): void;

        // --- Listeners ---
        onRequest(callback: (data: any, reply: (response: any) => void) => void): void;
        onMessage(callback: (msg: MessageEnvelope) => void): void;
        onLeadershipChange(callback: (leader_id: string) => void): void;

        // --- Utilities ---
        isLeader(): boolean;
        resign(): void;
        cedeLeadership() : void;
        getMembersInfo(): string[];
        sendToMember(id: string, data: any): void;
        broadcastToMembers(data: any): void;
    }
}