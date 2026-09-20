import { Bot } from 'mineflayer';
import { EventBus } from './EventBus';
import { StateMachine } from './StateMachine';
import { TaskEngine } from './TaskEngine';
import { BotState, TaskPriority, TaskCategory } from '../types/enums';
import { logger } from '../utils/logger';
import { sleep, generateId } from '../utils/math';

// Food items sorted by saturation (best first)
const FOOD_ITEMS = [
    'golden_carrot', 'cooked_beef', 'cooked_porkchop', 'cooked_mutton',
    'cooked_salmon', 'cooked_chicken', 'cooked_rabbit', 'cooked_cod',
    'baked_potato', 'bread', 'carrot', 'apple', 'melon_slice',
    'sweet_berries', 'dried_kelp', 'cookie',
];

const DANGEROUS_BLOCKS = ['lava', 'fire', 'magma_block', 'cactus', 'sweet_berry_bush'];

/**
 * Always-on survival system.
 * Handles: eating, hazard avoidance, death recovery, gear re-equip.
 * Runs on tick intervals regardless of mode.
 */
export class EmergencyManager {
    private bot: Bot | null = null;
    private checkInterval: NodeJS.Timeout | null = null;
    private isEating = false;
    private isHandlingEmergency = false;

    constructor(
        private eventBus: EventBus,
        private stateMachine: StateMachine,
        private taskEngine: TaskEngine
    ) { }

    init(bot: Bot): void {
        this.bot = bot;

        // Check every 2 seconds
        this.checkInterval = setInterval(() => this.tick(), 2000);

        // Death handler
        bot.on('death', () => {
            logger.warn('Emergency', 'Bot died! Will recover on respawn...');
            this.eventBus.emit('emergency:triggered', { type: 'death', detail: 'Bot died' });
        });

        bot.on('respawn', async () => {
            logger.info('Emergency', 'Respawned. Re-equipping gear...');
            await sleep(1000);
            await this.reequipBestGear();
            this.eventBus.emit('emergency:resolved', { type: 'death' });
        });

        logger.info('Emergency', 'Survival system initialized');
    }

    cleanup(): void {
        if (this.checkInterval) {
            clearInterval(this.checkInterval);
            this.checkInterval = null;
        }
    }

    private async tick(): Promise<void> {
        if (!this.bot || this.isHandlingEmergency) return;
        if (this.stateMachine.is(BotState.DISCONNECTED) || this.stateMachine.is(BotState.BOOTING)) return;

        try {
            // Priority 1: Eat when hungry
            if (this.bot.food <= 14 && !this.isEating) {
                await this.tryEat();
            }

            // Priority 2: Check for nearby hazards
            await this.checkHazards();

        } catch (e) {
            // Silently swallow tick errors to prevent crash
            logger.debug('Emergency', `Tick error: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    private async tryEat(): Promise<void> {
        if (!this.bot || this.isEating) return;

        const foodItem = this.bot.inventory.items().find(i => FOOD_ITEMS.includes(i.name));
        if (!foodItem) return;

        this.isEating = true;
        try {
            await this.bot.equip(foodItem, 'hand');
            await this.bot.consume();
            logger.info('Emergency', `Ate ${foodItem.name} (food: ${this.bot.food})`);
        } catch (e) {
            logger.debug('Emergency', `Failed to eat: ${e instanceof Error ? e.message : String(e)}`);
        }
        this.isEating = false;
    }

    private async checkHazards(): Promise<void> {
        if (!this.bot) return;

        const pos = this.bot.entity.position;

        // Check blocks around the bot's feet
        for (const offset of [
            { x: 0, y: -1, z: 0 },  // Below
            { x: 1, y: 0, z: 0 },   // Adjacent
            { x: -1, y: 0, z: 0 },
            { x: 0, y: 0, z: 1 },
            { x: 0, y: 0, z: -1 },
        ]) {
            const block = this.bot.blockAt(pos.offset(offset.x, offset.y, offset.z));
            if (block && DANGEROUS_BLOCKS.some(d => block.name.includes(d))) {
                logger.warn('Emergency', `Hazard detected: ${block.name} at ${block.position}`);
                this.eventBus.emit('emergency:triggered', { type: 'hazard', detail: block.name });

                // Jump away from lava/fire
                if (block.name.includes('lava') || block.name.includes('fire')) {
                    this.bot.setControlState('jump', true);
                    this.bot.setControlState('back', true);
                    await sleep(500);
                    this.bot.clearControlStates();
                }
                break;
            }
        }
    }

    async reequipBestGear(): Promise<void> {
        if (!this.bot) return;

        // Equip best armor
        const armorSlots: Array<'head' | 'torso' | 'legs' | 'feet'> = ['head', 'torso', 'legs', 'feet'];
        const armorTiers = ['netherite', 'diamond', 'iron', 'chainmail', 'golden', 'leather'];

        for (const slot of armorSlots) {
            for (const tier of armorTiers) {
                const item = this.bot.inventory.items().find(i => i.name.includes(tier) && i.name.includes(this.armorSlotToName(slot)));
                if (item) {
                    try {
                        await this.bot.equip(item, slot);
                        logger.info('Emergency', `Equipped ${item.name} to ${slot}`);
                    } catch (e) { /* already equipped or can't */ }
                    break;
                }
            }
        }

        // Equip best weapon in hand
        const weaponTiers = ['netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'wooden_sword',
            'netherite_axe', 'diamond_axe', 'iron_axe', 'stone_axe', 'wooden_axe'];
        for (const weapon of weaponTiers) {
            const item = this.bot.inventory.items().find(i => i.name === weapon);
            if (item) {
                try {
                    await this.bot.equip(item, 'hand');
                    logger.info('Emergency', `Equipped ${item.name}`);
                } catch (e) { /* skip */ }
                break;
            }
        }
    }

    private armorSlotToName(slot: 'head' | 'torso' | 'legs' | 'feet'): string {
        switch (slot) {
            case 'head': return 'helmet';
            case 'torso': return 'chestplate';
            case 'legs': return 'leggings';
            case 'feet': return 'boots';
        }
    }
}
