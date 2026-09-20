import { Bot } from 'mineflayer';
import { Module } from '../../types/interfaces';
import { EventBus } from '../../core/EventBus';
import { logger } from '../../utils/logger';
import { BotConfig } from '../../types/interfaces';
import { AtomicWriter } from '../../persistence/AtomicWriter';
import * as path from 'path';

const CONFIG_FILE = path.resolve(__dirname, '../../../config/config.json');

/**
 * AI Chat Module
 * Handles incoming chat messages, passes them to Gemini/Groq for interpretation,
 * and translates AI responses into bot actions.
 */
export class ChatModule implements Module {
    name = 'ChatModule';
    private bot: Bot | null = null;
    private eventBus: EventBus | null = null;
    private config: BotConfig;
    private actionHandlers: Map<string, (target?: string) => Promise<string | void>> = new Map();
    private chatHistory: { role: string, content: string }[] = [];

    constructor(config: BotConfig) {
        this.config = config;
    }

    async init(bot: Bot, eventBus: EventBus): Promise<void> {
        this.bot = bot;
        this.eventBus = eventBus;

        // Listen for player chat
        bot.on('chat', async (username, message) => {
            if (username === bot.username) return;
            logger.info('Chat', `${username}: ${message}`);
            eventBus.emit('chat:incoming', { username, message });

            try {
                // Add to history
                this.chatHistory.push({ role: 'Player', content: `${username}: ${message}` });
                if (this.chatHistory.length > 10) this.chatHistory.shift();

                const response = await this.processMessage(username, message);
                if (response) {
                    bot.chat(response);
                    eventBus.emit('chat:outgoing', { message: response });

                    // Add AI response to history
                    this.chatHistory.push({ role: 'You', content: response });
                    if (this.chatHistory.length > 10) this.chatHistory.shift();
                }
            } catch (e) {
                logger.error('Chat', `Failed to process message: ${e instanceof Error ? e.message : String(e)}`);
                bot.chat("Sorry, I had trouble understanding that.");
            }
        });

        logger.info('Chat', 'Chat module initialized');
    }

    async cleanup(): Promise<void> {
        this.bot = null;
        this.eventBus = null;
    }

    /**
     * Register an action handler that the AI can invoke.
     */
    registerAction(name: string, handler: (target?: string) => Promise<string | void>): void {
        this.actionHandlers.set(name, handler);
    }

    /**
     * Get the list of available actions for prompt building.
     */
    getActionList(): string {
        return Array.from(this.actionHandlers.keys()).join(', ');
    }

    // ─── Internal ─────────────────────────────────────────

    private async processMessage(username: string, message: string): Promise<string | null> {
        if (!this.bot) return null;

        const botState = this.getBotState();
        const prompt = this.buildPrompt(username, message, botState);

        // Try each AI model in order
        for (const model of this.config.aiModels) {
            try {
                const response = await this.callAI(model, prompt);
                if (response) {
                    return await this.handleAIResponse(response, username);
                }
            } catch (e) {
                logger.warn('Chat', `Model ${model} failed: ${e instanceof Error ? e.message : String(e)}`);
                continue;
            }
        }

        return "I'm having trouble thinking right now. Try again?";
    }

    private buildPrompt(username: string, message: string, botState: Record<string, string | number>): string {
        const actions = this.getActionList();
        const historyText = this.chatHistory.map(h => `[${h.role}] ${h.content}`).join('\n');

        return `You are an autonomous Minecraft bot. Respond to the player's message by choosing an appropriate action.

Available actions: ${actions}, do_nothing, chat_only

IMPORTANT RULES:
- NEGATIVE COMMANDS: If the user says "don't stop", "keep going", "continue", or uses negation, do NOT select the action they are negating. Reply with "do_nothing" and a message.
- "get me iron", "mine iron until I stop", "find iron constantly" MUST map to the action: gather_iron_continuously
- If a player name is used as a target, treat it as a player name, not a block name.
- ALWAYS prefer autonomous actions over manual steps.

Status: HP:${botState.health}/20 Food:${botState.food}/20 Pos:${botState.x},${botState.y},${botState.z} Held:${botState.heldItem}

--- RECENT CHAT HISTORY ---
${historyText}
---------------------------

Current Msg from ${username}: ${message}

Respond in ONLY this JSON (1 short sentence, be fun):
{"action":"name","target":"${username}","message":"response"}`;
    }

    private getBotState(): Record<string, string | number> {
        if (!this.bot) return {};
        const pos = this.bot.entity?.position;
        const held = this.bot.heldItem;
        return {
            health: Math.round(this.bot.health || 20),
            food: Math.round(this.bot.food || 20),
            x: Math.floor(pos?.x ?? 0),
            y: Math.floor(pos?.y ?? 0),
            z: Math.floor(pos?.z ?? 0),
            heldItem: held?.name ?? 'empty',
        };
    }

    private async callAI(model: string, prompt: string): Promise<string | null> {
        // Try Google Gemini first
        if (model.startsWith('gemini') && this.config.apiKeys.google) {
            return await this.callGemini(model, prompt);
        }

        // Try Groq
        if (this.config.apiKeys.groq) {
            return await this.callGroq(model, prompt);
        }

        return null;
    }

    private async callGemini(model: string, prompt: string): Promise<string> {
        const { GoogleGenerativeAI } = require('@google/generative-ai');
        const genAI = new GoogleGenerativeAI(this.config.apiKeys.google);
        const genModel = genAI.getGenerativeModel({ model });
        const result = await genModel.generateContent(prompt);
        const text = result.response.text();
        return text;
    }

    private async callGroq(model: string, prompt: string): Promise<string> {
        const Groq = require('groq-sdk');
        const groq = new Groq({ apiKey: this.config.apiKeys.groq });
        const response = await groq.chat.completions.create({
            messages: [{ role: 'user', content: prompt }],
            model,
            temperature: 0.7,
            max_tokens: 200,
        });
        return response.choices[0]?.message?.content || '';
    }

    private async handleAIResponse(rawResponse: string, username: string): Promise<string | null> {
        // Extract JSON from response
        const jsonMatch = rawResponse.match(/\{[\s\S]*?\}/);
        if (!jsonMatch) {
            logger.warn('Chat', `No JSON in AI response: ${rawResponse.substring(0, 100)}`);
            return rawResponse.substring(0, 200);
        }

        try {
            const parsed = JSON.parse(jsonMatch[0]);
            const action = parsed.action || 'chat_only';
            const target = parsed.target || username;
            const message = parsed.message || '';

            logger.info('Chat', `AI chose action: ${action} (target: ${target})`);

            // Execute action if registered
            if (action !== 'chat_only' && action !== 'do_nothing' && action !== 'none') {
                const handler = this.actionHandlers.get(action);
                if (handler) {
                    // Fire-and-forget the action, reply immediately
                    handler(target).catch(e =>
                        logger.error('Chat', `Action "${action}" failed: ${e instanceof Error ? e.message : String(e)}`)
                    );
                    return message;
                } else {
                    logger.warn('Chat', `Unknown action: ${action}`);
                    return message || `I don't know how to "${action}" yet.`;
                }
            }

            return message;
        } catch (e) {
            logger.error('Chat', `Failed to parse AI response: ${e instanceof Error ? e.message : String(e)}`);
            return rawResponse.substring(0, 200);
        }
    }
}
