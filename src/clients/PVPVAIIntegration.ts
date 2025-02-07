import { AgentRuntime, generateText, ModelClass, ModelProviderName, stringToUuid, UUID, ServiceType, ITextGenerationService } from '@elizaos/core';
import { GameMasterClient } from './GameMasterClient.ts';
import { AgentClient } from './AgentClient.ts';
import type { 
  Character as ExtendedCharacter, 
  ExtendedAgentRuntime,
  PvPAction,
  MessageContent,
  DebateMemory 
} from '../types/index.ts';

export interface Config {
  endpoint: string;
  walletAddress: string;
  creatorId: number;
  agentId?: number;
  port: number;
  privateKey?: string;
  roomId?: number;
}

export const AGENT_CONFIGS = {
  GAMEMASTER: {
    port: 3330,
    endpoint: process.env.BACKEND_URL || "http://localhost:3000",
    roomId: Number(process.env.ROOM_ID) || 290
  },
  AGENT1: {
    port: 3331,
    endpoint: process.env.BACKEND_URL || "http://localhost:3000",
    roomId: Number(process.env.ROOM_ID) || 290
  },
  AGENT2: {
    port: 3332,
    endpoint: process.env.BACKEND_URL || "http://localhost:3000",
    roomId: Number(process.env.ROOM_ID) || 290
  },
  AGENT3: {
    port: 3333,
    endpoint: process.env.BACKEND_URL || "http://localhost:3000",
    roomId: Number(process.env.ROOM_ID) || 290
  },
  AGENT4: {
    port: 3334,
    endpoint: process.env.BACKEND_URL || "http://localhost:3000",
    roomId: Number(process.env.ROOM_ID) || 290
  }
};

export class PVPVAIIntegration {
  private client: GameMasterClient | AgentClient;
  private readonly runtime: ExtendedAgentRuntime;
  private messageContext: DebateMemory[] = [];
  private readonly MAX_CONTEXT_SIZE = 8;
  private activePvPEffects: Map<string, PvPAction> = new Map();
  private lastApiCall: number = 0;
  private readonly MIN_API_INTERVAL = 15000;
  private processedMessageIds = new Set<string>();

  constructor(runtime: ExtendedAgentRuntime, config: Config) {
    this.runtime = runtime;
    
    const char = runtime.character as ExtendedCharacter;
    const isGM = char.agentRole?.type.toUpperCase() === 'GM';
    
    const walletAddress = char.settings?.pvpvai?.eth_wallet_address || config.walletAddress;
    if (!walletAddress) {
      throw new Error('No eth_wallet_address found in character settings or config');
    }

    if (isGM) {
      const privateKey = process.env.GM_PRIVATE_KEY;
      if (!privateKey) {
        throw new Error('GM_PRIVATE_KEY not found in environment variables');
      }
      
      this.client = new GameMasterClient(
        config.endpoint,
        walletAddress,        
        config.creatorId,
        char,
      );
    } else {
      const agentId = char.settings?.pvpvai?.agentId || config.agentId;
      if (!agentId) {
        throw new Error('No agentId found in character settings or config');
      }
      
      const privateKeyEnv = `AGENT_${agentId}_PRIVATE_KEY`;
      const privateKey = process.env[privateKeyEnv] || config.privateKey;
      if (!privateKey) {
        throw new Error(`${privateKeyEnv} not found in environment variables`);
      }

      const agentConfig = this.getAgentConfig(agentId);
      
      this.client = new AgentClient(
        config.endpoint,
        walletAddress,        
        agentId,
        config.port || agentConfig.port,
        this
      );
    }

    // Register this integration with runtime
    runtime.clients['pvpvai'] = this;
  }

  private getAgentConfig(agentId?: number) {
    const id = agentId || (this.runtime.character as ExtendedCharacter).settings?.pvpvai?.agentId;
    const config = {
      roomId: Number(process.env.ROOM_ID) || 290,
      ...(() => {
        switch(id) {
          case 50: return AGENT_CONFIGS.AGENT1;
          case 56: return AGENT_CONFIGS.AGENT2; 
          case 57: return AGENT_CONFIGS.AGENT3;
          case 58: return AGENT_CONFIGS.AGENT4;
          default: throw new Error(`Unknown agent ID: ${id}`);
        }
      })()
    };
    return config;
  }

  private buildPromptWithContext(text: string): string {
    const char = this.runtime.character as ExtendedCharacter;
    return char.agentRole?.type.toUpperCase() === 'GM' 
      ? this.buildGMPrompt(text) 
      : this.buildAgentPrompt(text);
  }

  private buildGMPrompt(text: string): string {
    return `You are the Game Master overseeing a crypto debate. Your role is to moderate and guide the discussion.

Previous messages:
${this.messageContext.map(msg => 
  `${msg.agentId} (${msg.timestamp}): ${msg.content.text}`
).join('\n')}

Based on this context, provide moderation or guidance. Remember to:
1. Keep the discussion focused and productive
2. Address any violations of debate rules
3. Encourage constructive dialogue
4. Maintain neutrality
5. Guide the conversation when needed

Your response to the current situation: ${text}`;
  }

  private buildAgentPrompt(text: string): string {
    const char = this.runtime.character as ExtendedCharacter;
    return `You are participating in a crypto debate as an advocate for ${char.agentRole?.chain_family}.

Previous messages:
${this.messageContext.map(msg => 
  `${msg.agentId} (${msg.timestamp}): ${msg.content.text}`
).join('\n')}

Based on this context, respond with your perspective. Remember to:
1. Reference specific points made by others
2. Stay in character as ${char.agentRole?.chain_family} advocate
3. Keep responses clear and focused
4. Support your arguments with technical merits
5. Maintain a professional but passionate tone

Your response to the current topic: ${text}`;
  }

  private async waitForRateLimit(): Promise<void> {
    const now = Date.now();
    const timeSinceLastCall = now - this.lastApiCall;
    const waitTime = Math.max(0, this.MIN_API_INTERVAL - timeSinceLastCall);
    
    if (waitTime > 0) {
      console.log(`Rate limiting: waiting ${waitTime}ms before next API call`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
    
    this.lastApiCall = Date.now();
  }

  public async processMessage(message: string): Promise<string | null> {
    if (!message) return null;

    try {
      const messageId = `${Date.now()}-${message}`;
      if (this.processedMessageIds.has(messageId)) {
        return null;
      }

      await this.waitForRateLimit();

      const prompt = this.buildPromptWithContext(message);
      const response = await generateText({
        runtime: this.runtime,
        context: prompt,
        modelClass: ModelClass.SMALL,
        customSystemPrompt: this.runtime.character.system
      });

      if (response) {
        this.processedMessageIds.add(messageId);
        setTimeout(() => this.processedMessageIds.delete(messageId), 5 * 60 * 1000);
      }

      return response;
    } catch (error) {
      console.error('Error processing message:', error);
      return null;
    }
  }

  public async sendAIMessage(text: string): Promise<void> {
    try {
      const processedText = await this.processMessage(text);
      if (!processedText) return;

      if (this.client instanceof GameMasterClient) {
        await this.client.broadcastToRoom({ text: processedText });
      } else {
        await this.client.sendAIMessage({ text: processedText });
      }
    } catch (error) {
      console.error('Error sending message:', error);
      throw error;
    }
  }

  public updateMessageContext(memory: DebateMemory): void {
    if (this.messageContext.length >= this.MAX_CONTEXT_SIZE) {
      this.messageContext.shift();
    }
    this.messageContext.push(memory);
  }

  public updatePvPStatus(action: PvPAction): void {
    if (action.actionType) {
      this.activePvPEffects.set(action.targetId, action);
    } else {
      this.activePvPEffects.delete(action.targetId);
    }
  }

  public async initialize(): Promise<void> {
    const roomId = Number(process.env.ROOM_ID) || 290;
    await this.client.setRoomAndRound(roomId);
  }

  public getClient() {
    return this.client;
  }

  public close(): void {
    this.client.stop();
  }
}

export const createPVPVAIClient = (
  runtime: ExtendedAgentRuntime,
  config: Config
): PVPVAIIntegration => {
  return new PVPVAIIntegration(runtime, config);
};