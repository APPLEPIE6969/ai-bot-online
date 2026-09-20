import { Bot } from 'mineflayer';
import { Module } from '../../types/interfaces';
import { EventBus } from '../../core/EventBus';
import { logger } from '../../utils/logger';
import { sleep } from '../../utils/math';

const ARMOR_TIERS = ['netherite', 'diamond', 'iron', 'chainmail', 'golden', 'leather'];
const JUNK_ITEMS = ['rotten_flesh', 'poisonous_potato', 'spider_eye'];

/**
 * Inventory Module
 * Auto-equip armor, sort, discard junk, retrieve materials.
 */
export class InventoryModule implements Module {
    name = 'InventoryModule';
    private bot: Bot | null = null;
    private eventBus: EventBus | null = null;

    async init(bot: Bot, eventBus: EventBus): Promise<void> {
        this.bot = bot;
        this.eventBus = eventBus;
        logger.info('Inventory', 'Inventory module initialized');
    }

    async cleanup(): Promise<void> {
        this.bot = null;
    }

    /**
     * Auto-equip the best armor in inventory.
     */
    async equipBestArmor(): Promise<void> {
        if (!this.bot) return;

        const slots: Array<{ slot: 'head' | 'torso' | 'legs' | 'feet'; search: string }> = [
            { slot: 'head', search: 'helmet' },
            { slot: 'torso', search: 'chestplate' },
            { slot: 'legs', search: 'leggings' },
            { slot: 'feet', search: 'boots' },
        ];

        for (const { slot, search } of slots) {
            for (const tier of ARMOR_TIERS) {
                const item = this.bot.inventory.items().find(i => i.name === `${tier}_${search}`);
                if (item) {
                    try {
                        await this.bot.equip(item, slot);
                        logger.info('Inventory', `Equipped ${item.name}`);
                    } catch (_) { }
                    break;
                }
            }
        }
    }

    /**
     * Discard junk items by dropping them.
     */
    async discardJunk(): Promise<number> {
        if (!this.bot) return 0;
        let discarded = 0;

        for (const item of this.bot.inventory.items()) {
            if (JUNK_ITEMS.includes(item.name)) {
                try {
                    await this.bot.tossStack(item);
                    discarded += item.count;
                    logger.info('Inventory', `Discarded ${item.count}x ${item.name}`);
                    await sleep(200);
                } catch (_) { }
            }
        }
        return discarded;
    }

    /**
     * Count items by name (supports partial match).
     */
    countItem(name: string): number {
        if (!this.bot) return 0;
        return this.bot.inventory.items()
            .filter(i => i.name === name || i.name.includes(name))
            .reduce((sum, i) => sum + i.count, 0);
    }

    /**
     * Check if we have a specific item.
     */
    hasItem(name: string): boolean {
        return this.countItem(name) > 0;
    }

    /**
     * List all items in inventory.
     */
    listItems(): Record<string, number> {
        if (!this.bot) return {};
        const items: Record<string, number> = {};
        for (const item of this.bot.inventory.items()) {
            items[item.name] = (items[item.name] || 0) + item.count;
        }
        return items;
    }

    /**
     * Drop items matching a specific target name.
     */
    async dropItem(targetName: string): Promise<number> {
        if (!this.bot) return 0;
        let dropped = 0;

        const itemsToDrop = this.bot.inventory.items().filter(i =>
            i.name === targetName || i.name.includes(targetName)
        );

        for (const item of itemsToDrop) {
            try {
                await this.bot.tossStack(item);
                dropped += item.count;
                logger.info('Inventory', `Dropped ${item.count}x ${item.name}`);
                await sleep(200);
            } catch (e) {
                logger.warn('Inventory', `Failed to drop ${item.name}: ${e}`);
            }
        }

        return dropped;
    }
}
