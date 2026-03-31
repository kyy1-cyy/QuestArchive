import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, '..', '..');

const rawCf = String(process.env.cloudfare_on || process.env.CLOUDFLARE_ON || 'true').trim().toLowerCase();
const isCfOn = rawCf === 'true' || rawCf === '1' || rawCf === 'yes' || rawCf === 'on';

function loadUserRoles() {
    const users = {};
    for (const key in process.env) {
        let role = '';
        if (key.startsWith('owner_')) role = 'owner';
        else if (key.startsWith('admin_')) role = 'admin';
        else if (key.startsWith('mod_')) role = 'moderator';

        if (role) {
            const username = key.split('_').slice(1).join('_');
            const hash = process.env[key].trim();
            if (hash && username) {
                users[hash] = { username, role };
            }
        }
    }
    return users;
}

export const config = {
    CLOUDFLARE_ON: isCfOn,
    PORT: process.env.PORT || 3000,
    JWT_SECRET: process.env.JWT_SECRET || 'quest-archive-fallback-secret',
    HASH_SECRET: process.env.HASH_SECRET || process.env.B2_APP_KEY || process.env.JWT_SECRET || 'quest-archive-fallback-secret',
    USERS: loadUserRoles(),
    B2: {
        ENDPOINT: process.env.B2_ENDPOINT || '',
        KEY_ID: process.env.B2_KEY_ID || '',
        APP_KEY: process.env.B2_APP_KEY || '',
        BUCKET_NAME: process.env.B2_BUCKET_NAME || 'quest-archive',
        DB_KEY: 'private/database.json',
        MD5_MAP_KEY: 'private/map_md5.json',
        SILENT_LOGS_KEY: 'private/silent_logs.json',
        GAME_CACHE_KEY: 'private/game_cache.json',
        DOWNLOAD_BASE_URL: process.env.DOWNLOAD_BASE_URL || ''
    },
    DONATIONS: {
        ENDPOINT: process.env.B2_ENDPOINT || '',
        KEY_ID: process.env.B2_DONATIONS_KEY_ID || '',
        APP_KEY: process.env.B2_DONATIONS_APP_KEY || '',
        BUCKET_NAME: process.env.B2_DONATIONS_BUCKET_NAME || 'quest-archive-donos'
    },
    GITHUB: {
        OWNER: process.env.GITHUB_OWNER || 'kyy1-cyy',
        REPO: process.env.GITHUB_REPO || 'QuestArchive',
        BRANCH: process.env.GITHUB_BRANCH || 'main',
        IMAGES_PATH: process.env.GITHUB_IMAGES_PATH || 'data',
        TOKEN: process.env.GITHUB_TOKEN || ''
    },
    PATHS: {
        ROOT: rootDir,
        DATA: path.join(rootDir, 'data'),
        DB: path.join(rootDir, 'data', 'database.txt'),
        PUBLIC: path.join(rootDir, 'public')
    }
};

export function validateEnv() {
    const warnings = [];
    if (!config.B2.ENDPOINT) warnings.push('B2_ENDPOINT is not set — uploads and downloads will fail');
    if (!config.B2.KEY_ID) warnings.push('B2_KEY_ID is not set');
    if (!config.B2.APP_KEY) warnings.push('B2_APP_KEY is not set');
    if (!config.B2.BUCKET_NAME) warnings.push('B2_BUCKET_NAME is not set');

    if (warnings.length) {
        console.warn('\n⚠️  Environment warnings:');
        warnings.forEach(w => console.warn(`   • ${w}`));
        console.warn('');
    }
    return warnings.length === 0;
}
