export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        // 1. Handle CORS preflight
        if (request.method === 'OPTIONS') {
            return new Response(null, {
                status: 204,
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
                    'Access-Control-Allow-Headers': 'Range, Content-Type',
                    'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges, ETag',
                    'Access-Control-Max-Age': '86400'
                }
            });
        }

        // 2. SECURITY BYPASS: Thumbnails and Meta files are free to view
        const isPublicMeta = url.pathname.includes('/.meta/') || 
                             url.pathname.endsWith('.png') || 
                             url.pathname.endsWith('.jpg') ||
                             url.pathname.endsWith('.jpeg');

        if (!isPublicMeta) {
            // 3. SECURITY: HMAC Validation (Rolling 3-Minute Tickets)
            const token = url.searchParams.get('token');
            const expires = parseInt(url.searchParams.get('expires') || '0');
            const fullPath = url.pathname;
            const secret = env.HASH_SECRET || "quest-archive-fallback-secret"; 

            if (!token || !expires || (Date.now() / 1000) > expires) {
                return new Response('Access Denied: Link Expired 🚫', { status: 403 });
            }

            // Verify HMAC signature
            const encoder = new TextEncoder();
            const keyData = encoder.encode(secret);
            const key = await crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
            const signature = encoder.encode(`${fullPath}:${expires}`);
            
            // Convert hex token to bytes
            const tokenBytes = new Uint8Array(token.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
            
            const isValid = await crypto.subtle.verify('HMAC', key, tokenBytes, signature);
            if (!isValid) return new Response('Access Denied: Invalid Request 🚫', { status: 403 });
        }

        // 4. HIGH-SPEED STREAMING PROXY
        // We remove the Cache logic here to avoid Cloudflare CPU Throttling on 100MB chunks.
        // 100MB chunks already keep B2 Class B API calls low enough for the free tier.
        url.host = 's3.us-west-004.backblazeb2.com';
        
        const response = await fetch(url.toString(), {
            method: 'GET',
            headers: request.headers,
            redirect: 'follow'
        });

        // Add headers and return the response stream immediately
        const finalResponse = new Response(response.body, response);
        finalResponse.headers.set('Access-Control-Allow-Origin', '*');
        finalResponse.headers.set('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges, ETag');
        
        return finalResponse;
    }
};
