import { Bot } from 'mineflayer';
import { Module } from '../../types/interfaces';
import { EventBus } from '../../core/EventBus';
import { MiningModule } from '../Mining/MiningModule';
import { CraftingModule } from '../Crafting/CraftingModule';
import { InventoryModule } from '../Inventory/InventoryModule';
import { GameKnowledge } from '../GameKnowledge/GameKnowledge';
import { logger } from '../../utils/logger';
import { sleep } from '../../utils/math';

/**
 * Self-Progression Module — now powered by GameKnowledge.
 *
 * Instead of a fixed stage list, uses GameKnowledge.getNextGoals()
 * to dynamically decide what to do based on current inventory state.
 * This makes the bot actually smart — it always knows what it needs next.
 */
export class ProgressionModule implements Module {
    name = 'ProgressionModule';
    private bot: Bot | null = null;
    private eventBus: EventBus | null = null;
    private isRunning = false;
    private isGatheringIron = false;
    private currentGoal = '';
    private gameKnowledge: GameKnowledge | null = null;

    constructor(
        private mining: MiningModule,
        private crafting: CraftingModule,
        private inventory: InventoryModule
    ) { }

    /** Set externally after both modules are created */
    setGameKnowledge(gk: GameKnowledge): void {
        this.gameKnowledge = gk;
    }

    async init(bot: Bot, eventBus: EventBus): Promise<void> {
        this.bot = bot;
        this.eventBus = eventBus;
        logger.info('Progression', 'Progression module initialized (GameKnowledge-powered)');
    }

    async cleanup(): Promise<void> {
        this.isRunning = false;
        this.bot = null;
    }

    /**
     * Run the smart progression loop.
     * Continuously asks GameKnowledge "what should I do next?" and executes.
     */
    async run(): Promise<void> {
        if (this.isRunning) {
            logger.info('Progression', 'Already running');
            return;
        }
        this.isRunning = true;
        logger.info('Progression', 'Starting autonomous progression...');

        let stuckCounter = 0;
        const MAX_STUCK = 5;

        while (this.isRunning) {
            // Ask GameKnowledge what to do
            let goals: string[];
            if (this.gameKnowledge) {
                goals = this.gameKnowledge.getNextGoals();
            } else {
                goals = ['chop_trees']; // Fallback
            }

            if (goals.length === 0 || (goals.length === 1 && goals[0] === 'explore')) {
                logger.info('Progression', '🎉 All progression goals complete! Exploring...');
                this.currentGoal = 'explore';
                break;
            }

            const goal = goals[0];
            if (goal === this.currentGoal) {
                stuckCounter++;
                if (stuckCounter >= MAX_STUCK) {
                    logger.warn('Progression', `Stuck on ${goal} for ${MAX_STUCK} attempts, skipping...`);
                    stuckCounter = 0;
                    await sleep(5000);
                    continue;
                }
            } else {
                stuckCounter = 0;
            }

            this.currentGoal = goal;
            this.eventBus?.emit('progression:stage', { name: goal });
            logger.info('Progression', `▸ ${goal}`);

            try {
                await this.executeGoal(goal);
                logger.info('Progression', `✓ ${goal} — done`);
            } catch (e) {
                logger.error('Progression', `✗ ${goal} failed: ${e instanceof Error ? e.message : String(e)}`);
                await sleep(3000);
            }

            // Brief pause between goals
            await sleep(1000);
        }

        this.isRunning = false;
        this.currentGoal = '';
        this.eventBus?.emit('progression:complete', {});
        logger.info('Progression', 'Progression loop complete');
    }

    stop(): void {
        this.isRunning = false;
        this.isGatheringIron = false;
    }

    getCurrentStage(): string {
        return this.currentGoal;
    }

    /**
     * Continuously gather iron until stopped.
     */
    async gatherIronContinuously(): Promise<void> {
        if (this.isGatheringIron) {
            logger.info('Progression', 'Already gathering iron continuously.');
            return;
        }

        this.isGatheringIron = true;

        if (this.bot) {
            this.bot.chat('Planning to get iron: 1. Ensure basic tools 2. Craft stone pickaxe 3. Mine iron constantly!');
        }

        while (this.isGatheringIron) {
            if (!this.bot) break;

            logger.info('Progression', 'Continuous Iron Gathering Loop Iteration...');

            // Step 1: Check basic generic needs
            const needsFood = this.bot.food < 10;
            if (needsFood) {
                await this.handleHunger();
            }

            // Step 2: Check tools. Need at least a stone pickaxe to mine iron
            const hasStonePick = this.bot.inventory.items().some(i => i.name === 'stone_pickaxe' || i.name === 'iron_pickaxe' || i.name === 'diamond_pickaxe');

            if (!hasStonePick) {
                logger.info('Progression', 'Need a stone pickaxe to mine iron.');
                // Use GameKnowledge or manual fallback to get tools
                if (this.gameKnowledge) {
                    await this.gameKnowledge.ensurePlanks(8);
                    await this.gameKnowledge.ensureSticks(4);
                } else {
                    await this.mining.chopTrees(2);
                }

                await this.crafting.craftSequence(['crafting_table', 'wooden_pickaxe']);
                await this.mining.mineBlock('stone', 10);
                await this.crafting.craftSequence(['stone_pickaxe']);
            }

            // Still no pickaxe? Something failed (e.g., stuck).
            if (!this.bot.inventory.items().some(i => i.name === 'stone_pickaxe' || i.name === 'iron_pickaxe' || i.name === 'diamond_pickaxe')) {
                logger.warn('Progression', 'Failed to acquire pickaxe. Retrying...');
                await sleep(5000);
                continue;
            }

            // Step 3: Find and mine Iron
            logger.info('Progression', 'Searching for iron ore...');

            // Try mining iron directly. If none is found, mining module returns 0.
            const mined = await this.mining.mineBlock('iron_ore', 8, 32);

            if (mined === 0) {
                // No iron nearby. Need to dig down or explore a cave.
                logger.info('Progression', 'No iron found nearby. Excavating down...');
                // We fake "exploring down" by just mining stone to expose more area
                // A true cave explorer would be better, but this exposes ores.
                await this.mining.mineBlock('stone', 15, 8);
                await sleep(2000); // Breathe
            } else {
                if (this.bot) this.bot.chat(`I found and mined ${mined} iron ore! Continuing search...`);
                await sleep(2000);
            }
        }

        logger.info('Progression', 'Continuous iron gathering stopped.');
    }

    // ─── Goal Execution ─────────────────────────────────────

    /**
     * Execute a single goal from GameKnowledge.
     * Maps goal names to actual bot actions.
     */
    private async executeGoal(goal: string): Promise<void> {
        switch (goal) {
            // ─── Gathering ───
            case 'eat':
                await this.handleHunger();
                break;
            case 'chop_trees':
                logger.info('Progression', '🪓 Chopping trees for wood...');
                await this.mining.chopTrees(5);
                break;

            case 'mine_cobblestone':
                logger.info('Progression', '⛏ Mining cobblestone...');
                await this.mining.mineBlock('stone', 20);
                break;

            case 'mine_coal':
                logger.info('Progression', '⛏ Mining coal...');
                await this.mining.mineBlock('coal_ore', 12);
                break;

            case 'mine_iron':
                logger.info('Progression', '⛏ Mining iron ore...');
                await this.mining.mineBlock('iron_ore', 8);
                break;

            case 'mine_diamond':
                logger.info('Progression', '💎 Mining diamonds (strip mining at y=-58)...');
                await this.mining.mineBlock('diamond_ore', 6);
                break;

            // ─── Crafting Tools ───
            case 'craft_wooden_pickaxe':
                logger.info('Progression', '🔨 Crafting wooden tools...');
                if (this.gameKnowledge) {
                    await this.gameKnowledge.ensurePlanks(8);
                    await this.gameKnowledge.ensureSticks(4);
                }
                await this.crafting.craftSequence([
                    'crafting_table', 'wooden_pickaxe', 'wooden_axe', 'wooden_sword'
                ]);
                break;

            case 'craft_wooden_axe':
                logger.info('Progression', '🔨 Crafting wooden axe...');
                await this.crafting.craftItem('wooden_axe');
                break;

            case 'craft_stone_pickaxe':
                logger.info('Progression', '🔨 Crafting stone tools...');
                if (this.gameKnowledge) {
                    await this.gameKnowledge.ensureSticks(4);
                }
                await this.crafting.craftSequence([
                    'stone_pickaxe', 'stone_axe', 'stone_sword', 'stone_shovel'
                ]);
                break;

            case 'craft_stone_axe':
                await this.crafting.craftItem('stone_axe');
                break;

            case 'craft_stone_sword':
                await this.crafting.craftItem('stone_sword');
                break;

            case 'craft_iron_pickaxe':
                logger.info('Progression', '🔨 Crafting iron tools...');
                await this.crafting.craftSequence([
                    'iron_pickaxe', 'iron_sword', 'iron_axe'
                ]);
                break;

            case 'craft_iron_sword':
                await this.crafting.craftItem('iron_sword');
                break;

            case 'craft_diamond_pickaxe':
                logger.info('Progression', '🔨 Crafting diamond tools...');
                await this.crafting.craftSequence([
                    'diamond_pickaxe', 'diamond_sword'
                ]);
                break;

            // ─── Utility Crafting ───
            case 'craft_torches':
                logger.info('Progression', '🔦 Crafting torches...');
                await this.crafting.craftItem('torch', 16);
                break;

            case 'craft_furnace':
                logger.info('Progression', '🔥 Crafting furnace...');
                await this.crafting.craftItem('furnace');
                break;

            // ─── Smelting ───
            case 'smelt_iron':
                logger.info('Progression', '🔥 Smelting iron ore...');
                await this.smeltItems();
                break;

            // ─── Armor ───
            case 'craft_iron_armor':
                logger.info('Progression', '🛡 Crafting iron armor...');
                await this.crafting.craftSequence([
                    'iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots',
                    'shield'
                ]);
                await this.inventory.equipBestArmor();
                break;

            // ─── Default ───
            case 'explore':
                logger.info('Progression', '🌍 Exploring...');
                break;

            default:
                logger.warn('Progression', `Unknown goal: ${goal}`);
                // Try crafting it
                if (goal.startsWith('craft_')) {
                    const item = goal.replace('craft_', '');
                    await this.crafting.craftItem(item);
                }
                break;
        }
    }

    /**
     * Simple smelting: find or place a furnace, smelt raw ores.
     */
    private async smeltItems(): Promise<void> {
        if (!this.bot) return;
        const mcData = require('minecraft-data')(this.bot.version);

        // Ensure furnace
        await this.crafting.craftItem('furnace');

        const furnaceBlockId = mcData.blocksByName['furnace']?.id;
        if (!furnaceBlockId) return;

        // Find nearby furnace
        let furnaceBlock = this.bot.findBlock({ matching: furnaceBlockId, maxDistance: 32 });

        // Place one if none exists
        if (!furnaceBlock) {
            const furnaceItem = this.bot.inventory.items().find(i => i.name === 'furnace');
            if (furnaceItem) {
                try {
                    await this.bot.equip(furnaceItem, 'hand');
                    const pos = this.bot.entity.position;
                    const ref = this.bot.blockAt(pos.offset(0, -1, 0));
                    if (ref && ref.name !== 'air') {
                        await this.bot.placeBlock(ref, { x: 0, y: 1, z: 0 } as any);
                        await sleep(500);
                        furnaceBlock = this.bot.findBlock({ matching: furnaceBlockId, maxDistance: 8 });
                    }
                } catch (_) { }
            }
        }

        if (!furnaceBlock) {
            logger.warn('Progression', 'No furnace available for smelting');
            return;
        }

        // Navigate to furnace
        const { goals } = require('mineflayer-pathfinder');
        try {
            await this.bot.pathfinder.goto(
                new goals.GoalNear(furnaceBlock.position.x, furnaceBlock.position.y, furnaceBlock.position.z, 2)
            );
        } catch (_) { }

        // Open furnace and smelt
        try {
            const furnace = await (this.bot as any).openFurnace(furnaceBlock);

            // Put raw materials in input
            const smeltable = this.bot.inventory.items().find(i =>
                i.name === 'raw_iron' || i.name === 'raw_gold' || i.name === 'raw_copper' ||
                i.name === 'iron_ore' || i.name === 'gold_ore' || i.name === 'copper_ore'
            );

            if (smeltable) {
                await furnace.putInput(smeltable.type, null, smeltable.count);
            }

            // Put fuel
            const fuel = this.gameKnowledge?.getBestFuel() ||
                this.bot.inventory.items().find(i =>
                    i.name === 'coal' || i.name === 'charcoal' || i.name.includes('planks')
                );
            if (fuel) {
                await furnace.putFuel(fuel.type, null, Math.min(fuel.count, 8));
            }

            // Wait for smelting
            logger.info('Progression', `Smelting ${smeltable?.name || '?'}... waiting 30s`);
            await sleep(30000);

            // Take output
            const output = furnace.outputItem();
            if (output) {
                await furnace.takeOutput();
                logger.info('Progression', `Smelted → ${output.name} x${output.count}`);
            }

            furnace.close();
        } catch (e) {
            logger.warn('Progression', `Smelting failed: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    /**
     * Handle hunger by eating food from inventory.
     */
    private async handleHunger(): Promise<void> {
        if (!this.bot) return;

        const foodNames = [
            'cooked_beef', 'steak', 'cooked_porkchop', 'cooked_mutton', 'cooked_chicken',
            'cooked_cod', 'cooked_salmon', 'bread', 'baked_potato', 'carrot', 'apple',
            'sweet_berries', 'melon_slice'
        ];

        const foodItem = this.bot.inventory.items().find(i => foodNames.includes(i.name));
        if (foodItem) {
            logger.info('Progression', `Eating ${foodItem.name}...`);
            try {
                await this.bot.equip(foodItem, 'hand');
                // Eat until food level is higher
                const startFood = this.bot.food;
                await this.bot.consume();
                logger.info('Progression', `Ate ${foodItem.name} (Food: ${startFood} -> ${this.bot.food})`);
            } catch (e) {
                logger.warn('Progression', `Failed to eat: ${e instanceof Error ? e.message : String(e)}`);
            }
        }
    }
}
