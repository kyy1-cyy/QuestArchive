import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, '..', '..');

const rawCf = String(process.env.cloudfare_on || process.env.CLOUDFLARE_ON || 'true').trim().toLowerCase();
const isCfOn = rawCf === 'true' || rawCf === '1' || rawCf === 'yes' || rawCf === 'on';

function envFirst(...keys) {
    for (const key of keys) {
        const value = process.env[key];
        if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return '';
}

const hasCompleteR2Config = Boolean(
    envFirst('R2_ENDPOINT') &&
    envFirst('R2_ACCESS_KEY_ID') &&
    envFirst('R2_SECRET_ACCESS_KEY') &&
    envFirst('R2_BUCKET_NAME')
);

const hasExplicitB2Config = Boolean(
    envFirst(
        'B2_KEY_ID',
        'B2_APP_KEY',
        'B2_APPLICATION_KEY_ID',
        'B2_APPLICATION_KEY',
        'B2_ENDPOINT',
        'BACKBLAZE_B2_ENDPOINT',
        'B2_BUCKET_NAME',
        'BACKBLAZE_B2_BUCKET',
        'BACKBLAZE_BUCKET_NAME',
        'BACKBLAZE_KEY_ID',
        'BACKBLAZE_APPLICATION_KEY_ID',
        'BACKBLAZE_APP_KEY',
        'BACKBLAZE_APPLICATION_KEY'
    )
);

const useR2PrimaryStorage = hasCompleteR2Config && !hasExplicitB2Config;

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
    HASH_SECRET: process.env.HASH_SECRET || envFirst('B2_APP_KEY', 'B2_APPLICATION_KEY', 'R2_SECRET_ACCESS_KEY') || process.env.JWT_SECRET || 'quest-archive-fallback-secret',
    USERS: loadUserRoles(),
    B2: {
        ENDPOINT: useR2PrimaryStorage
            ? envFirst('R2_ENDPOINT')
            : (envFirst('B2_ENDPOINT', 'BACKBLAZE_B2_ENDPOINT') || 'https://s3.us-west-004.backblazeb2.com'),
        KEY_ID: useR2PrimaryStorage
            ? envFirst('R2_ACCESS_KEY_ID')
            : envFirst('B2_KEY_ID', 'B2_APPLICATION_KEY_ID', 'BACKBLAZE_KEY_ID', 'BACKBLAZE_APPLICATION_KEY_ID'),
        APP_KEY: useR2PrimaryStorage
            ? envFirst('R2_SECRET_ACCESS_KEY')
            : envFirst('B2_APP_KEY', 'B2_APPLICATION_KEY', 'BACKBLAZE_APP_KEY', 'BACKBLAZE_APPLICATION_KEY'),
        BUCKET_NAME: useR2PrimaryStorage
            ? envFirst('R2_BUCKET_NAME')
            : (envFirst('B2_BUCKET_NAME', 'BACKBLAZE_B2_BUCKET', 'BACKBLAZE_BUCKET_NAME') || 'quest-archive'),
        DB_KEY: useR2PrimaryStorage ? envFirst('R2_DB_KEY', 'B2_DB_KEY') || 'database.json' : envFirst('B2_DB_KEY') || 'private/database.json',
        MD5_MAP_KEY: useR2PrimaryStorage ? envFirst('R2_MD5_MAP_KEY', 'B2_MD5_MAP_KEY') || 'map_md5.json' : envFirst('B2_MD5_MAP_KEY') || 'private/map_md5.json',
        SILENT_LOGS_KEY: useR2PrimaryStorage ? envFirst('R2_SILENT_LOGS_KEY', 'B2_SILENT_LOGS_KEY') || 'silent_logs.json' : envFirst('B2_SILENT_LOGS_KEY') || 'private/silent_logs.json',
        GAME_CACHE_KEY: useR2PrimaryStorage ? envFirst('R2_GAME_CACHE_KEY', 'B2_GAME_CACHE_KEY') || 'game_cache.json' : envFirst('B2_GAME_CACHE_KEY', 'GAME_CACHE_KEY') || 'game_cache.json',
        DOWNLOAD_BASE_URL: envFirst('DOWNLOAD_BASE_URL', 'B2_DOWNLOAD_BASE_URL', 'BACKBLAZE_DOWNLOAD_BASE_URL')
    },
    DONATIONS: {
        ENDPOINT: envFirst('DONATIONS_ENDPOINT', 'B2_DONATIONS_ENDPOINT', 'DONATIONS_R2_ENDPOINT', 'B2_ENDPOINT', 'R2_ENDPOINT', 'BACKBLAZE_DONATIONS_ENDPOINT', 'BACKBLAZE_B2_ENDPOINT'),
        KEY_ID: envFirst('DONATIONS_KEY_ID', 'B2_DONATIONS_KEY_ID', 'B2_DONATIONS_APPLICATION_KEY_ID', 'DONATIONS_R2_ACCESS_KEY_ID', 'BACKBLAZE_DONATIONS_KEY_ID'),
        APP_KEY: envFirst('DONATIONS_APP_KEY', 'B2_DONATIONS_APP_KEY', 'B2_DONATIONS_APPLICATION_KEY', 'DONATIONS_R2_SECRET_ACCESS_KEY', 'BACKBLAZE_DONATIONS_APP_KEY'),
        BUCKET_NAME: envFirst('DONATIONS_BUCKET_NAME', 'B2_DONATIONS_BUCKET_NAME', 'DONATIONS_R2_BUCKET_NAME', 'BACKBLAZE_DONATIONS_BUCKET_NAME') || 'quest-archive-donos'
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
