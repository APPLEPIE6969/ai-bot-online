import { Bot } from 'mineflayer';
import { goals } from 'mineflayer-pathfinder';
import { Module, StashEntry } from '../../types/interfaces';
import { EventBus } from '../../core/EventBus';
import { Database } from '../../persistence/Database';
import { logger } from '../../utils/logger';
import { sleep, generateId } from '../../utils/math';
import { withTimeout } from '../../utils/safety';

const CHEST_NAMES = ['chest', 'trapped_chest', 'barrel', 'ender_chest', 'shulker_box'];

/**
 * Stash Module
 * Manages hidden chests for storing overflow items.
 * Creates, tracks, stores to, retrieves from, and verifies stashes.
 */
export class StashModule implements Module {
    name = 'StashModule';
    private bot: Bot | null = null;
    private eventBus: EventBus | null = null;
    private database: Database;

    constructor(database: Database) {
        this.database = database;
    }

    async init(bot: Bot, eventBus: EventBus): Promise<void> {
        this.bot = bot;
        this.eventBus = eventBus;
        logger.info('Stash', `Stash module initialized (${this.database.getStashes().length} stashes tracked)`);
    }

    async cleanup(): Promise<void> {
        this.bot = null;
        this.eventBus = null;
    }

    /**
     * Create a new stash (place a chest and register it).
     * Requires a chest in inventory.
     */
    async createStash(label?: string): Promise<StashEntry | null> {
        if (!this.bot) return null;

        // Find a chest in inventory
        const chestItem = this.bot.inventory.items().find(i => CHEST_NAMES.some(c => i.name.includes(c)));
        if (!chestItem) {
            logger.warn('Stash', 'No chest in inventory to create stash');
            return null;
        }

        try {
            // Place the chest
            await this.bot.equip(chestItem, 'hand');
            const pos = this.bot.entity.position;
            const refBlock = this.bot.blockAt(pos.offset(1, -1, 0));
            if (!refBlock) {
                logger.warn('Stash', 'No surface to place chest on');
                return null;
            }

            await this.bot.placeBlock(refBlock, { x: 0, y: 1, z: 0 } as any);
            await sleep(500);

            const chestPos = refBlock.position.offset(0, 1, 0);
            const stash: StashEntry = {
                id: generateId(),
                label: label || `stash_${Date.now()}`,
                x: chestPos.x,
                y: chestPos.y,
                z: chestPos.z,
                items: [],
                createdAt: Date.now(),
                lastAccessed: Date.now(),
                verified: true,
            };

            this.database.addStash(stash);
            this.eventBus?.emit('stash:created', stash);
            logger.info('Stash', `Created stash "${stash.label}" at (${stash.x}, ${stash.y}, ${stash.z})`);
            return stash;
        } catch (e) {
            logger.error('Stash', `Failed to create stash: ${e instanceof Error ? e.message : String(e)}`);
            return null;
        }
    }

    /**
     * Store items in the nearest stash (or a specific one).
     * stashId: optional, if not given uses nearest stash.
     * itemFilter: optional, only stores matching items. If empty, stores everything non-essential.
     */
    async storeItems(stashId?: string, itemFilter?: string[]): Promise<number> {
        if (!this.bot) return 0;

        const stash = stashId
            ? this.database.getStashes().find(s => s.id === stashId)
            : this.findNearestStash();

        if (!stash) {
            logger.warn('Stash', 'No stash found');
            return 0;
        }

        // Navigate to stash
        const reached = await this.navigateTo(stash.x, stash.y, stash.z);
        if (!reached) {
            logger.warn('Stash', `Can't reach stash "${stash.label}"`);
            return 0;
        }

        // Open chest
        const chestBlock = this.bot.blockAt({ x: stash.x, y: stash.y, z: stash.z } as any);
        if (!chestBlock || !CHEST_NAMES.some(c => chestBlock.name.includes(c))) {
            logger.warn('Stash', `Stash "${stash.label}" chest missing at (${stash.x},${stash.y},${stash.z})!`);
            this.database.updateStash(stash.id, { verified: false });
            return 0;
        }

        try {
            const chest = await this.bot.openContainer(chestBlock);
            await sleep(300);

            let stored = 0;
            const essentials = ['_pickaxe', '_axe', '_sword', '_shovel', '_helmet', '_chestplate', '_leggings', '_boots'];

            for (const item of this.bot.inventory.items()) {
                // Skip essential items
                if (essentials.some(e => item.name.includes(e))) continue;
                // Apply filter if given
                if (itemFilter && !itemFilter.some(f => item.name.includes(f))) continue;

                try {
                    await chest.deposit(item.type, null, item.count);
                    stored += item.count;
                    await sleep(100);
                } catch (e) {
                    logger.debug('Stash', `Couldn't deposit ${item.name}: ${e instanceof Error ? e.message : String(e)}`);
                }
            }

            // Update stash record
            const updatedItems = chest.containerItems().map(i => ({ name: i.name, count: i.count }));
            this.database.updateStash(stash.id, {
                items: updatedItems,
                lastAccessed: Date.now(),
                verified: true,
            });

            chest.close();
            logger.info('Stash', `Stored ${stored} items in "${stash.label}"`);
            this.eventBus?.emit('stash:stored', { stashId: stash.id, count: stored });
            return stored;
        } catch (e) {
            logger.error('Stash', `Failed to store: ${e instanceof Error ? e.message : String(e)}`);
            return 0;
        }
    }

    /**
     * Retrieve specific items from a stash.
     */
    async retrieveItems(itemName: string, count: number = 64, stashId?: string): Promise<number> {
        if (!this.bot) return 0;

        // Find a stash that has the item
        const stashes = this.database.getStashes();
        let targetStash: StashEntry | undefined;

        if (stashId) {
            targetStash = stashes.find(s => s.id === stashId);
        } else {
            targetStash = stashes.find(s => s.items.some(i => i.name.includes(itemName)));
        }

        if (!targetStash) {
            logger.info('Stash', `No stash has "${itemName}"`);
            return 0;
        }

        const reached = await this.navigateTo(targetStash.x, targetStash.y, targetStash.z);
        if (!reached) return 0;

        const chestBlock = this.bot.blockAt({ x: targetStash.x, y: targetStash.y, z: targetStash.z } as any);
        if (!chestBlock || !CHEST_NAMES.some(c => chestBlock.name.includes(c))) {
            this.database.updateStash(targetStash.id, { verified: false });
            return 0;
        }

        try {
            const chest = await this.bot.openContainer(chestBlock);
            await sleep(300);

            let retrieved = 0;
            for (const item of chest.containerItems()) {
                if (!item.name.includes(itemName)) continue;
                const take = Math.min(item.count, count - retrieved);
                try {
                    await chest.withdraw(item.type, null, take);
                    retrieved += take;
                    await sleep(100);
                } catch (_) { }
                if (retrieved >= count) break;
            }

            // Update inventory record
            const updatedItems = chest.containerItems().map(i => ({ name: i.name, count: i.count }));
            this.database.updateStash(targetStash.id, { items: updatedItems, lastAccessed: Date.now() });

            chest.close();
            logger.info('Stash', `Retrieved ${retrieved}x ${itemName} from "${targetStash.label}"`);
            return retrieved;
        } catch (e) {
            logger.error('Stash', `Retrieve failed: ${e instanceof Error ? e.message : String(e)}`);
            return 0;
        }
    }

    /**
     * Verify all stashes still exist.
     */
    async verifyAll(): Promise<{ verified: number; missing: number }> {
        if (!this.bot) return { verified: 0, missing: 0 };

        const stashes = this.database.getStashes();
        let verified = 0, missing = 0;

        for (const stash of stashes) {
            const block = this.bot.blockAt({ x: stash.x, y: stash.y, z: stash.z } as any);
            if (block && CHEST_NAMES.some(c => block.name.includes(c))) {
                this.database.updateStash(stash.id, { verified: true });
                verified++;
            } else {
                this.database.updateStash(stash.id, { verified: false });
                missing++;
                logger.warn('Stash', `Stash "${stash.label}" at (${stash.x},${stash.y},${stash.z}) is MISSING`);
            }
        }

        return { verified, missing };
    }

    /**
     * Get a summary of all stashes.
     */
    getSummary(): string {
        const stashes = this.database.getStashes();
        if (stashes.length === 0) return 'No stashes.';
        return stashes.map(s =>
            `${s.label}: (${s.x},${s.y},${s.z}) ${s.verified ? '✓' : '✗'} [${s.items.length} types]`
        ).join(' | ');
    }

    /**
     * Find the nearest stash to the bot.
     */
    findNearestStash(): StashEntry | undefined {
        if (!this.bot) return undefined;
        const pos = this.bot.entity.position;
        const stashes = this.database.getStashes().filter(s => s.verified);
        if (stashes.length === 0) return undefined;

        return stashes.reduce((nearest, s) => {
            const dist = Math.sqrt((s.x - pos.x) ** 2 + (s.y - pos.y) ** 2 + (s.z - pos.z) ** 2);
            const nearestDist = Math.sqrt((nearest.x - pos.x) ** 2 + (nearest.y - pos.y) ** 2 + (nearest.z - pos.z) ** 2);
            return dist < nearestDist ? s : nearest;
        });
    }

    // ─── Internal ───────────────────────────────────────

    private async navigateTo(x: number, y: number, z: number): Promise<boolean> {
        if (!this.bot) return false;
        try {
            await withTimeout(
                this.bot.pathfinder.goto(new goals.GoalNear(x, y, z, 2)),
                20000,
                'Navigate to stash'
            );
            return true;
        } catch {
            return false;
        }
    }
}
