import archiver from 'archiver';
import { Upload } from '@aws-sdk/lib-storage';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { config } from './config.js';
import { s3Client } from './s3.js';
import { listTopLevelFolders, listAllObjects, md5Newline } from './s3-helpers.js';
import { readDB, writeDB, makePublicId } from './db.js';
import { logger } from './logger.js';
import { PassThrough } from 'stream';

const migrationState = {
    inProgress: false,
    currentFolder: '',
    processed: 0,
    total: 0,
    errors: [],
    logs: []
};

function addLog(msg) {
    const timestamp = new Date().toLocaleTimeString();
    migrationState.logs.unshift(`[${timestamp}] ${msg}`);
    if (migrationState.logs.length > 100) migrationState.logs.pop();
    logger.info(`Migration: ${msg}`);
}

export function getMigrationStatus() {
    return { ...migrationState };
}

async function zipAndUploadFolder(folderName) {
    const hashId = md5Newline(folderName);
    const targetKey = `${hashId}.zip`;
    
    addLog(`Zipping folder: "${folderName}" -> ${targetKey}`);
    
    // 1. List all objects in the folder
    const prefix = `${folderName}/`;
    const objects = await listAllObjects(prefix);
    
    if (objects.length === 0) {
        throw new Error(`Folder "${folderName}" is empty or not found.`);
    }

    // 2. Setup streaming pipeline
    const passThrough = new PassThrough();
    const archive = archiver('zip', { zlib: { level: 6 } });
    
    archive.on('error', (err) => { throw err; });
    archive.pipe(passThrough);

    // 3. Setup R2 Upload
    const upload = new Upload({
        client: s3Client,
        params: {
            Bucket: config.R2.BUCKET_NAME,
            Key: targetKey,
            Body: passThrough,
            ContentType: 'application/zip'
        },
        partSize: 10 * 1024 * 1024, // 10MB parts
        queueSize: 4
    });

    // 4. Add files to archive
    for (const obj of objects) {
        const fileKey = obj.Key;
        const relativePath = fileKey.slice(prefix.length);
        
        const getCommand = new GetObjectCommand({
            Bucket: config.R2.BUCKET_NAME,
            Key: fileKey
        });
        
        const response = await s3Client.send(getCommand);
        archive.append(response.Body, { name: relativePath });
    }

    // 5. Finalize archive and wait for upload
    const archiveFinalize = archive.finalize();
    await Promise.all([archiveFinalize, upload.done()]);
    
    addLog(`Successfully uploaded: ${targetKey}`);
    return hashId;
}

export async function runMigration() {
    if (migrationState.inProgress) return;
    migrationState.inProgress = true;
    migrationState.errors = [];
    migrationState.processed = 0;
    migrationState.logs = [];
    
    try {
        addLog('Starting migration task...');
        const folders = await listTopLevelFolders();
        migrationState.total = folders.length;
        addLog(`Found ${folders.length} top-level folders.`);

        const games = await readDB();
        
        for (const folder of folders) {
            migrationState.currentFolder = folder;
            try {
                const hashId = await zipAndUploadFolder(folder);
                
                // Add to database if not already there
                const exists = games.find(g => g.hashId === hashId);
                if (!exists) {
                    games.push({
                        id: Date.now().toString() + Math.random().toString(36).slice(2, 5),
                        publicId: makePublicId(),
                        title: folder,
                        hashId: hashId,
                        category: 'Uncategorized',
                        version: '1.0',
                        description: `Migrated from folder: ${folder}`,
                        thumbnailUrl: 'https://via.placeholder.com/300x400?text=Migrated',
                        lastUpdated: new Date().toISOString()
                    });
                    await writeDB(games);
                }
                
                migrationState.processed++;
                addLog(`Progress: ${migrationState.processed}/${migrationState.total}`);
            } catch (err) {
                const msg = `Failed for "${folder}": ${err.message}`;
                addLog(msg);
                migrationState.errors.push(msg);
            }
        }
        
        addLog('Migration task completed.');
    } catch (err) {
        addLog(`Fatal migration error: ${err.message}`);
    } finally {
        migrationState.inProgress = false;
        migrationState.currentFolder = '';
    }
}
