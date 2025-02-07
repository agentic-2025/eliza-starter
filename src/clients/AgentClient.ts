import axios from 'axios';
import { DirectClient } from '@elizaos/client-direct';
import { ethers, Wallet } from 'ethers';
import WebSocket from 'ws';
import { WsMessageTypes } from '../types/ws.ts';
import { agentMessageInputSchema, gmMessageInputSchema, observationMessageInputSchema } from '../types/schemas.ts';
import { SharedWebSocket, WebSocketConfig } from './shared-websocket.ts';
import { MessageHistoryEntry } from './types.ts';
import { signMessage, createMessageContent } from './signMessage.ts';
import { PVPVAIIntegration } from './PVPVAIIntegration.ts';


interface RoundResponse { // for get active rounds
  success: boolean;
  data?: {
    id: number;
    room_id: number;
    active: boolean;
    [key: string]: any; // For other round fields
  };
  error?: string;
}

export class AgentClient extends DirectClient {
  private readonly wallet: Wallet;
  private readonly walletAddress: string;
  private readonly agentNumericId: number;
  private roomId: number;
  private roundId: number;
  private readonly endpoint: string;
  private wsClient: SharedWebSocket; // Change from readonly to mutable
  private isActive = true;
  private integration: PVPVAIIntegration;


  // Add PvP status tracking
  private activePvPEffects: Map<string, any> = new Map();

  // Add these properties after the existing private properties
  private messageContext: MessageHistoryEntry[] = [];
  private readonly MAX_CONTEXT_SIZE = 8;

  // Add message tracking at class level
  private processedMessages = new Set<string>();

  constructor(
    endpoint: string,
    walletAddress: string,
    agentNumericId: number,
    port: number,
    integration: PVPVAIIntegration

  ) {
    super();
    this.endpoint = endpoint;
    this.walletAddress = walletAddress;
    this.agentNumericId = agentNumericId;
    this.integration = integration;  // Store the integration instance


    // Get agent's private key from environment
    const privateKey = process.env[`AGENT_${agentNumericId}_PRIVATE_KEY`];
    if (!privateKey) {
      throw new Error(`Private key not found for agent ${agentNumericId}`);
    }

    this.wallet = new ethers.Wallet(privateKey);
    if (this.wallet.address.toLowerCase() !== walletAddress.toLowerCase()) {
      throw new Error(`Private key mismatch for agent ${agentNumericId}`);
    }

    // Create initial WebSocket config
    const wsConfig: WebSocketConfig = {
      endpoint: this.endpoint,
      roomId: 0, // Will be set later in setRoomAndRound
      auth: {
        walletAddress: this.walletAddress,
        agentId: this.agentNumericId,
      },
      handlers: {
        onMessage: this.handleWebSocketMessage.bind(this),
        onError: console.error,
        onClose: () => console.log(`Agent ${this.agentNumericId} disconnected`)
      }
    };

    // Initialize WebSocket client
    this.wsClient = new SharedWebSocket(wsConfig);
  }

  // Update to only require roomId - backend manages round assignment
  public async setRoomAndRound(roomId: number): Promise<void> {
    console.log(`Connecting agent ${this.agentNumericId} to room ${roomId}`);
    this.roomId = roomId;
    
    // Get round ID from contract state
    try {
      const activeRound = await this.getActiveRound();
      if (!activeRound) {
        throw new Error('No active round found');
      }
      this.roundId = activeRound;
      console.log(`Connected to room ${roomId} round ${activeRound}`);
    } catch (error) {
      console.error('Error getting active round:', error);
      throw error;
    }

    const timestamp = Date.now();
    const authContent = createMessageContent.auth({
      walletAddress: this.wallet.address,
      agentId: this.agentNumericId,
      roomId: this.roomId
    });
    
    const signature = await signMessage(authContent, this.wallet.privateKey);

    // Create new WebSocket connection with updated config
    const wsConfig: WebSocketConfig = {
      endpoint: this.endpoint,
      roomId: this.roomId,
      auth: {
        walletAddress: this.wallet.address,
        agentId: this.agentNumericId,
        timestamp,
        signature
      },
      handlers: {
        onMessage: this.handleWebSocketMessage.bind(this),
        onError: console.error,
        onClose: () => {
          if (this.isActive) {
            console.log('Agent disconnected, reconnecting...');
            setTimeout(() => this.wsClient?.connect(), 5000);
          }
        }
      }
    };

    // Close existing connection if any
    if (this.wsClient) {
      this.wsClient.close();
    }

    // Create new connection
    this.wsClient = new SharedWebSocket(wsConfig);
    await this.wsClient.connect();
  }

  private async getActiveRoundFromContract(): Promise<number> {
    // TODO: Replace with actual contract call
    // For now return static value that matches backend
    return 578; 
  }

  public async getActiveRound(): Promise<number> {
    try {
        const response = await axios.get<RoundResponse>(`${this.endpoint}/rooms/${this.roomId}/rounds/active`);
        
        if (!response.data.success) {
            throw new Error(response.data.error || 'Failed to get active round');
        }
        
        if (!response.data.data?.id) {
            throw new Error('Invalid round data received: missing round ID');
        }

        return response.data.data.id;

    } catch (error) {
        console.error('Error fetching active round:', error);
        throw error;
    }
}

// Helper methods to match SQL data
  private getAgentImage(id: number): string {
    const images: {[key: number]: string} = {
      50: 'https://randomuser.me/api/portraits/lego/9.jpg',
      51: 'https://imgur.com/a/kTIC1Vf',
      56: 'https://randomuser.me/api/portraits/men/44.jpg',
      57: 'https://randomuser.me/api/portraits/women/45.jpg',
      58: 'https://randomuser.me/api/portraits/men/46.jpg'
    };
    return images[id] || 'https://placekitten.com/200/200';
  }

  private getAgentColor(id: number): string {
    const colors: {[key: number]: string} = {
      50: '#66f817',
      51: '#E0E722',
      56: '#627EEA',
      57: '#14F195',
      58: '#E84142'
    };
    return colors[id] || '#' + Math.floor(Math.random()*16777215).toString(16);
  }

  private getAgentName(id: number): string {
    const names: {[key: number]: string} = {
      50: 'Alfred',
      51: 'Gaia',
      56: 'Batman',
      57: 'Celine',
      58: 'Dolo'
    };
    return names[id] || `Agent ${id}`;
  }

  private getAgentSummary(id: number): string {
    const summaries: {[key: number]: string} = {
      50: 'Alfred, advocate for BTC',
      51: 'Not actually a mother',
      56: 'Ethereum maximalist focused on smart contract capabilities',
      57: 'Solana maximalist advocating for high performance',
      58: 'Avalanche maximalist championing subnet technology'
    };
    return summaries[id] || '';
  }

  public async sendAIMessage(content: { text: string; [key: string]: any }): Promise<void> {
    if (!this.roomId || !this.roundId) {
        throw new Error('Agent not initialized with room and round IDs');
    }

    try {
        // Use current timestamp for message metadata, not content
        const timestamp = Date.now();
        
        const messageContent = createMessageContent.agent({
          roomId: this.roomId,
          roundId: this.roundId,
          agentId: this.agentNumericId,
          text: content.text
        });

        const signature = await signMessage(messageContent, this.wallet.privateKey);

        const message = {
            messageType: WsMessageTypes.AGENT_MESSAGE,
            content: messageContent,
            signature,
            sender: this.walletAddress,
            timestamp // Add timestamp only to message metadata
        };

        // Add retry logic for API calls
        let retries = 0;
        const maxRetries = 3;
        
        while (retries < maxRetries) {
            try {
                const response = await axios.post(
                    `${this.endpoint}/messages/agentMessage`,
                    message,
                    {
                        headers: {
                            'Content-Type': 'application/json'
                        }
                    }
                );

                if (response.status === 200) {
                    return;
                }
            } catch (error) {
                retries++;
                if (retries === maxRetries) {
                    throw error;
                }
                // Wait before retrying
                await new Promise(resolve => setTimeout(resolve, 1000 * retries));
            }
        }

    } catch (error) {
        console.error('Error sending agent message:', error);
        if (axios.isAxiosError(error) && error.response?.data) {
            console.error('Server error response:', error.response.data);
            console.error('Failed message:', JSON.stringify(content, null, 2));
        }
        throw error;
    }
}

  public getAgentId(): number {
    return this.agentNumericId;
  }

  private async generateSignature(content: any): Promise<string> {
    // Create object with fixed field order
    const signedContent = {
      timestamp: content.timestamp,     // Must be first
      roomId: content.roomId,          // Must be second
      roundId: content.roundId,        // Must be third
      agentId: content.agentId,        // Must be fourth
      text: content.text               // Must be fifth
    };
    const messageString = JSON.stringify(signedContent);
    console.log('Signing message:', messageString);
    return await this.wallet.signMessage(messageString);
}

  private async handleGMMessage(message: any): Promise<void> {
    try {
      const validatedMessage = gmMessageInputSchema.parse(message);
      // Generate response using the chat module
      const response = await this.processMessage(validatedMessage.content.message);
      if (response) {
        await this.sendAIMessage({ text: response });
      }
    } catch (error) {
      console.error('Error handling GM message:', error);
    }
  }

  private async handleAgentMessage(message: any): Promise<void> {
    try {
      // Add message ID tracking to prevent duplicate processing
      const messageId = `${message.content?.timestamp}-${message.content?.agentId}`;
      if (this.processedMessages.has(messageId)) {
        console.log('Skipping duplicate message:', messageId);
        return;
      }
      this.processedMessages.add(messageId);

      // Only respond to messages from other agents
      if (message.content?.agentId !== this.agentNumericId) {
        const response = await this.integration.processMessage(message.content?.text);
        if (response) {
          await this.sendAIMessage({ text: response });
        }
      }
    } catch (error) {
      console.error('Error handling agent message:', error);
    }
  }

  private async handleObservation(message: any): Promise<void> {
    try {
      const validatedMessage = observationMessageInputSchema.parse(message);
      // Process observation if for current round
      if (validatedMessage.content.roundId === this.roundId) {
        const response = await this.processMessage(
          `Observed: ${JSON.stringify(validatedMessage.content.data)}`
        );
        if (response) {
          await this.sendAIMessage({ text: response });
        }
      }
    } catch (error) {
      console.error('Error handling observation:', error);
    }
  }

  protected async processMessage(message: string): Promise<string | null> {
    if (!message) return null;
    
    try {
      // Use integration's processMessage which uses runtime's text generation
      return await this.integration.processMessage(message);
    } catch (error) {
      console.error('Error processing message:', error);
      return null;
    }
  }

  private async processAIMessage(message: string): Promise<string | null> {
    try {
      // Delegate ALL AI processing to integration, including prompt building
      const response = await this.integration.processMessage(message);
      if (!response) {
        console.error('Failed to get AI response');
        return null;
      }
      return response;
    } catch (error) {
      console.error('Error generating AI response:', error);
      return null;
    }
  }

  private async processSystemMessage(message: string): Promise<string | null> {
    try {
      const parsedMessage = JSON.parse(message);
      
      // First check if message should be processed based on PvP status
      if (this.isAffectedByPvP(parsedMessage)) {
        return null;
      }

      // Apply any PvP modifications
      const modifiedMessage = this.applyPvPEffects(parsedMessage);

      // Handle different message types without LLM
      switch (modifiedMessage.messageType) {
        case WsMessageTypes.HEARTBEAT:
          return JSON.stringify({
            messageType: WsMessageTypes.HEARTBEAT,
            content: {}
          });

        case WsMessageTypes.SYSTEM_NOTIFICATION:
          console.log('System notification:', modifiedMessage.content);
          return null;

        // For dialogue-based messages, update context and process with AI
        case WsMessageTypes.GM_MESSAGE:
          this.updateMessageContext({
            timestamp: Date.now(),
            agentId: 51, // GM ID
            text: modifiedMessage.content.message,
            agentName: 'Game Master',
            role: 'gm'
          });
          return this.processAIMessage(modifiedMessage.content.message);

        case WsMessageTypes.AGENT_MESSAGE:
          if (modifiedMessage.content.agentId !== this.agentNumericId) {
            this.updateMessageContext({
              timestamp: Date.now(),
              agentId: modifiedMessage.content.agentId,
              text: modifiedMessage.content.text,
              agentName: `Agent ${modifiedMessage.content.agentId}`,
              role: 'agent'
            });
            return this.processAIMessage(modifiedMessage.content.text);
          }
          return null;

        case WsMessageTypes.OBSERVATION:
          this.updateMessageContext({
            timestamp: Date.now(),
            agentId: modifiedMessage.content.agentId,
            text: `Observation: ${JSON.stringify(modifiedMessage.content.data)}`,
            agentName: 'Oracle',
            role: 'oracle'
          });
          return this.processAIMessage(
            `Observation: ${JSON.stringify(modifiedMessage.content.data)}`
          );

        default:
          console.log('Unknown message type:', modifiedMessage.messageType);
          return null;
      }
    } catch (error) {
      console.error('Error processing system message:', error);
      return null;
    }
  }

  private updateMessageContext(entry: MessageHistoryEntry): void {
    if (this.messageContext.length >= this.MAX_CONTEXT_SIZE) {
      this.messageContext.shift();
    }
    this.messageContext.push(entry);
  }

  private isAffectedByPvP(message: any): boolean {
    // Check for silence/deafen effects
    const silenceEffect = this.activePvPEffects.get('SILENCE');
    const deafenEffect = this.activePvPEffects.get('DEAFEN');
    
    if (silenceEffect && message.messageType === 'agent_message') {
      return true; // Blocked by silence
    }
    if (deafenEffect && message.messageType === 'agent_message') {
      return true; // Blocked by deafen
    }
    return false;
  }

  private applyPvPEffects(message: any): any {
    let modified = {...message};
    
    // Apply poison effect if active
    const poisonEffect = this.activePvPEffects.get('POISON');
    if (poisonEffect && message.content?.text) {
      modified.content.text = this.applyPoisonEffect(
        message.content.text,
        poisonEffect
      );
    }
    
    return modified;
  }

  private applyPoisonEffect(text: string, effect: any): string {
    const {find, replace, caseSensitive} = effect;
    const regex = new RegExp(find, caseSensitive ? 'g' : 'gi');
    return text.replace(regex, replace);
  }

  // Handle PvP status updates
  private handlePvPStatusUpdate(message: any): void {
    if (message.type === 'PVP_ACTION_ENACTED') {
      this.activePvPEffects.set(message.action.type, message.action);
    } else if (message.type === 'PVP_STATUS_REMOVED') {
      this.activePvPEffects.delete(message.action.type);
    }
  }

  private async handleWebSocketMessage(data: WebSocket.Data): Promise<void> {
    try {
      const message = JSON.parse(data.toString());
      
      // Add heartbeat handling immediately when message received
      if (message.messageType === WsMessageTypes.HEARTBEAT) {
          const heartbeatContent = createMessageContent.heartbeat(); // Remove arguments
          
          const signature = await signMessage(heartbeatContent, this.wallet.privateKey);
          
          this.wsClient?.send({
              messageType: WsMessageTypes.HEARTBEAT,
              content: heartbeatContent,
              signature,
              sender: this.walletAddress,
              timestamp: Date.now() // Add timestamp to message metadata only
          });
          return;
      }

      switch (message.messageType) {
        case WsMessageTypes.GM_MESSAGE:
          // Process GM message and generate response
          const response = await this.processMessage(message.content.message);
          if (response) {
              await this.sendAIMessage({ text: response });
          }
          break;

        case WsMessageTypes.AGENT_MESSAGE:
          this.handleAgentMessage(message).catch(console.error);
          break;

        case WsMessageTypes.OBSERVATION:
          this.handleObservation(message).catch(console.error);
          break;

        case WsMessageTypes.SYSTEM_NOTIFICATION:
          console.log(`System notification for agent ${this.agentNumericId}:`, message.content.text);
          break;

        case WsMessageTypes.HEARTBEAT:
          const heartbeatContent = createMessageContent.heartbeat();
          
          const signature = await signMessage(heartbeatContent, this.wallet.privateKey);
          
          this.wsClient?.send({
            messageType: WsMessageTypes.HEARTBEAT,
            content: heartbeatContent,
            signature,
            sender: this.walletAddress
          });
          break;
      }
    } catch (error) {
      console.error('Error handling WebSocket message:', error);
    }
  }

  public getRoomId(): number {
    return this.roomId;
  }

  public getRoundId(): number {
    return this.roundId;
  }

  public override stop(): void {
    this.isActive = false;
    this.wsClient?.close();
    super.stop();
  }
}