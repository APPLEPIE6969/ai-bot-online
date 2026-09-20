const mcData = require('minecraft-data')('1.21.1');
const id = mcData.itemsByName['furnace']?.id;
console.log('Furnace ID:', id);

const recipes = mcData.recipes[id];
if (recipes) {
    console.log(`Found ${recipes.length} recipes in mcData.recipes`);
    recipes.forEach((r, i) => {
        console.log(`Recipe ${i}:`, JSON.stringify(r, null, 2));
    });
} else {
    console.log('No recipes found in mcData.recipes');
}

process.exit(0);
