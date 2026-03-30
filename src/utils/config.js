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

export const config = {
    CLOUDFLARE_ON: isCfOn,
    PORT: process.env.PORT || 3000,
    JWT_SECRET: process.env.JWT_SECRET || 'quest-archive-fallback-secret',
    HASH_SECRET: process.env.HASH_SECRET || process.env.R2_SECRET_ACCESS_KEY || process.env.JWT_SECRET || 'quest-archive-fallback-secret',
    USERS: {
        // Owner
        "668b58aa84fb347730ca27173284c5088b0755489a069bf4fc441f1d51ee0484": { username: "JJ", role: "owner" },
        // Admins
        "3dca71347dbcdd78474c3682aebaafe0e3e35b3083309bf1de13c6cbac0b7046": { username: "tear", role: "admin" },
        "c319dab3621832e35944604c9b7f0caf92dbad8664d3000f2d4a3d44cfee2ee7": { username: "misterio", role: "admin" },
        // Moderators
        "93519cf6389b13524b3c52bf0962db829dd0500b0a76945dceca1157141ced58": { username: "fowntain", role: "moderator" },
        "3068cc09d96b99b06acff516854bd63740e2f98bc67eed4828218848e90ebdc6": { username: "!.oxsn4", role: "moderator" },
        "65d91526edfca74db25bd4aeb701b04bd5597b92ca17f0f2f16f919ee4778654": { username: "lumi", role: "moderator" },
        "1d9ba28d1e4f01813338a4553cbce08c01741927f60e490c4dc0d1c8d5aef8bf": { username: "jar", role: "moderator" }
    },
    R2: {
        ENDPOINT: isCfOn ? (process.env.R2_ENDPOINT || '') : '',
        ACCESS_KEY_ID: isCfOn ? (process.env.R2_ACCESS_KEY_ID || '') : '',
        SECRET_ACCESS_KEY: isCfOn ? (process.env.R2_SECRET_ACCESS_KEY || '') : '',
        BUCKET_NAME: isCfOn ? (process.env.R2_BUCKET_NAME || 'quest-archive') : '',
        PUBLIC_DOMAIN: isCfOn ? (process.env.R2_PUBLIC_DOMAIN || '') : '',
        DB_KEY: effectiveDbKey,
        MD5_MAP_KEY: effectiveMapKey,
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
