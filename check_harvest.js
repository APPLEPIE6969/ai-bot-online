const mcData = require('minecraft-data')('1.21.1');

function check(name) {
    const block = mcData.blocksByName[name];
    console.log(`--- ${name} ---`);
    if (!block || !block.harvestTools) {
        console.log('No harvestTools');
        return;
    }
    const tools = Object.keys(block.harvestTools).map(id => {
        const item = mcData.items[id];
        return item ? item.name : id;
    });
    console.log('Valid tools:', tools.join(', '));
}

check('stone');
check('dirt');
check('grass_block');
check('gravel');

process.exit(0);
