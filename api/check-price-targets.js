// api/check-price-targets.js
import { createClient } from '@supabase/supabase-js';

// --- Supabase Admin Client ---
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

// --- Helper: Fetch current prices from the NEPSE API ---
async function getCurrentPrices() {
    const apiUrl = 'https://nepsehub-backend.vercel.app/core/live-nepse';
    try {
        console.log('Fetching live NEPSE data...');
        const response = await fetch(apiUrl);
        if (!response.ok) {
            throw new Error(`API responded with status ${response.status}`);
        }
        const json = await response.json();

        // The API returns: { success: true, data: [ { symbol: "...", lastTradedPrice: ... }, ... ] }
        if (!json.success || !json.data) {
            throw new Error('Unexpected API response structure');
        }

        // Build a price map: { "MBJC": 285, "NIMB": 195, ... }
        const priceMap = {};
        for (const item of json.data) {
            if (item.symbol && item.lastTradedPrice) {
                priceMap[item.symbol] = item.lastTradedPrice;
            }
        }

        console.log(`Fetched prices for ${Object.keys(priceMap).length} symbols.`);
        return priceMap;
    } catch (error) {
        console.error('Failed to fetch NEPSE live data:', error);
        return null; // Return null to indicate failure
    }
}

// --- Main Cron Job Handler ---
export default async function handler(req, res) {
    // 1. Optional security: check for cron secret
    const authHeader = req.headers.authorization;
    if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        console.warn('Unauthorized cron job attempt.');
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const startTime = Date.now();
    console.log('Starting price target check...');

    try {
        // 2. Fetch all active watchlist items
        const { data: watchlist, error: fetchError } = await supabase
            .from('watchlist')
            .select('id, user_id, symbol, target_buy, target_sell, buy_triggered, sell_triggered')
            .or('buy_triggered.eq.false,sell_triggered.eq.false');

        if (fetchError) throw fetchError;

        if (!watchlist || watchlist.length === 0) {
            console.log('No active watchlist items found.');
            return res.status(200).json({ message: 'No active targets to check.' });
        }

        // 3. Fetch current prices from the single NEPSE endpoint
        const currentPrices = await getCurrentPrices();
        if (!currentPrices) {
            throw new Error('Failed to fetch current prices from NEPSE API');
        }

        // 4. Evaluate each item
        const updatesToProcess = [];

        for (const item of watchlist) {
            const currentPrice = currentPrices[item.symbol];
            if (!currentPrice || isNaN(currentPrice)) {
                console.warn(`Skipping ${item.symbol} due to missing price data.`);
                continue;
            }

            // Check Buy Condition
            if (!item.buy_triggered && item.target_buy !== null && currentPrice <= item.target_buy) {
                console.log(`✅ BUY target hit for ${item.symbol}: ${currentPrice} <= ${item.target_buy}`);
                updatesToProcess.push({
                    watchlistId: item.id,
                    userId: item.user_id,
                    symbol: item.symbol,
                    targetPrice: item.target_buy,
                    type: 'buy',
                    price: currentPrice
                });
            }
            // Check Sell Condition
            else if (!item.sell_triggered && item.target_sell !== null && currentPrice >= item.target_sell) {
                console.log(`✅ SELL target hit for ${item.symbol}: ${currentPrice} >= ${item.target_sell}`);
                updatesToProcess.push({
                    watchlistId: item.id,
                    userId: item.user_id,
                    symbol: item.symbol,
                    targetPrice: item.target_sell,
                    type: 'sell',
                    price: currentPrice
                });
            }
        }

        // 5. Process all updates
        if (updatesToProcess.length === 0) {
            console.log('No price targets were hit this cycle.');
            return res.status(200).json({ message: 'No targets hit.' });
        }

        console.log(`Processing ${updatesToProcess.length} target hits...`);
        for (const update of updatesToProcess) {
            // a) Insert a new notification
            const message = `${update.symbol} ${update.type.toUpperCase()} target ${update.targetPrice} was hit! Current price: ${update.price}`;
            const { error: notifError } = await supabase
                .from('notifications')
                .insert({
                    user_id: update.userId,
                    title: `${update.type.toUpperCase()} Alert`,
                    message: message,
                    type: update.type,
                    symbol: update.symbol,
                    is_read: false
                });

            if (notifError) {
                console.error(`Failed to create notification for watchlist ID ${update.watchlistId}:`, notifError);
                continue;
            }

            // b) Mark the specific target as triggered
            const columnToUpdate = update.type === 'buy' ? 'buy_triggered' : 'sell_triggered';
            const { error: updateError } = await supabase
                .from('watchlist')
                .update({ [columnToUpdate]: true })
                .eq('id', update.watchlistId);

            if (updateError) {
                console.error(`Failed to update watchlist ID ${update.watchlistId}:`, updateError);
            }
        }

        const duration = Date.now() - startTime;
        console.log(`Price target check completed in ${duration}ms. Processed ${updatesToProcess.length} hits.`);
        res.status(200).json({ message: 'Success', processedHits: updatesToProcess.length });

    } catch (error) {
        console.error('Critical error in cron job:', error);
        res.status(500).json({ error: 'Internal Server Error', details: error.message });
    }
}