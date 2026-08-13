// api/check-price-targets.js
import { createClient } from '@supabase/supabase-js';

// --- Supabase Admin Client (Main DB for Watchlist & Transactions) ---
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

// --- Supabase Admin Client (Settings DB - DB2 with DB1 fallback) ---
const supabaseSettingsUrl = process.env.SUPABASE_URL_2 || process.env.SUPABASE_URL2;
const supabaseSettingsKey = process.env.SUPABASE_SERVICE_ROLE_KEY_2 || process.env.SUPABASE_SERVICE_ROLE_KEY2 || process.env.SUPABASE_SECRET_KEY_2;

const supabaseSettings = (supabaseSettingsUrl && supabaseSettingsKey)
    ? createClient(supabaseSettingsUrl, supabaseSettingsKey)
    : supabase;

// --- Helper: Fetch current prices from the NEPSE API ---
async function getCurrentPrices() {
    const apiUrl = 'https://nepse-hub-backend.vercel.app/api/core?route=live-nepse';
    try {
        console.log('Fetching live NEPSE data...');
        const response = await fetch(apiUrl);
        if (!response.ok) {
            throw new Error(`API responded with status ${response.status}`);
        }
        const data = await response.json();

        if (!Array.isArray(data)) {
            throw new Error('API response is not an array');
        }

        const priceMap = {};
        for (const item of data) {
            if (item.symbol && item.lastTradedPrice !== undefined && item.lastTradedPrice !== null) {
                const price = parseFloat(item.lastTradedPrice);
                if (!isNaN(price)) {
                    priceMap[item.symbol.toUpperCase()] = price;
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

// --- Helper: Check if a value is false (works with boolean, string, number) ---
const isFalse = (val) => {
    if (val === undefined || val === null) return false;
    if (typeof val === 'boolean') return val === false;
    if (typeof val === 'string') return val.toLowerCase() === 'false' || val === '0';
    if (typeof val === 'number') return val === 0;
    return false;
};

// --- Main Cron Job Handler ---
export default async function handler(req, res) {
    const startTime = Date.now();
    console.log('Starting price target check...');

    try {
        // Step 1: Fetch all active watchlist items
        const { data: watchlist, error: fetchError } = await supabase
            .from('watchlist')
            .select('id, user_id, symbol, target_buy, target_sell, buy_triggered, sell_triggered')
            .or('buy_triggered.eq.false,sell_triggered.eq.false');

        if (fetchError) throw fetchError;

        // Step 2: Fetch all active stop losses from transactions table
        const { data: transactions, error: txError } = await supabase
            .from('transactions')
            .select('id, user_id, symbol, stop_loss, stop_loss_triggered')
            .eq('stop_loss_triggered', false)
            .not('stop_loss', 'is', null);

        if (txError) {
            console.error('Failed to fetch transactions with stop loss:', txError);
        }

        // Step 3: Fetch current prices
        const currentPrices = await getCurrentPrices();
        if (!currentPrices) {
            throw new Error('Failed to fetch current prices from NEPSE API');
        }

        // Step 3.5: Fetch user alert preferences from user_settings table
        const userSettingsMap = {};
        try {
            console.log('🔍 Fetching user settings from DB...');
            const { data: settingsData, error: settingsError } = await supabaseSettings
                .from('user_settings')
                .select('*');

            if (settingsError) {
                console.warn('⚠️ Could not fetch user_settings:', settingsError.message);
            } else if (settingsData) {
                console.log(`📋 Retrieved ${settingsData.length} user settings records`);
                
                // Debug: Log all user IDs from settings
                console.log('👤 User IDs in settings:', settingsData.map(row => row.user_id));
                
                for (const row of settingsData) {
                    if (row.user_id) {
                        // Store the raw user_id as key (don't convert to lowercase yet)
                        const userKey = String(row.user_id).trim();
                        
                        // Parse preferences if it's a string
                        let prefs = row.preferences || {};
                        if (typeof prefs === 'string') {
                            try { 
                                prefs = JSON.parse(prefs); 
                            } catch (e) {
                                console.warn(`Failed to parse preferences for user ${userKey}:`, e.message);
                                prefs = {};
                            }
                        }
                        
                        // Also check if preferences are stored directly in columns
                        // (some tables have notif_buy, notif_sell, notif_stoploss as separate columns)
                        userSettingsMap[userKey] = { 
                            prefs, 
                            row,
                            // Store direct column values if they exist
                            notif_buy: row.notif_buy ?? prefs['notif-buy'] ?? prefs['notif_buy'],
                            notif_sell: row.notif_sell ?? prefs['notif-sell'] ?? prefs['notif_sell'],
                            notif_stoploss: row.notif_stoploss ?? row['notif-stoploss'] ?? prefs['notif-stoploss'] ?? prefs['notif_stoploss']
                        };
                        
                        console.log(`✅ Loaded settings for user [${userKey}]:`, {
                            notif_buy: userSettingsMap[userKey].notif_buy,
                            notif_sell: userSettingsMap[userKey].notif_sell,
                            notif_stoploss: userSettingsMap[userKey].notif_stoploss
                        });
                    }
                }
            }
        } catch (err) {
            console.warn('⚠️ Error querying user_settings:', err.message);
        }

        // Helper: Check if alert is enabled for a specific user and alert type
        const isAlertEnabled = (userId, alertType) => {
            if (!userId) {
                console.log('⚠️ No userId provided, defaulting to enabled');
                return true;
            }
            
            // Try both with and without trimming
            const userIdStr = String(userId).trim();
            
            // Log the user ID we're checking
            console.log(`🔍 Checking alert for user [${userIdStr}] type: ${alertType}`);
            
            // First try exact match
            let record = userSettingsMap[userIdStr];
            
            // If not found, try case-insensitive match
            if (!record) {
                const matchingKey = Object.keys(userSettingsMap).find(
                    key => key.toLowerCase() === userIdStr.toLowerCase()
                );
                if (matchingKey) {
                    record = userSettingsMap[matchingKey];
                    console.log(`🔄 Found case-insensitive match: ${matchingKey} for ${userIdStr}`);
                }
            }
            
            if (!record) {
                console.log(`ℹ️ No settings found for user [${userIdStr}], defaulting to enabled`);
                return true; // Default to enabled if no preferences row in DB
            }

            console.log(`📊 Record for user [${userIdStr}]:`, record);

            let value;
            if (alertType === 'buy') {
                value = record.notif_buy;
            } else if (alertType === 'sell') {
                value = record.notif_sell;
            } else if (alertType === 'stop_loss') {
                value = record.notif_stoploss;
            }
            
            // If value is undefined, default to true (enabled)
            if (value === undefined || value === null) {
                console.log(`ℹ️ No specific setting for ${alertType} for user [${userIdStr}], defaulting to enabled`);
                return true;
            }
            
            const enabled = !isFalse(value);
            console.log(`📌 Alert ${alertType} for user [${userIdStr}]: ${enabled ? 'ENABLED ✅' : 'DISABLED ⏸️'} (value: ${value})`);
            return enabled;
        };

        // Step 4: Evaluate watchlist items (buy/sell targets)
        const updatesToProcess = [];

        // Get unique user IDs for debugging
        const allUserIds = new Set();
        if (watchlist) {
            for (const item of watchlist) {
                allUserIds.add(String(item.user_id).trim());
            }
        }
        if (transactions) {
            for (const tx of transactions) {
                allUserIds.add(String(tx.user_id).trim());
            }
        }
        console.log('👥 All user IDs in watchlist/transactions:', Array.from(allUserIds));
        console.log('👥 User IDs with settings:', Object.keys(userSettingsMap));

        for (const item of watchlist) {
            const currentPrice = currentPrices[item.symbol];
            if (!currentPrice || isNaN(currentPrice)) {
                console.warn(`Skipping ${item.symbol} due to missing price data.`);
                continue;
            }

            // Check Buy Condition
            if (!item.buy_triggered && item.target_buy !== null && currentPrice <= item.target_buy) {
                const userIdStr = String(item.user_id).trim();
                if (!isAlertEnabled(userIdStr, 'buy')) {
                    console.log(`⏸️ BUY target hit for ${item.symbol} (${currentPrice} <= ${item.target_buy}) but SKIPPED for user ${userIdStr} (notif-buy toggle is OFF)`);
                } else {
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
            }
            // Check Sell Condition
            else if (!item.sell_triggered && item.target_sell !== null && currentPrice >= item.target_sell) {
                const userIdStr = String(item.user_id).trim();
                if (!isAlertEnabled(userIdStr, 'sell')) {
                    console.log(`⏸️ SELL target hit for ${item.symbol} (${currentPrice} >= ${item.target_sell}) but SKIPPED for user ${userIdStr} (notif-sell toggle is OFF)`);
                } else {
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
                    const userIdStr = String(tx.user_id).trim();
                    if (!isAlertEnabled(userIdStr, 'stop_loss')) {
                        console.log(`⏸️ STOP LOSS hit for ${tx.symbol} (${currentPrice} <= ${tx.stop_loss}) but SKIPPED for user ${tx.user_id} (notif-stoploss toggle is OFF)`);
                    } else {
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
        }

        // Step 6: Process all updates
        if (updatesToProcess.length === 0) {
            console.log('No price targets were hit this cycle.');
            return res.status(200).json({ 
                message: 'No targets hit.',
                usersWithSettings: Object.keys(userSettingsMap).length,
                usersInWatchlist: watchlist ? watchlist.length : 0,
                usersInTransactions: transactions ? transactions.length : 0
            });
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
                let columnToUpdate = update.type === 'buy' ? 'buy_triggered' : 'sell_triggered';
                const { error: updateError } = await supabase
                    .from('watchlist')
                    .update({ [columnToUpdate]: true })
                    .eq('id', update.watchlistId);

                if (updateError) {
                    console.error(`Failed to update watchlist ID ${update.watchlistId}:`, updateError);
                }
            } else if (update.source === 'transaction' && update.type === 'stop_loss') {
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