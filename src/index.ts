import { BotManager } from './core/BotManager';
import { RecoveryManager } from './core/RecoveryManager';
import { ConfigHotReload } from './core/ConfigHotReload';
import { PerformanceMonitor } from './core/PerformanceMonitor';
import { BackupManager } from './persistence/BackupManager';
import { ChatModule } from './modules/Chat/ChatModule';
import { NavigationModule } from './modules/Navigation/NavigationModule';
import { MiningModule } from './modules/Mining/MiningModule';
import { CraftingModule } from './modules/Crafting/CraftingModule';
import { InventoryModule } from './modules/Inventory/InventoryModule';
import { CombatModule } from './modules/Combat/CombatModule';
import { StashModule } from './modules/Stash/StashModule';
import { ProgressionModule } from './modules/Progression/ProgressionModule';
import { BuildingModule } from './modules/Building/BuildingModule';
import { FarmModule } from './modules/Farm/FarmModule';
import { ExplorationModule } from './modules/Exploration/ExplorationModule';
import { GameKnowledge } from './modules/GameKnowledge/GameKnowledge';
import { Mode } from './types/enums';
import { logger } from './utils/logger';
import { TaskPriority, TaskCategory } from './types/enums';
import { Task } from './types/interfaces';
import { generateId } from './utils/math';

// ─── Boot ───────────────────────────────────────────────────────
logger.info('Main', '═══════════════════════════════════════════');
logger.info('Main', '  Modular Autonomous Minecraft AI Bot v2');
logger.info('Main', '═══════════════════════════════════════════');

const manager = new BotManager();

// ─── Phase 4: Recovery, HotReload, Performance ──────────────────
const recoveryManager = new RecoveryManager(manager.eventBus);
const configHotReload = new ConfigHotReload(manager.eventBus);
const perfMonitor = new PerformanceMonitor({
    memoryWarnMB: 512,
    memoryKillMB: 1024,
    onThresholdExceeded: () => {
        logger.error('Main', 'Memory threshold exceeded — saving state');
        recoveryManager.saveState({ reason: 'memory_threshold', taskName: manager.taskEngine.getCurrentTaskName() });
    },
});

configHotReload.start();
perfMonitor.start();

// ─── Backup System ──────────────────────────────────────────────
const backupManager = new BackupManager(5 * 60 * 1000, 10); // every 5 min, keep 10
backupManager.start();

// ─── Config Hot-Reload Handler ──────────────────────────────────
manager.eventBus.on('config:reload' as any, (newConfig: any) => {
    logger.info('Main', '🔄 Config reloaded — applying changes...');
    if (manager.bot && newConfig.botUsername) {
        // Mode changes can be applied live
        if (newConfig.mode) {
            const modeMap: Record<string, Mode> = { FULL_AUTO: Mode.FULL_AUTO, HALF_AUTO: Mode.HALF_AUTO, PASSIVE: Mode.PASSIVE };
            const m = modeMap[newConfig.mode];
            if (m) manager.modeManager.setMode(m);
        }
    }
});

// ─── Create Modules ─────────────────────────────────────────────
const config = manager.database.getConfig();
const chatModule = new ChatModule(config);
const navModule = new NavigationModule();
const miningModule = new MiningModule();
const craftingModule = new CraftingModule();
const inventoryModule = new InventoryModule();
const combatModule = new CombatModule();
const stashModule = new StashModule(manager.database);
const progressionModule = new ProgressionModule(miningModule, craftingModule, inventoryModule);
const buildingModule = new BuildingModule();
const farmModule = new FarmModule();
const explorationModule = new ExplorationModule(manager.database);

// ─── GameKnowledge — wired after bot connects ───────────────────
let gameKnowledge: GameKnowledge | null = null;
manager.eventBus.on('bot:ready' as any, () => {
    if (manager.bot) {
        gameKnowledge = new GameKnowledge(manager.bot);
        miningModule.setGameKnowledge(gameKnowledge);
        craftingModule.setGameKnowledge(gameKnowledge);
        progressionModule.setGameKnowledge(gameKnowledge);
        combatModule.setGameKnowledge(gameKnowledge);
        logger.info('Main', '🧠 GameKnowledge initialized and wired to all modules');

        // Auto-start progression in FULL_AUTO mode
        if (manager.modeManager.getMode() === Mode.FULL_AUTO) {
            logger.info('Main', '🚀 FULL_AUTO mode — starting autonomous progression');
            setTimeout(() => {
                progressionModule.run().catch(e =>
                    logger.error('Main', `Progression error: ${e instanceof Error ? e.message : String(e)}`)
                );
            }, 3000); // 3s delay to let chunks load
        }
    }
});

// ─── Register Modules ───────────────────────────────────────────
manager.registerModule(chatModule);
manager.registerModule(navModule);
manager.registerModule(miningModule);
manager.registerModule(craftingModule);
manager.registerModule(inventoryModule);
manager.registerModule(combatModule);
manager.registerModule(stashModule);
manager.registerModule(progressionModule);
manager.registerModule(buildingModule);
manager.registerModule(farmModule);
manager.registerModule(explorationModule);

// ═══════════════════════════════════════════════════════════════════
// CHAT ACTIONS — These are the actions the AI can choose from
// ═══════════════════════════════════════════════════════════════════

// ─── Navigation ─────────────────────────────────────────────────
chatModule.registerAction('come', async (target) => {
    if (target) await navModule.goToPlayer(target);
});

chatModule.registerAction('follow', async (target) => {
    if (target) navModule.followPlayer(target);
});

chatModule.registerAction('stop', async () => {
    navModule.stop();
    miningModule.stopMining();
    buildingModule.stop();
    farmModule.stop();
    explorationModule.stop();
    progressionModule.stop();
});

chatModule.registerAction('gather_iron_continuously', async () => {
    progressionModule.gatherIronContinuously().catch(e => logger.error('Main', `Error gathering iron: ${e}`));
});

chatModule.registerAction('go_home', async () => {
    const ok = await explorationModule.goHome();
    if (manager.bot) manager.bot.chat(ok ? 'Made it home!' : "Can't find my way home.");
});

// ─── Mining ─────────────────────────────────────────────────────
chatModule.registerAction('chop_tree', async () => {
    const chopped = await miningModule.chopTrees(3);
    if (manager.bot) manager.bot.chat(`Chopped ${chopped} trees!`);
});

chatModule.registerAction('mine', async (target) => {
    if (target) {
        const mined = await miningModule.mineBlock(target, 8);
        if (manager.bot) manager.bot.chat(`Mined ${mined}x ${target}!`);
    }
});

chatModule.registerAction('gather_wood', async () => {
    const chopped = await miningModule.chopTrees(5);
    if (manager.bot) manager.bot.chat(`Gathered ${chopped} trees worth of wood!`);
});

// ─── Crafting ───────────────────────────────────────────────────
chatModule.registerAction('craft', async (target) => {
    if (target) {
        const ok = await craftingModule.craftItem(target);
        if (manager.bot) manager.bot.chat(ok ? `Crafted ${target}!` : `Couldn't craft ${target}.`);
    }
});

chatModule.registerAction('get_wooden_tools', async () => {
    const crafted = await craftingModule.craftSequence(['wooden_pickaxe', 'wooden_sword', 'wooden_axe', 'wooden_shovel']);
    if (manager.bot) manager.bot.chat(crafted.length > 0 ? `Got: ${crafted.join(', ')}!` : "Couldn't make tools!");
});

chatModule.registerAction('get_stone_tools', async () => {
    const crafted = await craftingModule.craftSequence(['stone_pickaxe', 'stone_sword', 'stone_axe', 'stone_shovel']);
    if (manager.bot) manager.bot.chat(crafted.length > 0 ? `Got: ${crafted.join(', ')}!` : "Need cobblestone first!");
});

// ─── Inventory ──────────────────────────────────────────────────
chatModule.registerAction('equip_armor', async () => {
    await inventoryModule.equipBestArmor();
    if (manager.bot) manager.bot.chat('Armored up!');
});

chatModule.registerAction('inventory', async () => {
    const items = inventoryModule.listItems();
    const list = Object.entries(items).map(([name, count]) => `${count}x ${name}`).slice(0, 15).join(', ');
    if (manager.bot) manager.bot.chat(list || 'Inventory is empty!');
});

chatModule.registerAction('discard_junk', async () => {
    const count = await inventoryModule.discardJunk();
    if (manager.bot) manager.bot.chat(count > 0 ? `Tossed ${count} junk items!` : 'No junk to toss.');
});

chatModule.registerAction('drop', async (target) => {
    if (!target) return;
    const count = await inventoryModule.dropItem(target);
    if (manager.bot) manager.bot.chat(count > 0 ? `Dropped ${count}x ${target}!` : `I don't have any ${target} to drop.`);
});

// ─── Stash ──────────────────────────────────────────────────────
chatModule.registerAction('create_stash', async (target) => {
    const stash = await stashModule.createStash(target);
    if (manager.bot) manager.bot.chat(stash ? `Stash "${stash.label}" created!` : "Couldn't create stash — need a chest.");
});

chatModule.registerAction('store_items', async () => {
    const stored = await stashModule.storeItems();
    if (manager.bot) manager.bot.chat(stored > 0 ? `Stored ${stored} items!` : 'Nothing to store or no stash nearby.');
});

chatModule.registerAction('retrieve_items', async (target) => {
    if (target) {
        const count = await stashModule.retrieveItems(target);
        if (manager.bot) manager.bot.chat(count > 0 ? `Got ${count}x ${target}!` : `No ${target} in any stash.`);
    }
});

chatModule.registerAction('stash_info', async () => {
    if (manager.bot) manager.bot.chat(stashModule.getSummary());
});

// ─── Building ───────────────────────────────────────────────────
chatModule.registerAction('build_shelter', async () => {
    const ok = await buildingModule.buildShelter();
    if (manager.bot) manager.bot.chat(ok ? 'Shelter built!' : "Couldn't build — need cobblestone.");
});

chatModule.registerAction('place_torches', async () => {
    if (!manager.bot) return;
    const pos = manager.bot.entity.position;
    const { Vec3 } = require('vec3');
    const count = await buildingModule.placeTorches(new Vec3(pos.x, pos.y, pos.z));
    if (manager.bot) manager.bot.chat(`Placed ${count} torches!`);
});

// ─── Farming ────────────────────────────────────────────────────
chatModule.registerAction('create_farm', async () => {
    const tilled = await farmModule.createFarm();
    if (manager.bot) manager.bot.chat(tilled > 0 ? `Farm created! ${tilled} blocks tilled.` : "Couldn't create farm — need a hoe.");
});

chatModule.registerAction('plant_seeds', async (target) => {
    const planted = await farmModule.plantSeeds(target || 'wheat_seeds');
    if (manager.bot) manager.bot.chat(planted > 0 ? `Planted ${planted} seeds!` : 'No seeds or farmland.');
});

chatModule.registerAction('harvest', async () => {
    const harvested = await farmModule.harvest();
    if (manager.bot) manager.bot.chat(harvested > 0 ? `Harvested ${harvested} crops!` : 'Nothing to harvest.');
});

chatModule.registerAction('farm_cycle', async () => {
    const { harvested, planted } = await farmModule.farmCycle();
    if (manager.bot) manager.bot.chat(`Farm cycle: harvested ${harvested}, replanted ${planted}`);
});

// ─── Exploration ────────────────────────────────────────────────
chatModule.registerAction('explore', async () => {
    const result = await explorationModule.explore(15);
    if (manager.bot) manager.bot.chat(`Explored ${result.chunksExplored} chunks, found ${result.poisFound} POIs!`);
});

chatModule.registerAction('scan_area', async () => {
    const pois = await explorationModule.scanForPOIs();
    if (manager.bot) manager.bot.chat(pois > 0 ? `Found ${pois} points of interest!` : 'Nothing special nearby.');
});

chatModule.registerAction('set_home', async () => {
    if (!manager.bot) return;
    const { Vec3 } = require('vec3');
    const pos = manager.bot.entity.position;
    explorationModule.setHome(new Vec3(pos.x, pos.y, pos.z));
    manager.bot.chat(`Home set at (${Math.floor(pos.x)}, ${Math.floor(pos.y)}, ${Math.floor(pos.z)})!`);
});

chatModule.registerAction('exploration_info', async () => {
    if (manager.bot) manager.bot.chat(explorationModule.getSummary());
});

// ─── Progression ────────────────────────────────────────────────
chatModule.registerAction('progress', async () => {
    progressionModule.run();
    if (manager.bot) manager.bot.chat('Starting progression — will gather, craft, and mine my way up!');
});

chatModule.registerAction('stop_progress', async () => {
    progressionModule.stop();
    if (manager.bot) manager.bot.chat('Stopped progression.');
});

// ─── Meta ───────────────────────────────────────────────────────
chatModule.registerAction('set_mode', async (target) => {
    if (target) {
        const modeMap: Record<string, Mode> = {
            'full_auto': Mode.FULL_AUTO,
            'half_auto': Mode.HALF_AUTO,
            'passive': Mode.PASSIVE,
            'auto': Mode.FULL_AUTO,
            'manual': Mode.PASSIVE,
            'off': Mode.PASSIVE,
        };
        const newMode = modeMap[target.toLowerCase()];
        if (newMode) {
            manager.modeManager.setMode(newMode);

            // Stop progression if moving away from FULL_AUTO
            if (newMode !== Mode.FULL_AUTO) {
                progressionModule.stop();
                miningModule.stopMining();
            }

            // Start progression if moving to FULL_AUTO
            if (newMode === Mode.FULL_AUTO) {
                setTimeout(() => {
                    progressionModule.run().catch(() => { });
                }, 1000);
            }

            if (manager.bot) manager.bot.chat(`Mode set to ${newMode}`);
        } else {
            if (manager.bot) manager.bot.chat(`Unknown mode: ${target}. Try: full_auto, half_auto, passive`);
        }
    }
});

chatModule.registerAction('status', async () => {
    if (!manager.bot) return;
    const mode = manager.modeManager.getMode();
    const task = manager.taskEngine.getCurrentTaskName();
    const hp = Math.round(manager.bot.health);
    const food = Math.round(manager.bot.food);
    const stage = progressionModule.getCurrentStage();
    const stashes = manager.database.getStashes().length;
    const perf = perfMonitor.getStatusString();
    manager.bot.chat(
        `Mode: ${mode} | HP: ${hp}/20 | Food: ${food}/20 | Task: ${task || 'idle'}` +
        (stage ? ` | Stage: ${stage}` : '') +
        ` | Stashes: ${stashes}`
    );
    manager.bot.chat(`Perf: ${perf}`);
});

chatModule.registerAction('backup', async () => {
    backupManager.createBackup();
    if (manager.bot) manager.bot.chat('Backup created!');
});

chatModule.registerAction('recovery_info', async () => {
    if (manager.bot) manager.bot.chat(recoveryManager.getSummary());
});

chatModule.registerAction('perf', async () => {
    if (manager.bot) manager.bot.chat(perfMonitor.getStatusString());
});

// ─── Self-Progression (FULL_AUTO) ───────────────────────────────
manager.eventBus.on('state:change', ({ to }: { from: string; to: string }) => {
    if (to === 'IDLE' && manager.modeManager.isFullAuto()) {
        recoveryManager.markCleanStart();
        setTimeout(() => startAutonomousLoop(), 5000);
    }
});

async function startAutonomousLoop(): Promise<void> {
    if (!manager.bot || !manager.modeManager.isFullAuto()) return;
    if (manager.taskEngine.getCurrentTaskName()) return;

    // Use the ProgressionModule for smarter sequencing
    const task: Task = {
        id: generateId(),
        name: 'Auto-Progression',
        priority: TaskPriority.AUTONOMOUS,
        category: TaskCategory.MINE,
        requiresConfirmation: false,
        retries: 0,
        maxRetries: 1,
        timeoutMs: 300000, // 5 minutes
        execute: async () => { await progressionModule.run(); },
        cancel: async () => {
            progressionModule.stop();
            miningModule.stopMining();
            navModule.stop();
        },
    };

    await manager.taskEngine.submit(task);
}

// ─── Start ──────────────────────────────────────────────────────
manager.start().catch((e) => {
    logger.error('Main', `Fatal startup error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
});

// ─── Graceful Shutdown ──────────────────────────────────────────
process.on('SIGINT', async () => {
    logger.info('Main', 'Received SIGINT, shutting down...');
    recoveryManager.saveState({
        reason: 'shutdown',
        taskName: manager.taskEngine.getCurrentTaskName(),
        position: manager.bot ? {
            x: Math.floor(manager.bot.entity.position.x),
            y: Math.floor(manager.bot.entity.position.y),
            z: Math.floor(manager.bot.entity.position.z),
        } : null,
    });
    perfMonitor.stop();
    configHotReload.stop();
    backupManager.stop();
    backupManager.createBackup();
    await manager.stop();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    logger.info('Main', 'Received SIGTERM, shutting down...');
    perfMonitor.stop();
    configHotReload.stop();
    backupManager.stop();
    await manager.stop();
    process.exit(0);
});

process.on('uncaughtException', (err) => {
    logger.error('Main', `Uncaught exception: ${err.message}`);
    logger.error('Main', err.stack || '');
    try {
        recoveryManager.saveState({
            reason: 'crash',
            taskName: manager.taskEngine.getCurrentTaskName(),
            position: manager.bot ? {
                x: Math.floor(manager.bot.entity.position.x),
                y: Math.floor(manager.bot.entity.position.y),
                z: Math.floor(manager.bot.entity.position.z),
            } : null,
        });
        manager.database.saveState({});
    } catch (_) { }
});

process.on('unhandledRejection', (reason) => {
    logger.error('Main', `Unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`);
});
