import { GetObjectCommand } from '@aws-sdk/client-s3';
import { s3Client } from './s3.js';
import { config } from './config.js';

let cachedMap = null;
let lastFetch = 0;

async function streamToString(stream) {
    const chunks = [];
    for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString('utf-8');
}

async function fetchGameMap() {
    const now = Date.now();
    // Cache for 10 minutes
    if (cachedMap && (now - lastFetch < 10 * 60 * 1000)) {
        return cachedMap;
    }
    try {
        console.log('[GameList] Fetching VRP-GameList.txt from B2...');
        const command = new GetObjectCommand({
            Bucket: config.B2.BUCKET_NAME,
            Key: 'VRP-GameList.txt'
        });
        const response = await s3Client.send(command);
        if (!response.Body) return null;
        
        const text = await streamToString(response.Body);
        const map = new Map();
        const lines = text.split(/\r?\n/);
        
        for (let i = 1; i < lines.length; i++) {
            const line = lines[i];
            if (!line.trim()) continue;
            
            const parts = line.split(';');
            if (parts.length >= 7) {
                const releaseName = parts[1].trim().toLowerCase();
                const pkgName = parts[2].trim();
                const sizeStr = parts[6].trim();
                let fileSize = 0;
                if (sizeStr) {
                    const parsed = parseInt(sizeStr);
                    if (!isNaN(parsed)) fileSize = parsed;
                }
                map.set(releaseName, { packageName: pkgName, fileSize });
            }
        }
        
        cachedMap = map;
        lastFetch = now;
        console.log(`[GameList] successfully loaded and indexed (${map.size} items)`);
        return cachedMap;
    } catch (err) {
        console.error('[GameList] Failed to fetch VRP-GameList.txt from B2:', err.message);
        return cachedMap; 
    }
}

export async function getPackageNameFromList(filename) {
    const map = await fetchGameMap();
    if (!map) return null;
    
    // Strip external .zip if provided
    const searchName = filename.replace(/\.zip$/i, '').trim().toLowerCase();
    
    const res = map.get(searchName);
    if (res) {
        console.log(`[GameList] Found data for "${filename}": ${res.packageName} (${res.fileSize})`);
        return res;
    }
    
    return null;
}
