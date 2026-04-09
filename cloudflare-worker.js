export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const cache = caches.default;

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

        // 2. SECURITY: HMAC Validation (Rolling 3-Minute Tickets)
        const token = url.searchParams.get('token');
        const expires = parseInt(url.searchParams.get('expires') || '0');
        const fullPath = url.pathname;
        const secret = env.HASH_SECRET || "quest-archive-fallback-secret"; 

        if (!token || !expires || (Date.now() / 1000) > expires) {
            return new Response('Access Denied: Link Expired (3min) 🚫', { status: 403 });
        }

        // Verify HMAC signature
        const encoder = new TextEncoder();
        const keyData = encoder.encode(secret);
        const key = await crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
        const signature = encoder.encode(`${fullPath}:${expires}`);
        const tokenBytes = new Uint8Array(token.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
        
        const isValid = await crypto.subtle.verify('HMAC', key, tokenBytes, signature);
        if (!isValid) return new Response('Access Denied: Forged Token 🚫', { status: 403 });

        // 3. Cache Management
        const range = request.headers.get('Range');
        const cacheKey = new Request(request.url, { headers: { 'Range': range || '' } });
        let response = await cache.match(cacheKey);
        let cacheHit = true;

        if (!response) {
            cacheHit = false;
            url.host = 's3.us-west-004.backblazeb2.com';
            
            // STREAMING PASS-THROUGH: Directly pipe B2 body to user while cache backgrounding
            response = await fetch(url.toString(), {
                method: 'GET',
                headers: request.headers
            });

            if (response.status === 206 || response.status === 200) {
                response = new Response(response.body, response);
                response.headers.set('Cache-Control', 'public, max-age=2592000');
                ctx.waitUntil(cache.put(cacheKey, response.clone()));
            }
        }

        const finalResponse = new Response(response.body, response);
        finalResponse.headers.set('Access-Control-Allow-Origin', '*');
        finalResponse.headers.set('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges, ETag');
        finalResponse.headers.set('X-Cache-Status', cacheHit ? 'HIT' : 'MISS');
        return finalResponse;
    }
};
