// ============================================================
// Minecraft AI Chat Bot — AI-Driven Action System
// The AI brain decides what actions to take based on chat
// ============================================================

const mineflayer = require('mineflayer');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');

// ─── Patch: Register 1.21.11 support using 1.21.10 data ─────
const mcDataLib = require('minecraft-data');
const mcpc = mcDataLib.versions.pc;
const base = mcpc.find(v => v.minecraftVersion === '1.21.1');
if (base) {
    // Patch 1.21.11 (Bedrock/Custom?)
    if (!mcpc.find(v => v.minecraftVersion === '1.21.11')) {
        const patched = { ...base, minecraftVersion: '1.21.11', version: 774 };
        mcpc.push(patched);
        mcDataLib.supportedVersions.pc.push('1.21.11');
        if (mcDataLib.versionsByMinecraftVersion?.pc) mcDataLib.versionsByMinecraftVersion.pc['1.21.11'] = patched;
        // if (mcDataLib.postNettyVersionsByProtocolVersion?.pc) mcDataLib.postNettyVersionsByProtocolVersion.pc[774] = [patched];
    }
    // Patch 1.21.2, 1.21.3, 1.21.4 (Nether update tweaks etc, often protocol compatible or close enough for bots)
    ['1.21.2', '1.21.3', '1.21.4'].forEach(ver => {
        if (!mcpc.find(v => v.minecraftVersion === ver)) {
            const p = { ...base, minecraftVersion: ver, version: base.version }; // reuse 1.21.1 protocol for now
            mcpc.push(p);
            mcDataLib.supportedVersions.pc.push(ver);
            if (mcDataLib.versionsByMinecraftVersion?.pc) mcDataLib.versionsByMinecraftVersion.pc[ver] = p;
        }
    });
    console.log('[Patch] Registered 1.21.x variants for ViaFabric/ViaVersion compatibility.');
}

// ─── Configuration ──────────────────────────────────────────
const API_KEY = 'YOUR_GOOGLE_API_KEY_HERE';
const GROQ_API_KEY = 'YOUR_GROQ_API_KEY_HERE';
const BOT_USERNAME = 'AIBot';
const SERVER_HOST = 'peak.progamer.me';
const SERVER_PORT = 25565;

// Best-to-Worst Fallback List (Google + Groq)
const MODELS = [
    // ─── TIER 1: Heavy Hitters (Logic & Reasoning) ───
    'llama-3.3-70b-versatile',          // Groq: High intelligence
    'openai/gpt-oss-120b',              // Groq: Large context/param
    'qwen/qwen3-32b',                   // Groq: Strong code/logic
    'gemini-3-flash-preview',                 // Google: Reliable workhorse

    // ─── TIER 2: Fast & Smart (Mid-range) ───
    'meta-llama/llama-4-maverick-17b-128e-instruct', // Groq: New Llama 4
    'meta-llama/llama-4-scout-17b-16e-instruct',     // Groq: New Llama 4
    'llama-3.1-8b-instant',             // Groq: Very fast
    'gemini-2.5-flash',            // Google: Fast fallback
    'openai/gpt-oss-20b',               // Groq: Balanced

    // ─── TIER 3: Specialized & Experimental ───
    'moonshotai/kimi-k2-instruct',      // Groq
    'moonshotai/kimi-k2-instruct-0905', // Groq
    'allam-2-7b',                       // Groq
    'groq/compound',                    // Groq
    'groq/compound-mini',               // Groq
    'gemini-2.5-flash-lite',         // Google
    'gemma-3-27b-it',                   // Google
    'gemma-3-12b-it',                   // Google
    'gemma-3-7b-it',                    // Google
    'gemma-3-4b-it',                    // Google
    'openai/gpt-oss-safeguard-20b',     // Groq: Guard model
    'meta-llama/llama-guard-4-12b',     // Groq: Guard model
    'meta-llama/llama-prompt-guard-2-22m', // Groq
    'meta-llama/llama-prompt-guard-2-86m'  // Groq
];

const genAI = new GoogleGenerativeAI(API_KEY);
const Groq = require('groq-sdk');
const groq = new Groq({ apiKey: GROQ_API_KEY });

// ─── AI Request with Multi-Provider Fallback ────────────────
async function askAI(prompt, retries = 1) {
    for (let attempt = 0; attempt <= retries; attempt++) {
        for (const modelName of MODELS) {
            try {
                let text = '';

                // ROUTING: Google vs Groq
                if (modelName.startsWith('gemini') || modelName.startsWith('gemma')) {
                    // GOOGLE GEMINI
                    const model = genAI.getGenerativeModel({
                        model: modelName,
                        generationConfig: { maxOutputTokens: 256, temperature: 0.7 },
                    });
                    const result = await model.generateContent(prompt);
                    text = result.response.text();
                } else {
                    // GROQ (Llama, Mixtral, Qwen, etc)
                    // Note: Groq uses OpenAI-compatible chat completions
                    const completion = await groq.chat.completions.create({
                        messages: [{ role: 'user', content: prompt }],
                        model: modelName,
                        max_tokens: 256,
                        temperature: 0.7,
                    });
                    text = completion.choices[0]?.message?.content || '';
                }

                // Validate JSON response
                if (text && text.includes('{') && text.includes('}')) {
                    console.log(`[AI] Success with ${modelName}`);
                    return text;
                }
                // console.warn(`[AI] ${modelName} invalid response (no JSON).`);
            } catch (err) {
                // console.warn(`[AI] ${modelName} failed: ${err.message?.substring(0, 50)}...`);
                continue; // Try next model immediately
            }
        }
    }
    return '{"action":"none","message":"My brain is offline (all models failed)."}';
}

// ─── Action Registry ────────────────────────────────────────
// All actions the bot can perform, organized by category.
// The AI sees the name + description and picks the right one.
function buildActionHandlers(bot) {
    const handlers = {};
    bot.isMining = false;
    bot.miningTarget = null;


    // Helper: find player entity
    const getPlayer = (name) => {
        const p = bot.players[name];
        return p?.entity ?? null;
    };
    const getNearestEntity = (type) => {
        return bot.nearestEntity(e => {
            if (e === bot.entity) return false;
            const eName = (e.name || e.displayName || '').toLowerCase();
            const eKind = (e.entityType || e.mobType || e.type || '').toString().toLowerCase();
            if (type === 'hostile') return e.type === 'hostile' || e.kind === 'Hostile mobs';
            if (type === 'animal') return e.type === 'animal' || e.kind === 'Passive mobs' || e.kind === 'Tameable mobs';
            if (type === 'player') return e.type === 'player';
            // Fuzzy match by name
            const search = type.toLowerCase().replace(/s$/, ''); // remove trailing 's' for plural
            return eName.includes(search) || eKind.includes(search) || (e.displayName || '').toLowerCase().includes(search);
        });
    };

    // ────────────── MOVEMENT ──────────────
    handlers.follow_player = {
        desc: "Follow a player and keep following them wherever they go",
        fn: (target) => {
            const entity = getPlayer(target);
            if (entity) {
                bot.pathfinder.setGoal(new goals.GoalFollow(entity, 2), true);
                return true;
            }
            return false;
        }
    };
    handlers.go_to_player = {
        desc: "Walk to a player's current position (one-time, not continuous)",
        fn: (target) => {
            const entity = getPlayer(target);
            if (entity) {
                const p = entity.position;
                bot.pathfinder.setGoal(new goals.GoalNear(p.x, p.y, p.z, 2));
                return true;
            }
            return false;
        }
    };
    handlers.stop = {
        desc: "Stop all movement, digging, and actions immediately",
        fn: () => {
            bot.pathfinder.stop();
            try { bot.stopDigging(); } catch (e) { }
            bot.clearControlStates();
            bot.isMining = false;
            bot.miningTarget = null;
            return true;
        }
    };
    handlers.jump = {
        desc: "Jump once",
        fn: () => { bot.setControlState('jump', true); setTimeout(() => bot.setControlState('jump', false), 500); return true; }
    };
    handlers.start_sprinting = {
        desc: "Start sprinting/running fast",
        fn: () => { bot.setControlState('sprint', true); return true; }
    };
    handlers.stop_sprinting = {
        desc: "Stop sprinting, return to walking speed",
        fn: () => { bot.setControlState('sprint', false); return true; }
    };
    handlers.sneak = {
        desc: "Start sneaking/crouching",
        fn: () => { bot.setControlState('sneak', true); return true; }
    };
    handlers.stand_up = {
        desc: "Stop sneaking, stand back up",
        fn: () => { bot.setControlState('sneak', false); return true; }
    };
    handlers.move_forward = {
        desc: "Walk forward for a few seconds",
        fn: () => { bot.setControlState('forward', true); setTimeout(() => bot.setControlState('forward', false), 3000); return true; }
    };
    handlers.move_backward = {
        desc: "Walk backward for a few seconds",
        fn: () => { bot.setControlState('back', true); setTimeout(() => bot.setControlState('back', false), 3000); return true; }
    };
    handlers.move_left = {
        desc: "Strafe left for a few seconds",
        fn: () => { bot.setControlState('left', true); setTimeout(() => bot.setControlState('left', false), 3000); return true; }
    };
    handlers.move_right = {
        desc: "Strafe right for a few seconds",
        fn: () => { bot.setControlState('right', true); setTimeout(() => bot.setControlState('right', false), 3000); return true; }
    };
    handlers.go_to_coordinates = {
        desc: "Walk to specific x, y, z coordinates (target should be 'x,y,z' like '100,64,-200')",
        fn: (target) => {
            const parts = target.split(',').map(Number);
            if (parts.length === 3 && parts.every(n => !isNaN(n))) {
                bot.pathfinder.setGoal(new goals.GoalNear(parts[0], parts[1], parts[2], 2));
                return true;
            }
            return false;
        }
    };
    handlers.run_away = {
        desc: "Run away from the player or danger, move in the opposite direction",
        fn: (target) => {
            const entity = getPlayer(target);
            if (entity) {
                const p = entity.position;
                const bp = bot.entity.position;
                const dx = bp.x - p.x;
                const dz = bp.z - p.z;
                const dist = Math.sqrt(dx * dx + dz * dz) || 1;
                const fx = bp.x + (dx / dist) * 30;
                const fz = bp.z + (dz / dist) * 30;
                bot.pathfinder.setGoal(new goals.GoalNear(fx, bp.y, fz, 2));
            }
            return true;
        }
    };

    // ────────────── LOOKING ──────────────
    handlers.look_at_player = {
        desc: "Turn to look directly at a player",
        fn: (target) => {
            const entity = getPlayer(target);
            if (entity) { bot.lookAt(entity.position.offset(0, 1.6, 0)); return true; }
            return false;
        }
    };
    handlers.look_up = {
        desc: "Look straight up at the sky",
        fn: () => { bot.look(bot.entity.yaw, -Math.PI / 2, false); return true; }
    };
    handlers.look_down = {
        desc: "Look straight down at the ground",
        fn: () => { bot.look(bot.entity.yaw, Math.PI / 2, false); return true; }
    };
    handlers.look_north = {
        desc: "Turn to face north",
        fn: () => { bot.look(Math.PI, 0, false); return true; }
    };
    handlers.look_south = {
        desc: "Turn to face south",
        fn: () => { bot.look(0, 0, false); return true; }
    };
    handlers.look_east = {
        desc: "Turn to face east",
        fn: () => { bot.look(-Math.PI / 2, 0, false); return true; }
    };
    handlers.look_west = {
        desc: "Turn to face west",
        fn: () => { bot.look(Math.PI / 2, 0, false); return true; }
    };

    // ────────────── EMOTES / SOCIAL ──────────────
    handlers.nod_yes = {
        desc: "Nod head up and down to say yes or agree",
        fn: () => {
            let i = 0;
            const iv = setInterval(() => { bot.look(bot.entity.yaw, i % 2 === 0 ? -0.5 : 0.5, false); i++; if (i > 5) clearInterval(iv); }, 200);
            return true;
        }
    };
    handlers.shake_head_no = {
        desc: "Shake head left and right to say no or disagree",
        fn: () => {
            let i = 0;
            const base = bot.entity.yaw;
            const iv = setInterval(() => { bot.look(base + (i % 2 === 0 ? 0.5 : -0.5), 0, false); i++; if (i > 5) clearInterval(iv); }, 200);
            return true;
        }
    };
    handlers.wave = {
        desc: "Wave at someone by crouching and uncrouching rapidly",
        fn: () => {
            let i = 0;
            const iv = setInterval(() => { bot.setControlState('sneak', i % 2 === 0); i++; if (i > 7) { clearInterval(iv); bot.setControlState('sneak', false); } }, 250);
            return true;
        }
    };
    handlers.dance = {
        desc: "Dance by jumping and spinning around happily",
        fn: () => {
            let i = 0;
            const iv = setInterval(() => {
                bot.setControlState('jump', true);
                bot.look(bot.entity.yaw + 1, 0, false);
                i++;
                if (i > 15) { clearInterval(iv); bot.setControlState('jump', false); }
            }, 250);
            return true;
        }
    };
    handlers.spin = {
        desc: "Spin around in circles",
        fn: () => {
            let i = 0;
            const iv = setInterval(() => { bot.look(bot.entity.yaw + 0.8, 0, false); i++; if (i > 25) clearInterval(iv); }, 100);
            return true;
        }
    };
    handlers.celebrate = {
        desc: "Celebrate by jumping and spinning excitedly",
        fn: () => {
            handlers.dance.fn();
            return true;
        }
    };
    handlers.sit_down = {
        desc: "Sit down (crouch and stay crouched)",
        fn: () => { bot.setControlState('sneak', true); return true; }
    };

    // ────────────── COMBAT ──────────────
    // Helper: chase and repeatedly attack a target entity
    const startCombat = (entity, label) => {
        if (!entity) return false;
        console.log(`[Combat] Attacking ${label || entity.name || entity.displayName}`);
        // Follow the target closely
        bot.pathfinder.setGoal(new goals.GoalFollow(entity, 2), true);
        // Attack loop: look at and hit the target every 600ms
        const attackLoop = setInterval(() => {
            if (!entity || !entity.isValid) {
                clearInterval(attackLoop);
                bot.pathfinder.stop();
                console.log('[Combat] Target is dead or gone');
                return;
            }
            // Look at the target
            bot.lookAt(entity.position.offset(0, entity.height * 0.8, 0));
            // Only attack if within reach (~4 blocks)
            if (bot.entity.position.distanceTo(entity.position) < 4.5) {
                bot.attack(entity);
            }
        }, 600);
        // Safety timeout: stop after 30 seconds
        setTimeout(() => { clearInterval(attackLoop); }, 30000);
        return true;
    };

    handlers.attack_nearest_mob = {
        desc: "Attack the nearest hostile mob (zombie, skeleton, spider, creeper, etc.) - chases and fights it",
        fn: () => startCombat(getNearestEntity('hostile'), 'hostile mob')
    };
    handlers.attack_nearest_animal = {
        desc: "Attack the nearest animal (cow, pig, sheep, chicken, llama, horse, etc.) - chases and fights it",
        fn: () => startCombat(getNearestEntity('animal'), 'animal')
    };
    handlers.attack_entity = {
        desc: "Attack a specific type of entity/mob by name (target = mob name like 'llama', 'zombie', 'cow', 'spider') - chases and fights it",
        fn: (target) => {
            const entity = getNearestEntity(target);
            return startCombat(entity, target);
        }
    };
    handlers.attack_player = {
        desc: "Attack a specific player by name (PvP) - chases and fights them",
        fn: (target) => {
            const entity = getPlayer(target);
            return startCombat(entity, target);
        }
    };
    handlers.kill_all_nearby = {
        desc: "Attack and kill all nearby mobs or animals in the area",
        fn: () => {
            const mob = bot.nearestEntity(e => e !== bot.entity && (e.type === 'hostile' || e.type === 'animal' || e.kind === 'Hostile mobs' || e.kind === 'Passive mobs'));
            return startCombat(mob, 'nearest entity');
        }
    };
    handlers.shield = {
        desc: "Raise shield to block attacks (use item in offhand)",
        fn: () => { bot.activateItem(true); return true; }
    };
    handlers.stop_shield = {
        desc: "Lower shield and stop blocking",
        fn: () => { bot.deactivateItem(); return true; }
    };

    // ────────────── MINING / DIGGING ──────────────
    handlers.dig_below = {
        desc: "Dig/mine the block directly below the bot's feet",
        fn: async () => {
            const block = bot.blockAt(bot.entity.position.offset(0, -1, 0));
            if (block && block.name !== 'air') { try { await bot.dig(block); } catch (e) { } return true; }
            return false;
        }
    };
    handlers.dig_forward = {
        desc: "Dig/mine the block directly in front of the bot",
        fn: async () => {
            const dir = bot.entity.position.offset(
                -Math.sin(bot.entity.yaw), 0, -Math.cos(bot.entity.yaw)
            ).floor();
            const block = bot.blockAt(dir);
            if (block && block.name !== 'air') { try { await bot.dig(block); } catch (e) { } return true; }
            return false;
        }
    };
    handlers.dig_above = {
        desc: "Dig/mine the block directly above the bot's head",
        fn: async () => {
            const block = bot.blockAt(bot.entity.position.offset(0, 2, 0));
            if (block && block.name !== 'air') { try { await bot.dig(block); } catch (e) { } return true; }
            return false;
        }
    };

    // ────────────── INVENTORY / ITEMS ──────────────
    handlers.list_inventory = {
        desc: "List all items in the bot's inventory and tell the player",
        fn: () => {
            const items = bot.inventory.items();
            if (items.length === 0) return 'empty_inventory';
            const list = items.map(i => `${i.name} x${i.count}`).join(', ');
            bot.chat(`My inventory: ${list}`);
            return 'skip_chat';
        }
    };
    handlers.drop_held_item = {
        desc: "Drop/throw the currently held item on the ground",
        fn: () => {
            const item = bot.heldItem;
            if (item) { bot.tossStack(item); return true; }
            return false;
        }
    };
    handlers.drop_all_items = {
        desc: "Drop/throw all items from inventory on the ground",
        fn: async () => {
            const items = bot.inventory.items();
            for (const item of items) { try { await bot.tossStack(item); } catch (e) { } }
            return true;
        }
    };
    handlers.equip_sword = {
        desc: "Equip the best sword from inventory",
        fn: async () => {
            const sword = bot.inventory.items().find(i => i.name.includes('sword'));
            if (sword) { try { await bot.equip(sword, 'hand'); } catch (e) { } return true; }
            return false;
        }
    };
    handlers.equip_pickaxe = {
        desc: "Equip the best pickaxe from inventory",
        fn: async () => {
            const pick = bot.inventory.items().find(i => i.name.includes('pickaxe'));
            if (pick) { try { await bot.equip(pick, 'hand'); } catch (e) { } return true; }
            return false;
        }
    };
    handlers.equip_axe = {
        desc: "Equip an axe from inventory",
        fn: async () => {
            const axe = bot.inventory.items().find(i => i.name.includes('_axe'));
            if (axe) { try { await bot.equip(axe, 'hand'); } catch (e) { } return true; }
            return false;
        }
    };
    handlers.equip_shovel = {
        desc: "Equip a shovel from inventory",
        fn: async () => {
            const shovel = bot.inventory.items().find(i => i.name.includes('shovel'));
            if (shovel) { try { await bot.equip(shovel, 'hand'); } catch (e) { } return true; }
            return false;
        }
    };
    handlers.equip_armor = {
        desc: "Equip all available armor pieces from inventory",
        fn: async () => {
            const armorSlots = ['head', 'torso', 'legs', 'feet'];
            const armorNames = ['helmet', 'chestplate', 'leggings', 'boots'];
            for (let i = 0; i < 4; i++) {
                const piece = bot.inventory.items().find(item => item.name.includes(armorNames[i]));
                if (piece) { try { await bot.equip(piece, armorSlots[i]); } catch (e) { } }
            }
            return true;
        }
    };
    handlers.unequip_armor = {
        desc: "Remove all armor pieces",
        fn: async () => {
            try { await bot.unequip('head'); } catch (e) { }
            try { await bot.unequip('torso'); } catch (e) { }
            try { await bot.unequip('legs'); } catch (e) { }
            try { await bot.unequip('feet'); } catch (e) { }
            return true;
        }
    };
    handlers.hold_item = {
        desc: "Hold/equip a specific item by name from inventory (target = item name like 'diamond_sword')",
        fn: async (target) => {
            const item = bot.inventory.items().find(i => i.name.includes(target.replace(/ /g, '_')));
            if (item) { try { await bot.equip(item, 'hand'); } catch (e) { } return true; }
            return false;
        }
    };

    // ────────────── SURVIVAL ──────────────
    handlers.eat_food = {
        desc: "Eat food from inventory to restore hunger",
        fn: async () => {
            const foods = ['cooked_beef', 'cooked_porkchop', 'bread', 'golden_apple', 'apple', 'cooked_chicken',
                'cooked_mutton', 'cooked_salmon', 'cooked_cod', 'baked_potato', 'cookie', 'melon_slice',
                'sweet_berries', 'carrot', 'potato', 'beetroot', 'mushroom_stew', 'rabbit_stew',
                'pumpkin_pie', 'cake', 'golden_carrot', 'dried_kelp'];
            const food = bot.inventory.items().find(i => foods.some(f => i.name.includes(f)));
            if (food) {
                try { await bot.equip(food, 'hand'); await bot.consume(); } catch (e) { }
                return true;
            }
            return false;
        }
    };
    handlers.use_held_item = {
        desc: "Use/right-click with the currently held item",
        fn: () => { bot.activateItem(); return true; }
    };
    handlers.place_block = {
        desc: "Place the held block on the ground below",
        fn: async () => {
            const held = bot.inventory.slots[bot.getEquipmentDestSlot('hand')];
            if (!held) { bot.chat("I'm not holding anything to place!"); return 'skip_chat'; }
            return await placeInventoryItem(held);
        }
    };

    // ────────────── INFORMATION ──────────────
    handlers.say_health = {
        desc: "Tell the player the bot's current health and hunger levels",
        fn: () => {
            bot.chat(`Health: ${Math.round(bot.health)}/20 | Food: ${Math.round(bot.food)}/20`);
            return 'skip_chat';
        }
    };
    handlers.say_position = {
        desc: "Tell the player the bot's current coordinates/position",
        fn: () => {
            const p = bot.entity.position;
            bot.chat(`I'm at X:${Math.round(p.x)} Y:${Math.round(p.y)} Z:${Math.round(p.z)}`);
            return 'skip_chat';
        }
    };
    handlers.list_nearby_players = {
        desc: "List all players that are currently nearby/online",
        fn: () => {
            const players = Object.keys(bot.players).filter(n => n !== bot.username);
            bot.chat(players.length > 0 ? `Nearby players: ${players.join(', ')}` : 'No other players nearby.');
            return 'skip_chat';
        }
    };
    handlers.list_nearby_mobs = {
        desc: "List all mobs/entities that are nearby",
        fn: () => {
            const entities = Object.values(bot.entities)
                .filter(e => e !== bot.entity && e.type !== 'object' && e.position.distanceTo(bot.entity.position) < 30)
                .map(e => e.displayName || e.name || e.type)
                .slice(0, 15);
            bot.chat(entities.length > 0 ? `Nearby: ${entities.join(', ')}` : 'No mobs nearby.');
            return 'skip_chat';
        }
    };
    handlers.say_time = {
        desc: "Tell the player what time it is in the Minecraft world (day or night)",
        fn: () => {
            const time = bot.time.timeOfDay;
            const period = time < 6000 ? 'morning' : time < 12000 ? 'afternoon' : time < 18000 ? 'evening' : 'night';
            bot.chat(`It's ${period} (tick ${time})`);
            return 'skip_chat';
        }
    };
    handlers.say_held_item = {
        desc: "Tell the player what item the bot is currently holding",
        fn: () => {
            const item = bot.heldItem;
            bot.chat(item ? `I'm holding: ${item.displayName || item.name} x${item.count}` : "I'm not holding anything.");
            return 'skip_chat';
        }
    };
    handlers.count_item = {
        desc: "Count how many of a specific item the bot has (target = item name)",
        fn: (target) => {
            const searchName = target.replace(/ /g, '_').toLowerCase();
            const count = bot.inventory.items().filter(i => i.name.includes(searchName)).reduce((sum, i) => sum + i.count, 0);
            bot.chat(count > 0 ? `I have ${count}x ${target}` : `I don't have any ${target}`);
            return 'skip_chat';
        }
    };
    handlers.say_biome = {
        desc: "Tell the player what biome the bot is currently in",
        fn: () => {
            try {
                const biome = bot.blockAt(bot.entity.position)?.biome;
                bot.chat(`I'm in biome: ${biome?.name || 'unknown'}`);
            } catch (e) { bot.chat("Can't determine biome."); }
            return 'skip_chat';
        }
    };
    handlers.say_weather = {
        desc: "Tell the player what the current weather is (rain, thunder, clear)",
        fn: () => {
            const weather = bot.thunderState > 0 ? 'thunderstorm' : bot.rainState > 0 ? 'raining' : 'clear';
            bot.chat(`Weather: ${weather}`);
            return 'skip_chat';
        }
    };
    handlers.say_gamemode = {
        desc: "Tell the player what gamemode the bot is in",
        fn: () => {
            const modes = ['survival', 'creative', 'adventure', 'spectator'];
            bot.chat(`Gamemode: ${modes[bot.game.gameMode] || 'unknown'}`);
            return 'skip_chat';
        }
    };
    handlers.say_experience = {
        desc: "Tell the player the bot's XP level and points",
        fn: () => {
            bot.chat(`Level: ${bot.experience.level} | XP: ${Math.round(bot.experience.progress * 100)}%`);
            return 'skip_chat';
        }
    };

    // ────────────── INTERACTION ──────────────
    handlers.activate_block_forward = {
        desc: "Right-click/activate the block in front (open door, press button, use lever, open chest, etc.)",
        fn: async () => {
            const dir = bot.entity.position.offset(
                -Math.sin(bot.entity.yaw) * 2, 0, -Math.cos(bot.entity.yaw) * 2
            ).floor();
            const block = bot.blockAt(dir);
            if (block && block.name !== 'air') { try { await bot.activateBlock(block); } catch (e) { } return true; }
            return false;
        }
    };
    handlers.sleep = {
        desc: "Try to sleep in a nearby bed",
        fn: async () => {
            const bed = bot.findBlock({ matching: b => b.name.includes('bed'), maxDistance: 10 });
            if (bed) { try { await bot.sleep(bed); } catch (e) { } return true; }
            return false;
        }
    };
    handlers.wake_up = {
        desc: "Wake up from sleeping",
        fn: () => { try { bot.wake(); } catch (e) { } return true; }
    };
    handlers.fish = {
        desc: "Start fishing with a fishing rod",
        fn: async () => {
            const rod = bot.inventory.items().find(i => i.name.includes('fishing_rod'));
            if (rod) {
                try { await bot.equip(rod, 'hand'); bot.activateItem(); } catch (e) { }
                return true;
            }
            return false;
        }
    };

    // ────────────── SPECIAL / FUN ──────────────
    handlers.do_nothing = {
        desc: "Do nothing, just respond with chat. Use this for general conversation.",
        fn: () => { return true; }
    };
    handlers.guard_player = {
        desc: "Guard/protect a player by following them and attacking nearby hostile mobs",
        fn: (target) => {
            const entity = getPlayer(target);
            if (entity) {
                bot.pathfinder.setGoal(new goals.GoalFollow(entity, 3), true);
                // Start a guard loop
                const guardInterval = setInterval(() => {
                    const mob = getNearestEntity('hostile');
                    if (mob && mob.position.distanceTo(bot.entity.position) < 8) {
                        bot.attack(mob);
                    }
                    if (!bot.players[target]?.entity) clearInterval(guardInterval);
                }, 1000);
                setTimeout(() => clearInterval(guardInterval), 120000); // Guard for 2 min max
                return true;
            }
            return false;
        }
    };
    handlers.explore = {
        desc: "Explore the area by walking to a random nearby location",
        fn: () => {
            const p = bot.entity.position;
            const rx = p.x + (Math.random() - 0.5) * 60;
            const rz = p.z + (Math.random() - 0.5) * 60;
            bot.pathfinder.setGoal(new goals.GoalNear(rx, p.y, rz, 3));
            return true;
        }
    };
    handlers.patrol = {
        desc: "Patrol around the current area in a circle pattern",
        fn: () => {
            const center = bot.entity.position.clone();
            let angle = 0;
            const iv = setInterval(() => {
                angle += Math.PI / 4;
                const x = center.x + Math.cos(angle) * 15;
                const z = center.z + Math.sin(angle) * 15;
                bot.pathfinder.setGoal(new goals.GoalNear(x, center.y, z, 2));
                if (angle >= Math.PI * 4) clearInterval(iv);
            }, 5000);
            return true;
        }
    };
    handlers.flee_from_mobs = {
        desc: "Run away from all nearby hostile mobs to safety",
        fn: () => {
            const mob = getNearestEntity('hostile');
            if (mob) {
                const p = mob.position;
                const bp = bot.entity.position;
                const dx = bp.x - p.x;
                const dz = bp.z - p.z;
                const dist = Math.sqrt(dx * dx + dz * dz) || 1;
                bot.pathfinder.setGoal(new goals.GoalNear(bp.x + (dx / dist) * 30, bp.y, bp.z + (dz / dist) * 30, 2));
                return true;
            }
            return false;
        }
    };
    handlers.mimic_player = {
        desc: "Mimic a player's position by going to where they are repeatedly",
        fn: (target) => {
            const iv = setInterval(() => {
                const entity = getPlayer(target);
                if (entity) {
                    bot.lookAt(entity.position.offset(0, 1.6, 0));
                } else {
                    clearInterval(iv);
                }
            }, 500);
            setTimeout(() => clearInterval(iv), 30000);
            return true;
        }
    };
    // ────────────── CRAFTING ──────────────
    // Wood type variants for auto-conversion
    const WOOD_TYPES = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'bamboo', 'crimson', 'warped'];

    // Helper: auto-craft planks from any logs the bot has (makes multiple batches)
    const autoCraftPlanks = async (mcData, count) => {
        // Prevent over-crafting: check if we already have enough planks
        const currentPlanks = bot.inventory.items().filter(i => i.name.includes('planks')).reduce((s, i) => s + i.count, 0);
        if (currentPlanks >= 16) return false;

        let crafted = false;
        // Craft only what's needed, not just batch loop
        const needed = (count || 3) - Math.floor(currentPlanks / 4);
        if (needed <= 0) return false;

        for (let batch = 0; batch < needed; batch++) {
            for (const wood of WOOD_TYPES) {
                const logName = wood === 'crimson' || wood === 'warped' ? `${wood}_stem` : `${wood}_log`;
                const plankName = `${wood}_planks`;
                const log = bot.inventory.items().find(i => i.name === logName || i.name === `stripped_${logName}`);
                if (log) {
                    const plankItem = mcData.itemsByName[plankName];
                    if (plankItem) {
                        const recipes = bot.recipesFor(plankItem.id, null, 1, null);
                        if (recipes && recipes.length > 0) {
                            try {
                                await bot.craft(recipes[0], 1, null);
                                console.log(`[Craft] Auto-crafted ${plankName} from ${log.name}`);
                                crafted = true;
                            } catch (e) { }
                        }
                    }
                    break;
                }
            }
        }
        return crafted;
    };

    // Helper: auto-craft sticks from planks
    const autoCraftSticks = async (mcData, count) => {
        // Prevent over-crafting
        const currentSticks = bot.inventory.items().filter(i => i.name === 'stick').reduce((s, i) => s + i.count, 0);
        if (currentSticks >= 8) return false;

        let crafted = false;
        const stickItem = mcData.itemsByName['stick'];
        if (!stickItem) return false;
        for (let i = 0; i < (count || 2); i++) {
            const recipes = bot.recipesFor(stickItem.id, null, 1, null);
            if (recipes && recipes.length > 0) {
                try { await bot.craft(recipes[0], 1, null); crafted = true; } catch (e) { break; }
            } else break;
        }
        if (crafted) console.log('[Craft] Auto-crafted sticks');
        return crafted;
    };

    // Helper: auto-craft a crafting table and place it
    const autoPlaceCraftingTable = async (mcData) => {
        const tableBlockId = mcData.blocksByName['crafting_table']?.id;
        // First check if one already exists nearby
        let existing = tableBlockId ? bot.findBlock({ matching: tableBlockId, maxDistance: 32 }) : null;
        if (existing) return existing;

        // Check availability in inventory BEFORE crafting
        let tableInv = bot.inventory.items().find(i => i.name === 'crafting_table');
        if (!tableInv) {
            // Try to craft one
            const tableItem = mcData.itemsByName['crafting_table'];
            if (!tableItem) return null;

            // Make sure we have planks (need 4)
            const plankCount = bot.inventory.items().filter(i => i.name.includes('planks')).reduce((s, i) => s + i.count, 0);
            if (plankCount < 4) {
                await autoCraftPlanks(mcData, 2);
            }

            let recipes = bot.recipesFor(tableItem.id, null, 1, null);
            if (!recipes || recipes.length === 0) return null;
            try {
                await bot.craft(recipes[0], 1, null);
                console.log('[Craft] Auto-crafted crafting table');
                // Refresh inventory
                tableInv = bot.inventory.items().find(i => i.name === 'crafting_table');
            } catch (e) { return null; }
        }

        if (!tableInv) return null;
        return await placeInventoryItem(tableInv, tableBlockId);
    };

    // Helper: Find a valid spot to place a block nearby
    const findPlacementSpot = (radius = 3) => {
        const position = bot.entity.position;
        const validSpots = [];
        const replaceable = ['air', 'grass', 'short_grass', 'tall_grass', 'fern', 'large_fern', 'dead_bush', 'vine', 'snow', 'water', 'lava'];

        for (let x = -radius; x <= radius; x++) {
            for (let z = -radius; z <= radius; z++) {
                for (let y = -1; y <= 1; y++) {
                    const offset = position.offset(x, y, z).floor();
                    const candidate = bot.blockAt(offset);
                    const above = bot.blockAt(offset.offset(0, 1, 0));

                    // Avoid placing in bot's hitbox (AABB check)
                    const bx = offset.x;
                    const by = offset.y + 1; // The block we are placing
                    const bz = offset.z;
                    const p = bot.entity.position;

                    // Bot width 0.6 (radius 0.3), Height 1.8
                    const intersectX = (bx < p.x + 0.4) && (bx + 1 > p.x - 0.4); // slightly expanded 0.3->0.4 padding
                    const intersectZ = (bz < p.z + 0.4) && (bz + 1 > p.z - 0.4);
                    const intersectY = (by < p.y + 1.8) && (by + 1 > p.y);

                    if (intersectX && intersectZ && intersectY) continue;

                    if (candidate && candidate.boundingBox === 'block' && above && (above.name === 'air' || replaceable.includes(above.name))) {
                        validSpots.push({ ref: candidate, face: { x: 0, y: 1, z: 0 }, pos: offset.offset(0, 1, 0) });
                    }
                }
            }
        }
        validSpots.sort((a, b) => a.pos.distanceTo(position) - b.pos.distanceTo(position));
        return validSpots[0] || null;
    };

    // Helper: Equip and place an item from inventory
    const placeInventoryItem = async (item, blockId) => {
        const spot = findPlacementSpot(3);
        if (!spot) {
            console.log(`[Place] No valid spot for ${item.name}`);
            return null;
        }

        try {
            await bot.equip(item, 'hand');
            await bot.lookAt(spot.pos);
            await bot.placeBlock(spot.ref, spot.face);
            await new Promise(r => setTimeout(r, 500));
            return blockId ? bot.findBlock({ matching: blockId, maxDistance: 5 }) : true;
        } catch (e) {
            console.log(`[Place] Error placing ${item.name}: ${e.message}`);
            return null;
        }
    };

    // Helper: Pillar up (jump + place) to reach higher places
    const pillarUp = async (height) => {
        const h = parseInt(height) || 1;

        // Find blocks (cobble, dirt, planks, stone, netherrack)
        const allowed = ['cobblestone', 'dirt', 'stone', 'oak_planks', 'spruce_planks', 'birch_planks', 'netherrack', 'andesite', 'diorite', 'granite'];
        const item = bot.inventory.items().find(i => allowed.some(a => i.name.includes(a)));

        if (!item) {
            console.log("[Pillar] No blocks to pillar with.");
            return false;
        }

        console.log(`[Pillar] Pillaring up ${h} blocks with ${item.name}`);
        await bot.equip(item, 'hand');

        // Look straight down
        await bot.look(bot.entity.yaw, -Math.PI / 2, true);

        for (let i = 0; i < h; i++) {
            const startY = bot.entity.position.y;
            try {
                bot.setControlState('jump', true);

                // Wait to jump high enough
                let loops = 0;
                while (bot.entity.position.y < startY + 1.1) {
                    await new Promise(r => setTimeout(r, 10));
                    loops++;
                    if (loops > 200) break; // timeout
                }

                // Place block below
                const targetPos = bot.entity.position.offset(0, -1, 0).floor();
                const blockBelow = bot.blockAt(targetPos.offset(0, -1, 0));

                if (blockBelow) {
                    await bot.placeBlock(blockBelow, { x: 0, y: 1, z: 0 });
                }

                // Wait to verify we are on top
                bot.setControlState('jump', false);
                await new Promise(r => setTimeout(r, 250));
            } catch (e) {
                console.log(`[Pillar] Failed step: ${e.message}`);
                bot.setControlState('jump', false);
                return false;
            }
        }
        return true;
    };

    // Helper: manually scan for a block by name in a radius (bot.findBlock can be unreliable)
    const findBlockManual = (testFn, maxDist = 32) => {
        const pos = bot.entity.position;
        let closest = null;
        let closestDist = Infinity;
        for (let x = -maxDist; x <= maxDist; x++) {
            for (let z = -maxDist; z <= maxDist; z++) {
                for (let y = -10; y <= 30; y++) {
                    const block = bot.blockAt(pos.offset(x, y, z));
                    if (block && testFn(block)) {
                        const d = pos.distanceTo(block.position);
                        if (d < closestDist) {
                            closestDist = d;
                            closest = block;
                        }
                    }
                }
            }
        }
        return closest;
    };

    // Helper: Equip the best tool for a given block
    const equipBestTool = async (block) => {
        const items = bot.inventory.items();
        let best = null;

        // Helper to sort tools by tier (Netherite > Diamond > Iron > Stone > Wood > Gold)
        const getBestTier = (tools) => {
            if (!tools || tools.length === 0) return null;
            // Order: Diamond > Iron > Stone > Wooden > Gold
            const order = ['netherite', 'diamond', 'iron', 'stone', 'wooden', 'gold'];
            return tools.sort((a, b) => {
                const aTier = order.findIndex(t => a.name.includes(t));
                const bTier = order.findIndex(t => b.name.includes(t));
                return aTier - bTier; // Lower index = better
            })[0];
        };

        // 1. Check harvest tools
        const blockDef = bot.registry.blocksByName[block.name];
        if (blockDef && blockDef.harvestTools) {
            const tools = items.filter(i => blockDef.harvestTools[i.type]);
            best = getBestTier(tools);
        }

        // 2. Fallback: Name-based partial matching
        if (!best) {
            if (block.name.endsWith('_log') || block.name.endsWith('_stem') || block.name.includes('planks') || block.name.includes('_wood') || block.name.includes('crafting_table')) {
                const axes = items.filter(i => i.name.endsWith('_axe'));
                // console.log(`[Debug] Looking for axe for ${block.name}. Found: ${axes.map(i => i.name).join(', ')}`);
                best = getBestTier(axes);
            } else if (['dirt', 'grass_block', 'gravel', 'sand', 'clay', 'snow', 'soul_sand', 'soul_soil'].some(n => block.name.includes(n))) {
                best = getBestTier(items.filter(i => i.name.endsWith('_shovel')));
            } else if (block.name.includes('leaves') || block.name.includes('cobweb') || block.name.includes('wool')) {
                best = items.find(i => i.name === 'shears') || getBestTier(items.filter(i => i.name.endsWith('_hoe')));
            } else if (['ore', 'stone', 'cobblestone', 'andesite', 'diorite', 'granite', 'deepslate', 'netherrack', 'end_stone'].some(n => block.name.includes(n))) {
                // Catch-all for rocky stuff if harvestTools failed
                best = getBestTier(items.filter(i => i.name.endsWith('_pickaxe')));
            }
        }

        if (best) {
            // Check if already equipped
            const held = bot.inventory.slots[bot.getEquipmentDestSlot('hand')];
            if (held && held.name === best.name) return true;
            try {
                console.log(`[Equip] Equipping ${best.name} for ${block.name}`);
                await bot.equip(best, 'hand');
                return true;
            } catch (e) {
                console.log(`[Equip] Failed to equip ${best.name}: ${e.message}`);
                return false;
            }
        } else {
            // LOG WHY WE FAILED
            if (block.name.endsWith('_log')) {
                console.log(`[Equip] No axe found for ${block.name}. Inventory has: ${items.map(i => i.name).join(', ')}`);
            }

            // IMPORTANT: If no best tool was found, check if we are holding something "wrong"
            // that shouldn't be used for this block (e.g. shovel for stone)
            const held = bot.inventory.slots[bot.getEquipmentDestSlot('hand')];
            if (held) {
                const isRocky = ['ore', 'stone', 'cobblestone', 'andesite', 'diorite', 'granite', 'deepslate', 'netherrack', 'end_stone'].some(n => block.name.includes(n));
                const isWoody = block.name.endsWith('_log') || block.name.endsWith('_stem') || block.name.includes('planks') || block.name.includes('_wood');
                const isSoil = ['dirt', 'grass_block', 'gravel', 'sand', 'clay', 'snow'].some(n => block.name.includes(n));

                let unequip = false;
                if (isRocky && (held.name.includes('_shovel') || held.name.includes('_axe') || held.name.includes('_hoe') || held.name.includes('sword'))) unequip = true;
                if (isWoody && (held.name.includes('_pickaxe') || held.name.includes('_shovel') || held.name.includes('_hoe') || held.name.includes('sword'))) unequip = true;
                if (isSoil && (held.name.includes('_pickaxe') || held.name.includes('_axe') || held.name.includes('sword'))) unequip = true;

                if (unequip) {
                    console.log(`[Equip] Unequipping ${held.name} for ${block.name} (wrong tool)`);
                    try { await bot.unequip('hand'); } catch (e) { }
                }
            }
        }
        return false;
    };

    // Helper: Ensure the bot has a suitable tool for a block, crafting one if necessary
    const ensureToolForBlock = async (block) => {
        // Try equipping existing tool first
        const hasTool = await equipBestTool(block);
        if (hasTool) return true;

        const isRocky = ['ore', 'stone', 'cobblestone', 'andesite', 'diorite', 'granite', 'deepslate', 'netherrack', 'end_stone'].some(n => block.name.includes(n));
        const isWoody = block.name.endsWith('_log') || block.name.endsWith('_stem') || block.name.includes('planks') || block.name.includes('_wood');
        const isSoil = ['dirt', 'grass_block', 'gravel', 'sand', 'clay', 'snow'].some(n => block.name.includes(n));

        if (isRocky) {
            console.log("[Tool] No pickaxe found, auto-crafting wooden pickaxe...");
            await handlers.craft_item.fn('wooden_pickaxe');
        } else if (isWoody) {
            console.log("[Tool] No axe found, auto-crafting wooden axe...");
            await handlers.craft_item.fn('wooden_axe');
        } else if (isSoil) {
            console.log("[Tool] No shovel found, auto-crafting wooden shovel...");
            await handlers.craft_item.fn('wooden_shovel');
        }

        // VERIFY: Did we actually get the tool?
        const hasToolNow = await equipBestTool(block);
        if (!hasToolNow) {
            console.log(`[Tool] Failed to obtain tool for ${block.name} even after crafting attempt.`);
            // Force a stop to prevent infinite loops
            bot.chat("I tried to craft a tool but failed! stopping.");
            return false;
        }
        return true;

        // Try equipping again after potential crafting
        return await equipBestTool(block);
    };



    // Helper: auto-chop a nearby tree to get logs
    const autoChopTree = async (mcData) => {
        // Find MULTIPLE logs to try, in case the closest one is unreachable (floating/inside something)
        const logPositions = bot.findBlocks({
            matching: (blk) => blk.name.endsWith('_log') || blk.name.endsWith('_stem'),
            maxDistance: 128, // Vastly increased range (was 32)
            count: 5 // Try up to 5 candidates
        });

        if (logPositions.length === 0) {
            // Log what blocks ARE nearby for debugging
            const pos = bot.entity.position;
            console.log(`[Debug] No logs found within 128 blocks of ${pos}`);
            bot.chat("No trees found nearby.");
            return false;
        }

        // Try each candidate
        let logBlock = null;
        for (const p of logPositions) {
            const block = bot.blockAt(p);

            // Skip logs that are visibly too high/floating effectively?
            // Simple check: if it's more than 3 blocks above feet and implies pathfinding difficulty?
            // Let pathfinder decide, but use short timeout.

            try {
                console.log(`[Chop] Trying tree at ${p}...`);
                // Move with shorter timeout to skip bad ones fast
                await Promise.race([
                    bot.pathfinder.goto(new goals.GoalNear(p.x, p.y, p.z, 2)),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Pathfinding skip')), 6000))
                ]);
                // Re-verify block exists
                if (bot.blockAt(p) && (bot.blockAt(p).name.endsWith('_log') || bot.blockAt(p).name.endsWith('_stem'))) {
                    logBlock = bot.blockAt(p);
                    break; // Found and reached one!
                }
            } catch (e) {
                console.log(`[Chop] Skipped tree at ${p}: ${e.message}`);
                // Throttle pathfinding failures to prevent spam/crash
                await new Promise(r => setTimeout(r, 1000));
            }
        }

        if (!logBlock) {
            bot.chat("I saw trees but couldn't reach any of them.");
            return false;
        }

        bot.chat(`Found a tree (${logBlock.name}) at ${logBlock.position}! Chopping...`);
        const p = logBlock.position;

        // Mark as active task
        bot.isMining = true;
        bot.miningTarget = 'tree';

        // Ensure we have an axe
        console.log(`[Chop] Ensuring tool for ${logBlock.name}`);
        const hasTool = await ensureToolForBlock(logBlock);
        if (!hasTool) {
            bot.chat("No axe found, using my fists!");
            console.log("[Chop] proceeding without tool (fallback to hand)");
            try { await bot.unequip('hand'); } catch (e) { }
        }

        // Mine the log and any logs above it (chop whole tree)
        let mined = 0;
        let currentPos = logBlock.position.clone();
        for (let i = 0; i < 10; i++) {
            if (!bot.isMining) break; // Stop if interrupted

            const block = bot.blockAt(currentPos);
            if (block && (block.name.endsWith('_log') || block.name.endsWith('_stem'))) {
                // Check reachability
                const dist = bot.entity.position.distanceTo(currentPos);
                if (dist > 4.5) {
                    console.log(`[Chop] Block at ${currentPos} is too high/far (${dist.toFixed(1)}).`);

                    // Attempt to pillar up to reach it
                    const targetFeetY = currentPos.y - 2; // Aim to be 2 blocks below target (eye levelish)
                    const climb = Math.ceil(targetFeetY - bot.entity.position.y);

                    if (climb > 0 && climb <= 6) {
                        console.log(`[Chop] Auto-pillaring up ${climb} blocks to reach log...`);
                        const climbed = await pillarUp(climb);
                        if (!climbed) {
                            console.log("[Chop] Pillar failed (no blocks?), stopping tree.");
                            break;
                        }
                    } else {
                        console.log(`[Chop] Too high to pillar safely (${climb} blocks needed). Stopping.`);
                        break;
                    }
                }

                try {
                    console.log(`[Chop] Digging ${block.name} at ${currentPos}`);
                    await ensureToolForBlock(block); // Try to equip best tool, but ignore failure

                    await bot.dig(block);
                    mined++;
                    currentPos = currentPos.offset(0, 1, 0);
                    await new Promise(r => setTimeout(r, 800));
                } catch (e) {
                    console.log(`[Chop] Dig failed: ${e.message}`);
                    break;
                }
            } else {
                break; // No more logs above
            }
        }

        // Pick up drops
        if (mined > 0) {
            bot.pathfinder.setGoal(new goals.GoalNear(p.x, p.y, p.z, 1));
            await new Promise(r => setTimeout(r, 1000));
        }

        console.log(`[Craft] Auto-chopped tree, mined ${mined} logs`);
        bot.isMining = false;
        bot.miningTarget = null;
        return mined > 0;
    };


    handlers.debug_surroundings = {
        desc: "Look around and list all blocks the bot can see nearby",
        fn: async () => {
            const pos = bot.entity.position;
            const blockMap = {};
            for (let x = -5; x <= 5; x++) {
                for (let y = -2; y <= 5; y++) {
                    for (let z = -5; z <= 5; z++) {
                        const b = bot.blockAt(pos.offset(x, y, z));
                        if (b && b.name !== 'air') {
                            blockMap[b.name] = (blockMap[b.name] || 0) + 1;
                        }
                    }
                }
            }
            const sorted = Object.entries(blockMap).sort((a, b) => b[1] - a[1]);
            const summary = sorted.map(([name, count]) => `${name} x${count}`).join(', ');
            bot.chat(`Blocks near me: ${summary}`);
            console.log(`[Debug] Surrounding blocks: ${summary}`);
            // Also check if any logs
            const hasLogs = sorted.some(([name]) => name.endsWith('_log') || name.endsWith('_stem'));
            if (hasLogs) bot.chat("I can see tree logs nearby!");
            return 'skip_chat';
        }
    };

    // Helper: Ensure the bot has materials for a recipe by gathering them autonomously
    const ensureMaterials = async (mcData, itemId) => {
        const recipes = mcData.recipes[itemId];
        if (!recipes || recipes.length === 0) return false;

        // Use all available recipes to build a list of possible ingredients
        const ingredientIds = new Set();
        for (const recipe of recipes) {
            if (recipe.inShape) {
                recipe.inShape.flat().filter(id => id !== null).forEach(id => ingredientIds.add(id));
            } else if (recipe.ingredients) {
                recipe.ingredients.forEach(id => ingredientIds.add(id));
            }
        }

        for (const id of ingredientIds) {
            const ingItem = mcData.items[id];
            if (!ingItem) continue;
            const ingName = ingItem.name;

            // Check if we have ANY valid variant for this component
            // (e.g. if we need stone, do we have cobblestone, deepslate, etc.)
            let hasAny = false;
            if (['cobblestone', 'stone', 'cobbled_deepslate', 'blackstone'].some(n => ingName.includes(n))) {
                hasAny = bot.inventory.items().some(i => ['cobblestone', 'stone', 'cobbled_deepslate', 'blackstone'].some(sn => i.name.includes(sn)));
            } else if (ingName.endsWith('_log') || ingName.endsWith('_stem') || ingName.includes('planks')) {
                hasAny = bot.inventory.items().some(i => i.name.endsWith('_log') || i.name.endsWith('_stem') || i.name.includes('planks'));
            } else {
                hasAny = bot.inventory.items().some(i => i.type === id);
            }

            if (!hasAny) {
                console.log(`[Craft] Missing ingredient similar to ${ingName}, attempting to gather...`);
                let success = true;

                if (ingName.endsWith('_log') || ingName.endsWith('_stem') || ingName.includes('planks')) {
                    if (bot.miningTarget !== 'tree') success = await autoChopTree(mcData);
                } else if (['cobblestone', 'stone', 'cobbled_deepslate', 'blackstone', 'andesite', 'diorite', 'granite'].some(n => ingName.includes(n))) {
                    if (!bot.inventory.items().some(i => i.name.includes('pickaxe'))) await craftSequence(['wooden_pickaxe']);
                    success = await autoMineOre(mcData, ['stone', 'cobblestone', 'cobbled_deepslate', 'blackstone', 'andesite', 'diorite', 'granite'], 8);
                } else if (ingName === 'coal' || ingName === 'charcoal') {
                    if (!bot.inventory.items().some(i => i.name.includes('pickaxe'))) await craftSequence(['wooden_pickaxe']);
                    success = await autoMineOre(mcData, ['coal_ore', 'deepslate_coal_ore'], 4);
                } else if (ingName === 'iron_ingot' || ingName === 'raw_iron' || ingName === 'iron_ore') {
                    if (!bot.inventory.items().some(i => i.name.includes('pickaxe'))) await craftSequence(['stone_pickaxe', 'wooden_pickaxe']);
                    success = await autoMineOre(mcData, ['iron_ore', 'deepslate_iron_ore'], 4);
                    if (success) await autoSmelt(mcData, 'raw_iron', 4);
                } else if (ingName === 'gold_ingot' || ingName === 'raw_gold' || ingName === 'gold_ore') {
                    await craft_item.fn('iron_pickaxe');
                    success = await autoMineOre(mcData, ['gold_ore', 'deepslate_gold_ore'], 4);
                    if (success) await autoSmelt(mcData, 'raw_gold', 4);
                } else if (ingName === 'diamond' || ingName === 'diamond_ore') {
                    await craft_item.fn('iron_pickaxe');
                    success = await autoMineOre(mcData, ['diamond_ore', 'deepslate_diamond_ore'], 3);
                }

                if (!success) {
                    console.log(`[Craft] Failed to gather ${ingName}, aborting ensureMaterials.`);
                    return false;
                }
            }
        }
        return true;
    };

    // Main smart crafter: auto-crafts the whole dependency chain
    const smartCraft = async (mcData, item, craftingTable) => {
        // Try up to 4 rounds of auto-crafting intermediates
        for (let attempt = 0; attempt < 4; attempt++) {
            // Try to get recipes: with table, then without
            let recipes = craftingTable ? bot.recipesFor(item.id, null, 1, craftingTable) : [];
            if (!recipes || recipes.length === 0) {
                recipes = bot.recipesFor(item.id, null, 1, null);
            }

            if (recipes && recipes.length > 0) {
                // Found a recipe we can use!
                try {
                    await bot.craft(recipes[0], 1, recipes[0].requiresTable ? craftingTable : null);
                    return true;
                } catch (e) {
                    console.log(`[Craft] Craft failed: ${e.message}`);
                }
            }

            // No recipe yet — try building intermediates
            console.log(`[Craft] Attempt ${attempt + 1}: auto-crafting intermediates...`);

            // Step -1: Ensure base materials exist (logs, stone, etc.)
            const matsOk = await ensureMaterials(mcData, item.id);
            if (!matsOk) {
                console.log("[Craft] Could not gather materials, aborting craft.");
                return false;
            }

            // Step 0: if no logs, go chop a tree (always try to get wood when crafting fails)
            const hasLogs = bot.inventory.items().some(i => i.name.endsWith('_log') || i.name.endsWith('_stem'));
            const hasPlanks = bot.inventory.items().some(i => i.name.includes('planks'));
            const hasSticks = bot.inventory.items().some(i => i.name === 'stick');

            if (!hasLogs && attempt < 2) {
                console.log("[Craft] No logs in inventory, chopping a tree...");
                if (bot.miningTarget !== 'tree') await autoChopTree(mcData);
            }

            // Step 1: logs → planks
            if (bot.inventory.items().some(i => i.name.endsWith('_log') || i.name.endsWith('_stem'))) {
                await autoCraftPlanks(mcData, 3);
            }

            // Step 2: planks → sticks
            if (bot.inventory.items().some(i => i.name.includes('planks'))) {
                await autoCraftSticks(mcData, 2);
            }

            // Step 3: if we need a crafting table, make and place one
            if (!craftingTable) {
                craftingTable = await autoPlaceCraftingTable(mcData);
            }

            // Also try wood-type variants
            for (const wood of WOOD_TYPES) {
                const variantName = item.name.replace(/^(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|bamboo|crimson|warped)_/, `${wood}_`);
                const variantItem = mcData.itemsByName[variantName];
                if (variantItem && variantItem.id !== item.id) {
                    let vRecipes = craftingTable ? bot.recipesFor(variantItem.id, null, 1, craftingTable) : [];
                    if (!vRecipes || vRecipes.length === 0) vRecipes = bot.recipesFor(variantItem.id, null, 1, null);
                    if (vRecipes && vRecipes.length > 0) {
                        try {
                            await bot.craft(vRecipes[0], 1, vRecipes[0].requiresTable ? craftingTable : null);
                            console.log(`[Craft] Used wood variant: ${variantName}`);
                            return true;
                        } catch (e) { }
                    }
                }
            }
        }
        return false;
    };

    handlers.craft_item = {
        desc: "Craft a specific item by name (target = item name like 'wooden_sword', 'crafting_table', 'stick', 'planks', 'iron_pickaxe', 'torch'). Automatically gathers wood, crafts intermediates, and places crafting tables as needed.",
        fn: async (target) => {
            const mcData = require('minecraft-data')(bot.version);
            const searchName = target.replace(/ /g, '_').toLowerCase();

            // Handle generic names — use whatever wood type the bot actually has
            let itemName = searchName;
            if (searchName === 'planks' || searchName === 'wooden_planks') {
                // First check if we already HAVE any planks
                const existingPlanks = bot.inventory.items().find(i => i.name.includes('planks'));
                if (existingPlanks) {
                    itemName = existingPlanks.name;
                } else {
                    // Check which log type we have and use that
                    for (const wood of WOOD_TYPES) {
                        const logName = wood === 'crimson' || wood === 'warped' ? `${wood}_stem` : `${wood}_log`;
                        if (bot.inventory.items().some(i => i.name === logName || i.name === `stripped_${logName}`)) {
                            itemName = `${wood}_planks`;
                            break;
                        }
                    }
                    // If no logs either, just use the first planks type — smartCraft will get wood
                    if (itemName === searchName) itemName = 'oak_planks';
                }
            }

            // Find the item in minecraft-data
            const item = mcData.itemsByName[itemName] || Object.values(mcData.itemsByName).find(i => i.name.includes(searchName));
            if (!item) { bot.chat(`I don't know what "${target}" is.`); return 'skip_chat'; }

            // Find or create a nearby crafting table
            const tableBlockId = mcData.blocksByName['crafting_table']?.id;
            let craftingTable = tableBlockId ? bot.findBlock({ matching: tableBlockId, maxDistance: 32 }) : null;

            // Walk to crafting table if found
            if (craftingTable) {
                const p = craftingTable.position;
                bot.pathfinder.setGoal(new goals.GoalNear(p.x, p.y, p.z, 2));
                await new Promise(r => setTimeout(r, 4000));
            }

            // Smart craft with auto-dependency chain
            bot.chat(`Let me try to craft ${item.displayName || item.name}...`);
            const success = await smartCraft(mcData, item, craftingTable);

            if (success) {
                bot.chat(`Crafted ${item.displayName || item.name}!`);
            } else {
                // Report what's needed
                const hasLogs = bot.inventory.items().some(i => i.name.endsWith('_log') || i.name.endsWith('_stem'));
                const hasPlanks = bot.inventory.items().some(i => i.name.includes('planks'));
                if (!hasLogs && !hasPlanks) {
                    bot.chat("I couldn't find any trees nearby to get wood!");
                } else {
                    bot.chat(`Sorry, I couldn't craft ${item.displayName || item.name}. I might be missing some materials.`);
                }
            }
            return 'skip_chat';
        }
    };

    // ────────────── COMPOUND/AUTONOMOUS ACTIONS ──────────────
    // Helper to craft multiple items in sequence
    const craftSequence = async (items) => {
        const mcData = require('minecraft-data')(bot.version);
        const tableBlockId = mcData.blocksByName['crafting_table']?.id;
        let craftingTable = tableBlockId ? bot.findBlock({ matching: tableBlockId, maxDistance: 32 }) : null;
        if (craftingTable) {
            bot.pathfinder.setGoal(new goals.GoalNear(craftingTable.position.x, craftingTable.position.y, craftingTable.position.z, 2));
            await new Promise(r => setTimeout(r, 4000));
        }
        const crafted = [];
        for (const itemName of items) {
            const item = mcData.itemsByName[itemName];
            if (!item) continue;
            // Skip if we already have one
            if (bot.inventory.items().some(i => i.name === itemName)) { crafted.push(item.displayName || item.name); continue; }
            const ok = await smartCraft(mcData, item, craftingTable);
            if (ok) {
                crafted.push(item.displayName || item.name);
                // Update crafting table reference (might have been placed)
                if (!craftingTable) craftingTable = tableBlockId ? bot.findBlock({ matching: tableBlockId, maxDistance: 32 }) : null;
            }
        }
        return crafted;
    };

    handlers.get_wooden_tools = {
        desc: "Autonomously get a full set of wooden tools (pickaxe, sword, axe, shovel). Chops trees, crafts everything automatically.",
        fn: async () => {
            bot.chat("Getting wooden tools, hang on...");
            const crafted = await craftSequence(['wooden_pickaxe', 'wooden_sword', 'wooden_axe', 'wooden_shovel']);
            bot.chat(crafted.length > 0 ? `Got: ${crafted.join(', ')}!` : "Couldn't make any tools — no trees nearby!");
            return 'skip_chat';
        }
    };
    handlers.get_stone_tools = {
        desc: "Autonomously get stone tools. Mines cobblestone if needed, crafts pickaxe, sword, axe, shovel.",
        fn: async () => {
            bot.chat("Getting stone tools...");
            const mcData = require('minecraft-data')(bot.version);
            // Make sure we have a wooden pickaxe first
            if (!bot.inventory.items().some(i => i.name.includes('pickaxe'))) {
                await craftSequence(['wooden_pickaxe']);
            }
            // Mine some cobblestone
            const stoneId = mcData.blocksByName['stone']?.id;
            const cobbleId = mcData.blocksByName['cobblestone']?.id;
            const hasCobble = bot.inventory.items().filter(i => i.name === 'cobblestone').reduce((s, i) => s + i.count, 0);
            if (hasCobble < 12) {
                const pick = bot.inventory.items().find(i => i.name.includes('pickaxe'));
                if (pick) await bot.equip(pick, 'hand');
                for (let i = 0; i < 12 - hasCobble; i++) {
                    const stone = bot.findBlock({ matching: [stoneId, cobbleId].filter(Boolean), maxDistance: 16 });
                    if (!stone) break;
                    try {
                        bot.pathfinder.setGoal(new goals.GoalNear(stone.position.x, stone.position.y, stone.position.z, 2));
                        await new Promise(r => setTimeout(r, 2000));
                        await bot.dig(stone);
                    } catch (e) { break; }
                }
                await new Promise(r => setTimeout(r, 1000));
            }
            const crafted = await craftSequence(['stone_pickaxe', 'stone_sword', 'stone_axe', 'stone_shovel']);
            bot.chat(crafted.length > 0 ? `Got: ${crafted.join(', ')}!` : "Need more cobblestone!");
            return 'skip_chat';
        }
    };
    handlers.get_iron_tools = {
        desc: "Autonomously get iron tools. Mines iron ore, smelts it, crafts pickaxe, sword, axe, shovel.",
        fn: async () => {
            bot.chat("Working on iron tools, this might take a while...");
            const mcData = require('minecraft-data')(bot.version);
            // Make sure we have a stone pickaxe first
            if (!bot.inventory.items().some(i => ['stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe'].includes(i.name))) {
                await craftSequence(['stone_pickaxe']);
            }
            // Mine iron ore
            const ironCount = bot.inventory.items().filter(i => i.name === 'iron_ingot' || i.name === 'raw_iron').reduce((s, i) => s + i.count, 0);
            if (ironCount < 12) {
                const pick = bot.inventory.items().find(i => i.name.includes('pickaxe'));
                if (pick) await bot.equip(pick, 'hand');
                const ironOreId = mcData.blocksByName['iron_ore']?.id;
                const deepIronId = mcData.blocksByName['deepslate_iron_ore']?.id;
                for (let i = 0; i < 12 - ironCount; i++) {
                    const ore = bot.findBlock({ matching: [ironOreId, deepIronId].filter(Boolean), maxDistance: 32 });
                    if (!ore) break;
                    try {
                        bot.pathfinder.setGoal(new goals.GoalNear(ore.position.x, ore.position.y, ore.position.z, 2));
                        await new Promise(r => setTimeout(r, 3000));
                        await bot.dig(ore);
                    } catch (e) { break; }
                }
                await new Promise(r => setTimeout(r, 1000));
            }
            // Try smelting raw iron
            const rawIron = bot.inventory.items().find(i => i.name === 'raw_iron');
            if (rawIron) {
                const furnaceId = mcData.blocksByName['furnace']?.id;
                let furnace = furnaceId ? bot.findBlock({ matching: furnaceId, maxDistance: 32 }) : null;
                if (furnace) {
                    bot.pathfinder.setGoal(new goals.GoalNear(furnace.position.x, furnace.position.y, furnace.position.z, 2));
                    await new Promise(r => setTimeout(r, 3000));
                    try {
                        const f = await bot.openFurnace(furnace);
                        await f.putInput(rawIron.type, null, rawIron.count);
                        const fuel = bot.inventory.items().find(i => ['coal', 'charcoal'].some(n => i.name.includes(n)));
                        if (fuel) await f.putFuel(fuel.type, null, fuel.count);
                        bot.chat("Smelting iron... please wait.");
                        await new Promise(r => setTimeout(r, rawIron.count * 10000 + 5000));
                        try { await f.takeOutput(); } catch (e) { }
                        f.close();
                    } catch (e) { }
                } else {
                    bot.chat("I need a furnace to smelt the iron!");
                }
            }
            const crafted = await craftSequence(['iron_pickaxe', 'iron_sword', 'iron_axe', 'iron_shovel']);
            bot.chat(crafted.length > 0 ? `Got: ${crafted.join(', ')}!` : "Need more iron!");
            return 'skip_chat';
        }
    };
    handlers.gear_up = {
        desc: "Full autonomous gear-up: crafts the best tools and armor the bot can make from available resources.",
        fn: async () => {
            bot.chat("Gearing up with whatever I can make...");
            const hasIron = bot.inventory.items().some(i => i.name === 'iron_ingot');
            const hasDiamond = bot.inventory.items().some(i => i.name === 'diamond');
            const hasCobble = bot.inventory.items().some(i => i.name === 'cobblestone');
            let tier = 'wooden';
            if (hasDiamond) tier = 'diamond';
            else if (hasIron) tier = 'iron';
            else if (hasCobble) tier = 'stone';
            const crafted = await craftSequence([`${tier}_pickaxe`, `${tier}_sword`, `${tier}_axe`, `${tier}_shovel`]);
            const bonus = await craftSequence(['shield', 'torch']);
            const all = [...crafted, ...bonus];
            bot.chat(all.length > 0 ? `Geared up: ${all.join(', ')}!` : "I need some materials first!");
            return 'skip_chat';
        }
    };

    // Helper: mine ore blocks autonomously
    const autoMineOre = async (mcData, oreNames, count) => {
        const oreIds = oreNames.map(n => mcData.blocksByName[n]?.id).filter(Boolean);
        if (oreIds.length === 0) return 0;
        let mined = 0;
        for (let i = 0; i < count; i++) {
            const ore = bot.findBlock({ matching: oreIds, maxDistance: 32 });
            if (!ore) break;
            try {
                bot.pathfinder.setGoal(new goals.GoalNear(ore.position.x, ore.position.y, ore.position.z, 2));
                await new Promise(r => setTimeout(r, 3000));

                await ensureToolForBlock(ore);
                await bot.dig(ore);
                mined++;
            } catch (e) { break; }
        }
        if (mined > 0) await new Promise(r => setTimeout(r, 1000));
        return mined;
    };

    // Helper: smelt items in a furnace
    const autoSmelt = async (mcData, inputName, count) => {
        const furnaceId = mcData.blocksByName['furnace']?.id;
        let furnace = furnaceId ? bot.findBlock({ matching: furnaceId, maxDistance: 32 }) : null;
        if (!furnace) {
            // Try to craft and place a furnace
            const cobble = bot.inventory.items().filter(i => i.name === 'cobblestone').reduce((s, i) => s + i.count, 0);
            if (cobble >= 8) {
                const fItem = mcData.itemsByName['furnace'];
                if (fItem) {
                    const tableBlockId = mcData.blocksByName['crafting_table']?.id;
                    let ct = tableBlockId ? bot.findBlock({ matching: tableBlockId, maxDistance: 32 }) : null;
                    const recipes = bot.recipesFor(fItem.id, null, 1, ct);
                    if (recipes && recipes.length > 0) {
                        try { await bot.craft(recipes[0], 1, ct); } catch (e) { }
                    }
                }
                const fInv = bot.inventory.items().find(i => i.name === 'furnace');
                if (fInv) {
                    try {
                        await bot.equip(fInv, 'hand');
                        const ref = bot.blockAt(bot.entity.position.offset(0, -1, 0));
                        if (ref && ref.name !== 'air') {
                            await bot.placeBlock(ref, { x: 0, y: 1, z: 0 });
                            await new Promise(r => setTimeout(r, 500));
                            furnace = bot.findBlock({ matching: furnaceId, maxDistance: 5 });
                        }
                    } catch (e) { }
                }
            }
        }
        if (!furnace) return false;

        bot.pathfinder.setGoal(new goals.GoalNear(furnace.position.x, furnace.position.y, furnace.position.z, 2));
        await new Promise(r => setTimeout(r, 3000));
        try {
            const f = await bot.openFurnace(furnace);
            const input = bot.inventory.items().find(i => i.name === inputName);
            if (!input) { f.close(); return false; }
            const amt = Math.min(input.count, count);
            await f.putInput(input.type, null, amt);
            const fuels = ['coal', 'charcoal', 'oak_planks', 'birch_planks', 'spruce_planks', 'cherry_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks', 'mangrove_planks'];
            const fuel = bot.inventory.items().find(i => fuels.some(n => i.name === n));
            if (fuel) await f.putFuel(fuel.type, null, Math.min(fuel.count, amt));
            else {
                // Try planks from any wood
                const planks = bot.inventory.items().find(i => i.name.includes('planks'));
                if (planks) await f.putFuel(planks.type, null, Math.min(planks.count, amt));
            }
            bot.chat("Smelting...");
            await new Promise(r => setTimeout(r, amt * 10000 + 3000));
            try { await f.takeOutput(); } catch (e) { }
            f.close();
            return true;
        } catch (e) { return false; }
    };

    // ── DIAMOND TOOLS ──
    handlers.get_diamond_tools = {
        desc: "Autonomously get diamond tools. Mines diamonds, crafts pickaxe, sword, axe, shovel.",
        fn: async () => {
            bot.chat("Going for diamond tools...");
            const mcData = require('minecraft-data')(bot.version);
            if (!bot.inventory.items().some(i => ['iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe'].includes(i.name))) {
                bot.chat("I need an iron pickaxe first, crafting one...");
                await handlers.get_iron_tools.fn();
            }
            const dCount = bot.inventory.items().filter(i => i.name === 'diamond').reduce((s, i) => s + i.count, 0);
            if (dCount < 12) {
                bot.chat("Mining diamonds...");
                await autoMineOre(mcData, ['diamond_ore', 'deepslate_diamond_ore'], 12 - dCount);
            }
            const crafted = await craftSequence(['diamond_pickaxe', 'diamond_sword', 'diamond_axe', 'diamond_shovel']);
            bot.chat(crafted.length > 0 ? `Got: ${crafted.join(', ')}!` : "Couldn't find enough diamonds!");
            return 'skip_chat';
        }
    };
    handlers.get_gold_tools = {
        desc: "Autonomously get gold tools. Mines gold ore, smelts it, crafts tools.",
        fn: async () => {
            bot.chat("Going for gold tools...");
            const mcData = require('minecraft-data')(bot.version);
            if (!bot.inventory.items().some(i => i.name.includes('pickaxe'))) await craftSequence(['wooden_pickaxe']);
            const goldCount = bot.inventory.items().filter(i => i.name === 'gold_ingot').reduce((s, i) => s + i.count, 0);
            if (goldCount < 12) {
                await autoMineOre(mcData, ['gold_ore', 'deepslate_gold_ore'], 12 - goldCount);
                const raw = bot.inventory.items().find(i => i.name === 'raw_gold');
                if (raw) await autoSmelt(mcData, 'raw_gold', raw.count);
            }
            const crafted = await craftSequence(['golden_pickaxe', 'golden_sword', 'golden_axe', 'golden_shovel']);
            bot.chat(crafted.length > 0 ? `Got: ${crafted.join(', ')}!` : "Need more gold!");
            return 'skip_chat';
        }
    };

    // ── ARMOR SETS ──
    handlers.get_leather_armor = {
        desc: "Autonomously get leather armor. Hunts cows/horses for leather, crafts full set.",
        fn: async () => {
            bot.chat("Getting leather armor...");
            const mcData = require('minecraft-data')(bot.version);
            const leatherCount = bot.inventory.items().filter(i => i.name === 'leather').reduce((s, i) => s + i.count, 0);
            if (leatherCount < 24) {
                bot.chat("Hunting for leather...");
                for (let i = 0; i < 10; i++) {
                    const animal = Object.values(bot.entities).find(e => e.name && ['cow', 'mooshroom', 'horse', 'donkey', 'mule', 'llama', 'hoglin'].includes(e.name) && e.position.distanceTo(bot.entity.position) < 32);
                    if (!animal) break;
                    bot.pathfinder.setGoal(new goals.GoalNear(animal.position.x, animal.position.y, animal.position.z, 2));
                    await new Promise(r => setTimeout(r, 2000));
                    try { bot.attack(animal); await new Promise(r => setTimeout(r, 500)); bot.attack(animal); } catch (e) { }
                    await new Promise(r => setTimeout(r, 1500));
                }
                await new Promise(r => setTimeout(r, 1000));
            }
            const crafted = await craftSequence(['leather_helmet', 'leather_chestplate', 'leather_leggings', 'leather_boots']);
            bot.chat(crafted.length > 0 ? `Got: ${crafted.join(', ')}!` : "Need more leather!");
            return 'skip_chat';
        }
    };
    handlers.get_iron_armor = {
        desc: "Autonomously get full iron armor. Mines iron, smelts, crafts helmet, chestplate, leggings, boots.",
        fn: async () => {
            bot.chat("Getting iron armor...");
            const mcData = require('minecraft-data')(bot.version);
            if (!bot.inventory.items().some(i => i.name.includes('pickaxe'))) await craftSequence(['stone_pickaxe']);
            const ironCount = bot.inventory.items().filter(i => i.name === 'iron_ingot').reduce((s, i) => s + i.count, 0);
            if (ironCount < 24) {
                bot.chat("Mining iron...");
                await autoMineOre(mcData, ['iron_ore', 'deepslate_iron_ore'], 24 - ironCount);
                const raw = bot.inventory.items().find(i => i.name === 'raw_iron');
                if (raw) await autoSmelt(mcData, 'raw_iron', raw.count);
            }
            const crafted = await craftSequence(['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots']);
            bot.chat(crafted.length > 0 ? `Got: ${crafted.join(', ')}!` : "Need more iron!");
            return 'skip_chat';
        }
    };
    handlers.get_gold_armor = {
        desc: "Autonomously get full gold armor. Mines gold, smelts, crafts all pieces.",
        fn: async () => {
            bot.chat("Getting gold armor...");
            const mcData = require('minecraft-data')(bot.version);
            if (!bot.inventory.items().some(i => i.name.includes('pickaxe'))) await craftSequence(['iron_pickaxe']);
            const goldCount = bot.inventory.items().filter(i => i.name === 'gold_ingot').reduce((s, i) => s + i.count, 0);
            if (goldCount < 24) {
                await autoMineOre(mcData, ['gold_ore', 'deepslate_gold_ore'], 24 - goldCount);
                const raw = bot.inventory.items().find(i => i.name === 'raw_gold');
                if (raw) await autoSmelt(mcData, 'raw_gold', raw.count);
            }
            const crafted = await craftSequence(['golden_helmet', 'golden_chestplate', 'golden_leggings', 'golden_boots']);
            bot.chat(crafted.length > 0 ? `Got: ${crafted.join(', ')}!` : "Need more gold!");
            return 'skip_chat';
        }
    };
    handlers.get_diamond_armor = {
        desc: "Autonomously get full diamond armor. Mines diamonds, crafts all pieces.",
        fn: async () => {
            bot.chat("Going for diamond armor...");
            const mcData = require('minecraft-data')(bot.version);
            if (!bot.inventory.items().some(i => ['iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe'].includes(i.name))) {
                await handlers.get_iron_tools.fn();
            }
            const dCount = bot.inventory.items().filter(i => i.name === 'diamond').reduce((s, i) => s + i.count, 0);
            if (dCount < 24) {
                bot.chat("Mining diamonds...");
                await autoMineOre(mcData, ['diamond_ore', 'deepslate_diamond_ore'], 24 - dCount);
            }
            const crafted = await craftSequence(['diamond_helmet', 'diamond_chestplate', 'diamond_leggings', 'diamond_boots']);
            bot.chat(crafted.length > 0 ? `Got: ${crafted.join(', ')}!` : "Need more diamonds!");
            return 'skip_chat';
        }
    };

    // ── COMBINED FULL GEAR ──
    handlers.get_full_iron = {
        desc: "Get full iron gear: all iron tools AND full iron armor. Fully autonomous.",
        fn: async () => {
            bot.chat("Getting full iron gear...");
            await handlers.get_iron_tools.fn();
            await handlers.get_iron_armor.fn();
            bot.chat("Full iron gear complete!");
            return 'skip_chat';
        }
    };
    handlers.get_full_diamond = {
        desc: "Get full diamond gear: all diamond tools AND full diamond armor. Fully autonomous.",
        fn: async () => {
            bot.chat("Going for full diamond...");
            await handlers.get_diamond_tools.fn();
            await handlers.get_diamond_armor.fn();
            bot.chat("Full diamond gear complete!");
            return 'skip_chat';
        }
    };

    // ── WEAPONS ──
    handlers.get_bow_and_arrows = {
        desc: "Autonomously craft a bow and arrows. Gathers string and feathers if possible.",
        fn: async () => {
            bot.chat("Getting ranged weapons...");
            const crafted = await craftSequence(['bow']);
            // Try to craft arrows
            const arrowsCrafted = await craftSequence(['arrow']);
            const all = [...crafted, ...arrowsCrafted];
            bot.chat(all.length > 0 ? `Got: ${all.join(', ')}!` : "I need sticks, string, feathers, and flint for this!");
            return 'skip_chat';
        }
    };
    handlers.get_shield = {
        desc: "Autonomously craft a shield. Gathers wood and iron if needed.",
        fn: async () => {
            bot.chat("Crafting a shield...");
            const crafted = await craftSequence(['shield']);
            bot.chat(crafted.length > 0 ? "Got a shield!" : "I need iron and planks for a shield!");
            return 'skip_chat';
        }
    };

    // ── FOOD ──
    handlers.get_food = {
        desc: "Autonomously hunt animals and cook the meat. Gets the bot fed.",
        fn: async () => {
            bot.chat("Hunting for food...");
            const mcData = require('minecraft-data')(bot.version);
            const foodAnimals = ['cow', 'pig', 'sheep', 'chicken', 'rabbit', 'mooshroom'];
            let kills = 0;
            for (let i = 0; i < 8; i++) {
                const animal = Object.values(bot.entities).find(e => e.name && foodAnimals.includes(e.name) && e.position.distanceTo(bot.entity.position) < 32);
                if (!animal) break;
                const sword = bot.inventory.items().find(i => i.name.includes('sword'));
                if (sword) await bot.equip(sword, 'hand');
                bot.pathfinder.setGoal(new goals.GoalNear(animal.position.x, animal.position.y, animal.position.z, 2));
                await new Promise(r => setTimeout(r, 2000));
                for (let hit = 0; hit < 5; hit++) {
                    try { bot.attack(animal); } catch (e) { break; }
                    await new Promise(r => setTimeout(r, 400));
                    if (!animal.isValid) break;
                }
                kills++;
                await new Promise(r => setTimeout(r, 500));
            }
            await new Promise(r => setTimeout(r, 1500));
            // Cook raw meat
            const rawMeats = ['raw_beef', 'raw_porkchop', 'raw_chicken', 'raw_mutton', 'raw_rabbit'];
            const rawMeat = bot.inventory.items().find(i => rawMeats.includes(i.name));
            if (rawMeat) {
                await autoSmelt(mcData, rawMeat.name, rawMeat.count);
            }
            const food = bot.inventory.items().filter(i => ['cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton', 'cooked_rabbit', 'bread', 'apple', 'golden_apple'].some(f => i.name === f));
            const total = food.reduce((s, i) => s + i.count, 0);
            bot.chat(total > 0 ? `Got ${total} food items! Ready to eat.` : (kills > 0 ? "Killed some animals but need a furnace to cook!" : "No animals nearby to hunt!"));
            return 'skip_chat';
        }
    };

    // ── BASE BUILDING ──
    handlers.build_base = {
        desc: "Build a complete survival base: shelter, crafting table, furnace, bed, chest, torches. Fully autonomous.",
        fn: async () => {
            bot.chat("Building a survival base...");
            const mcData = require('minecraft-data')(bot.version);
            // Ensure we have wood
            const hasLogs = bot.inventory.items().some(i => i.name.endsWith('_log') || i.name.endsWith('_stem'));
            if (!hasLogs) {
                bot.chat("Chopping wood first...");
                await autoChopTree(mcData);
                await autoChopTree(mcData);
                await autoChopTree(mcData);
            }
            // Make planks
            await autoCraftPlanks(mcData, 8);
            // Craft essentials
            const crafted = await craftSequence(['crafting_table', 'furnace', 'chest', 'torch']);
            // Place crafting table
            const placeItem = async (name) => {
                const item = bot.inventory.items().find(i => i.name === name);
                if (!item) return;
                try {
                    await bot.equip(item, 'hand');
                    const ref = bot.blockAt(bot.entity.position.offset(0, -1, 0));
                    if (ref && ref.name !== 'air') {
                        await bot.placeBlock(ref, { x: 0, y: 1, z: 0 });
                        await new Promise(r => setTimeout(r, 300));
                    }
                } catch (e) { }
            };
            await placeItem('crafting_table');
            // Move slightly and place furnace
            bot.pathfinder.setGoal(new goals.GoalNear(bot.entity.position.x + 2, bot.entity.position.y, bot.entity.position.z, 1));
            await new Promise(r => setTimeout(r, 1500));
            await placeItem('furnace');
            // Place chest
            bot.pathfinder.setGoal(new goals.GoalNear(bot.entity.position.x + 2, bot.entity.position.y, bot.entity.position.z, 1));
            await new Promise(r => setTimeout(r, 1500));
            await placeItem('chest');
            // Place torch
            await placeItem('torch');
            // Try to craft and place a bed
            const bedCrafted = await craftSequence(['white_bed']);
            bot.chat(`Base set up! Placed: ${[...crafted, ...bedCrafted].join(', ') || 'essentials'}.`);
            return 'skip_chat';
        }
    };

    // ── MINING OPERATIONS ──
    handlers.mine_and_smelt_iron = {
        desc: "Autonomously mine iron ore and smelt it into iron ingots.",
        fn: async () => {
            bot.chat("Mining and smelting iron...");
            const mcData = require('minecraft-data')(bot.version);
            if (!bot.inventory.items().some(i => i.name.includes('pickaxe'))) await craftSequence(['stone_pickaxe']);
            await autoMineOre(mcData, ['iron_ore', 'deepslate_iron_ore'], 10);
            const raw = bot.inventory.items().find(i => i.name === 'raw_iron');
            if (raw) {
                await autoSmelt(mcData, 'raw_iron', raw.count);
                const ingots = bot.inventory.items().filter(i => i.name === 'iron_ingot').reduce((s, i) => s + i.count, 0);
                bot.chat(`Done! Got ${ingots} iron ingots.`);
            } else {
                bot.chat("Couldn't find iron ore nearby!");
            }
            return 'skip_chat';
        }
    };
    handlers.mine_and_smelt_gold = {
        desc: "Autonomously mine gold ore and smelt it into gold ingots.",
        fn: async () => {
            bot.chat("Mining and smelting gold...");
            const mcData = require('minecraft-data')(bot.version);
            if (!bot.inventory.items().some(i => i.name.includes('pickaxe'))) await craftSequence(['iron_pickaxe']);
            await autoMineOre(mcData, ['gold_ore', 'deepslate_gold_ore'], 10);
            const raw = bot.inventory.items().find(i => i.name === 'raw_gold');
            if (raw) {
                await autoSmelt(mcData, 'raw_gold', raw.count);
                const ingots = bot.inventory.items().filter(i => i.name === 'gold_ingot').reduce((s, i) => s + i.count, 0);
                bot.chat(`Done! Got ${ingots} gold ingots.`);
            } else {
                bot.chat("Couldn't find gold ore nearby!");
            }
            return 'skip_chat';
        }
    };
    handlers.mine_and_smelt_copper = {
        desc: "Autonomously mine copper ore and smelt it into copper ingots.",
        fn: async () => {
            bot.chat("Mining and smelting copper...");
            const mcData = require('minecraft-data')(bot.version);
            if (!bot.inventory.items().some(i => i.name.includes('pickaxe'))) await craftSequence(['stone_pickaxe']);
            await autoMineOre(mcData, ['copper_ore', 'deepslate_copper_ore'], 10);
            const raw = bot.inventory.items().find(i => i.name === 'raw_copper');
            if (raw) {
                await autoSmelt(mcData, 'raw_copper', raw.count);
                bot.chat("Done smelting copper!");
            } else {
                bot.chat("Couldn't find copper ore nearby!");
            }
            return 'skip_chat';
        }
    };
    handlers.mine_diamonds = {
        desc: "Autonomously mine diamonds. Gets a good pickaxe first if needed.",
        fn: async () => {
            bot.chat("Mining diamonds...");
            const mcData = require('minecraft-data')(bot.version);
            if (!bot.inventory.items().some(i => ['iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe'].includes(i.name))) {
                bot.chat("I need an iron pickaxe first...");
                await handlers.get_iron_tools.fn();
            }
            const mined = await autoMineOre(mcData, ['diamond_ore', 'deepslate_diamond_ore'], 10);
            const dCount = bot.inventory.items().filter(i => i.name === 'diamond').reduce((s, i) => s + i.count, 0);
            bot.chat(mined > 0 ? `Mined ${mined} diamond ore! Have ${dCount} diamonds total.` : "Couldn't find diamonds nearby. Try deeper (Y < 16)!");
            return 'skip_chat';
        }
    };

    // ── FULL SURVIVAL SETUP ──
    handlers.survival_setup = {
        desc: "Complete survival setup from scratch: gathers wood, makes tools, builds a base with furnace and chest, hunts for food, and places torches. The ultimate starter command.",
        fn: async () => {
            bot.chat("Starting full survival setup! This will take a while...");
            // Step 1: Get wooden tools
            bot.chat("Step 1: Getting tools...");
            await handlers.get_wooden_tools.fn();
            // Step 2: Try to upgrade to stone
            bot.chat("Step 2: Upgrading to stone...");
            await handlers.get_stone_tools.fn();
            // Step 3: Build base
            bot.chat("Step 3: Building base...");
            await handlers.build_base.fn();
            // Step 4: Get food
            bot.chat("Step 4: Getting food...");
            await handlers.get_food.fn();
            bot.chat("Survival setup complete! We have tools, a base, and food!");
            return 'skip_chat';
        }
    };

    // ── COLLECTION/FARMING ──
    handlers.gather_wood = {
        desc: "Autonomously chop multiple trees and collect all the wood. Gets a lot of logs.",
        fn: async () => {
            bot.chat("Gathering wood...");
            const mcData = require('minecraft-data')(bot.version);
            const axe = bot.inventory.items().find(i => i.name.includes('_axe'));
            if (axe) await bot.equip(axe, 'hand');
            let totalMined = 0;
            for (let tree = 0; tree < 5; tree++) {
                const result = await autoChopTree(mcData);
                if (!result) break;
                totalMined++;
            }
            const logs = bot.inventory.items().filter(i => i.name.endsWith('_log') || i.name.endsWith('_stem')).reduce((s, i) => s + i.count, 0);
            bot.chat(totalMined > 0 ? `Chopped ${totalMined} trees! Have ${logs} logs.` : "No trees nearby!");
            return 'skip_chat';
        }
    };
    handlers.gather_cobblestone = {
        desc: "Autonomously mine a bunch of cobblestone (up to 32). Gets a pickaxe first if needed.",
        fn: async () => {
            bot.chat("Gathering cobblestone...");
            const mcData = require('minecraft-data')(bot.version);
            if (!bot.inventory.items().some(i => i.name.includes('pickaxe'))) await craftSequence(['wooden_pickaxe']);
            const pick = bot.inventory.items().find(i => i.name.includes('pickaxe'));
            if (pick) await bot.equip(pick, 'hand');
            const stoneId = mcData.blocksByName['stone']?.id;
            const cobbleId = mcData.blocksByName['cobblestone']?.id;
            let mined = 0;
            for (let i = 0; i < 32; i++) {
                const block = bot.findBlock({ matching: [stoneId, cobbleId].filter(Boolean), maxDistance: 16 });
                if (!block) break;
                try {
                    bot.pathfinder.setGoal(new goals.GoalNear(block.position.x, block.position.y, block.position.z, 2));
                    await new Promise(r => setTimeout(r, 2000));

                    // Re-check and equip tool inside the loop
                    const hasPick = bot.inventory.items().some(i => i.name.includes('pickaxe'));
                    if (!hasPick && i % 4 === 0) await craftSequence(['wooden_pickaxe']); // Craft if broken
                    await equipBestTool(block);

                    // Safety: only dig if we have a pickaxe or it's a weak block
                    const blockDef = mcData.blocks[block.type];
                    const pick = bot.inventory.items().find(i => i.name.includes('pickaxe'));
                    if (!pick && blockDef && blockDef.harvestTools) {
                        console.log("[Gather] No pickaxe for rocky block, skipping.");
                        continue;
                    }

                    await bot.dig(block);
                    mined++;
                } catch (e) { break; }
            }
            await new Promise(r => setTimeout(r, 1000));
            bot.chat(mined > 0 ? `Mined ${mined} cobblestone!` : "Can't find stone nearby!");
            return 'skip_chat';
        }
    };
    handlers.make_torches = {
        desc: "Autonomously make torches. Mines coal and gathers sticks if needed.",
        fn: async () => {
            bot.chat("Making torches...");
            const mcData = require('minecraft-data')(bot.version);
            const coalCount = bot.inventory.items().filter(i => i.name === 'coal' || i.name === 'charcoal').reduce((s, i) => s + i.count, 0);
            if (coalCount < 4) {
                if (!bot.inventory.items().some(i => i.name.includes('pickaxe'))) await craftSequence(['wooden_pickaxe']);
                await autoMineOre(mcData, ['coal_ore', 'deepslate_coal_ore'], 8);
            }
            const crafted = await craftSequence(['torch']);
            // Craft more torches if we have materials
            for (let i = 0; i < 3; i++) {
                const more = await craftSequence(['torch']);
                if (more.length === 0) break;
            }
            const torchCount = bot.inventory.items().filter(i => i.name === 'torch').reduce((s, i) => s + i.count, 0);
            bot.chat(torchCount > 0 ? `Made ${torchCount} torches!` : "Need coal and sticks for torches!");
            return 'skip_chat';
        }
    };
    handlers.list_craftable = {
        desc: "List all items the bot can currently craft with materials in inventory",
        fn: () => {
            const mcData = require('minecraft-data')(bot.version);
            const craftable = [];
            for (const item of Object.values(mcData.itemsByName)) {
                const recipes = bot.recipesFor(item.id);
                if (recipes && recipes.length > 0) craftable.push(item.displayName || item.name);
            }
            if (craftable.length === 0) { bot.chat("I can't craft anything with what I have."); }
            else { bot.chat(`I can craft: ${craftable.slice(0, 20).join(', ')}${craftable.length > 20 ? ` (+${craftable.length - 20} more)` : ''}`); }
            return 'skip_chat';
        }
    };
    handlers.craft_planks = {
        desc: "Craft wooden planks from logs in inventory",
        fn: async () => { return await handlers.craft_item.fn('oak_planks') || await handlers.craft_item.fn('planks'); }
    };
    handlers.craft_sticks = {
        desc: "Craft sticks from planks in inventory",
        fn: async () => { return await handlers.craft_item.fn('stick'); }
    };
    handlers.craft_crafting_table = {
        desc: "Craft a crafting table from planks",
        fn: async () => { return await handlers.craft_item.fn('crafting_table'); }
    };
    handlers.craft_furnace = {
        desc: "Craft a furnace from cobblestone",
        fn: async () => { return await handlers.craft_item.fn('furnace'); }
    };
    handlers.craft_wooden_pickaxe = {
        desc: "Craft a wooden pickaxe",
        fn: async () => { return await handlers.craft_item.fn('wooden_pickaxe'); }
    };
    handlers.craft_stone_pickaxe = {
        desc: "Craft a stone pickaxe",
        fn: async () => { return await handlers.craft_item.fn('stone_pickaxe'); }
    };
    handlers.craft_iron_pickaxe = {
        desc: "Craft an iron pickaxe",
        fn: async () => { return await handlers.craft_item.fn('iron_pickaxe'); }
    };
    handlers.craft_wooden_sword = {
        desc: "Craft a wooden sword",
        fn: async () => { return await handlers.craft_item.fn('wooden_sword'); }
    };
    handlers.craft_stone_sword = {
        desc: "Craft a stone sword",
        fn: async () => { return await handlers.craft_item.fn('stone_sword'); }
    };
    handlers.craft_iron_sword = {
        desc: "Craft an iron sword",
        fn: async () => { return await handlers.craft_item.fn('iron_sword'); }
    };
    handlers.craft_torch = {
        desc: "Craft torches from coal and sticks",
        fn: async () => { return await handlers.craft_item.fn('torch'); }
    };
    handlers.craft_chest = {
        desc: "Craft a chest from planks",
        fn: async () => { return await handlers.craft_item.fn('chest'); }
    };
    handlers.craft_bed = {
        desc: "Craft a bed from wool and planks",
        fn: async () => { return await handlers.craft_item.fn('white_bed'); }
    };
    handlers.craft_shield = {
        desc: "Craft a shield from planks and iron ingot",
        fn: async () => { return await handlers.craft_item.fn('shield'); }
    };
    handlers.craft_bucket = {
        desc: "Craft a bucket from iron ingots",
        fn: async () => { return await handlers.craft_item.fn('bucket'); }
    };
    handlers.craft_bow = {
        desc: "Craft a bow from sticks and string",
        fn: async () => { return await handlers.craft_item.fn('bow'); }
    };
    handlers.craft_arrows = {
        desc: "Craft arrows from flint, sticks, and feathers",
        fn: async () => { return await handlers.craft_item.fn('arrow'); }
    };
    handlers.craft_boat = {
        desc: "Craft a boat from planks",
        fn: async () => { return await handlers.craft_item.fn('oak_boat'); }
    };

    // ────────────── MINING / RESOURCE GATHERING ──────────────
    handlers.find_and_mine_block = {
        desc: "Find and mine a specific block type nearby (target = block name like 'diamond_ore', 'iron_ore', 'coal_ore', 'stone', 'sand', 'gravel', 'clay'). Mines CONTINUOUSLY until told to stop.",
        fn: async (target) => {
            if (!target || target === 'undefined') {
                bot.chat("Mine what? You didn't say.");
                return 'skip_chat';
            }
            // Check if target is a player
            const playerMatch = Object.keys(bot.players).find(p => p.toLowerCase() === target.toLowerCase());
            if (playerMatch) {
                bot.chat(`I can't mine ${playerMatch}, that's a player! 😨`);
                return 'skip_chat';
            }

            const mcData = require('minecraft-data')(bot.version);
            const searchName = target.replace(/ /g, '_').toLowerCase();
            const blockType = mcData.blocksByName[searchName] || Object.values(mcData.blocksByName).find(b => b.name.includes(searchName));
            if (!blockType) { bot.chat(`I don't know what block "${target}" is.`); return 'skip_chat'; }

            bot.isMining = true;
            bot.miningTarget = target;
            bot.chat(`I will keep mining ${blockType.displayName || blockType.name} until you tell me to stop!`);

            while (bot.isMining) {
                const block = bot.findBlock({ matching: blockType.id, maxDistance: 128 });
                if (!block) {
                    bot.chat(`Can't find any more ${blockType.displayName || blockType.name} nearby. I'll wait a bit then look again.`);
                    for (let i = 0; i < 10 && bot.isMining; i++) {
                        await new Promise(r => setTimeout(r, 1000));
                    }
                    continue;
                }

                try {
                    // Walk to the block
                    const p = block.position;
                    bot.pathfinder.setGoal(new goals.GoalNear(p.x, p.y, p.z, 2));

                    // Wait until close (or stop)
                    while (bot.isMining && bot.entity.position.distanceTo(block.position) > 3.5) {
                        await new Promise(r => setTimeout(r, 500));
                        // Re-check block existence (might have been mined by someone else)
                        if (!bot.blockAt(block.position) || bot.blockAt(block.position).type === 0) break;
                    }

                    if (!bot.isMining) break;
                    if (bot.entity.position.distanceTo(block.position) > 4) continue; // Missed it or failed pathfinding

                    const hasTool = await ensureToolForBlock(block);
                    if (!hasTool) {
                        bot.chat(`I can't find or craft a tool for ${blockType.name}. Stopping.`);
                        break;
                    }

                    await bot.dig(block);
                    console.log(`[Mining] Mined ${blockType.name}`);
                    await new Promise(r => setTimeout(r, 500)); // Brief pause
                } catch (e) {
                    console.log(`[Mining] Loop error: ${e.message}`);
                    await new Promise(r => setTimeout(r, 1000));
                }
            }
            return true;
        }
    };
    handlers.mine_multiple = {
        desc: "Mine multiple blocks of a specific type nearby (target = block name). (Alias for continuous mining)",
        fn: async (target) => { return await handlers.find_and_mine_block.fn(target); }
    };
    handlers.stop_mining = {
        desc: "Stop mining immediately",
        fn: () => { return handlers.stop.fn(); }
    };
    handlers.chop_tree = {
        desc: "Find and chop down the nearest tree (mine all log blocks)",
        fn: async () => {
            const mcData = require('minecraft-data')(bot.version);

            // autoChopTree handles tool equipping now
            let totalMined = 0;
            for (let tree = 0; tree < 5; tree++) {
                const result = await autoChopTree(mcData);
                if (!result) break;
                totalMined++;
            }
            const logs = bot.inventory.items().filter(i => i.name.endsWith('_log') || i.name.endsWith('_stem')).reduce((s, i) => s + i.count, 0);
            bot.chat(totalMined > 0 ? `Chopped ${totalMined} trees! Have ${logs} logs.` : "No trees nearby!");
            return 'skip_chat';
        }
    };
    handlers.mine_coal = {
        desc: "Find and mine coal ore nearby",
        fn: async () => { return await handlers.find_and_mine_block.fn('coal_ore'); }
    };
    handlers.mine_iron = {
        desc: "Find and mine iron ore nearby",
        fn: async () => { return await handlers.find_and_mine_block.fn('iron_ore'); }
    };
    handlers.mine_gold = {
        desc: "Find and mine gold ore nearby",
        fn: async () => { return await handlers.find_and_mine_block.fn('gold_ore'); }
    };
    handlers.mine_diamond = {
        desc: "Find and mine diamond ore nearby",
        fn: async () => { return await handlers.find_and_mine_block.fn('diamond_ore'); }
    };
    handlers.mine_copper = {
        desc: "Find and mine copper ore nearby",
        fn: async () => { return await handlers.find_and_mine_block.fn('copper_ore'); }
    };
    handlers.mine_redstone = {
        desc: "Find and mine redstone ore nearby",
        fn: async () => { return await handlers.find_and_mine_block.fn('redstone_ore'); }
    };
    handlers.mine_lapis = {
        desc: "Find and mine lapis lazuli ore nearby",
        fn: async () => { return await handlers.find_and_mine_block.fn('lapis_ore'); }
    };
    handlers.mine_emerald = {
        desc: "Find and mine emerald ore nearby",
        fn: async () => { return await handlers.find_and_mine_block.fn('emerald_ore'); }
    };
    handlers.mine_stone = {
        desc: "Mine stone/cobblestone blocks nearby",
        fn: async () => { return await handlers.find_and_mine_block.fn('stone'); }
    };
    handlers.mine_sand = {
        desc: "Mine sand blocks nearby",
        fn: async () => { return await handlers.find_and_mine_block.fn('sand'); }
    };
    handlers.dig_straight_down = {
        desc: "Dig straight down multiple blocks (staircase mining, up to 10 blocks deep)",
        fn: async () => {
            for (let i = 0; i < 10; i++) {
                const block = bot.blockAt(bot.entity.position.offset(0, -1, 0));
                if (!block || block.name === 'air' || block.name === 'bedrock' || block.name.includes('lava') || block.name.includes('water')) break;
                try { await bot.dig(block); } catch (e) { break; }
                await new Promise(r => setTimeout(r, 200));
            }
            return true;
        }
    };
    handlers.strip_mine = {
        desc: "Strip mine forward in a 1x2 tunnel for resources (mines 20 blocks forward)",
        fn: async () => {
            const equip = async () => {
                const pick = bot.inventory.items().find(i => i.name.includes('pickaxe'));
                if (pick) await bot.equip(pick, 'hand');
            };
            await equip();
            for (let i = 0; i < 20; i++) {
                const yaw = bot.entity.yaw;
                const dx = -Math.sin(yaw);
                const dz = -Math.cos(yaw);
                const pos = bot.entity.position;
                const feetBlock = bot.blockAt(pos.offset(dx, 0, dz).floor());
                const headBlock = bot.blockAt(pos.offset(dx, 1, dz).floor());
                if (feetBlock && feetBlock.name !== 'air') { try { await bot.dig(feetBlock); } catch (e) { break; } }
                if (headBlock && headBlock.name !== 'air') { try { await bot.dig(headBlock); } catch (e) { break; } }
                bot.setControlState('forward', true);
                await new Promise(r => setTimeout(r, 500));
                bot.setControlState('forward', false);
                await new Promise(r => setTimeout(r, 200));
            }
            return true;
        }
    };

    // ────────────── COLLECTION / PICKUP ──────────────
    handlers.collect_drops = {
        desc: "Walk around and pick up all dropped items on the ground nearby",
        fn: () => {
            const items = Object.values(bot.entities).filter(e => e.type === 'object' && e.objectType === 'Item' && e.position.distanceTo(bot.entity.position) < 30);
            if (items.length === 0) { bot.chat("No dropped items nearby."); return 'skip_chat'; }

            let i = 0;
            const collectNext = () => {
                if (i >= items.length) return;
                const item = items[i];
                if (item && item.isValid) {
                    bot.pathfinder.setGoal(new goals.GoalNear(item.position.x, item.position.y, item.position.z, 1));
                }
                i++;
                setTimeout(collectNext, 3000);
            };
            collectNext();
            return true;
        }
    };
    handlers.collect_nearby_items = {
        desc: "Same as collect_drops - pick up all items on the ground",
        fn: () => { return handlers.collect_drops.fn(); }
    };

    // ────────────── SMELTING ──────────────
    handlers.smelt_item = {
        desc: "Smelt items in a nearby furnace (target = item to smelt like 'iron_ore', 'raw_iron', 'raw_gold', 'sand', 'cobblestone')",
        fn: async (target) => {
            const mcData = require('minecraft-data')(bot.version);
            const furnaceBlock = bot.findBlock({ matching: mcData.blocksByName['furnace']?.id, maxDistance: 32 });
            if (!furnaceBlock) { bot.chat("No furnace nearby! Craft one first."); return 'skip_chat'; }

            // Walk to furnace
            bot.pathfinder.setGoal(new goals.GoalNear(furnaceBlock.position.x, furnaceBlock.position.y, furnaceBlock.position.z, 2));
            await new Promise(r => setTimeout(r, 3000));

            try {
                const furnace = await bot.openFurnace(furnaceBlock);
                const searchName = target.replace(/ /g, '_').toLowerCase();
                const item = bot.inventory.items().find(i => i.name.includes(searchName));
                if (!item) { bot.chat(`I don't have any ${target} to smelt.`); furnace.close(); return 'skip_chat'; }

                // Put item in input slot
                await furnace.putInput(item.type, null, item.count > 8 ? 8 : item.count);

                // Add fuel if needed
                if (!furnace.fuelItem()) {
                    const fuels = ['coal', 'charcoal', 'oak_planks', 'birch_planks', 'spruce_planks', 'planks', 'stick', 'lava_bucket'];
                    const fuel = bot.inventory.items().find(i => fuels.some(f => i.name.includes(f)));
                    if (fuel) { await furnace.putFuel(fuel.type, null, fuel.count > 8 ? 8 : fuel.count); }
                    else { bot.chat("I don't have any fuel for the furnace!"); furnace.close(); return 'skip_chat'; }
                }

                bot.chat(`Smelting ${item.displayName || item.name}... This will take a moment.`);
                // Wait for smelting (check every 5 seconds for 60 seconds)
                let waited = 0;
                const checkDone = setInterval(async () => {
                    waited += 5;
                    const output = furnace.outputItem();
                    if (output) {
                        try { await furnace.takeOutput(); } catch (e) { }
                        bot.chat(`Smelting done! Got ${output.displayName || output.name}.`);
                        clearInterval(checkDone);
                        furnace.close();
                    } else if (waited >= 60) {
                        clearInterval(checkDone);
                        try { await furnace.takeOutput(); } catch (e) { }
                        furnace.close();
                    }
                }, 5000);
                return 'skip_chat';
            } catch (e) {
                bot.chat("Couldn't use the furnace.");
                console.error('[Smelt] Error:', e.message);
                return 'skip_chat';
            }
        }
    };
    handlers.smelt_iron = {
        desc: "Smelt raw iron/iron ore in a nearby furnace to get iron ingots",
        fn: async () => { return await handlers.smelt_item.fn('raw_iron') || await handlers.smelt_item.fn('iron_ore'); }
    };
    handlers.tower_up = {
        desc: "Build a pillar under the bot to go up (jump + place). Usage: 'tower up 3', 'pillar up'",
        fn: async (height) => {
            const h = parseInt(height) || 3;
            bot.chat(`Towering up ${h} blocks!`);
            const result = await pillarUp(h);
            if (result) {
                bot.chat("Pillar complete!");
            } else {
                bot.chat("Failed to pillar (maybe out of blocks?)");
            }
            return 'skip_chat';
        }
    };
    handlers.smelt_gold = {
        desc: "Smelt raw gold/gold ore in a nearby furnace to get gold ingots",
        fn: async () => { return await handlers.smelt_item.fn('raw_gold') || await handlers.smelt_item.fn('gold_ore'); }
    };
    handlers.smelt_copper = {
        desc: "Smelt raw copper in a nearby furnace to get copper ingots",
        fn: async () => { return await handlers.smelt_item.fn('raw_copper'); }
    };
    handlers.smelt_sand = {
        desc: "Smelt sand in a furnace to make glass",
        fn: async () => { return await handlers.smelt_item.fn('sand'); }
    };
    handlers.cook_food = {
        desc: "Cook raw meat/food in a nearby furnace",
        fn: async () => {
            const rawFoods = ['raw_beef', 'raw_porkchop', 'raw_chicken', 'raw_mutton', 'raw_rabbit', 'raw_cod', 'raw_salmon', 'potato', 'kelp'];
            const food = bot.inventory.items().find(i => rawFoods.some(f => i.name.includes(f)));
            if (food) { return await handlers.smelt_item.fn(food.name); }
            bot.chat("I don't have any raw food to cook.");
            return 'skip_chat';
        }
    };

    // ────────────── BUILDING ──────────────
    handlers.build_shelter = {
        desc: "Build a simple dirt/cobblestone shelter around the bot for protection",
        fn: async () => {
            const buildBlock = bot.inventory.items().find(i => i.name.includes('cobblestone') || i.name.includes('dirt') || i.name.includes('planks'));
            if (!buildBlock) { bot.chat("I need building materials!"); return 'skip_chat'; }
            try { await bot.equip(buildBlock, 'hand'); } catch (e) { }

            const pos = bot.entity.position.floor();
            const offsets = [
                [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1],
                [1, 1, 0], [-1, 1, 0], [0, 1, 1], [0, 1, -1],
                [0, 2, 0]
            ];
            for (const [dx, dy, dz] of offsets) {
                const target = bot.blockAt(pos.offset(dx, dy, dz));
                if (target && target.name === 'air') {
                    const ref = bot.blockAt(pos.offset(dx, dy - 1, dz));
                    if (ref && ref.name !== 'air') {
                        try { await bot.placeBlock(ref, { x: 0, y: 1, z: 0 }); } catch (e) { }
                    }
                }
                await new Promise(r => setTimeout(r, 300));
            }
            return true;
        }
    };
    handlers.place_block_here = {
        desc: "Place the held block at the bot's current position",
        fn: async () => {
            const held = bot.inventory.slots[bot.getEquipmentDestSlot('hand')];
            if (!held) { bot.chat("I'm not holding anything to place!"); return 'skip_chat'; }
            return await placeInventoryItem(held);
        }
    };
    handlers.place_crafting_table = {
        desc: "Place a crafting table from inventory on the ground",
        fn: async () => {
            const table = bot.inventory.items().find(i => i.name === 'crafting_table');
            if (!table) { bot.chat("I don't have a crafting table."); return 'skip_chat'; }
            return await placeInventoryItem(table);
        }
    };
    handlers.place_furnace = {
        desc: "Place a furnace from inventory on the ground",
        fn: async () => {
            const furnace = bot.inventory.items().find(i => i.name === 'furnace');
            if (!furnace) { bot.chat("I don't have a furnace."); return 'skip_chat'; }
            return await placeInventoryItem(furnace);
        }
    };
    handlers.place_torch = {
        desc: "Place a torch on the ground or wall nearby to light up the area",
        fn: async () => {
            const torch = bot.inventory.items().find(i => i.name === 'torch');
            if (!torch) { bot.chat("I don't have any torches."); return 'skip_chat'; }
            return await placeInventoryItem(torch);
        }
    };

    // ────────────── SURVIVAL TASKS ──────────────
    handlers.hunt_for_food = {
        desc: "Hunt nearby animals for food (attacks nearest cow, pig, sheep, or chicken)",
        fn: async () => {
            const animals = ['cow', 'pig', 'sheep', 'chicken', 'rabbit'];
            let mob = null;
            for (const a of animals) {
                mob = getNearestEntity(a);
                if (mob) break;
            }
            if (mob) { return startCombat(mob, 'animal for food'); }
            bot.chat("No animals nearby to hunt.");
            return 'skip_chat';
        }
    };
    handlers.find_water = {
        desc: "Navigate to the nearest water source",
        fn: () => {
            const mcData = require('minecraft-data')(bot.version);
            const water = bot.findBlock({ matching: mcData.blocksByName['water']?.id, maxDistance: 64 });
            if (water) { bot.pathfinder.setGoal(new goals.GoalNear(water.position.x, water.position.y, water.position.z, 2)); return true; }
            bot.chat("No water nearby.");
            return 'skip_chat';
        }
    };
    handlers.find_cave = {
        desc: "Find and navigate to a nearby cave entrance (look for underground air blocks)",
        fn: () => {
            const mcData = require('minecraft-data')(bot.version);
            const stone = bot.findBlock({
                matching: (block) => block.name === 'air' && block.position.y < bot.entity.position.y - 3,
                maxDistance: 64
            });
            if (stone) { bot.pathfinder.setGoal(new goals.GoalNear(stone.position.x, stone.position.y, stone.position.z, 2)); return true; }
            bot.chat("Can't find a cave nearby.");
            return 'skip_chat';
        }
    };
    handlers.fill_water_bucket = {
        desc: "Fill a bucket with water from a nearby water source",
        fn: async () => {
            const bucket = bot.inventory.items().find(i => i.name === 'bucket');
            if (!bucket) { bot.chat("I don't have a bucket."); return 'skip_chat'; }
            const mcData = require('minecraft-data')(bot.version);
            const water = bot.findBlock({ matching: mcData.blocksByName['water']?.id, maxDistance: 16 });
            if (!water) { bot.chat("No water nearby."); return 'skip_chat'; }
            bot.pathfinder.setGoal(new goals.GoalNear(water.position.x, water.position.y, water.position.z, 2));
            await new Promise(r => setTimeout(r, 3000));
            try { await bot.equip(bucket, 'hand'); bot.activateBlock(water); } catch (e) { }
            return true;
        }
    };
    handlers.find_village = {
        desc: "Try to find and navigate toward a village (look for village-type blocks like doors, beds, workstations)",
        fn: () => {
            const mcData = require('minecraft-data')(bot.version);
            const villageBlocks = ['bell', 'lectern', 'cartography_table', 'smithing_table', 'fletching_table', 'barrel', 'blast_furnace', 'smoker', 'composter', 'loom', 'stonecutter', 'grindstone'];
            for (const bName of villageBlocks) {
                const blockId = mcData.blocksByName[bName]?.id;
                if (blockId === undefined) continue;
                const block = bot.findBlock({ matching: blockId, maxDistance: 128 });
                if (block) {
                    bot.pathfinder.setGoal(new goals.GoalNear(block.position.x, block.position.y, block.position.z, 3));
                    return true;
                }
            }
            bot.chat("Can't find a village nearby.");
            return 'skip_chat';
        }
    };

    // ────────────── CHEST INTERACTION ──────────────
    handlers.open_nearest_chest = {
        desc: "Open the nearest chest and list what's inside",
        fn: async () => {
            const mcData = require('minecraft-data')(bot.version);
            const chestBlock = bot.findBlock({ matching: mcData.blocksByName['chest']?.id, maxDistance: 16 });
            if (!chestBlock) { bot.chat("No chest nearby."); return 'skip_chat'; }

            bot.pathfinder.setGoal(new goals.GoalNear(chestBlock.position.x, chestBlock.position.y, chestBlock.position.z, 2));
            await new Promise(r => setTimeout(r, 3000));

            try {
                const chest = await bot.openContainer(chestBlock);
                const items = chest.containerItems();
                if (items.length === 0) { bot.chat("The chest is empty."); }
                else { bot.chat(`Chest contains: ${items.map(i => `${i.name} x${i.count}`).slice(0, 10).join(', ')}`); }
                chest.close();
            } catch (e) { bot.chat("Couldn't open the chest."); }
            return 'skip_chat';
        }
    };
    handlers.deposit_all_to_chest = {
        desc: "Deposit all inventory items into the nearest chest",
        fn: async () => {
            const mcData = require('minecraft-data')(bot.version);
            const chestBlock = bot.findBlock({ matching: mcData.blocksByName['chest']?.id, maxDistance: 16 });
            if (!chestBlock) { bot.chat("No chest nearby."); return 'skip_chat'; }

            bot.pathfinder.setGoal(new goals.GoalNear(chestBlock.position.x, chestBlock.position.y, chestBlock.position.z, 2));
            await new Promise(r => setTimeout(r, 3000));

            try {
                const chest = await bot.openContainer(chestBlock);
                for (const item of bot.inventory.items()) {
                    try { await chest.deposit(item.type, null, item.count); } catch (e) { }
                }
                bot.chat("Deposited all items!");
                chest.close();
            } catch (e) { bot.chat("Couldn't use the chest."); }
            return 'skip_chat';
        }
    };
    handlers.take_from_chest = {
        desc: "Take a specific item from the nearest chest (target = item name)",
        fn: async (target) => {
            const mcData = require('minecraft-data')(bot.version);
            const chestBlock = bot.findBlock({ matching: mcData.blocksByName['chest']?.id, maxDistance: 16 });
            if (!chestBlock) { bot.chat("No chest nearby."); return 'skip_chat'; }

            bot.pathfinder.setGoal(new goals.GoalNear(chestBlock.position.x, chestBlock.position.y, chestBlock.position.z, 2));
            await new Promise(r => setTimeout(r, 3000));

            try {
                const chest = await bot.openContainer(chestBlock);
                const searchName = target.replace(/ /g, '_').toLowerCase();
                const item = chest.containerItems().find(i => i.name.includes(searchName));
                if (item) {
                    await chest.withdraw(item.type, null, item.count);
                    bot.chat(`Took ${item.count}x ${item.displayName || item.name} from chest.`);
                } else { bot.chat(`No ${target} in the chest.`); }
                chest.close();
            } catch (e) { bot.chat("Couldn't use the chest."); }
            return 'skip_chat';
        }
    };


    // ─── EVENTS ───

    const handleCombat = async (attacker) => {
        if (!attacker || !attacker.name) return;
        console.log(`[Combat] Engaged with ${attacker.name}!`);

        const STRONG_MOBS = ['creeper', 'warden', 'iron_golem', 'wither', 'ender_dragon', 'ravager', 'piglin_brute'];
        const isStrong = STRONG_MOBS.includes(attacker.name);
        const isLowHealth = bot.health < 6;

        if (isStrong || isLowHealth) {
            // RUN AWAY
            bot.chat(`I'm fleeing from ${attacker.name}!`);
            bot.setControlState('sprint', true);
            const p = attacker.position;
            try {
                bot.pathfinder.setGoal(new goals.GoalInvert(new goals.GoalNear(p.x, p.y, p.z, 50)), true);
            } catch (e) { }
        } else {
            // FIGHT BACK
            const sword = bot.inventory.items().find(i => i.name.includes('sword')) || bot.inventory.items().find(i => i.name.includes('axe'));
            if (sword) await bot.equip(sword, 'hand');

            // Attack loop
            const fight = setInterval(() => {
                if (!attacker.isValid || bot.entity.position.distanceTo(attacker.position) > 10) {
                    clearInterval(fight);
                    bot.pathfinder.setGoal(null);
                    bot.setControlState('forward', false);
                    return;
                }
                bot.lookAt(attacker.position.offset(0, attacker.height * 0.5, 0));
                bot.attack(attacker);
                bot.setControlState('jump', Math.random() < 0.3);
                bot.setControlState('forward', true);
            }, 600);

            setTimeout(() => { clearInterval(fight); bot.setControlState('forward', false); }, 10000);
        }
    };

    // Self-Defense Mechanism
    bot.on('entityHurt', async (entity) => {
        // 1. Self-Defense
        if (entity === bot.entity) {
            const attacker = bot.nearestEntity(e =>
                e.type === 'mob' && e.position.distanceTo(bot.entity.position) < 5 && e.mobType !== 'Armor Stand'
            );
            if (attacker) handleCombat(attacker);
            return;
        }

        // 2. Protect Players (Bodyguard)
        if (entity.type === 'player') {
            const dist = bot.entity.position.distanceTo(entity.position);
            if (dist > 15) return; // Too far to care

            // Find who hurt the player
            const attacker = bot.nearestEntity(e =>
                e.type === 'mob' &&
                e.position.distanceTo(entity.position) < 5 &&
                e.mobType !== 'Armor Stand'
            );

            if (attacker) {
                bot.chat(`Hey! Get away from ${entity.username || 'them'}!`);
                handleCombat(attacker);
            }
        }
    });




    // Automatic Item Collection (Drops)
    bot.on('itemDrop', async (entity) => {
        // Did we (or someone) just kill something? Or did we mine something?
        // Wait a moment for it to settle
        await new Promise(r => setTimeout(r, 1000));

        if (!entity.isValid) return; // Despawned or picked up

        // Distance check (don't run across map)
        if (bot.entity.position.distanceTo(entity.position) > 15) return;

        // Safety check: LAVA
        const b = bot.blockAt(entity.position);
        const bBelow = bot.blockAt(entity.position.offset(0, -1, 0));
        if ((b && b.name === 'lava') || (bBelow && bBelow.name === 'lava')) {
            console.log(`[Collect] Ignoring item ${entity.displayName} in lava.`);
            return;
        }

        // If we are currently busy with a high-priority task (building, mining), maybe skip?
        // For now, interrupts are okay if short.

        try {
            // bot.pathfinder.goto(new goals.GoalFollow(entity, 1)); // Follow moving item?
            // Simple: go to its position
            // Don't interrupt if we are 'mining' specifically? 
            if (bot.isMining) return;

            // console.log(`[Collect] Picking up ${entity.metadata[10]?.itemId || 'item'}`);
            await bot.pathfinder.goto(new goals.GoalNear(entity.position.x, entity.position.y, entity.position.z, 1));
        } catch (e) { }
    });

    // Explicit Mob Kill -> Collect Trigger
    bot.on('entityDead', async (entity) => {
        if (entity.type !== 'mob' && entity.type !== 'animal') return;
        if (bot.entity.position.distanceTo(entity.position) < 10) {
            // A mob died near us. Look for drops specifically near its death location.
            await new Promise(r => setTimeout(r, 800));
            const drops = Object.values(bot.entities).filter(e =>
                e.type === 'object' && // items are 'object' type in older/some versions, or 'other'? 'object' is usually drops. 
                // actually type='object' class='Item' (depending on version)
                // Safer: e.objectType === 'Item' or just check name
                e.name === 'item' || e.kind === 'Drops' || (e.metadata && e.metadata.length > 0) // rough check
            ).filter(e => e.position.distanceTo(entity.position) < 3);

            for (const drop of drops) {
                const b = bot.blockAt(drop.position);
                if (b && b.name === 'lava') continue;

                // Go get it
                if (!bot.isMining) {
                    try {
                        await bot.pathfinder.goto(new goals.GoalNear(drop.position.x, drop.position.y, drop.position.z, 1));
                    } catch (e) { }
                }
            }
        }
    });

    return handlers;
}

// Build a COMPACT action list grouped by category to save tokens
function getActionList(handlers) {
    // Group actions by category prefix
    const categories = {};
    for (const [name, a] of Object.entries(handlers)) {
        const prefix = name.split('_')[0];
        const cat = {
            follow: 'Movement', go: 'Movement', stop: 'Control', move: 'Movement', run: 'Movement',
            jump: 'Movement', sprint: 'Movement', sneak: 'Movement', stand: 'Movement', look: 'Looking',
            nod: 'Emotes', shake: 'Emotes', wave: 'Emotes', dance: 'Emotes', spin: 'Emotes',
            celebrate: 'Emotes', sit: 'Emotes',
            attack: 'Combat', kill: 'Combat', shield: 'Combat', guard: 'Combat', flee: 'Combat',
            dig: 'Mining', mine: 'Mining', chop: 'Mining', strip: 'Mining', find: 'Navigation',
            craft: 'Crafting', list: 'Info', smelt: 'Smelting', cook: 'Smelting',
            collect: 'Collection', drop: 'Inventory', equip: 'Inventory', unequip: 'Inventory',
            hold: 'Inventory', eat: 'Survival', use: 'Interaction', activate: 'Interaction',
            place: 'Building', build: 'Building',
            say: 'Info', count: 'Info',
            open: 'Chests', deposit: 'Chests', take: 'Chests',
            sleep: 'Interaction', wake: 'Interaction', fish: 'Interaction', fill: 'Survival',
            explore: 'Navigation', patrol: 'Navigation', mimic: 'Special', hunt: 'Survival',
            do: 'General',
        }[prefix] || 'Other';
        if (!categories[cat]) categories[cat] = [];
        categories[cat].push(name);
    }
    // Build compact string
    return Object.entries(categories)
        .map(([cat, actions]) => `[${cat}] ${actions.join(', ')}`)
        .join('\n');
}

// ─── Build System Prompt ────────────────────────────────────
function buildPrompt(actionList, username, message, botState) {
    return `You are an autonomous Minecraft bot. You take initiative and handle tasks independently. When a player asks you to do something, pick the BEST action that fully accomplishes their goal without needing further instructions.

ACTIONS (pick one):
${actionList}

KEY ACTIONS GUIDE:
- survival_setup: THE ULTIMATE STARTER — gathers wood, makes tools, builds base, gets food
- get_full_iron/get_full_diamond: FULLY AUTONOMOUS — gets full set of armor AND tools
- get_wooden_tools/stone/iron/gold/diamond: autonomously gets full tool set of that tier
- get_leather_armor/iron/gold/diamond: autonomously gets full armor set
- build_base: builds shelter, crafting table, furnace, bed, chest, torches
- get_food: hunts and cooks food
- get_bow_and_arrows/get_shield: crafts weapons
- mine_diamonds/mine_and_smelt_iron/gold/copper: autonomous mining & smelting sequences
- gear_up: best possible gear from current inventory
- craft_item: for single specific items only
- find_and_mine_block/chop_tree: specific gathering
- do_nothing: for chat

IMPORTANT: ALWAYS prefer the autonomous actions (e.g. "get_full_iron", "build_base", "survival_setup") over manual steps. If the player says "get everything" or "start survival", use survival_setup.
NEGATIVE COMMANDS: If the user says "don't stop", "keep going", "continue", or uses negation (e.g. "don't mine"), do NOT select the action they are negating. If they say "don't stop", reply with "do_nothing" (or "none") and a message saying you will continue.

Status: HP:${botState.health}/20 Food:${botState.food}/20 Pos:${botState.x},${botState.y},${botState.z} Held:${botState.heldItem}
Player: ${username}
Msg: ${message}

Respond in ONLY this JSON (1 short sentence, be fun):
{"action":"name","target":"${username}","message":"response"}`;
}

// ─── Create Bot ─────────────────────────────────────────────
function createBot() {
    console.log(`[Bot] Connecting to ${SERVER_HOST}:${SERVER_PORT}...`);

    const bot = mineflayer.createBot({
        host: SERVER_HOST,
        port: SERVER_PORT,
        username: BOT_USERNAME,
        version: false, // Auto-detect
        auth: 'offline',
        checkTimeoutInterval: 60 * 1000 // Increase timeout to 60s (default 30s)
    });

    let actionHandlers = null;
    let actionList = '';

    bot.on('login', () => console.log(`[Bot] Logged in as ${bot.username}`));

    bot.on('spawn', () => {
        console.log(`[Bot] Spawned in the world! Version: ${bot.version}`);
        bot.loadPlugin(pathfinder);
        const mcData = require('minecraft-data')(bot.version);
        bot.registry = mcData;

        // Heartbeat to prove life
        setInterval(() => {
            console.log(`[System] Heartbeat: Bot is alive at ${bot.entity.position}`);
        }, 30000);

        // Auto-eat listener
        bot.isEating = false;
        bot.on('health', async () => {
            if (bot.food < 18 && !bot.isEating) {
                const foods = bot.inventory.items().filter(item =>
                    ['apple', 'bread', 'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton', 'cooked_cod', 'cooked_salmon', 'carrot', 'baked_potato', 'golden_carrot'].includes(item.name)
                );
                // consistent sort: best food first? or just any?
                // simple: just pick the first found high value one
                const food = foods.find(f => f.name.includes('cooked')) || foods[0];

                if (food) {
                    bot.isEating = true;
                    try {
                        // If digging, stop to eat
                        try { bot.stopDigging(); } catch (e) { }

                        const previousItem = bot.inventory.slots[bot.getEquipmentDestSlot('hand')];
                        await bot.equip(food, 'hand');
                        bot.chat("I'm getting hungry, eating " + food.displayName + "...");
                        await bot.consume();

                        // Re-equip previous if we had one (helpful for continuity)
                        if (previousItem) {
                            // verify it's still there
                            if (bot.inventory.items().some(i => i.name === previousItem.name)) {
                                await bot.equip(previousItem, 'hand');
                            }
                        }
                    } catch (e) {
                        console.log("[AutoEat] Failed to eat: " + e.message);
                    }
                    bot.isEating = false;
                }
            }
        });

        if (!mcData) {
            console.log(`[Error] minecraft-data returned null for version: ${bot.version}`);
            return;
        }
        console.log(`[Bot] Loaded mcData for version: ${mcData.version?.minecraftVersion}`);
        const moves = new Movements(bot, mcData);
        moves.allowSprinting = true;
        bot.pathfinder.setMovements(moves);

        actionHandlers = buildActionHandlers(bot);
        actionList = getActionList(actionHandlers);
        console.log(`[Actions] Loaded ${Object.keys(actionHandlers).length} actions`);
        startAntiAFK(bot);

        // Auto-swim physics handler
        bot.on('physicsTick', () => {
            if (bot.pathfinder.isMoving()) return; // Let pathfinder handle its own movement
            if (bot.entity.isInWater) {
                bot.setControlState('jump', true);
            } else {
                bot.setControlState('jump', false);
            }
        });
    });




    // ─── Chat Handler ──────────────────────────────────────
    bot.on('chat', async (username, message) => {
        if (username === bot.username) return;

        const lowerMsg = message.toLowerCase();
        const botNameLower = bot.username.toLowerCase();
        if (!lowerMsg.includes('bot') && !lowerMsg.includes(botNameLower)) return;

        console.log(`[Chat] ${username}: ${message}`);

        try {
            const botState = {
                health: Math.round(bot.health || 20),
                food: Math.round(bot.food || 20),
                x: Math.round(bot.entity.position.x),
                y: Math.round(bot.entity.position.y),
                z: Math.round(bot.entity.position.z),
                heldItem: bot.heldItem?.displayName || 'nothing',
            };

            const prompt = buildPrompt(actionList, username, message, botState);
            let response = await askAI(prompt);

            // Parse the JSON response
            console.log(`[AI Raw] ${response}`);

            // Extract JSON from the response (handle markdown code blocks too)
            let jsonStr = response;
            const jsonMatch = response.match(/\{[\s\S]*?\}/);
            if (jsonMatch) jsonStr = jsonMatch[0];

            let parsed;
            try {
                parsed = JSON.parse(jsonStr);
            } catch (e) {
                console.error("[JSON] Failed to parse AI response:", e.message);
                bot.chat("My brain glitched! " + bot.username + " needs a reboot/check.");
                return;
            }

            const actionName = parsed.action;
            const target = parsed.target;
            const chatMsg = parsed.message;

            // Execute the action silently
            if (actionName !== 'do_nothing' && actionName !== 'none' && actionHandlers[actionName]) {
                // AUTO-INTERRUPT: If doing a new task, stop mining/continuous tasks
                if (bot.isMining) {
                    const stopMsg = "Okay, stopping mining to do that.";
                    bot.chat(stopMsg);

                    bot.isMining = false;
                    bot.miningTarget = null;
                    bot.pathfinder.stop();
                }

                console.log(`[Action] Executing: ${actionName} (target: ${target})`);
                try {
                    const result = await actionHandlers[actionName].fn(target);
                    if (result === 'skip_chat') return; // Action already sent its own chat
                    if (result === 'empty_inventory') {
                        const emptyMsg = "My inventory is empty!";
                        bot.chat(emptyMsg);

                        return;
                    }
                } catch (err) {
                    console.error(`[Action] Error in ${actionName}:`, err.message);
                }
            } else if (actionName !== 'do_nothing' && actionName !== 'none') {
                console.log(`[Action] Unknown action: ${actionName}`);
            }

            // Send the chat response AND speak it
            if (chatMsg && chatMsg.length > 0) {
                const trimmed = chatMsg.length > 250 ? chatMsg.substring(0, 247) + '...' : chatMsg;
                bot.chat(trimmed);

            }

        } catch (err) {
            console.error('[Chat] Error processing message:', err);
        }
    });
    // ─── Error Handling ────────────────────────────────────
    let wasKicked = false;

    bot.on('kicked', (reason) => {
        wasKicked = true;
        console.warn('[Bot] Kicked:', reason);
    });

    bot.on('error', (err) => console.error('[Bot] Error:', err.message));

    bot.on('end', (reason) => {
        console.log('[Bot] Disconnected:', reason);
        if (wasKicked || reason === 'differentVersionError') {
            console.log('[Bot] Waiting 30 seconds...');
            setTimeout(createBot, 30000);
        } else {
            console.log('[Bot] Reconnecting in 10 seconds...');
            setTimeout(createBot, 10000);
        }
    });

    return bot;
}

// ─── Anti-AFK ───────────────────────────────────────────────
function startAntiAFK(bot) {
    setInterval(() => {
        if (!bot.entity) return;
        const yaw = Math.random() * Math.PI * 2;
        const pitch = (Math.random() - 0.5) * Math.PI;
        bot.look(yaw, pitch, false);
    }, 15000);
}

// ─── Start ──────────────────────────────────────────────────
createBot();
