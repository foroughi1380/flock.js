
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

    interface LeaderMessage {
        senderId: string;
        payload: any;
        type: 'leader-message' | 'broadcast' | 'direct-message';
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
        onMessage(callback: (message: LeaderMessage) => void): void;
        onLeadershipChange(callback: (isLeader: boolean) => void): void;

        // --- Utilities ---
        isLeader(): boolean;
        resign(): void;
        getMembersInfo(): string[];
        sendToMember(id: string, data: any): void;
        broadcastToMembers(data: any): void;
    }
}