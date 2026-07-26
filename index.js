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
db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY,
        first_seen INTEGER,
        is_admin INTEGER DEFAULT 0,
        awaiting_pin INTEGER DEFAULT 0,
        step TEXT DEFAULT ''
    )
`);

// SQL Запросы
const getUserStmt = db.prepare('SELECT * FROM users WHERE id = ?');
const createUserStmt = db.prepare('INSERT INTO users (id, first_seen, is_admin) VALUES (?, ?, ?)');
const getAllUsersStmt = db.prepare('SELECT id FROM users');
const getUsersCountStmt = db.prepare('SELECT COUNT(*) as count FROM users');
const setAdminStatusStmt = db.prepare('UPDATE users SET is_admin = ? WHERE id = ?');
const setAwaitingPinStmt = db.prepare('UPDATE users SET awaiting_pin = ? WHERE id = ?');
const setUserStepStmt = db.prepare('UPDATE users SET step = ? WHERE id = ?');

function registerUser(userId) {
    let user = getUserStmt.get(userId);
    if (!user) {
        const initialAdmin = (userId === OWNER_ID) ? 1 : 0;
        createUserStmt.run(userId, Math.floor(Date.now() / 1000), initialAdmin);
        user = getUserStmt.get(userId);
    }
    return user;
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

    const user = registerUser(userId);

    let rawText = context.text || '';
    if (context.messagePayload && context.messagePayload.command) {
        rawText = context.messagePayload.command;
    }

    if (!rawText.trim() && !context.hasReplyMessage) return;

    const text = rawText.trim();
    const args = text.split(/\s+/);
    const command = args[0] ? args[0].toLowerCase() : '';

    const isAdmin = (userId === OWNER_ID || user.is_admin === 1);

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

        await context.send({
            message: `Отлично! Вы заказали ${amount} пакет(-ов, -иков) чая! На данный момент 1 пакетик стоит ${TEA_PRICE} руб. Сумма и вердикт будут вынесены позже.`,
            keyboard: getMainMenuKeyboard(isAdmin)
        });

        try {
            await vk.api.messages.send({
                user_id: OWNER_ID,
                message: `🛒 Новый заказ на покупку чая!\n\nОт пользователя: vk.com/id${userId}\nКоличество: ${amount} шт.\nПредварительная стоимость: ${amount * TEA_PRICE} руб.`,
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

        await context.send({
            message: `Заявка на подписку на ${days} дн. принята!`,
            keyboard: getMainMenuKeyboard(isAdmin)
        });

        try {
            await vk.api.messages.send({
                user_id: OWNER_ID,
                message: `⭐ Заявка на подписку!\n\nОт пользователя: vk.com/id${userId}\nСрок: ${days} дн.`,
                random_id: Math.floor(Math.random() * 1000000)
            });
        } catch (error) {
            console.error('Ошибка отправки уведомления админу:', error);
        }
        return;
    }

    // 4. ОТПРАВКА СООБЩЕНИЯ ПОЛЬЗОВАТЕЛЮ (КОМАНДА "Отв [текст]" ЧЕРЕЗ REPLY ИЛИ ПО ID)
    if (command === 'отв' || (isAdmin && context.hasReplyMessage)) {
        if (!isAdmin) return;

        let targetId = null;
        let messageText = '';

        // Вариант 1: Через Reply (цитирование)
        if (context.hasReplyMessage) {
            targetId = context.replyMessage.senderId;

            if (command === 'отв') {
                messageText = args.slice(1).join(' ');
            } else {
                messageText = rawText;
            }
        } 
        // Вариант 2: "отв [ID] [Текст]" (без reply)
        else if (command === 'отв') {
            targetId = parseInt(args[1], 10);
            messageText = args.slice(2).join(' ');
        }

        if (!targetId || targetId < 0) {
            return context.send('⚠️ Не удалось определить ID получателя.');
        }

        if (!messageText.trim()) {
            return context.send('⚠️ Введите текст сообщения для отправки. Пример: `Отв Ваш заказ готовит администрация`');
        }

        try {
            await vk.api.messages.send({
                user_id: targetId,
                message: `💬 Сообщение от администрации:\n\n${messageText}`,
                random_id: Math.floor(Math.random() * 1000000000)
            });

            return context.send(`✅ Ответ успешно отправлен пользователю vk.com/id${targetId}`);
        } catch (error) {
            return context.send(`❌ Ошибка отправки: ${error.message}`);
        }
    }

    // 5. КОМАНДЫ АДМИНИСТРАТОРА

    if (command === 'апанель' || command === '👑 панель' || command === 'панель') {
        if (!isAdmin) {
            return context.send({
                message: '❌ У вас нет прав доступа.',
                keyboard: getMainMenuKeyboard(false)
            });
        }

        return context.send({
            message: `👑 Панель Администратора\n\n` +
                     `• Астата — статистика пользователей\n` +
                     `• Отв [Текст] (в ответ на сообщение) — отправить сообщение пользователю\n` +
                     `• Отв [ID] [Текст] — отправить сообщение по ID\n` +
                     `• Рассылка [Текст] — сделать рассылку всем\n` +
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
