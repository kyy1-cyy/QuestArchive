import { readJsonFromR2 } from './src/utils/s3-helpers.js';
import { config } from './src/utils/config.js';

async function test() {
    console.log('Reading from R2:', config.R2.SILENT_LOGS_KEY);
    const logs = await readJsonFromR2(config.R2.SILENT_LOGS_KEY, 'FAILED');
    console.log('Logs retrieved:', JSON.stringify(logs, null, 2));
}

test().catch(console.error);
