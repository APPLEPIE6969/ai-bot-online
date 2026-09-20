const mcData = require('minecraft-data');
const pc = mcData.versions.pc;
const recent = pc.filter(v => v.minecraftVersion.startsWith('1.21'));
console.log("Found 1.21 versions:");
recent.forEach(v => console.log(`${v.minecraftVersion} (proto ${v.version})`));

const v1211 = pc.find(v => v.minecraftVersion === '1.21.1');
console.log("1.21.1 exists:", !!v1211);
