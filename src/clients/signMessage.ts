import { Wallet } from 'ethers';
import { sortObjectKeys } from './sortObjectKeys.ts';

// All messages must extend BaseMessageContent to ensure timestamp
interface BaseMessageContent {
  timestamp: number;  // Must always be first
}

interface SignableMessage extends BaseMessageContent {
  [key: string]: any;
}

export const signMessage = async (content: SignableMessage, privateKey: string): Promise<string> => {
  try {
    // Ensure timestamp exists and is first
    if (!content.timestamp) {
      content.timestamp = Date.now();
    }

    // Use deterministic sorting - CRITICAL for signature verification
    const orderedContent = sortObjectKeys(content);

    // Create deterministic string representation
    const messageString = JSON.stringify(orderedContent);
    console.log('Signing message string:', messageString);

    // Sign the message
    const wallet = new Wallet(privateKey);
    return await wallet.signMessage(messageString);

  } catch (error) {
    throw new Error(`Failed to sign message: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
};

// Helper function to prepare message objects with correct field order
export const createMessageContent = {
  agent: (params: {roomId: number, roundId: number, agentId: number, text: string}): SignableMessage => ({
    timestamp: Date.now(),    // First
    roomId: params.roomId,    // Second
    roundId: params.roundId,  // Third  
    agentId: params.agentId,  // Fourth
    text: params.text         // Fifth
  }),

  gm: (params: {roomId: number, roundId: number, gmId: number, message: string, targets: number[], ignoreErrors?: boolean}): SignableMessage => ({
    timestamp: Date.now(),    // First
    roomId: params.roomId,    // Second
    roundId: params.roundId,  // Third
    gmId: params.gmId,        // Fourth
    message: params.message,   // Fifth
    targets: params.targets,   // Sixth
    ignoreErrors: params.ignoreErrors ?? false // Seventh
  }),

  auth: (params: {walletAddress: string, agentId: number, roomId: number}): SignableMessage => ({
    timestamp: Date.now(),          // First
    walletAddress: params.walletAddress, // Second
    agentId: params.agentId,            // Third
    roomId: params.roomId               // Fourth
  }),

  subscribe: (params: {roomId: number}): SignableMessage => ({
    timestamp: Date.now(),    // First
    roomId: params.roomId     // Second
  }),

  heartbeat: (): SignableMessage => ({
    timestamp: Date.now()     // Only field needed
  })
};
