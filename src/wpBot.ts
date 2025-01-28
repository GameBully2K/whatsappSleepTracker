import { Client, LocalAuth } from 'whatsapp-web.js';
//@ts-ignore
import qrcode from 'qrcode-terminal';
import Redis from 'ioredis';

const redis = new Redis(
    {db: 1} // Redis connection options
); // Redis connection
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: { args: ["--no-sandbox"] },
});

const candidates = [
    { name: 'Bilal', wpNumber: "212687053026" },
    { name: 'Walid', wpNumber: "212767379926" },
];

const userTimers = new Map<string, NodeJS.Timer>();

// ================== REDIS DATA MANAGEMENT ================== //
// Key structure:
// - Global phase: `sleepPhase` ("sleeping" or "waking")
// - User states: `userState:<user>` ("asleep" or "awake")
// - Sleep history: `sleepHistory:<user>` (list of JSON objects)

async function getCurrentPhase(): Promise<'sleeping' | 'waking'> {
    return (await redis.get('sleepPhase')) as 'sleeping' | 'waking' || 'sleeping';
}

async function togglePhase() {
    const current = await getCurrentPhase();
    await redis.set('sleepPhase', current === 'sleeping' ? 'waking' : 'sleeping');
}

async function markUserAsleep(user: string) {
    // Record sleep start time in history
    await redis.lpush(`sleepHistory:${user}`, JSON.stringify({
        start: Date.now(),
        end: null // End time will be updated when user wakes up
    }));
    await redis.hset(`userState`, user, 'asleep');
}

async function calculateSleepStats(user: string, session: { start: number, end: number }) {
    const sleepStart = new Date(session.start);
    const sleepEnd = new Date(session.end);
    const sleepHours = (session.end - session.start) / (1000 * 60 * 60);
    const sleepDebt = sleepHours - 8;
    const isGoodNight = sleepStart.getHours() < 24; // Before midnight

    // Update sleep debt
    const currentDebt = parseFloat(await redis.hget(`sleepStats:${user}`, 'sleepDebt') || '0');
    await redis.hset(`sleepStats:${user}`, 'sleepDebt', (currentDebt + sleepDebt).toString());

    // Update good sleep streak and best streak
    let streak = parseInt(await redis.hget(`sleepStats:${user}`, 'goodSleepStreak') || '0');
    let bestStreak = parseInt(await redis.hget(`sleepStats:${user}`, 'bestStreak') || '0');
    
    if (isGoodNight && sleepHours >= 8) {
        streak++;
        if (streak > bestStreak) {
            bestStreak = streak;
            await redis.hset(`sleepStats:${user}`, 'bestStreak', bestStreak.toString());
        }
    } else {
        streak = 0;
    }
    await redis.hset(`sleepStats:${user}`, 'goodSleepStreak', streak.toString());

    // Update good night percentage
    const totalNights = parseInt(await redis.hget(`sleepStats:${user}`, 'totalNights') || '0') + 1;
    const goodNights = parseInt(await redis.hget(`sleepStats:${user}`, 'goodNights') || '0') + (isGoodNight ? 1 : 0);
    await redis.hset(`sleepStats:${user}`, 'totalNights', totalNights.toString());
    await redis.hset(`sleepStats:${user}`, 'goodNights', goodNights.toString());
}

async function getUserStats(user: string) {
    const stats = await redis.hgetall(`sleepStats:${user}`);
    return {
        sleepDebt: parseFloat(stats.sleepDebt || '0'),
        goodSleepStreak: parseInt(stats.goodSleepStreak || '0'),
        bestStreak: parseInt(stats.bestStreak || '0'),
        goodNightPercentage: stats.totalNights ? 
            (parseInt(stats.goodNights) / parseInt(stats.totalNights) * 100) : 0
    };
}

async function markUserAwake(user: string) {
    // Update the latest sleep session with end time
    const historyKey = `sleepHistory:${user}`;
    const latestSession = await redis.lindex(historyKey, 0);
    
    if (latestSession) {
        const session = JSON.parse(latestSession);
        if (session.end === null) {
            const updatedSession = { ...session, end: Date.now() };
            const updated = JSON.stringify(updatedSession);
            await redis.lset(historyKey, 0, updated);
            await calculateSleepStats(user, updatedSession);
        }
    }
    await redis.hset(`userState`, user, 'awake');

    // Send statistics to user
    const stats = await getUserStats(user);
    const statsMessage = 
        `Sleep Statistics:\n` +
        `Sleep Debt: ${stats.sleepDebt.toFixed(1)} hours\n` +
        `Good Sleep Streak: ${stats.goodSleepStreak} days\n` +
        `Best Streak: ${stats.bestStreak} days\n` +
        `Good Night Percentage: ${stats.goodNightPercentage.toFixed(1)}%`;
    
    client.sendMessage(user, statsMessage);
}

async function areAllUsersInState(state: 'asleep' | 'awake'): Promise<boolean> {
    const states = await redis.hgetall('userState');
    return Object.values(states).every(s => s === state);
}

// ================== BOT LOGIC ================== //
function clearUserTimers(user: string) {
    const timers = userTimers.get(user);
    if (timers) clearTimeout(timers);
    userTimers.delete(user);
}

function scheduleSleepCheck(user: string) {
    clearUserTimers(user);

    const timer = setTimeout(async () => {
        client.sendMessage(user, "Are you still awake?");
        const secondTimer = setTimeout(async () => {
            client.sendMessage(user, "Are you really asleep?");
            const finalTimer = setTimeout(async () => {
              client.sendMessage(user, "Marking you as asleep. Reply 'yes' when you wake up.");
              await markUserAsleep(user);
              if (await areAllUsersInState('asleep')) {
                  await togglePhase();
                  console.log('All users asleep. Exiting.');
                  await new Promise(resolve => setTimeout(resolve, 500)); // Wait for messages to send
                  process.exit(0);
              }
          }, 20 * 1000); // 5 minutes to confirm sleep
          userTimers.set(user, finalTimer);
        }, 20 * 1000); // 10 minutes to confirm sleep
        userTimers.set(user, secondTimer);
    }, 20 * 1000); // 15 minutes to confirm sleep
    userTimers.set(user, timer);
}

// ================== MESSAGE HANDLER ================== //
client.on('message', async (msg) => {
    const user = msg.from;
    const phase = await getCurrentPhase();

    if (msg.body.toLowerCase() === 'yes') {
        if (phase === 'sleeping') {
            client.sendMessage(user, "Still awake? I'll check again later.");
            scheduleSleepCheck(user);
        } else if (phase === 'waking') {
            await markUserAwake(user);
            client.sendMessage(user, "Good morning! You're marked awake.");
            if (await areAllUsersInState('awake')) {
                await togglePhase();
                await new Promise(resolve => setTimeout(resolve, 500)); // Wait for messages to send
                console.log('All users awake. Exiting.');
                process.exit(0);
            }
        }
    }
});

// ================== INITIALIZATION ================== //
client.on('qr', qr => qrcode.generate(qr, { small: true }));
client.initialize();

client.once('ready', async () => {
    console.log('Client ready!');
    const phase = await getCurrentPhase();

    if (phase === 'sleeping') {
        // Initialize sleeping phase
        candidates.forEach(candidate => {
            const user = `${candidate.wpNumber}@c.us`;
            client.sendMessage(user, `Hello ${candidate.name}! Reply "yes" if you're awake.`);
            scheduleSleepCheck(user);
        });
    } else {
        // Waking phase: Silent mode (no messages sent)
        console.log('Waking phase: Waiting for wake-up confirmations.');
    }
});

// Cleanup
process.on('exit', () => {
    userTimers.forEach((_, user) => clearUserTimers(user));
});