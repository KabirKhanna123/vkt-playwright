// VKT Entrypoint — runs seeder first, then scraper
const { execSync } = require('child_process');

async function run() {
  const mode = process.env.MODE || 'scrape';

  if (mode === 'seed') {
    console.log('🌱 Running seeder...');
    require('./seeder');
  } else if (mode === 'both') {
    console.log('🌱 Running seeder then scraper...');
    // Seeder runs synchronously via require
    // After it completes, run scraper
    const { execFileSync } = require('child_process');
    execFileSync('node', ['seeder.js'], { stdio: 'inherit' });
    require('./scraper');
  } else {
    console.log('🎟 Running scraper...');
    require('./scraper');
  }
}

run().catch(e => {
  console.error(e);
  process.exit(1);
});
