// api/check-price-targets.js
import { createClient } from '@supabase/supabase-js';

// --- Supabase Admin Client ---
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

// --- Helper: Fetch current prices from the NEPSE API ---
async function getCurrentPrices() {
    const apiUrl = 'https://nepse-hub-backend.vercel.app/api/core?route=live-nepse';
    try {
        console.log('Fetching live NEPSE data...');
        const response = await fetch(apiUrl);
        if (!response.ok) {
            throw new Error(`API responded with status ${response.status}`);
        }
        const data = await response.json(); // directly the array

        // Validate that it's an array
        if (!Array.isArray(data)) {
            throw new Error('API response is not an array');
        }

        // Build price map: { "BFC": 538, "SABBL": 902, ... }
        const priceMap = {};
        for (const item of data) {
            if (item.symbol && item.lastTradedPrice !== undefined && item.lastTradedPrice !== null) {
                const price = parseFloat(item.lastTradedPrice);
                if (!isNaN(price)) {
                    priceMap[item.symbol.toUpperCase()] = price; // ensure uppercase
                }
            }
        }

        console.log(`Fetched prices for ${Object.keys(priceMap).length} symbols.`);
        return priceMap;
    } catch (error) {
        console.error('Failed to fetch NEPSE live data:', error);
        return null;
    }
}

// --- Main Cron Job Handler (no authentication) ---
export default async function handler(req, res) {
    const startTime = Date.now();
    console.log('Starting price target check...');

    try {
        // Step 1: Fetch all active watchlist items (buy_triggered or sell_triggered still false)
        const { data: watchlist, error: fetchError } = await supabase
            .from('watchlist')
            .select('id, user_id, symbol, target_buy, target_sell, buy_triggered, sell_triggered')
            .or('buy_triggered.eq.false,sell_triggered.eq.false');

        if (fetchError) throw fetchError;

        if (!watchlist || watchlist.length === 0) {
            console.log('No active watchlist items found.');
            return res.status(200).json({ message: 'No active targets to check.' });
        }

        // Step 2: Fetch all active stop losses from transactions table
        // Assuming stop_loss is a column in transactions table and we track if it's triggered
        // We'll need to add stop_loss_triggered to transactions table or use a flag
        const { data: transactions, error: txError } = await supabase
            .from('transactions')
            .select('id, user_id, symbol, stop_loss, stop_loss_triggered')
            .eq('stop_loss_triggered', false)
            .not('stop_loss', 'is', null);

        if (txError) {
            console.error('Failed to fetch transactions with stop loss:', txError);
            // Continue with watchlist processing even if transactions fail
        }

        // Step 3: Fetch current prices from the single NEPSE endpoint
        const currentPrices = await getCurrentPrices();
        if (!currentPrices) {
            throw new Error('Failed to fetch current prices from NEPSE API');
        }

        // Step 4: Evaluate watchlist items (buy/sell targets)
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
                    price: currentPrice,
                    source: 'watchlist'
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
                    price: currentPrice,
                    source: 'watchlist'
                });
            }
        }

        // Step 5: Evaluate stop losses from transactions table
        if (transactions && transactions.length > 0) {
            for (const tx of transactions) {
                const currentPrice = currentPrices[tx.symbol];
                if (!currentPrice || isNaN(currentPrice)) {
                    console.warn(`Skipping stop loss for ${tx.symbol} due to missing price data.`);
                    continue;
                }

                // Check Stop Loss Condition
                if (currentPrice <= tx.stop_loss) {
                    console.log(`🛑 STOP LOSS hit for ${tx.symbol}: ${currentPrice} <= ${tx.stop_loss}`);
                    updatesToProcess.push({
                        transactionId: tx.id,
                        userId: tx.user_id,
                        symbol: tx.symbol,
                        targetPrice: tx.stop_loss,
                        type: 'stop_loss',
                        price: currentPrice,
                        source: 'transaction'
                    });
                }
            }
        }

        // Step 6: Process all updates
        if (updatesToProcess.length === 0) {
            console.log('No price targets were hit this cycle.');
            return res.status(200).json({ message: 'No targets hit.' });
        }

        console.log(`Processing ${updatesToProcess.length} target hits...`);
        
        for (const update of updatesToProcess) {
            // Insert a new notification
            let title, message;
            
            if (update.type === 'stop_loss') {
                title = 'STOP LOSS Alert';
                message = `${update.symbol} STOP LOSS at ${update.targetPrice} was hit! Current price: ${update.price}`;
            } else {
                title = `${update.type.toUpperCase()} Alert`;
                message = `${update.symbol} ${update.type.toUpperCase()} target ${update.targetPrice} was hit! Current price: ${update.price}`;
            }
            
            const { error: notifError } = await supabase
                .from('notifications')
                .insert({
                    user_id: update.userId,
                    title: title,
                    message: message,
                    type: update.type,
                    symbol: update.symbol,
                    is_read: false
                });

            if (notifError) {
                console.error(`Failed to create notification:`, notifError);
                continue;
            }

            // Mark the specific target as triggered based on source
            if (update.source === 'watchlist') {
                // Update watchlist
                let columnToUpdate = update.type === 'buy' ? 'buy_triggered' : 'sell_triggered';
                const { error: updateError } = await supabase
                    .from('watchlist')
                    .update({ [columnToUpdate]: true })
                    .eq('id', update.watchlistId);

                if (updateError) {
                    console.error(`Failed to update watchlist ID ${update.watchlistId}:`, updateError);
                }
            } else if (update.source === 'transaction' && update.type === 'stop_loss') {
                // Update transactions table - mark stop loss as triggered
                const { error: updateError } = await supabase
                    .from('transactions')
                    .update({ stop_loss_triggered: true })
                    .eq('id', update.transactionId);

                if (updateError) {
                    console.error(`Failed to update transaction ID ${update.transactionId}:`, updateError);
                }
            }
        }

        const duration = Date.now() - startTime;
        console.log(`Price target check completed in ${duration}ms. Processed ${updatesToProcess.length} hits.`);
        res.status(200).json({ 
            message: 'Success', 
            processedHits: updatesToProcess.length,
            watchlistHits: updatesToProcess.filter(u => u.source === 'watchlist').length,
            stopLossHits: updatesToProcess.filter(u => u.source === 'transaction').length
        });

    } catch (error) {
        console.error('Critical error in cron job:', error);
        res.status(500).json({ error: 'Internal Server Error', details: error.message });
    }
}