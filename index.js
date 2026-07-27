const { VK, Keyboard } = require('vk-io');
const Database = require('better-sqlite3');

// ----------------------------------------------------
// НАСТРОЙКИ
// ----------------------------------------------------
const VK_TOKEN = process.env.VK_TOKEN;
const OWNER_ID = 1021072434; // Твой VK ID
const ADMIN_PIN = '5480';     // ПИН для входа
const TEA_PRICE = 1400;       // Цена за 1 пакетик чая

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

// Таблица забаненных
db.exec(`
    CREATE TABLE IF NOT EXISTS banned_users (
        id INTEGER PRIMARY KEY,
        reason TEXT DEFAULT '',
        banned_at INTEGER
    )
`);

// Таблица настроек бота (для хранения состояния тех. работ)
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

// SQL для бана/тех. работ
const isBannedStmt = db.prepare('SELECT * FROM banned_users WHERE id = ?');
const banUserStmt = db.prepare('INSERT INTO banned_users (id, reason, banned_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET reason = excluded.reason');
const unbanUserStmt = db.prepare('DELETE FROM banned_users WHERE id = ?');

function registerUser(userId) {
    let user = getUserStmt.get(userId);
    if (!user) {
        const initialAdmin = (userId === OWNER_ID) ? 1 : 0;
        createUserStmt.run(userId, Math.floor(Date.now() / 1000), initialAdmin);
        user = getUserStmt.get(userId);
    }
    return user;
}

// Функция определения targetId по тексту (число, @mention или screen_name/ссылка)
async function resolveTargetId(input) {
    if (!input) return null;

    // 1. Упоминание типа [id12345|Имя] или [club12345|Имя]
    const mentionMatch = input.match(/\[(id|club)(\d+)\|/);
    if (mentionMatch) {
        return parseInt(mentionMatch[2], 10);
    }

    // 2. Обычное числовой ID
    if (/^\d+$/.test(input)) {
        return parseInt(input, 10);
    }

    // 3. Ссылка или юзернейм (@durov, vk.com/durov, durov)
    let clean = input.replace(/^@/, '').replace(/^(https?:\/\/)?(www\.)?vk\.com\//, '');
    
    // Если ссылка на idXXXXX
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

    // 1. ПРОВЕРКА НА БАН
    const banRecord = isBannedStmt.get(userId);
    if (banRecord) {
        // Забаненным пользователям ничего не отвечаем
        return;
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

    // 1. ВВОД ПИН-КОДА
    if (user.awaiting_pin === 1) {
        if (text === ADMIN_PIN) {
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

    if (user.step === 'awaiting_buy_tea_amount') {
        const amount = parseInt(text, 10);
        if (isNaN(amount) || amount < 1 || amount > 150) {
            return context.send('Пожалуйста, введите корректное число от 1 до 150.');
        }

        setUserStepStmt.run('', userId);

        // Отправляем дублирующее сообщение-подтверждение от лица пользователя в чат
        await context.send(`🍵 Заказ чая: ${amount} шт.`);

        await context.send({
            message: `Отлично! Вы заказали ${amount} пакет(-ов, -иков) чая! На данный момент 1 пакетик стоит ${TEA_PRICE} руб. Сумма и вердикт будут вынесены позже.`,
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
                         `💰 Предварительная стоимость: ${amount * TEA_PRICE} руб.\n\n` +
                         `💡 Ответить можно с реплаем (+ / -) или командой:\n` +
                         `отв ${userDomain} [текст]`,
                random_id: Math.floor(Math.random() * 1000000)
            });
        } catch (error) {
            console.error('Ошибка отправки уведомления админу:', error);
        }
        return;
    }

    if (user.step === 'awaiting_sub_days') {
        const days = parseInt(text, 10);
        if (isNaN(days) || days <= 0) {
            return context.send('Пожалуйста, укажите количество дней числом (больше 0).');
        }

        setUserStepStmt.run('', userId);

        await context.send(`⭐ Заказ подписки: ${days} дн.`);

        await context.send({
            message: `Заявка на подписку на ${days} дн. принята!`,
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
                         `⏱ Срок: ${days} дн.\n\n` +
                         `💡 Ответить: отв ${userDomain} [текст]`,
                random_id: Math.floor(Math.random() * 1000000)
            });
        } catch (error) {
            console.error('Ошибка отправки уведомления админу:', error);
        }
        return;
    }

    // 4. ОБРАБОТКА ОТВЕТОВ ПОЛЬЗОВАТЕЛЮ (АВТООТВЕТЫ И КОМАНДА "ОТВ")
    if (isAdmin && (command === '+' || command === '-' || command === 'отв')) {
        let targetId = null;
        let messageText = '';

        if (context.hasReplyMessage) {
            targetId = context.replyMessage.senderId;

            if (command === '+') {
                messageText = '✨ Ваш заказ принят! Вступите в чат https://vk.me/join//v/d04bOI6dq978Y5ufV/6wY3eQ7WD3C_ec=';
            } else if (command === '-') {
                messageText = '❌ К сожалению, ваш заказ был отменен администратором. Если у вас есть вопросы — напишите в ответ.';
            } else if (command === 'отв') {
                messageText = args.slice(1).join(' ');
            }
        } else {
            if (command === 'отв') {
                const targetInput = args[1];
                targetId = await resolveTargetId(targetInput);
                messageText = args.slice(2).join(' ');
            } else {
                return context.send('⚠️ Чтобы использовать "+" или "-", сделайте ответ (reply) на сообщение заказа.');
            }
        }

        if (!targetId || targetId < 0) {
            return context.send('⚠️ Не удалось найти пользователя по указанному ID/юзернейму.');
        }

        if (!messageText.trim()) {
            return context.send('⚠️ Введите текст сообщения. Пример:\n`Отв @durov Ваш заказ готов`');
        }

        try {
            await vk.api.messages.send({
                user_id: targetId,
                message: messageText,
                random_id: Math.floor(Math.random() * 1000000000)
            });

            return context.send(`✅ Сообщение отправлено пользователю vk.com/id${targetId}`);
        } catch (error) {
            return context.send(`❌ Ошибка отправки: ${error.message}`);
        }
    }

    // 5. КОМАНДЫ АДМИНИСТРАТОРА

    // Закрытие/открытие бота на тех. работы (cl)
    if (isAdmin && (command === 'cl' || command === 'клир')) {
        const currentlyClosed = getSettingStmt.get('bot_closed')?.value === '1';
        const newState = currentlyClosed ? '0' : '1';
        setSettingStmt.run('bot_closed', newState);

        if (newState === '1') {
            return context.send('🛠 Бот **ЗАКРЫТ** на техническое обслуживание. Обычные пользователи не смогут им пользоваться.');
        } else {
            return context.send('✅ Бот **ОТКРЫТ** для пользователей.');
        }
    }

    // Бан пользователя (бан по reply или по юзернейму/ID)
    if (isAdmin && (command === 'бан' || command === 'ban')) {
        let targetId = null;
        let reason = '';

        if (context.hasReplyMessage) {
            targetId = context.replyMessage.senderId;
            reason = args.slice(1).join(' ');
        } else {
            const targetInput = args[1];
            targetId = await resolveTargetId(targetInput);
            reason = args.slice(2).join(' ');
        }

        if (!targetId || targetId < 0) {
            return context.send('⚠️ Укажите пользователя для бана через reply или команду:\n`бан @durov [причина]`');
        }

        if (targetId === OWNER_ID) {
            return context.send('❌ Нельзя забанить владельца бота.');
        }

        banUserStmt.run(targetId, reason || 'Без причины', Math.floor(Date.now() / 1000));
        return context.send(`⛔ Пользователь vk.com/id${targetId} забанен.`);
    }

    // Разбан пользователя
    if (isAdmin && (command === 'разбан' || command === 'unban')) {
        let targetId = null;

        if (context.hasReplyMessage) {
            targetId = context.replyMessage.senderId;
        } else {
            targetId = await resolveTargetId(args[1]);
        }

        if (!targetId || targetId < 0) {
            return context.send('⚠️ Укажите пользователя для разбана через reply или команду:\n`разбан @durov`');
        }

        unbanUserStmt.run(targetId);
        return context.send(`✅ Пользователь vk.com/id${targetId} разбанен.`);
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
                     `• **cl** — переключить тех. работы (закрыть/открыть бота)\n` +
                     `• **Бан [юзер/reply] [причина]** — забанить пользователя\n` +
                     `• **Разбан [юзер/reply]** — разбанить пользователя\n` +
                     `• **Астата** — статистика пользователей\n` +
                     `• Ответы клиенту:\n` +
                     `   [+] (в ответ) — принять заказ\n` +
                     `   [-] (в ответ) — отменить заказ\n` +
                     `   [Отв юзернейм/ID текст] — отправить текст\n` +
                     `• **Рассылка [Текст]** — рассылка всем\n` +
                     `• **Сервер** — техническое состояние\n` +
                     `• **Выход** — выйти из админки`,
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
