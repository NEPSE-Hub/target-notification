// api/check-price-targets.js
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function getCurrentPrices() {
    const apiUrl = 'https://nepsehub-backend.vercel.app/core/live-nepse';
    const response = await fetch(apiUrl);
    if (!response.ok) throw new Error(`API HTTP ${response.status}`);
    const json = await response.json();

    let dataArray = json.data;
    if (!dataArray && Array.isArray(json)) dataArray = json;
    if (!dataArray && json.success === true && Array.isArray(json.data)) dataArray = json.data;
    if (!dataArray) throw new Error('API response missing data array');

    const priceMap = {};
    for (const item of dataArray) {
        const symbol = item.symbol;
        const price = item.lastTradedPrice ?? item.lastPrice ?? item.closePrice ?? item.ltp;
        if (symbol && typeof price === 'number' && !isNaN(price)) {
            priceMap[symbol] = price;
        }
    }
    return priceMap;
}

export default async function handler(req, res) {
    // ✅ No auth check – completely open for cron-job.org
    try {
        const { data: watchlist, error } = await supabase
            .from('watchlist')
            .select('id, user_id, symbol, target_buy, target_sell, buy_triggered, sell_triggered')
            .or('buy_triggered.eq.false,sell_triggered.eq.false');

        if (error) throw error;
        if (!watchlist || watchlist.length === 0) {
            return res.status(200).json({ message: 'No active targets' });
        }

        const prices = await getCurrentPrices();
        const updates = [];

        for (const item of watchlist) {
            const price = prices[item.symbol];
            if (!price) continue;

            if (!item.buy_triggered && item.target_buy !== null && price <= item.target_buy) {
                updates.push({ ...item, type: 'buy', targetPrice: item.target_buy, currentPrice: price });
            } else if (!item.sell_triggered && item.target_sell !== null && price >= item.target_sell) {
                updates.push({ ...item, type: 'sell', targetPrice: item.target_sell, currentPrice: price });
            }
        }

        for (const upd of updates) {
            await supabase.from('notifications').insert({
                user_id: upd.user_id,
                title: `${upd.type.toUpperCase()} Alert`,
                message: `${upd.symbol} ${upd.type} target ${upd.targetPrice} hit at ${upd.currentPrice}`,
                type: upd.type,
                symbol: upd.symbol,
                is_read: false,
            });
            const column = upd.type === 'buy' ? 'buy_triggered' : 'sell_triggered';
            await supabase.from('watchlist').update({ [column]: true }).eq('id', upd.id);
        }

        res.status(200).json({ processed: updates.length });
    } catch (err) {
        console.error('Cron failed:', err);
        res.status(500).json({ error: err.message });
    }
}