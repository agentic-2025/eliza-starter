import WebSocket from 'ws';
import { WsMessageTypes } from '../types/ws.ts';
import { sortObjectKeys } from './sortObjectKeys.ts'; 

// Update auth interface to match backend expectations
export interface WebSocketConfig {
  endpoint: string;
  roomId: number;
  auth: {
    walletAddress: string;
    agentId: number;
    timestamp?: number;
    signature?: string;
  };
  handlers: {
    onMessage: (data: WebSocket.Data) => void;
    onError?: (error: Error) => void;
    onClose?: () => void;
  };
}

export class SharedWebSocket {
  private ws: WebSocket | null = null;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private readonly HEARTBEAT_INTERVAL = 30000; // Match server's 30s interval
  private readonly HEARTBEAT_TIMEOUT = 30000;  // Match server's timeout
  private reconnectAttempts = 0;
  private isActive = true;
  private lastHeartbeatResponse = Date.now();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private readonly MAX_RECONNECT_DELAY = 30000; // 30 seconds max
  private reconnectAttempt = 0;

  constructor(private config: WebSocketConfig) {}

  public async connect(): Promise<void> {
    // Clear any existing connection
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }

    // Clear any pending reconnect
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    const wsUrl = new URL(this.config.endpoint);
    wsUrl.protocol = wsUrl.protocol.replace('http', 'ws');
    wsUrl.pathname = '/ws';

    // Add auth params to query string
    const params = new URLSearchParams({
      walletAddress: this.config.auth.walletAddress,
      agentId: this.config.auth.agentId.toString(),
      timestamp: (this.config.auth.timestamp || Date.now()).toString()
    });
    if (this.config.auth.signature) {
      params.append('signature', this.config.auth.signature);
    }
    wsUrl.search = params.toString();

    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(wsUrl.toString());

        this.ws.on('open', async () => {
          console.log('WebSocket connected');
          this.reconnectAttempt = 0; // Reset counter on successful connection
          try {
            await this.subscribeToRoom();
            this.setupHeartbeat();
            this.reconnectAttempts = 0;
            resolve();
          } catch (error) {
            reject(error);
          }
        });

        this.ws.on('message', (data) => {
          try {
            this.handleMessage(data);
          } catch (err) {
            console.error('Error handling message:', err);
          }
        });

        this.ws.on('error', (error) => {
          console.error('WebSocket error:', error);
          this.config.handlers.onError?.(error as Error);
          reject(error);
        });

        this.ws.on('close', () => {
          this.handleDisconnect();
        });

        // Add connection timeout
        const timeout = setTimeout(() => {
          if (this.ws?.readyState !== WebSocket.OPEN) {
            this.ws?.close();
            reject(new Error('WebSocket connection timeout'));
          }
        }, 5000);

        this.ws.once('open', () => clearTimeout(timeout));

      } catch (error) {
        reject(error);
      }
    });
  }

  private async subscribeToRoom(): Promise<void> {
    if (!this.ws) return;

    const subscribeMessage = {
      messageType: WsMessageTypes.SUBSCRIBE_ROOM,
      content: sortObjectKeys({
        roomId: this.config.roomId,
        timestamp: Date.now()
      })
    };

    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(subscribeMessage));
    }
  }

  private setupHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }

    this.heartbeatInterval = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

      const timeSinceLastResponse = Date.now() - this.lastHeartbeatResponse;
      if (timeSinceLastResponse > this.HEARTBEAT_TIMEOUT) {
        this.ws.close(1000, 'Heartbeat timeout');
        return;
      }

      this.ws.send(JSON.stringify({
        messageType: WsMessageTypes.HEARTBEAT,
        content: {}
      }));

    }, this.HEARTBEAT_INTERVAL);
  }

  public handleHeartbeat(): void {
    this.lastHeartbeatResponse = Date.now();
  }

  private handleMessage(data: WebSocket.Data): void {
    try {
      const message = JSON.parse(data.toString());
      
      if (message.messageType === WsMessageTypes.HEARTBEAT) {
        this.handleHeartbeat();
        return;
      }

      this.config.handlers.onMessage(data);
    } catch (error) {
      console.error('Error handling WebSocket message:', error);
    }
  }

  private handleDisconnect(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    
    if (!this.isActive) return;

    const delay = Math.min(
      1000 * Math.pow(2, this.reconnectAttempt),
      this.MAX_RECONNECT_DELAY
    );
    
    console.log(`WebSocket disconnected. Attempting reconnect in ${delay}ms`);
    
    this.reconnectTimer = setTimeout(() => {
      this.reconnectAttempt++;
      this.connect().catch(console.error);
    }, delay);

    this.config.handlers.onClose?.();
  }

  public close(): void {
    this.isActive = false;
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    if (this.ws) {
      this.ws.close();
    }
  }

  public send(message: any): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(sortObjectKeys(message)));
    }
  }

  public isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  
}