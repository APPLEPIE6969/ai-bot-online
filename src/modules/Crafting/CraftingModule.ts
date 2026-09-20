import { Bot } from 'mineflayer';
import { Module } from '../../types/interfaces';
import { EventBus } from '../../core/EventBus';
import { logger } from '../../utils/logger';
import { GameKnowledge } from '../GameKnowledge/GameKnowledge';

/**
 * CraftingModule — Thin wrapper that delegates to GameKnowledge for smart crafting.
 */
export class CraftingModule implements Module {
    name = 'CraftingModule';
    private bot: Bot | null = null;
    private eventBus: EventBus | null = null;
    private gameKnowledge: GameKnowledge | null = null;

    /** Set externally after both modules are created */
    setGameKnowledge(gk: GameKnowledge): void {
        this.gameKnowledge = gk;
    }

    async init(bot: Bot, eventBus: EventBus): Promise<void> {
        this.bot = bot;
        this.eventBus = eventBus;
        logger.info('Crafting', 'Crafting module initialized');
    }

    async cleanup(): Promise<void> {
        this.bot = null;
        this.eventBus = null;
    }

    /**
     * Craft an item by name, using GameKnowledge for dependency resolution.
     */
    async craftItem(itemName: string, count: number = 1): Promise<boolean> {
        if (!this.bot) return false;

        if (this.gameKnowledge) {
            return await this.gameKnowledge.smartCraft(itemName, count);
        }

        // Fallback if GameKnowledge isn't set (shouldn't happen)
        logger.warn('Crafting', 'GameKnowledge not available, using basic craft');
        return await this.basicCraft(itemName, count);
    }

    /**
     * Craft a sequence of items, each in order.
     */
    async craftSequence(items: string[]): Promise<string[]> {
        const crafted: string[] = [];
        for (const name of items) {
            const ok = await this.craftItem(name);
            if (ok) crafted.push(name);
        }
        return crafted;
    }

    /**
     * Basic fallback craft without GameKnowledge.
     */
    private async basicCraft(itemName: string, count: number): Promise<boolean> {
        if (!this.bot) return false;
        const mcData = require('minecraft-data')(this.bot.version);
        const clean = itemName.replace(/ /g, '_').toLowerCase();
        const item = mcData.itemsByName[clean];
        if (!item) return false;

        // Try hand recipe
        const recipes = this.bot.recipesFor(item.id, null, 1, null);
        if (recipes && recipes.length > 0) {
            try {
                await this.bot.craft(recipes[0], count, undefined);
                return true;
            } catch (_) { }
        }
        return false;
    }
}
