import { Bot } from 'mineflayer';
import { logger } from '../../utils/logger';
import { sleep } from '../../utils/math';

/**
 * GameKnowledge — The bot's brain for Minecraft game mechanics.
 *
 * Uses minecraft-data to understand:
 * - Which tool is best for each block (via harvestTools + material properties)
 * - Full crafting dependency chains (e.g. pickaxe needs sticks needs planks needs logs)
 * - What to smelt and with what fuel
 * - Progression priorities (what to do next to survive & advance)
 *
 * This module makes the bot "smart" about Minecraft without hardcoding recipes.
 */
export class GameKnowledge {
    private mcData: any;
    private bot: Bot;

    /** Cached tool effectiveness mapping */
    private toolForMaterial: Record<string, string> = {
        'mineable/pickaxe': '_pickaxe',
        'mineable/axe': '_axe',
        'mineable/shovel': '_shovel',
        'mineable/hoe': '_hoe',
        'rock': '_pickaxe',
        'wood': '_axe',
        'plant': '_axe',
        'dirt': '_shovel',
        'sand': '_shovel',
        'clay': '_shovel',
        'snow': '_shovel',
    };

    /** Tool tiers from best to worst */
    private toolTiers = ['netherite', 'diamond', 'iron', 'stone', 'wooden', 'golden'];

    /** Minimum tool tier required for certain blocks */
    private minToolTier: Record<string, number> = {
        'obsidian': 3,         // diamond
        'ancient_debris': 3,   // diamond
        'diamond_ore': 2,      // iron
        'deepslate_diamond_ore': 2,
        'gold_ore': 2,
        'deepslate_gold_ore': 2,
        'emerald_ore': 2,
        'deepslate_emerald_ore': 2,
        'redstone_ore': 2,
        'deepslate_redstone_ore': 2,
        'iron_ore': 1,         // stone
        'deepslate_iron_ore': 1,
        'copper_ore': 1,
        'deepslate_copper_ore': 1,
        'lapis_ore': 1,
        'deepslate_lapis_ore': 1,
    };

    /** Smelting recipes the bot should know */
    private smeltingRecipes: Record<string, string> = {
        'raw_iron': 'iron_ingot',
        'raw_gold': 'gold_ingot',
        'raw_copper': 'copper_ingot',
        'iron_ore': 'iron_ingot',
        'gold_ore': 'gold_ingot',
        'copper_ore': 'copper_ingot',
        'cobblestone': 'stone',
        'sand': 'glass',
        'clay_ball': 'brick',
        'netherrack': 'nether_brick',
        'wet_sponge': 'sponge',
        'cactus': 'green_dye',
    };

    /** Fuel values (burn time in ticks) */
    private fuels: Record<string, number> = {
        'coal': 1600,
        'charcoal': 1600,
        'coal_block': 16000,
        'lava_bucket': 20000,
        'blaze_rod': 2400,
    };

    /** Complete crafting dependency tree for common items */
    private craftingChains: Record<string, string[]> = {
        // Basic materials
        'stick': ['planks'],
        'planks': ['log'],
        'crafting_table': ['planks'],

        // Wooden tools
        'wooden_pickaxe': ['planks', 'stick', 'crafting_table'],
        'wooden_axe': ['planks', 'stick', 'crafting_table'],
        'wooden_shovel': ['planks', 'stick', 'crafting_table'],
        'wooden_sword': ['planks', 'stick', 'crafting_table'],
        'wooden_hoe': ['planks', 'stick', 'crafting_table'],

        // Stone tools
        'stone_pickaxe': ['cobblestone', 'stick', 'crafting_table'],
        'stone_axe': ['cobblestone', 'stick', 'crafting_table'],
        'stone_shovel': ['cobblestone', 'stick', 'crafting_table'],
        'stone_sword': ['cobblestone', 'stick', 'crafting_table'],
        'stone_hoe': ['cobblestone', 'stick', 'crafting_table'],

        // Iron tools
        'iron_pickaxe': ['iron_ingot', 'stick', 'crafting_table'],
        'iron_axe': ['iron_ingot', 'stick', 'crafting_table'],
        'iron_shovel': ['iron_ingot', 'stick', 'crafting_table'],
        'iron_sword': ['iron_ingot', 'stick', 'crafting_table'],
        'iron_hoe': ['iron_ingot', 'stick', 'crafting_table'],

        // Diamond tools
        'diamond_pickaxe': ['diamond', 'stick', 'crafting_table'],
        'diamond_axe': ['diamond', 'stick', 'crafting_table'],
        'diamond_shovel': ['diamond', 'stick', 'crafting_table'],
        'diamond_sword': ['diamond', 'stick', 'crafting_table'],
        'diamond_hoe': ['diamond', 'stick', 'crafting_table'],

        // Armor
        'iron_helmet': ['iron_ingot', 'crafting_table'],
        'iron_chestplate': ['iron_ingot', 'crafting_table'],
        'iron_leggings': ['iron_ingot', 'crafting_table'],
        'iron_boots': ['iron_ingot', 'crafting_table'],
        'diamond_helmet': ['diamond', 'crafting_table'],
        'diamond_chestplate': ['diamond', 'crafting_table'],
        'diamond_leggings': ['diamond', 'crafting_table'],
        'diamond_boots': ['diamond', 'crafting_table'],

        // Utility
        'furnace': ['cobblestone', 'crafting_table'],
        'chest': ['planks', 'crafting_table'],
        'torch': ['stick', 'coal'],
        'bucket': ['iron_ingot', 'crafting_table'],
        'shield': ['planks', 'iron_ingot', 'crafting_table'],
        'bed': ['planks', 'wool'],
        'boat': ['planks', 'crafting_table'],
    };

    constructor(bot: Bot) {
        this.bot = bot;
        this.mcData = require('minecraft-data')(bot.version);
    }

    // ─── Tool Selection ────────────────────────────────────────

    /**
     * Get the best tool from inventory for a given block.
     * Uses minecraft-data harvestTools for exact lookup, falls back to material-based logic.
     */
    getBestToolForBlock(block: any): any | null {
        if (!block) return null;

        // Method 1: Check block.harvestTools — exact tool IDs that work
        if (block.harvestTools) {
            const harvestToolIds = Object.keys(block.harvestTools).map(Number);
            let bestTool: any = null;
            let bestTier = 999;

            for (const item of this.bot.inventory.items()) {
                if (harvestToolIds.includes(item.type)) {
                    const tier = this.getToolTier(item.name);
                    if (tier < bestTier) {
                        bestTier = tier;
                        bestTool = item;
                    }
                }
            }

            if (bestTool) return bestTool;
        }

        // Method 2: Use block material to determine tool type
        const toolSuffix = this.getToolTypeForBlock(block);
        if (!toolSuffix) return null;

        // Check minimum tier requirement
        const minTier = this.minToolTier[block.name] ?? 999;

        // Find best tool of the right type
        for (let i = 0; i < this.toolTiers.length; i++) {
            const tier = this.toolTiers[i];
            const tool = this.bot.inventory.items().find(item =>
                item.name === `${tier}${toolSuffix}`
            );
            if (tool && i <= minTier) return tool; // Tool meets minimum tier
            if (tool && minTier === 999) return tool; // No minimum required
        }

        return null;
    }

    /**
     * Determine what tool type a block needs based on its material/name.
     */
    getToolTypeForBlock(block: any): string | null {
        const name = block.name || '';

        // Check material property from minecraft-data
        if (block.material) {
            for (const [material, toolSuffix] of Object.entries(this.toolForMaterial)) {
                if (block.material.includes(material)) return toolSuffix;
            }
        }

        // Fallback: name-based detection
        const nameRules: [string[], string][] = [
            // Pickaxe
            [['ore', 'stone', 'cobblestone', 'andesite', 'diorite', 'granite',
                'deepslate', 'netherrack', 'basalt', 'blackstone', 'end_stone',
                'obsidian', 'terracotta', 'sandstone', 'prismarine', 'purpur',
                'quartz', 'brick', 'concrete', 'furnace', 'anvil', 'rail',
                'iron_bars', 'iron_door', 'chain', 'lantern', 'hopper',
                'dispenser', 'dropper', 'observer', 'piston', 'copper',
                'amethyst', 'calcite', 'tuff', 'dripstone'], '_pickaxe'],
            // Axe
            [['_log', '_stem', '_wood', 'planks', 'bookshelf', 'chest',
                'barrel', 'crafting', 'lectern', 'composter', 'campfire',
                'mushroom_block', 'pumpkin', 'melon', 'bamboo', 'cocoa',
                'jukebox', 'note_block', '_fence', '_door', '_sign',
                '_trapdoor', '_button', '_stairs', '_slab', 'loom',
                'cartography', 'fletching', 'smithing', 'bee'], '_axe'],
            // Shovel
            [['dirt', 'grass_block', 'sand', 'gravel', 'clay', 'snow',
                'soul_sand', 'soul_soil', 'mycelium', 'podzol', 'farmland',
                'mud', 'rooted_dirt', 'coarse_dirt', 'path', 'concrete_powder'], '_shovel'],
            // Hoe
            [['leaves', '_wart_block', 'shroomlight', 'hay_block',
                'target', 'dried_kelp_block', 'sponge', 'moss', 'sculk'], '_hoe'],
        ];

        for (const [patterns, toolSuffix] of nameRules) {
            if (patterns.some(p => name.includes(p))) return toolSuffix;
        }

        return null;
    }

    /**
     * Can this block be harvested with the tools we have?
     * Some blocks (diamond ore, obsidian) need a minimum tool tier.
     */
    canHarvest(blockName: string): boolean {
        const minTier = this.minToolTier[blockName];
        if (minTier === undefined) return true; // No restriction

        const toolType = '_pickaxe';
        for (let i = 0; i <= minTier; i++) {
            if (this.bot.inventory.items().some(item =>
                item.name === `${this.toolTiers[i]}${toolType}`
            )) return true;
        }
        return false;
    }

    // ─── Recipe Intelligence ──────────────────────────────────

    /**
     * Smart craft: resolve the full dependency chain and craft everything needed.
     * Returns true if the item was successfully crafted.
     */
    async smartCraft(itemName: string, count: number = 1): Promise<boolean> {
        const resolved = this.resolveItemName(itemName);
        const item = this.mcData.itemsByName[resolved];
        if (!item) {
            logger.warn('GameKnowledge', `Unknown item: ${itemName} (resolved: ${resolved})`);
            return false;
        }

        // Already have enough?
        const have = this.countItem(resolved);
        if (have >= count) return true;

        const needed = count - have;
        logger.info('GameKnowledge', `Smart crafting ${needed}x ${resolved}...`);

        // Build dependency chain
        const deps = this.getDependencies(resolved);
        logger.info('GameKnowledge', `Dependencies: ${deps.join(' → ') || 'none'}`);

        // Craft dependencies first (bottom-up)
        for (const dep of deps) {
            if (dep === 'log') {
                // Can't craft logs — need to mine them
                if (!this.hasAnyLog()) {
                    logger.warn('GameKnowledge', 'Need logs but have none — must chop trees first');
                    return false;
                }
                continue;
            }
            if (dep === 'cobblestone' || dep === 'coal' || dep === 'iron_ingot' || dep === 'diamond' || dep === 'wool') {
                // Raw materials — can't craft, need to mine/kill
                if (this.countItem(dep) === 0) {
                    logger.warn('GameKnowledge', `Need ${dep} but have none — must gather first`);
                    return false;
                }
                continue;
            }

            const depCount = this.getRequiredCount(resolved, dep, needed);
            const depHave = this.countItemFuzzy(dep);
            if (depHave < depCount) {
                logger.info('GameKnowledge', `Crafting dependency: ${depCount - depHave}x ${dep}`);
                await this.craftSingle(dep, depCount - depHave);
            }
        }

        // Now craft the target
        return await this.craftSingle(resolved, needed);
    }

    /**
     * Craft a single item using mineflayer's recipesFor.
     * Tries with crafting table first (most recipes need one).
     */
    private async craftSingle(itemName: string, count: number): Promise<boolean> {
        const resolved = this.resolveItemName(itemName);
        const item = this.mcData.itemsByName[resolved];
        if (!item) return false;

        // Ensure crafting table
        const table = await this.ensureCraftingTable();

        // Try with table first (most recipes need one)
        if (table) {
            const recipes = this.bot.recipesFor(item.id, null, 1, table);
            if (recipes && recipes.length > 0) {
                try {
                    await this.bot.craft(recipes[0], count, table);
                    logger.info('GameKnowledge', `✓ Crafted ${count}x ${resolved}`);
                    return true;
                } catch (e) {
                    logger.debug('GameKnowledge', `Table craft failed: ${e instanceof Error ? e.message : String(e)}`);
                }
            }
        }

        // Try without table (2x2 recipes: planks, sticks, etc.)
        const handRecipes = this.bot.recipesFor(item.id, null, 1, null);
        if (handRecipes && handRecipes.length > 0) {
            try {
                await this.bot.craft(handRecipes[0], count, undefined);
                logger.info('GameKnowledge', `✓ Crafted ${count}x ${resolved} (hand)`);
                return true;
            } catch (e) {
                logger.debug('GameKnowledge', `Hand craft failed: ${e instanceof Error ? e.message : String(e)}`);
            }
        }

        // Try wood variants
        return await this.tryWoodVariants(resolved, count, table);
    }



    /**
     * Get the crafting dependencies for an item (ordered, bottom-up).
     */
    getDependencies(itemName: string): string[] {
        const chain = this.craftingChains[itemName];
        if (!chain) return [];

        const allDeps: string[] = [];
        const visited = new Set<string>();

        const resolve = (deps: string[]) => {
            for (const dep of deps) {
                if (visited.has(dep)) continue;
                visited.add(dep);
                // Resolve sub-dependencies first
                const subDeps = this.craftingChains[dep];
                if (subDeps) resolve(subDeps);
                allDeps.push(dep);
            }
        };

        resolve(chain);
        return allDeps;
    }

    /**
     * How many of a dependency do we need for crafting N of the target?
     */
    private getRequiredCount(target: string, dep: string, targetCount: number): number {
        // Common ratios
        const ratios: Record<string, Record<string, number>> = {
            'planks': { 'log': 1 },       // 1 log → 4 planks
            'stick': { 'planks': 2 },      // 2 planks → 4 sticks
            'crafting_table': { 'planks': 4 },
            'wooden_pickaxe': { 'planks': 3, 'stick': 2 },
            'wooden_axe': { 'planks': 3, 'stick': 2 },
            'wooden_shovel': { 'planks': 1, 'stick': 2 },
            'wooden_sword': { 'planks': 2, 'stick': 1 },
            'stone_pickaxe': { 'cobblestone': 3, 'stick': 2 },
            'stone_axe': { 'cobblestone': 3, 'stick': 2 },
            'stone_shovel': { 'cobblestone': 1, 'stick': 2 },
            'stone_sword': { 'cobblestone': 2, 'stick': 1 },
            'iron_pickaxe': { 'iron_ingot': 3, 'stick': 2 },
            'iron_axe': { 'iron_ingot': 3, 'stick': 2 },
            'iron_shovel': { 'iron_ingot': 1, 'stick': 2 },
            'iron_sword': { 'iron_ingot': 2, 'stick': 1 },
            'diamond_pickaxe': { 'diamond': 3, 'stick': 2 },
            'diamond_axe': { 'diamond': 3, 'stick': 2 },
            'diamond_shovel': { 'diamond': 1, 'stick': 2 },
            'diamond_sword': { 'diamond': 2, 'stick': 1 },
            'furnace': { 'cobblestone': 8 },
            'chest': { 'planks': 8 },
            'torch': { 'stick': 1, 'coal': 1 },
            'bucket': { 'iron_ingot': 3 },
            'shield': { 'planks': 6, 'iron_ingot': 1 },
        };

        const recipe = ratios[target];
        if (recipe && recipe[dep] !== undefined) {
            return recipe[dep] * targetCount;
        }

        // Default: assume 1:1
        return targetCount;
    }

    // ─── Progression Intelligence ─────────────────────────────

    /**
     * Determine what the bot should do next to progress in survival.
     * Returns a prioritized list of goals.
     */
    getNextGoals(): string[] {
        const goals: string[] = [];

        // Priority 0: Hunger (Knowledge about survival)
        if (this.bot.food < 10 && this.hasFood()) {
            goals.push('eat');
            return goals;
        }

        // Priority 1: Get wood if we have none
        if (!this.hasAnyLog() && this.countItemFuzzy('planks') < 4) {
            goals.push('chop_trees');
            return goals;
        }

        // Priority 2: Craft basic tools if we have none
        if (!this.hasTool('_pickaxe')) {
            goals.push('craft_wooden_pickaxe');
            return goals;
        }
        if (!this.hasTool('_axe')) {
            goals.push('craft_wooden_axe');
        }

        // Priority 3: Get cobblestone for stone tools
        if (this.countItem('cobblestone') < 3 && !this.hasTool('_pickaxe', 'stone')) {
            goals.push('mine_cobblestone');
            return goals;
        }

        // Priority 4: Stone tools are essential for speed
        if (!this.hasTool('_pickaxe', 'stone')) {
            goals.push('craft_stone_pickaxe');
            return goals;
        }
        if (!this.hasTool('_axe', 'stone') && this.countItem('cobblestone') >= 3) {
            goals.push('craft_stone_axe');
        }

        // Priority 5: Get coal for torches and smelting
        if (this.countItem('coal') < 8 && this.countItem('torch') < 4) {
            goals.push('mine_coal');
            return goals;
        }

        // Priority 6: Craft torches for safety/visibility
        if (this.countItem('coal') > 0 && this.countItem('torch') < 16) {
            goals.push('craft_torches');
        }

        // Priority 7: Get furnace
        if (this.countItemFuzzy('furnace') === 0 && this.countItem('cobblestone') >= 8) {
            goals.push('craft_furnace');
        }

        // Priority 8: Find iron
        if (this.countItem('iron_ingot') < 3 && !this.hasTool('_pickaxe', 'iron')) {
            goals.push('mine_iron');
            return goals;
        }

        // Priority 9: Smelt iron
        if (this.countItem('raw_iron') > 0 && this.countItem('iron_ingot') < 3) {
            goals.push('smelt_iron');
            return goals;
        }

        // Priority 10: Upgrade to Iron tools (Much faster!)
        if (this.countItem('iron_ingot') >= 3 && !this.hasTool('_pickaxe', 'iron')) {
            goals.push('craft_iron_pickaxe');
            return goals;
        }

        // Priority 11: Iron Armor for safety
        if (this.countItem('iron_ingot') >= 24 && !this.hasArmor('iron')) {
            goals.push('craft_iron_armor');
        }

        // Priority 12: High-tier mining (Diamonds)
        if (this.hasTool('_pickaxe', 'iron') && this.countItem('diamond') < 5) {
            goals.push('mine_diamond');
            return goals;
        }

        // Priority 13: End-game tools
        if (this.countItem('diamond') >= 3 && !this.hasTool('_pickaxe', 'diamond')) {
            goals.push('craft_diamond_pickaxe');
        }

        if (goals.length === 0) goals.push('explore'); // Nothing else to do
        return goals;
    }

    // ─── Helpers ──────────────────────────────────────────────

    /** Resolve generic item names to specific ones based on inventory */
    resolveItemName(name: string): string {
        const clean = name.replace(/ /g, '_').toLowerCase();

        // Generic "planks" → use wood type we have
        if (clean === 'planks' || clean === 'wooden_planks') {
            const log = this.bot.inventory.items().find(i =>
                i.name.endsWith('_log') || i.name.endsWith('_stem')
            );
            if (log) {
                return `${log.name.replace('_log', '').replace('_stem', '')}_planks`;
            }
            // Check for existing planks
            const existingPlanks = this.bot.inventory.items().find(i => i.name.includes('planks'));
            if (existingPlanks) return existingPlanks.name;
            return 'oak_planks';
        }

        // Generic "log" → any log
        if (clean === 'log' || clean === 'wood') {
            const log = this.bot.inventory.items().find(i =>
                i.name.endsWith('_log') || i.name.endsWith('_stem')
            );
            return log?.name || 'oak_log';
        }

        // Direct match
        if (this.mcData.itemsByName[clean]) return clean;

        // Fuzzy
        const match = Object.keys(this.mcData.itemsByName).find(k => k.includes(clean));
        return match || clean;
    }

    /** Count how many of an exact item we have */
    countItem(name: string): number {
        return this.bot.inventory.items()
            .filter(i => i.name === name)
            .reduce((sum, i) => sum + i.count, 0);
    }

    /** Count how many of a fuzzy-matched item we have */
    countItemFuzzy(name: string): number {
        return this.bot.inventory.items()
            .filter(i => i.name.includes(name))
            .reduce((sum, i) => sum + i.count, 0);
    }

    /** Check if we have any log type */
    hasAnyLog(): boolean {
        return this.bot.inventory.items().some(i =>
            i.name.endsWith('_log') || i.name.endsWith('_stem')
        );
    }

    /** Check if we have a specific tool type (optionally of a minimum tier) */
    hasTool(toolSuffix: string, minTier?: string): boolean {
        const items = this.bot.inventory.items();
        if (!minTier) return items.some(i => i.name.endsWith(toolSuffix));

        const tierIndex = this.toolTiers.indexOf(minTier);
        for (let i = 0; i <= tierIndex; i++) {
            if (items.some(item => item.name === `${this.toolTiers[i]}${toolSuffix}`)) return true;
        }
        return false;
    }

    /** Check if we have armor of a given tier */
    hasArmor(tier: string): boolean {
        return this.bot.inventory.items().some(i =>
            i.name.startsWith(`${tier}_`) && (
                i.name.endsWith('_helmet') || i.name.endsWith('_chestplate') ||
                i.name.endsWith('_leggings') || i.name.endsWith('_boots')
            )
        );
    }

    /** Get tool tier index (lower = better) */
    private getToolTier(itemName: string): number {
        for (let i = 0; i < this.toolTiers.length; i++) {
            if (itemName.startsWith(this.toolTiers[i])) return i;
        }
        return 999;
    }

    /** Get smelting result for an item */
    getSmeltResult(itemName: string): string | null {
        return this.smeltingRecipes[itemName] || null;
    }

    /** Get the best fuel in inventory */
    getBestFuel(): any | null {
        for (const [fuelName] of Object.entries(this.fuels).sort((a, b) => b[1] - a[1])) {
            const fuel = this.bot.inventory.items().find(i => i.name === fuelName);
            if (fuel) return fuel;
        }
        // Fallback: any wood item as fuel
        return this.bot.inventory.items().find(i =>
            i.name.includes('planks') || i.name.endsWith('_log') || i.name.endsWith('_stem')
        ) || null;
    }

    /**
     * Find a safe position nearby to place a block.
     * Checks for:
     * 1. Air block at targeting position.
     * 2. Solid block below (for support).
     * 3. No entities (including bot) colliding with the placement.
     */
    async findSafePlacement(): Promise<{ refBlock: any, faceVector: any } | null> {
        const { Vec3 } = require('vec3');
        const pos = this.bot.entity.position.floored();

        // Search in a small radius around the bot's feet
        for (let dx = -2; dx <= 2; dx++) {
            for (let dz = -2; dz <= 2; dz++) {
                for (let dy = -1; dy <= 1; dy++) {
                    const placePos = pos.offset(dx, dy, dz);
                    const block = this.bot.blockAt(placePos);

                    // Must be air/replaceable
                    if (!block || block.name !== 'air') continue;

                    // Support block below must be solid
                    const refBlock = this.bot.blockAt(placePos.offset(0, -1, 0));
                    if (!refBlock || refBlock.name === 'air' || refBlock.name === 'water' || refBlock.name === 'lava') continue;

                    // Collision check: No entities in this block space
                    const blockBB = {
                        minX: placePos.x, minY: placePos.y, minZ: placePos.z,
                        maxX: placePos.x + 1, maxY: placePos.y + 1, maxZ: placePos.z + 1
                    };

                    const colliding = Object.values(this.bot.entities).some(entity => {
                        if (!entity.position) return false;
                        // Rough bounding box check for entities
                        const eWidth = 0.6;
                        const eHeight = 1.8;
                        const ex = entity.position.x;
                        const ey = entity.position.y;
                        const ez = entity.position.z;

                        return (ex + eWidth / 2 > blockBB.minX && ex - eWidth / 2 < blockBB.maxX &&
                            ey + eHeight > blockBB.minY && ey < blockBB.maxY &&
                            ez + eWidth / 2 > blockBB.minZ && ez - eWidth / 2 < blockBB.maxZ);
                    });

                    if (!colliding) {
                        return { refBlock, faceVector: new Vec3(0, 1, 0) };
                    }
                }
            }
        }

        return null;
    }

    /**
     * Find/place a crafting table and navigate to it.
     */
    async ensureCraftingTable(): Promise<any> {
        const { goals } = require('mineflayer-pathfinder');

        // Already nearby?
        const tableBlockId = this.mcData.blocksByName['crafting_table']?.id;
        if (tableBlockId) {
            const existing = this.bot.findBlock({ matching: tableBlockId, maxDistance: 32 });
            if (existing) {
                // Navigate if too far
                const dist = this.bot.entity.position.distanceTo(existing.position);
                if (dist > 4.5) {
                    try {
                        await this.bot.pathfinder.goto(
                            new goals.GoalNear(existing.position.x, existing.position.y, existing.position.z, 2)
                        );
                    } catch (_) { }
                }
                return existing;
            }
        }

        // Craft one if we don't have one
        let tableItem = this.bot.inventory.items().find(i => i.name === 'crafting_table');
        if (!tableItem) {
            // Need planks
            await this.ensurePlanks(4);
            const tableId = this.mcData.itemsByName['crafting_table']?.id;
            if (tableId) {
                const recipes = this.bot.recipesFor(tableId, null, 1, null);
                if (recipes && recipes.length > 0) {
                    try {
                        await this.bot.craft(recipes[0], 1, undefined);
                    } catch (e) {
                        logger.debug('GameKnowledge', `Craft table failed: ${e instanceof Error ? e.message : String(e)}`);
                        return null;
                    }
                }
            }
            tableItem = this.bot.inventory.items().find(i => i.name === 'crafting_table');
        }

        if (!tableItem) return null;

        // Place it
        try {
            const placement = await this.findSafePlacement();
            if (!placement) {
                logger.warn('GameKnowledge', 'No safe spot to place crafting table!');
                return null;
            }

            await this.bot.equip(tableItem, 'hand');
            await this.bot.placeBlock(placement.refBlock, placement.faceVector);
            logger.info('GameKnowledge', `✓ Placed crafting table at ${placement.refBlock.position.offset(0, 1, 0)}`);
            await sleep(300);

            // Find the placed table
            if (tableBlockId) {
                return this.bot.findBlock({ matching: tableBlockId, maxDistance: 8 });
            }
        } catch (e) {
            logger.debug('GameKnowledge', `Place failed: ${e instanceof Error ? e.message : String(e)}`);
        }

        return null;
    }

    /**
     * Ensure we have at least N planks (converting logs if needed).
     */
    async ensurePlanks(count: number): Promise<boolean> {
        const have = this.countItemFuzzy('planks');
        if (have >= count) return true;

        const logs = this.bot.inventory.items().filter(i =>
            i.name.endsWith('_log') || i.name.endsWith('_stem')
        );

        for (const log of logs) {
            const woodType = log.name.replace('_log', '').replace('_stem', '');
            const planksName = `${woodType}_planks`;
            const planksItem = this.mcData.itemsByName[planksName];
            if (!planksItem) continue;

            const recipes = this.bot.recipesFor(planksItem.id, null, 1, null);
            if (recipes && recipes.length > 0) {
                const batches = Math.ceil((count - this.countItemFuzzy('planks')) / 4);
                try {
                    await this.bot.craft(recipes[0], Math.min(batches, log.count), undefined);
                    logger.info('GameKnowledge', `Converted logs → ${planksName}`);
                    if (this.countItemFuzzy('planks') >= count) return true;
                } catch (_) { }
            }
        }

        return this.countItemFuzzy('planks') >= count;
    }

    /**
     * Ensure we have at least N sticks.
     */
    async ensureSticks(count: number): Promise<boolean> {
        const have = this.countItem('stick');
        if (have >= count) return true;

        await this.ensurePlanks(Math.ceil((count - have) / 2));

        const stickItem = this.mcData.itemsByName['stick'];
        if (!stickItem) return false;

        const recipes = this.bot.recipesFor(stickItem.id, null, 1, null);
        if (recipes && recipes.length > 0) {
            const batches = Math.ceil((count - have) / 4);
            try {
                await this.bot.craft(recipes[0], batches, undefined);
                logger.info('GameKnowledge', `Crafted sticks`);
                return true;
            } catch (_) { }
        }
        return this.countItem('stick') >= count;
    }

    /**
     * Try crafting an item using different wood variants.
     */
    private async tryWoodVariants(itemName: string, count: number, table: any): Promise<boolean> {
        const woodTypes = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry'];

        for (const wood of woodTypes) {
            // Generate variant name
            let variantName: string;
            const baseName = itemName.replace(/^(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|bamboo|crimson|warped)_/, '');
            variantName = `${wood}_${baseName}`;

            const variantItem = this.mcData.itemsByName[variantName];
            if (!variantItem) continue;

            // Try with table
            if (table) {
                const recipes = this.bot.recipesFor(variantItem.id, null, 1, table);
                if (recipes && recipes.length > 0) {
                    try {
                        await this.bot.craft(recipes[0], count, table);
                        logger.info('GameKnowledge', `✓ Crafted ${count}x ${variantName} (variant)`);
                        return true;
                    } catch (_) { continue; }
                }
            }

            // Try by hand
            const handRecipes = this.bot.recipesFor(variantItem.id, null, 1, null);
            if (handRecipes && handRecipes.length > 0) {
                try {
                    await this.bot.craft(handRecipes[0], count, undefined);
                    logger.info('GameKnowledge', `✓ Crafted ${count}x ${variantName} (hand variant)`);
                    return true;
                } catch (_) { continue; }
            }
        }

        return false;
    }

    // ─── Combat Intelligence ──────────────────────────────────

    /**
     * Rate the danger level of an entity (0-100).
     */
    getThreatLevel(entity: any): number {
        if (!entity) return 0;
        const name = entity.name || '';

        // Extreme threats
        if (name === 'warden' || name === 'wither' || name === 'ender_dragon') return 100;

        // High threats
        const highThreats = ['piglin_brute', 'vindicator', 'evoker', 'ravager'];
        if (highThreats.includes(name)) return 70;

        // Moderate threats
        const moderateThreats = ['creeper', 'enderman', 'witch', 'blaze', 'ghast', 'wither_skeleton'];
        if (moderateThreats.includes(name)) return 40;

        // Low threats
        const lowThreats = ['zombie', 'skeleton', 'spider', 'drowned', 'husk', 'stray', 'pillager', 'phantom', 'silverfish'];
        if (lowThreats.includes(name)) return 20;

        return 5;
    }

    /**
     * Calculate combat confidence based on gear (0-100).
     */
    getCombatConfidence(): number {
        let confidence = 0;

        // Armor rating
        const armorTiers: Record<string, number> = { 'netherite': 40, 'diamond': 30, 'iron': 20, 'chainmail': 10, 'golden': 5, 'leather': 2 };
        if (this.bot.inventory) {
            const slots = [5, 6, 7, 8]; // helm, chest, legs, boots
            for (const slotId of slots) {
                const item = this.bot.inventory.slots[slotId];
                if (item) {
                    for (const [tier, score] of Object.entries(armorTiers)) {
                        if (item.name.includes(tier)) {
                            confidence += score;
                            break;
                        }
                    }
                }
            }
        }

        // Weapon rating
        const weaponTiers: Record<string, number> = { 'sword': 1, 'axe': 0.8 };
        const materialTiers: Record<string, number> = { 'netherite': 40, 'diamond': 30, 'iron': 20, 'stone': 10, 'wooden': 5 };

        const weapon = this.bot.inventory.items().find(i => i.name.includes('sword') || i.name.includes('axe'));
        if (weapon) {
            let weaponScore = 0;
            for (const [mat, score] of Object.entries(materialTiers)) {
                if (weapon.name.includes(mat)) {
                    weaponScore = score;
                    break;
                }
            }
            if (weapon.name.includes('sword')) confidence += weaponScore;
            else confidence += weaponScore * 0.8;
        }

        // Health modifier
        const healthFactor = this.bot.health / 20;
        return Math.min(100, Math.round(confidence * healthFactor));
    }

    /**
     * Check if the bot is in an enclosed/cramped space (e.g. 1x1 hole).
     */
    isEnclosed(): boolean {
        const pos = this.bot.entity.position.floored();
        let airSpaces = 0;

        // Check 3x3x3 around the bot
        for (let dx = -1; dx <= 1; dx++) {
            for (let dz = -1; dz <= 1; dz++) {
                for (let dy = 0; dy <= 1; dy++) {
                    const block = this.bot.blockAt(pos.offset(dx, dy, dz));
                    if (block && (block.name === 'air' || block.name === 'cave_air')) {
                        airSpaces++;
                    }
                }
            }
        }

        // If less than 6 air blocks in the immediate 18 block vicinity (3x3x2), we are "enclosed"
        // (A normal 2x1 standing space has 2 air blocks. A 3x3x2 room has 18 blocks).
        return airSpaces < 6;
    }

    /** Helper to check if inventory has any food */
    private hasFood(): boolean {
        const foodNames = [
            'apple', 'bread', 'cooked_beef', 'cooked_chicken', 'cooked_porkchop',
            'cooked_mutton', 'cooked_rabbit', 'cooked_cod', 'cooked_salmon',
            'baked_potato', 'carrot', 'melon_slice', 'sweet_berries', 'steak'
        ];
        return this.bot.inventory.items().some(item => foodNames.includes(item.name));
    }
}
