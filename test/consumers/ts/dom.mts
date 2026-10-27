// DOM cells only (lib dom; scripts/consumer-matrix.sh): the platform WebSocket satisfies the structural constructor
// type.
import { Client, type WebSocketConstructorLike } from 'thruway.js';

export const platform: WebSocketConstructorLike = WebSocket;
export const client = new Client('wss://example.invalid/ws', 'realm1', { WebSocket, autoOpen: false });
