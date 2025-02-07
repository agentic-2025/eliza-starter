import { stringToUuid, type UUID, elizaLogger } from '@elizaos/core';
import type { ExtendedAgentRuntime } from './types/index.ts';
import { WsMessageTypes } from './types/ws.ts';
import { GameMasterClient } from './clients/GameMasterClient.ts';
import { PVPVAIIntegration } from './clients/PVPVAIIntegration.ts';

interface DebateState {
  phase: 'init' | 'discussion' | 'voting' | 'end';
  currentTurn: number;
}

/**
 * Simplified DebateOrchestrator that only handles LLM coordination
 * All message routing and effects are handled by backend
 */
class DebateOrchestrator {
  private agents: ExtendedAgentRuntime[] = [];
  private gameMaster?: ExtendedAgentRuntime;
  private isDebating = false;
  private currentTopicId: UUID;
  private roomId?: number;
  private roundId?: number;
  private isRunning: boolean = false;
  private currentSpeakerIndex: number = 0;

  // Update timing configuration with safer delays
  private readonly config = {
    minResponseDelay: 15000,    // Minimum delay between responses (15s)
    maxResponseDelay: 20000,    // Maximum delay between responses (20s)
    turnDelay: 5000,           // Delay between turns (5s)
    gmThinkingTime: 10000,     // Time for GM to "think" (10s)
    roundBreak: 30000,         // Break between rounds (30s)
    retryDelay: 10000,         // Delay before retrying failed API calls (10s)
    maxRetries: 3              // Maximum number of retries for failed calls
  };

  // Add rate limiting queue
  private lastApiCall: number = 0;
  private readonly MIN_API_INTERVAL = 10000; // Minimum 10s between API calls

  private async waitForRateLimit(): Promise<void> {
    const now = Date.now();
    const timeSinceLastCall = now - this.lastApiCall;
    
    if (timeSinceLastCall < this.MIN_API_INTERVAL) {
      const waitTime = this.MIN_API_INTERVAL - timeSinceLastCall;
      await this.sleep(waitTime);
    }
    this.lastApiCall = Date.now();
  }

  private async retryWithBackoff<T>(
    operation: () => Promise<T>, 
    retries: number = this.config.maxRetries
  ): Promise<T> {
    for (let i = 0; i < retries; i++) {
      try {
        await this.waitForRateLimit();
        return await operation();
      } catch (error: any) {
        if (error?.statusCode === 429 && i < retries - 1) {
          const delay = this.config.retryDelay * Math.pow(2, i);
          console.log(`Rate limited, waiting ${delay}ms before retry ${i + 1}/${retries}`);
          await this.sleep(delay);
          continue;
        }
        throw error;
      }
    }
    throw new Error('Max retries exceeded');
  }

  private state: DebateState = {
    phase: 'init',
    currentTurn: 0
  };

  constructor(runtimes: ExtendedAgentRuntime[]) {
    this.currentTopicId = stringToUuid('debate-topic') as UUID;
    
    // Separate GM from regular agents
    for (const runtime of runtimes) {
      if (runtime.character.agentRole?.type.toUpperCase() === 'GM') {
        this.gameMaster = runtime;
      } else {
        this.agents.push(runtime);
      }
    }

    if (!this.gameMaster) {
      throw new Error('No GM found in provided runtimes');
    }

    console.log('DebateOrchestrator initialized with:', {
      gameMaster: this.gameMaster.character.name,
      agents: this.agents.map(a => a.character.name)
    });
  }

  private getDebateAgents(): ExtendedAgentRuntime[] {
    return this.agents;
  }

  private async sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private getRandomDelay(): number {
    return Math.floor(
      Math.random() * 
      (this.config.maxResponseDelay - this.config.minResponseDelay) + 
      this.config.minResponseDelay
    );
  }

  public async initialize(roomId: number): Promise<void> {
    if (!this.gameMaster) {
      throw new Error('GameMaster not found!');
    }

    this.roomId = roomId;

    const gmClient = this.gameMaster.clients?.pvpvai?.getClient() as GameMasterClient;
    if (!gmClient) {
      throw new Error('GM client not initialized');
    }

    // Initialize GM first
    await gmClient.setRoomAndRound(roomId);
    // Set roundId from GM client
    this.roundId = gmClient.getRoundId();

    // Initialize other agents
    for (const agent of this.agents) {
      const agentClient = agent.clients?.pvpvai?.getClient();
      if (!agentClient) {
        throw new Error(`Agent client not initialized for ${agent.character.name}`);
      }
      await agentClient.setRoomAndRound(roomId);
    }

    // Wait for all connections to be established
    await this.verifyConnections();
    
    console.log(`DebateOrchestrator initialized with room ${this.roomId} and round ${this.roundId}`);
  }

  private async handleGMTurn(gmRuntime: ExtendedAgentRuntime): Promise<void> {
    const client = gmRuntime.clients['pvpvai'] as PVPVAIIntegration;
    if (!client) return;

    await this.sleep(this.config.gmThinkingTime);
    
    // Use retryWithBackoff for API calls
    await this.retryWithBackoff(async () => {
      const messages = [
        "Let's explore this topic further. What are your thoughts on scalability?",
        "Interesting perspectives. How do you address security concerns?",
        "Let's focus on real-world applications. Can you provide specific examples?",
        "What are your views on interoperability between different chains?",
        "How does your approach handle network congestion?",
        "Let's discuss environmental impact and sustainability.",
        "What about developer experience and ecosystem growth?",
        "How do you ensure decentralization while maintaining performance?"
      ];

      const randomMessage = messages[Math.floor(Math.random() * messages.length)];
      await client.sendAIMessage(randomMessage);
    });
  }

  private async handleAgentTurn(runtime: ExtendedAgentRuntime): Promise<void> {
    const client = runtime.clients['pvpvai'] as PVPVAIIntegration;
    if (!client) return;

    await this.sleep(this.getRandomDelay());
    
    // Use retryWithBackoff for API calls
    await this.retryWithBackoff(async () => {
      const response = await client.processMessage("Continue the debate based on the previous messages.");
      if (response) {
        await client.sendAIMessage(response);
      }
    });
  }

  public async startDebate() {
    try {
        // Add log to help debug
        console.log('Starting debate with:', {
            roomId: this.roomId,
            roundId: this.roundId
        });

        if (!this.roomId || !this.roundId) {
            throw new Error('Must call initialize() with room and round IDs first');
        }

        this.isDebating = true;
        this.state.phase = 'init';

        const gmClient = this.gameMaster?.clients?.pvpvai?.getClient() as GameMasterClient;
        if (!gmClient) {
            throw new Error('GM client not initialized');
        }

        // Start debate session
        await gmClient.sendGMMessage("Room initialized. Beginning debate round.", []);
        await gmClient.sendGMMessage("Beginning discussion phase. Agents may now engage in debate.", []);
        
        const topic = "Let's discuss the future of cryptocurrency. What are your thoughts on Bitcoin versus Ethereum?";
        const validAgentIds = this.agents.map(a => a.character.settings?.pvpvai?.agentId).filter(Boolean);
        await gmClient.sendGMMessage(topic, validAgentIds);
        
        this.state.phase = 'discussion';

        this.isRunning = true;
        if (!this.gameMaster) {
          throw new Error("No GM found in runtimes");
        }

        elizaLogger.log("Starting debate with turn-based system...");

        while (this.isRunning) {
          try {
            // GM's turn with rate limiting
            await this.handleGMTurn(this.gameMaster);
            await this.sleep(this.config.turnDelay);

            // Agents take turns responding with rate limiting
            for (let i = 0; i < this.agents.length && this.isRunning; i++) {
              const runtime = this.agents[i];
              elizaLogger.log(`${runtime.character.name}'s turn...`);
              
              await this.handleAgentTurn(runtime);
              await this.sleep(this.config.turnDelay);
            }

            // Longer break between rounds to help with rate limiting
            await this.sleep(this.config.roundBreak);

          } catch (error) {
            elizaLogger.error("Error in debate loop:", error);
            await this.sleep(this.config.retryDelay); // Prevent rapid error loops
          }
        }

    } catch (error) {
        console.error('Error in startDebate:', error);
        throw error;
    }
  }

  private async verifyConnections(): Promise<void> {
    const maxRetries = 10;
    const retryDelay = 2000;
    let retries = 0;

    while (retries < maxRetries) {
      const allConnected = [
        this.gameMaster?.clients?.pvpvai?.getClient()?.wsClient?.isConnected(),
        ...this.agents.map(agent => 
          agent.clients?.pvpvai?.getClient()?.wsClient?.isConnected()
        )
      ].every(Boolean);

      if (allConnected) {
        console.log('All agents connected successfully');
        return;
      }

      await new Promise(r => setTimeout(r, retryDelay));
      retries++;
    }

    throw new Error('Failed to establish connections for all agents');
  }

  public stopDebate() {
    const gmClient = this.gameMaster?.clients?.pvpvai?.getClient() as GameMasterClient;
    
    console.log('Stopping debate...');
    this.isDebating = false;
    this.state.phase = 'end';
    
    if (gmClient) {
      gmClient.sendGMMessage("Debate session ended.", [])
        .catch(error => console.error('Error sending debate end message:', error));
    }

    elizaLogger.log("Stopping debate...");
    this.isRunning = false;
    
    // Cleanup
    for (const runtime of this.agents) {
      const client = runtime.clients['pvpvai'] as PVPVAIIntegration;
      if (client) {
        client.close();
      }
    }
  }
}

export { DebateOrchestrator };