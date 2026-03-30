import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, '..', '..');

const legacyDbKey = process.env.R2_DB_KEY || '';
const legacyMapKey = process.env.R2_MD5_MAP_KEY || 'map_md5.json';

const insecureDbKey = !legacyDbKey || legacyDbKey === 'database.json';
const insecureMapKey = !legacyMapKey || legacyMapKey === 'map_md5.json';

const effectiveDbKey = insecureDbKey ? 'private/database.json' : legacyDbKey;
const effectiveMapKey = insecureMapKey ? 'private/map_md5.json' : legacyMapKey;
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
    HASH_SECRET: process.env.HASH_SECRET || process.env.R2_SECRET_ACCESS_KEY || process.env.JWT_SECRET || 'quest-archive-fallback-secret',
    USERS: loadUserRoles(),
    R2: {
        ENDPOINT: isCfOn ? (process.env.R2_ENDPOINT || '') : '',
        ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID || '',
        SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY || '',
        BUCKET_NAME: process.env.R2_BUCKET_NAME || 'quest-archive',
        PUBLIC_DOMAIN: isCfOn ? (process.env.R2_PUBLIC_DOMAIN || '') : '',
        DB_KEY: effectiveDbKey,
        MD5_MAP_KEY: effectiveMapKey,
        SILENT_LOGS_KEY: 'private/silent_logs.json',
        LEGACY_DB_KEY: insecureDbKey ? 'database.json' : '',
        LEGACY_MD5_MAP_KEY: insecureMapKey ? 'map_md5.json' : ''
    },
    DONATIONS: {
        BUCKET_NAME: process.env.DONATIONS_R2_BUCKET_NAME || 'quest-archive-donations',
        PUBLIC_DOMAIN: process.env.DONATIONS_PUBLIC_DOMAIN || ''
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

export function getR2EndpointBase(rawEndpoint) {
    if (!rawEndpoint) return undefined;
    try {
        const u = new URL(rawEndpoint);
        return `${u.protocol}//${u.host}`;
    } catch {
        return rawEndpoint;
    }
}

export function validateEnv() {
    const warnings = [];
    if (!config.ADMIN_PASSWORD) warnings.push('ADMIN_PASSWORD is not set — admin panel will be inaccessible');
    if (!process.env.HASH_SECRET) warnings.push('HASH_SECRET is not set — hashing will fall back to R2_SECRET_ACCESS_KEY (set HASH_SECRET for dedicated stable IDs)');
    if (!config.R2.ENDPOINT) warnings.push('R2_ENDPOINT is not set — uploads and downloads will fail');
    if (!config.R2.ACCESS_KEY_ID) warnings.push('R2_ACCESS_KEY_ID is not set');
    if (!config.R2.SECRET_ACCESS_KEY) warnings.push('R2_SECRET_ACCESS_KEY is not set');
    if (!config.R2.BUCKET_NAME) warnings.push('R2_BUCKET_NAME is not set');

    if (warnings.length) {
        console.warn('\n⚠️  Environment warnings:');
        warnings.forEach(w => console.warn(`   • ${w}`));
        console.warn('');
    }
    return warnings.length === 0;
}
