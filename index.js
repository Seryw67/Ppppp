const { VK, Keyboard } = require('vk-io');
const Database = require('better-sqlite3');

// ----------------------------------------------------
// НАСТРОЙКИ
// ----------------------------------------------------
const VK_TOKEN = process.env.VK_TOKEN;
const OWNER_ID = 1021072434; // Твой VK ID
const ADMIN_PINS = ['5480', '1746']; // ПИН-коды для входа с админ-правами
const TEA_PRICE = 1400;       // Цена за 1 пакетик чая
const SUB_PRICE_PER_DAY = 100; // Цена подписки за 1 день

if (!VK_TOKEN) {
    console.error('Ошибка: Переменная VK_TOKEN не найдена в окружении!');
    process.exit(1);
}

const vk = new VK({ token: VK_TOKEN });

// Инициализация базы данных SQLite
const db = new Database('database.db');

// Таблица пользователей
db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY,
        first_seen INTEGER,
        is_admin INTEGER DEFAULT 0,
        awaiting_pin INTEGER DEFAULT 0,
        step TEXT DEFAULT ''
    )
`);

// Таблица забаненных пользователей
db.exec(`
    CREATE TABLE IF NOT EXISTS banned_users (
        id INTEGER PRIMARY KEY,
        reason TEXT DEFAULT '',
        banned_at INTEGER,
        unban_at INTEGER DEFAULT 0
    )
`);

// Таблица забаненных IP / Жесткого бана
db.exec(`
    CREATE TABLE IF NOT EXISTS banned_ips (
        user_id INTEGER PRIMARY KEY,
        ip TEXT DEFAULT '0.0.0.0',
        reason TEXT DEFAULT '',
        banned_at INTEGER,
        unban_at INTEGER DEFAULT 0
    )
`);

// Таблица настроек бота
db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
    )
`);

// Инициализируем статус тех. работ, если его нет
const getSettingStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
const setSettingStmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');

if (!getSettingStmt.get('bot_closed')) {
    setSettingStmt.run('bot_closed', '0');
}

// SQL Запросы
const getUserStmt = db.prepare('SELECT * FROM users WHERE id = ?');
const createUserStmt = db.prepare('INSERT INTO users (id, first_seen, is_admin) VALUES (?, ?, ?)');
const getAllUsersStmt = db.prepare('SELECT id FROM users');
const getUsersCountStmt = db.prepare('SELECT COUNT(*) as count FROM users');
const setAdminStatusStmt = db.prepare('UPDATE users SET is_admin = ? WHERE id = ?');
const setAwaitingPinStmt = db.prepare('UPDATE users SET awaiting_pin = ? WHERE id = ?');
const setUserStepStmt = db.prepare('UPDATE users SET step = ? WHERE id = ?');

// SQL для бана и бана по IP
const isBannedStmt = db.prepare('SELECT * FROM banned_users WHERE id = ?');
const isIpBannedStmt = db.prepare('SELECT * FROM banned_ips WHERE user_id = ?');
const banUserStmt = db.prepare('INSERT INTO banned_users (id, reason, banned_at, unban_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET reason = excluded.reason, banned_at = excluded.banned_at, unban_at = excluded.unban_at');
const unbanUserStmt = db.prepare('DELETE FROM banned_users WHERE id = ?');

const banIpStmt = db.prepare('INSERT INTO banned_ips (user_id, ip, reason, banned_at, unban_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET reason = excluded.reason, banned_at = excluded.banned_at, unban_at = excluded.unban_at');
const unbanIpStmt = db.prepare('DELETE FROM banned_ips WHERE user_id = ?');

function registerUser(userId) {
    let user = getUserStmt.get(userId);
    if (!user) {
        const initialAdmin = (userId === OWNER_ID) ? 1 : 0;
        createUserStmt.run(userId, Math.floor(Date.now() / 1000), initialAdmin);
        user = getUserStmt.get(userId);
    }
    return user;
}

// Вспомогательная функция разбора длительности (10m, 2h, 1d, * и т.д.)
function parseDuration(timeStr) {
    if (!timeStr || timeStr === '*') return { seconds: 0, isForever: true };

    const match = timeStr.match(/^(\d+)([mмhчdд]?)$/i);
    if (!match) return null;

    const val = parseInt(match[1], 10);
    const unit = match[2].toLowerCase();

    let seconds = 0;
    if (unit === 'm' || unit === 'м') {
        seconds = val * 60;
    } else if (unit === 'h' || unit === 'ч') {
        seconds = val * 3600;
    } else if (unit === 'd' || unit === 'д') {
        seconds = val * 86400;
    } else {
        seconds = val * 60;
    }

    return { seconds, isForever: false };
}

// Форматирование времени для вывода
function formatDurationText(unbanAt) {
    if (unbanAt === 0) return 'навсегда';
    const diff = unbanAt - Math.floor(Date.now() / 1000);
    if (diff <= 0) return 'истек';
    
    const minutes = Math.ceil(diff / 60);
    if (minutes < 60) return `на ${minutes} мин.`;
    const hours = Math.ceil(minutes / 60);
    if (hours < 24) return `на ${hours} ч.`;
    const days = Math.ceil(hours / 24);
    return `на ${days} дн.`;
}

// Функция определения targetId по тексту
async function resolveTargetId(input) {
    if (!input) return null;

    const mentionMatch = input.match(/\[(id|club)(\d+)\|/);
    if (mentionMatch) {
        return parseInt(mentionMatch[2], 10);
    }

    if (/^\d+$/.test(input)) {
        return parseInt(input, 10);
    }

    let clean = input.replace(/^@/, '').replace(/^(https?:\/\/)?(www\.)?vk\.com\//, '');
    
    if (/^id\d+$/i.test(clean)) {
        return parseInt(clean.replace(/id/i, ''), 10);
    }

    try {
        const res = await vk.api.utils.resolveScreenName({ screen_name: clean });
        if (res && res.type === 'user') {
            return res.object_id;
        }
    } catch (e) {
        return null;
    }

    return null;
}

// Генератор клавиатуры
function getMainMenuKeyboard(isAdmin) {
    const builder = Keyboard.builder();

    builder.textButton({
        label: '🍵 Купить чай',
        payload: { command: 'buy_tea' },
        color: Keyboard.POSITIVE_COLOR
    }).textButton({
        label: '⭐ Купить подписку',
        payload: { command: 'buy_sub' },
        color: Keyboard.PRIMARY_COLOR
    }).row();

    if (isAdmin) {
        builder.textButton({
            label: '👑 Панель',
            payload: { command: 'апанель' },
            color: Keyboard.POSITIVE_COLOR
        }).textButton({
            label: '🚪 Выйти',
            payload: { command: 'выход' },
            color: Keyboard.NEGATIVE_COLOR
        });
    } else {
        builder.textButton({
            label: '🔑 Вход в айди',
            payload: { command: 'вход' },
            color: Keyboard.SECONDARY_COLOR
        });
    }

    return builder.inline(false);
}

// ----------------------------------------------------
// ОБРАБОТКА СООБЩЕНИЙ
// ----------------------------------------------------
vk.updates.on('message_new', async (context) => {
    if (context.isOutbox) return;

    const userId = context.senderId;
    if (!userId || userId < 0) return;

    const now = Math.floor(Date.now() / 1000);

    // 1. ПРОВЕРКА НА БАН
    const banRecord = isBannedStmt.get(userId);
    const ipBanRecord = isIpBannedStmt.get(userId);

    if (banRecord || ipBanRecord) {
        let isExpired = false;

        if (banRecord && banRecord.unban_at > 0 && now >= banRecord.unban_at) {
            unbanUserStmt.run(userId);
            isExpired = true;
        }

        if (ipBanRecord && ipBanRecord.unban_at > 0 && now >= ipBanRecord.unban_at) {
            unbanIpStmt.run(userId);
            isExpired = true;
        }

        if (!isExpired && ((banRecord && (banRecord.unban_at === 0 || now < banRecord.unban_at)) || 
                           (ipBanRecord && (ipBanRecord.unban_at === 0 || now < ipBanRecord.unban_at)))) {
            return;
        }
    }

    const user = registerUser(userId);
    const isAdmin = (userId === OWNER_ID || user.is_admin === 1);

    // 2. ПРОВЕРКА НА ТЕХНИЧЕСКИЕ РАБОТЫ (cl)
    const isClosed = getSettingStmt.get('bot_closed')?.value === '1';
    if (isClosed && !isAdmin) {
        return context.send('🛠 В данный момент бот находится на техническом обслуживании. Пожалуйста, попробуйте позже!');
    }

    let rawText = context.text || '';
    if (context.messagePayload && context.messagePayload.command) {
        rawText = context.messagePayload.command;
    }

    if (!rawText.trim() && !context.hasReplyMessage) return;

    const text = rawText.trim();
    const args = text.split(/\s+/);
    const command = args[0] ? args[0].toLowerCase() : '';

    // Старт / Помощь
    if (command === 'начать' || command === 'start' || command === '/start' || command === 'помощь') {
        setUserStepStmt.run('', userId);
        setAwaitingPinStmt.run(0, userId);

        let msg = '👋 Привет! Выберите действие ниже:';
        if (isAdmin) {
            msg += '\n\n👑 Вы авторизованы как Администратор!';
        }

        return context.send({
            message: msg,
            keyboard: getMainMenuKeyboard(isAdmin)
        });
    }

    // 1. ВВОД ПИН-КОДА (Проверка по массиву ADMIN_PINS)
    if (user.awaiting_pin === 1) {
        if (ADMIN_PINS.includes(text)) {
            setAdminStatusStmt.run(1, userId);
            setAwaitingPinStmt.run(0, userId);

            return context.send({
                message: '🔓 Доступ разрешен! Вы вошли в режим Администратора.',
                keyboard: getMainMenuKeyboard(true)
            });
        } else {
            setAwaitingPinStmt.run(0, userId);

            return context.send({
                message: '❌ Неверный ПИН-код!',
                keyboard: getMainMenuKeyboard(false)
            });
        }
    }

    // 2. ВХОД И ВЫХОД
    if (command === 'вход' || command === '🔑 вход в айди') {
        if (isAdmin) {
            return context.send({
                message: '👑 Вы уже авторизованы как Администратор!',
                keyboard: getMainMenuKeyboard(true)
            });
        }

        setAwaitingPinStmt.run(1, userId);
        return context.send('🔑 Введите ПИН-код для доступа к панели:');
    }

    if (command === 'выход' || command === '🚪 выйти') {
        if (userId === OWNER_ID) {
            return context.send({
                message: '⚠️ Создатель бота не может выйти из режима администратора.',
                keyboard: getMainMenuKeyboard(true)
            });
        }

        setAdminStatusStmt.run(0, userId);
        setAwaitingPinStmt.run(0, userId);

        return context.send({
            message: '🔒 Вы вышли из режима администратора.',
            keyboard: getMainMenuKeyboard(false)
        });
    }

    // 3. ПОКУПКИ
    if (command === 'buy_tea') {
        setUserStepStmt.run('awaiting_buy_tea_amount', userId);
        return context.send('Сколько вы хотите купить чая? (Введите число от 1 до 150)');
    }

    if (command === 'buy_sub') {
        setUserStepStmt.run('awaiting_sub_days', userId);
        return context.send('На сколько дней вы хотите купить подписку?');
    }

    // Расчет стоимости для ЧАЯ
    if (user.step === 'awaiting_buy_tea_amount') {
        const amount = parseInt(text, 10);
        if (isNaN(amount) || amount < 1 || amount > 150) {
            return context.send('Пожалуйста, введите корректное число от 1 до 150.');
        }

        setUserStepStmt.run('', userId);

        const totalPrice = amount * TEA_PRICE;

        await context.send(`🍵 Заказ чая: ${amount} шт.`);

        await context.send({
            message: `🛒 Заказ оформлен!\n\n` +
                     `📦 Количество: ${amount} шт.\n` +
                     `💰 Сумма к оплате: ${totalPrice} руб. (по ${TEA_PRICE} руб./шт.)\n\n` +
                     `⏳ Ожидайте подтверждения от администратора...`,
            keyboard: getMainMenuKeyboard(isAdmin)
        });

        try {
            const [userInfo] = await vk.api.users.get({ user_ids: userId, fields: ['domain'] });
            const userName = `${userInfo.first_name} ${userInfo.last_name}`;
            const userDomain = userInfo.domain ? `@${userInfo.domain}` : `id${userId}`;

            await vk.api.messages.send({
                user_id: OWNER_ID,
                message: `🛒 Новый заказ на покупку чая!\n\n` +
                         `👤 Клиент: ${userName} (${userDomain})\n` +
                         `🆔 ID: ${userId}\n` +
                         `📦 Количество: ${amount} шт.\n` +
                         `💰 Итоговая стоимость: ${totalPrice} руб.\n\n` +
                         `💡 Ответить:\n` +
                         `• + ${userDomain} или - ${userDomain}\n` +
                         `• отв ${userDomain} [текст]`,
                random_id: Math.floor(Math.random() * 1000000)
            });
        } catch (error) {
            console.error('Ошибка отправки уведомления админу:', error);
        }
        return;
    }

    // Расчет стоимости для ПОДПИСКИ
    if (user.step === 'awaiting_sub_days') {
        const days = parseInt(text, 10);
        if (isNaN(days) || days <= 0) {
            return context.send('Пожалуйста, укажите количество дней числом (больше 0).');
        }

        setUserStepStmt.run('', userId);

        const totalPrice = days * SUB_PRICE_PER_DAY;

        await context.send(`⭐ Заказ подписки: ${days} дн.`);

        await context.send({
            message: `⭐ Заявка принята!\n\n` +
                     `⏱ Срок подписки: ${days} дн.\n` +
                     `💰 Сумма к оплате: ${totalPrice} руб.\n\n` +
                     `⏳ Ожидайте ответа администратора...`,
            keyboard: getMainMenuKeyboard(isAdmin)
        });

        try {
            const [userInfo] = await vk.api.users.get({ user_ids: userId, fields: ['domain'] });
            const userName = `${userInfo.first_name} ${userInfo.last_name}`;
            const userDomain = userInfo.domain ? `@${userInfo.domain}` : `id${userId}`;

            await vk.api.messages.send({
                user_id: OWNER_ID,
                message: `⭐ Заявка на подписку!\n\n` +
                         `👤 Клиент: ${userName} (${userDomain})\n` +
                         `🆔 ID: ${userId}\n` +
                         `⏱ Срок: ${days} дн.\n` +
                         `💰 Сумма: ${totalPrice} руб.\n\n` +
                         `💡 Ответить: + ${userDomain} / - ${userDomain} / отв ${userDomain} [текст]`,
                random_id: Math.floor(Math.random() * 1000000)
            });
        } catch (error) {
            console.error('Ошибка отправки уведомления админу:', error);
        }
        return;
    }

    // 4. ОБРАБОТКА ОТВЕТОВ ПОЛЬЗОВАТЕЛЮ (+, -, отв)
    if (isAdmin && (command === '+' || command === '-' || command === 'отв')) {
        let targetId = null;
        let messageText = '';

        const ACCEPT_MSG = '✨ Ваш заказ принят! Вступите в чат https://vk.me/join//v/d04bOI6dq978Y5ufV/6wY3eQ7WD3C_ec=';
        const REJECT_MSG = '❌ К сожалению, ваш заказ был отменен администратором. Если у вас есть вопросы — напишите в ответ.';

        if (context.hasReplyMessage) {
            targetId = context.replyMessage.senderId;

            if (command === '+') {
                messageText = ACCEPT_MSG;
            } else if (command === '-') {
                messageText = REJECT_MSG;
            } else if (command === 'отв') {
                messageText = args.slice(1).join(' ');
            }
        } else {
            const targetInput = args[1];

            if (!targetInput) {
                return context.send('⚠️ Укажите юзернейм или ID. Пример:\n+ @durov\n- @durov\nотв @durov Ваш текст');
            }

            targetId = await resolveTargetId(targetInput);

            if (command === '+') {
                messageText = ACCEPT_MSG;
            } else if (command === '-') {
                messageText = REJECT_MSG;
            } else if (command === 'отв') {
                messageText = args.slice(2).join(' ');
            }
        }

        if (!targetId || targetId < 0) {
            return context.send('⚠️ Не удалось найти пользователя по указанному ID/юзернейму.');
        }

        if (!messageText.trim()) {
            return context.send('⚠️ Введите текст сообщения. Пример:\nотв @durov Ваш заказ готов');
        }

        try {
            await vk.api.messages.send({
                user_id: targetId,
                message: messageText,
                random_id: Math.floor(Math.random() * 1000000000)
            });

            return context.send(`✅ Ответ отправлен пользователю vk.com/id${targetId}`);
        } catch (error) {
            return context.send(`❌ Ошибка отправки: ${error.message}`);
        }
    }

    // 5. КОМАНДЫ АДМИНИСТРАТОРА

    if (isAdmin && (command === 'cl' || command === 'клир')) {
        const currentlyClosed = getSettingStmt.get('bot_closed')?.value === '1';
        const newState = currentlyClosed ? '0' : '1';
        setSettingStmt.run('bot_closed', newState);

        if (newState === '1') {
            return context.send('🛠 Бот ЗАКРЫТ на техническое обслуживание. Обычные пользователи не смогут им пользоваться.');
        } else {
            return context.send('✅ Бот ОТКРЫТ для пользователей.');
        }
    }

    // ОБЫЧНЫЙ БАН
    if (isAdmin && (command === 'бан' || command === 'ban')) {
        if (args[1] === 'ип' || args[1] === 'ip') return;

        let targetId = null;
        let timeArg = null;
        let reason = '';

        if (context.hasReplyMessage) {
            targetId = context.replyMessage.senderId;
            timeArg = args[1];
            reason = args.slice(2).join(' ');
        } else {
            const targetInput = args[1];
            targetId = await resolveTargetId(targetInput);
            timeArg = args[2];
            reason = args.slice(3).join(' ');
        }

        if (!targetId || targetId < 0) {
            return context.send('⚠️ Укажите пользователя для бана:\nбан @durov [время/*] [причина]');
        }

        if (targetId === OWNER_ID) {
            return context.send('❌ Нельзя забанить владельца бота.');
        }

        const duration = parseDuration(timeArg);
        let unbanAt = 0;

        if (duration && !duration.isForever) {
            unbanAt = Math.floor(Date.now() / 1000) + duration.seconds;
        } else if (!duration && timeArg) {
            reason = [timeArg, reason].join(' ').trim();
        }

        banUserStmt.run(targetId, reason || 'Без причины', Math.floor(Date.now() / 1000), unbanAt);
        return context.send(`⛔ Пользователь vk.com/id${targetId} забанен ${formatDurationText(unbanAt)}.`);
    }

    // БАН ПО IP
    if (isAdmin && ((command === 'бан' && (args[1] === 'ип' || args[1] === 'ip')) || command === 'banip')) {
        let targetId = null;
        let timeArg = null;
        let reason = '';

        const offset = (command === 'banip') ? 1 : 2;

        if (context.hasReplyMessage) {
            targetId = context.replyMessage.senderId;
            timeArg = args[offset];
            reason = args.slice(offset + 1).join(' ');
        } else {
            const targetInput = args[offset];
            targetId = await resolveTargetId(targetInput);
            timeArg = args[offset + 1];
            reason = args.slice(offset + 2).join(' ');
        }

        if (!targetId || targetId < 0) {
            return context.send('⚠️ Укажите пользователя для IP бана:\nбан ип @durov [время/*] [причина]');
        }

        if (targetId === OWNER_ID) {
            return context.send('❌ Нельзя забанить владельца бота.');
        }

        const duration = parseDuration(timeArg);
        let unbanAt = 0;

        if (duration && !duration.isForever) {
            unbanAt = Math.floor(Date.now() / 1000) + duration.seconds;
        } else if (!duration && timeArg) {
            reason = [timeArg, reason].join(' ').trim();
        }

        const nowSec = Math.floor(Date.now() / 1000);
        banUserStmt.run(targetId, reason || 'IP Ban', nowSec, unbanAt);
        banIpStmt.run(targetId, '0.0.0.0', reason || 'IP Ban', nowSec, unbanAt);

        return context.send(`🚫 Пользователь vk.com/id${targetId} забанен по IP ${formatDurationText(unbanAt)}.`);
    }

    // Разбан пользователя
    if (isAdmin && (command === 'разбан' || command === 'unban')) {
        let targetId = null;
        const isIpUnban = args[1] === 'ип' || args[1] === 'ip';
        const targetInput = isIpUnban ? args[2] : args[1];

        if (context.hasReplyMessage) {
            targetId = context.replyMessage.senderId;
        } else {
            targetId = await resolveTargetId(targetInput);
        }

        if (!targetId || targetId < 0) {
            return context.send('⚠️ Укажите пользователя для разбана через reply или команду:\nразбан @durov');
        }

        unbanUserStmt.run(targetId);
        unbanIpStmt.run(targetId);

        return context.send(`✅ Пользователь vk.com/id${targetId} полностью разбанен.`);
    }

    if (command === 'апанель' || command === '👑 панель' || command === 'панель') {
        if (!isAdmin) {
            return context.send({
                message: '❌ У вас нет прав доступа.',
                keyboard: getMainMenuKeyboard(false)
            });
        }

        const isClosedNow = getSettingStmt.get('bot_closed')?.value === '1';

        return context.send({
            message: `👑 Панель Администратора\n\n` +
                     `• Статус бота: ${isClosedNow ? '🛠 На тех. работах' : '✅ Работает'}\n` +
                     `• cl — закрыть/открыть бота\n` +
                     `• Бан [юзер/reply] [время/*] [причина] — забанить\n` +
                     `• Бан ип [юзер/reply] [время/*] [причина] — забанить по IP\n` +
                     `• Разбан [юзер/reply] — разбанить\n` +
                     `• Астата — статистика пользователей\n` +
                     `• Принять/отклонить заказ:\n` +
                     `   + или + @durov — принять заказ\n` +
                     `   - или - @durov — отменить заказ\n` +
                     `   отв @durov [текст] — произвольный текст\n` +
                     `• Рассылка [Текст] — рассылка всем\n` +
                     `• Сервер — техническое состояние\n` +
                     `• Выход — выйти из админки`,
            keyboard: getMainMenuKeyboard(true)
        });
    }

    if (command === 'астата' || command === 'стата') {
        if (!isAdmin) return;
        const count = getUsersCountStmt.get().count;
        return context.send(`📊 Зарегистрировано пользователей в базе: ${count}`);
    }

    if (command === 'рассылка') {
        if (!isAdmin) return;
        const broadcastText = args.slice(1).join(' ');
        if (!broadcastText) {
            return context.send('⚠️ Использование: Рассылка [Текст]');
        }

        const users = getAllUsersStmt.all();
        let success = 0;
        let failed = 0;

        await context.send(`📢 Начинаю рассылку для ${users.length} пользователей...`);

        for (const u of users) {
            try {
                await vk.api.messages.send({
                    user_id: u.id,
                    message: broadcastText,
                    random_id: Math.floor(Math.random() * 1000000000)
                });
                success++;
            } catch (err) {
                failed++;
            }
            await new Promise(resolve => setTimeout(resolve, 50));
        }

        return context.send(`✅ Рассылка завершена!\nУспешно: ${success}\nОшибок: ${failed}`);
    }

    if (command === 'сервер') {
        if (!isAdmin) return;
        const mem = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2);
        const uptime = Math.floor(process.uptime());

        return context.send(
            `🖥 Состояние сервера:\n` +
            `• ОЗУ: ${mem} MB\n` +
            `• Аптайм: ${uptime} сек.\n` +
            `• Node.js: ${process.version}`
        );
    }
});

// Запуск бота
vk.updates.start()
    .then(() => console.log('🤖 Бот успешно запущен!'))
    .catch(console.error);
