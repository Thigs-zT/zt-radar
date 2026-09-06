import dotenv from 'dotenv';
dotenv.config();

const STEAM_API_KEY = process.env.STEAM_API_KEY;

// Coloque o seu SteamID64 ou link/vanity aqui para testar:
const TARGET_STEAM_ID = process.argv[2] || 'SEU_STEAM_ID64_AQUI';

async function diagnose() {
    console.log(`\n--- Diagnosticando Wishlist para SteamID: ${TARGET_STEAM_ID} ---`);

    // Teste 1: Endpoint de Loja (store.steampowered.com)
    const storeUrl = `https://store.steampowered.com/wishlist/profiles/${TARGET_STEAM_ID}/wishlistdata/?p=0`;
    console.log(`\n[1] Testando Store Endpoint: ${storeUrl}`);
    try {
        const res = await fetch(storeUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
                'Accept': 'application/json, text/javascript, */*; q=0.01',
                'Referer': `https://store.steampowered.com/wishlist/profiles/${TARGET_STEAM_ID}/`,
            },
        });

        console.log(`Status: ${res.status} ${res.statusText}`);
        console.log(`Redirected: ${res.redirected} -> URL: ${res.url}`);
        console.log(`Content-Type: ${res.headers.get('content-type')}`);

        const text = await res.text();
        console.log(`Inicio da resposta (primeiros 150 caracteres):\n${text.substring(0, 150)}...`);
        try {
            const json = JSON.parse(text);
            const keys = Object.keys(json);
            console.log(`JSON parseado com sucesso! Total de jogos encontrados: ${keys.length}`);
        } catch {
            console.log('Falha ao parsear como JSON (Steam devolveu HTML ou vazio).');
        }
    } catch (err) {
        console.error('Erro no Store Endpoint:', err.message);
    }

    // Teste 2: Web API Oficial (IWishlistService)
    if (STEAM_API_KEY) {
        const apiUrl = `https://api.steampowered.com/IWishlistService/GetWishlist/v1/?steamid=${TARGET_STEAM_ID}`;
        console.log(`\n[2] Testando Official Web API (IWishlistService): ${apiUrl}`);
        try {
            const res = await fetch(apiUrl, {
                headers: {
                    'x-webapi-key': STEAM_API_KEY,
                },
            });
            console.log(`Status: ${res.status} ${res.statusText}`);
            const data = await res.json();
            console.log('Resposta Web API:', JSON.stringify(data).substring(0, 200));
            if (data?.response?.items) {
                console.log(`Sucesso na Web API! Total de itens: ${data.response.items.length}`);
            }
        } catch (err) {
            console.error('Erro na Web API:', err.message);
        }
    } else {
        console.log('\n[2] STEAM_API_KEY ausente no .env para testar IWishlistService.');
    }
}

diagnose();