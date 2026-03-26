import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, '..', '..');

export const config = {
    PORT: process.env.PORT || 3000,
    ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || '',
    JWT_SECRET: process.env.JWT_SECRET || 'quest-archive-fallback-secret',
    R2: {
        ENDPOINT: process.env.R2_ENDPOINT || '',
        ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID || '',
        SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY || '',
        BUCKET_NAME: process.env.R2_BUCKET_NAME || 'quest-archive',
        PUBLIC_DOMAIN: process.env.R2_PUBLIC_DOMAIN || '',
        DB_KEY: process.env.R2_DB_KEY || '',
        MD5_MAP_KEY: process.env.R2_MD5_MAP_KEY || 'map_md5.json'
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
