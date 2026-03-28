import { GetObjectCommand } from '@aws-sdk/client-s3';
import { s3Client } from './s3.js';
import { config } from './config.js';

let listCache = null;
let lastFetch = 0;

async function streamToString(stream) {
    const chunks = [];
    for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString('utf-8');
}

async function fetchGameList() {
    const now = Date.now();
    // Cache for 10 minutes
    if (listCache && (now - lastFetch < 10 * 60 * 1000)) {
        return listCache;
    }
    try {
        console.log('[GameList] Fetching VRP-GameList.txt from R2...');
        const command = new GetObjectCommand({
            Bucket: config.R2.BUCKET_NAME,
            Key: 'VRP-GameList.txt'
        });
        const response = await s3Client.send(command);
        if (!response.Body) return null;
        
        const text = await streamToString(response.Body);
        listCache = text;
        lastFetch = now;
        console.log(`[GameList] successfully loaded and cached (${text.length} bytes)`);
        return listCache;
    } catch (err) {
        console.error('[GameList] Failed to fetch VRP-GameList.txt from R2:', err.message);
        return null; // keep old cache if exists, or return null
    }
}

export async function getPackageNameFromList(filename) {
    const text = await fetchGameList();
    if (!text) return null;
    
    // Example CSV row:
    // Game Name;Release Name;Package Name;Version Code...
    // Strip external .zip if provided
    const searchName = filename.replace(/\.zip$/i, '').trim().toLowerCase();
    
    const lines = text.split(/\r?\n/);
    for (let i = 1; i < lines.length; i++) { // skip header
        const line = lines[i];
        if (!line.trim()) continue;
        
        const parts = line.split(';');
        if (parts.length >= 3) {
            const releaseName = parts[1].trim().toLowerCase();
            
            // Allow exact match or if releaseName is exactly the base name
            if (releaseName === searchName) {
                const pkgName = parts[2].trim();
                console.log(`[GameList] Found package for "${filename}": ${pkgName}`);
                return pkgName;
            }
        }
    }
    
    console.log(`[GameList] No matching package found for "${filename}"`);
    return null;
}
