import { Elysia, t } from 'elysia';
import { staticPlugin } from '@elysiajs/static';
import Redis from 'ioredis';

const redis = new Redis(
    {db: 1} // Redis connection options
);

const app = new Elysia()
    .use(staticPlugin())
    // Get all sleep history
    .get('/api/history', async () => {
        const allKeys = await redis.keys('sleepHistory:*');
        const data: Record<string, any[]> = {};
        for (const key of allKeys) {
            const userHistory = await redis.lrange(key, 0, -1);
            const userId = key.split(':')[1];
            data[userId] = userHistory.map((str) => JSON.parse(str));
        }
        return data;
    })
    // Get all user statistics
    .get('/api/stats', async () => {
        const allUsers = await redis.keys('sleepStats:*');
        const stats: Record<string, any> = {};
        
        for (const key of allUsers) {
            const userId = key.split(':')[1];
            const userStats = await redis.hgetall(key);
            stats[userId] = {
                sleepDebt: parseFloat(userStats.sleepDebt || '0') / 3600 * 1000,
                goodSleepStreak: parseInt(userStats.goodSleepStreak || '0'),
                bestStreak: parseInt(userStats.bestStreak || '0'),
                goodNightPercentage: userStats.totalNights ? 
                    (parseInt(userStats.goodNights) / parseInt(userStats.totalNights) * 100) : 0,
                totalNights: parseInt(userStats.totalNights || '0'),
                goodNights: parseInt(userStats.goodNights || '0')
            };
        }
        return stats;
    })
    // Get current phase and user states
    .get('/api/status', async () => {
        const phase = await redis.get('sleepPhase');
        const states = await redis.hgetall('userState');
        return { phase, states };
    })
    // Serve the dashboard
    .get('/', () => Bun.file('./public/index.html'))
    .listen(3000);

console.log('Elysia server listening on port 3000');