const { VK, Keyboard } = require('vk-io');
const Database = require('better-sqlite3');

// ----------------------------------------------------
// НАСТРОЙКИ
// ----------------------------------------------------
const VK_TOKEN = process.env.VK_TOKEN;
const OWNER_ID = 1021072434; // Твой VK ID (Владелец по умолчанию)
const ADMIN_PIN = '5480';     // ПИН-код для входа

if (!VK_TOKEN) {
    console.error('Ошибка: Переменная VK_TOKEN не найдена!');
    process.exit(1);
}

const vk = new VK({
    token: VK_TOKEN
});

// Инициализация базы данных
const db = new Database('database.db');

// Создание таблицы с хранением статуса авторизации и состояния ввода ПИН
db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY,
        first_seen INTEGER,
        is_admin INTEGER DEFAULT 0,
        awaiting_pin INTEGER DEFAULT 0
    )
`);

// Подготовка SQL запросов
const getUserStmt = db.prepare('SELECT * FROM users WHERE id = ?');
const createUserStmt = db.prepare('INSERT INTO users (id, first_seen, is_admin) VALUES (?, ?, ?)');
const getAllUsersStmt = db.prepare('SELECT id FROM users');
const getUsersCountStmt = db.prepare('SELECT COUNT(*) as count FROM users');
const setAdminStatusStmt = db.prepare('UPDATE users SET is_admin = ? WHERE id = ?');
const setAwaitingPinStmt = db.prepare('UPDATE users SET awaiting_pin = ? WHERE id = ?');

function registerUser(userId) {
    let user = getUserStmt.get(userId);
    if (!user) {
        // Если зашел OWNER_ID — даем админку сразу
        const initialAdmin = (userId === OWNER_ID) ? 1 : 0;
        createUserStmt.run(userId, Math.floor(Date.now() / 1000), initialAdmin);
        user = getUserStmt.get(userId);
    }
    return user;
}

// Генератор клавиатуры в зависимости от того, админ ли пользователь
function getMainMenuKeyboard(isAdmin) {
    const builder = Keyboard.builder().resize();

    builder.textButton({
        label: '📜 Помощь',
        payload: { command: 'помощь' },
        color: Keyboard.PRIMARY_COLOR
    }).textButton({
        label: '🤖 Инфо',
        payload: { command: 'инфо' },
        color: Keyboard.SECONDARY_COLOR
    }).row();

    if (isAdmin) {
        builder.textButton({
            label: '👑 Панель администратора',
            payload: { command: 'апанель' },
            color: Keyboard.POSITIVE_COLOR
        }).row().textButton({
            label: '🚪 Выйти из админки',
            payload: { command: 'выход' },
            color: Keyboard.NEGATIVE_COLOR
        });
    } else {
        builder.textButton({
            label: '🔑 Вход в айди',
            payload: { command: 'вход' },
            color: Keyboard.POSITIVE_COLOR
        });
    }

    return builder;
}

// ----------------------------------------------------
// ОБРАБОТКА СООБЩЕНИЙ
// ----------------------------------------------------
vk.updates.on('message_new', async (context) => {
    if (context.isOutbox) return;

    const userId = context.senderId;
    if (!userId || userId < 0) return; // Игнорируем группы

    const user = registerUser(userId);

    // Достаем текст из сообщения или из Payload кнопки
    let rawText = context.text || '';
    if (context.messagePayload && context.messagePayload.command) {
        rawText = context.messagePayload.command;
    }

    if (!rawText.trim()) return;

    const text = rawText.trim();
    const args = text.split(/\s+/);
    const command = args[0].toLowerCase();

    // Проверка прав: либо по ВК ID владельца, либо через введенный ПИН-код
    const isOwner = (userId === OWNER_ID || user.is_admin === 1);

    // ----------------------------------------------------
    // ПРОВЕРКА ВВОДА ПИН-КОДА
    // ----------------------------------------------------
    if (user.awaiting_pin === 1) {
        if (text === ADMIN_PIN) {
            setAdminStatusStmt.run(1, userId);
            setAwaitingPinStmt.run(0, userId);

            return context.send({
                message: '🔓 Доступ разрешен! Вход выполнен успешно.\nТеперь вам доступна Панель Администратора.',
                keyboard: getMainMenuKeyboard(true)
            });
        } else {
            setAwaitingPinStmt.run(0, userId);

            return context.send({
                message: '❌ Неверный ПИН-код! Доступ отклонен.',
                keyboard: getMainMenuKeyboard(false)
            });
        }
    }

    // ----------------------------------------------------
    // КОМАНДЫ АВТОРИЗАЦИИ И ВЫХОДА
    // ----------------------------------------------------

    if (command === 'вход' || command === 'логин' || command === 'вход в айди') {
        if (isOwner) {
            return context.send({
                message: '👑 Вы уже авторизованы как Администратор!',
                keyboard: getMainMenuKeyboard(true)
            });
        }

        setAwaitingPinStmt.run(1, userId);

        return context.send('🔑 Введите ПИН-код для получения прав администратора:');
    }

    if (command === 'выход' || command === 'выйти') {
        if (userId === OWNER_ID) {
            return context.send('⚠️ Владелец проекта по ID не может разжаловать самого себя.');
        }

        setAdminStatusStmt.run(0, userId);
        setAwaitingPinStmt.run(0, userId);

        return context.send({
            message: '🔒 Вы успешно вышли из панели администратора.',
            keyboard: getMainMenuKeyboard(false)
        });
    }

    // ----------------------------------------------------
    // КОМАНДЫ ДЛЯ ОБЫЧНЫХ ПОЛЬЗОВАТЕЛЕЙ
    // ----------------------------------------------------

    if (command === 'начать' || command === 'помощь' || command === 'команды' || command === 'start') {
        let msg = `👋 Привет! Я официальный бот сообщества.\n\n` +
                  `📜 Доступные команды:\n` +
                  `• Помощь — список команд\n` +
                  `• Инфо — информация о боте\n` +
                  `• Вход — авторизация администратора`;

        if (isOwner) {
            msg += `\n\n👑 Вы Владелец!\nНажмите кнопку «Панель администратора» или напишите Апанель.`;
        }

        return context.send({
            message: msg,
            keyboard: getMainMenuKeyboard(isOwner)
        });
    }

    if (command === 'инфо' || command === 'info') {
        return context.send({
            message: '🤖 Бот работает в штатном режиме 24/7!',
            keyboard: getMainMenuKeyboard(isOwner)
        });
    }

    // ----------------------------------------------------
    // КОМАНДЫ ТОЛЬКО ДЛЯ АДМИНИСТРАТОРОВ И ВЛАДЕЛЬЦА
    // ----------------------------------------------------

    if (command === 'апанель' || command === 'админ' || command === 'панель' || command === 'панель администратора') {
        if (!isOwner) {
            return context.send({
                message: '❌ У вас нет прав Владельца / Администратора.',
                keyboard: getMainMenuKeyboard(false)
            });
        }

        return context.send({
            message: `👑 Панель Владельца\n\n` +
                     `• Астата — статистика пользователей в базе\n` +
                     `• Сказать [ID] [Текст] — написать пользователю от лица бота\n` +
                     `• Рассылка [Текст] — сделать рассылку всем юзерам\n` +
                     `• Сервер — техническое состояние (память, аптайм)\n` +
                     `• Выход — выйти из режима администратора\n` +
                     `• Рестарт — перезапуск бота`,
            keyboard: getMainMenuKeyboard(true)
        });
    }

    // Статистика бота
    if (command === 'астата' || command === 'стата') {
        if (!isOwner) return;

        const count = getUsersCountStmt.get().count;
        return context.send(`📊 В базе бота зарегистрировано пользователей: ${count}`);
    }

    // Написать конкретному юзеру от лица сообщества
    if (command === 'сказать' || command === 'ответить') {
        if (!isOwner) return;

        const targetId = parseInt(args[1]);
        const messageText = args.slice(2).join(' ');

        if (!targetId || !messageText) {
            return context.send('⚠️ Использование: Сказать [VK ID] [Текст]');
        }

        try {
            await vk.api.messages.send({
                user_id: targetId,
                message: messageText,
                random_id: Math.floor(Math.random() * 1000000000)
            });
            return context.send(`✅ Сообщение отправлено пользователю id${targetId}`);
        } catch (error) {
            return context.send(`❌ Ошибка отправки: ${error.message}`);
        }
    }

    // Массовая рассылка всем юзерам из базы
    if (command === 'рассылка') {
        if (!isOwner) return;

        const broadcastText = args.slice(1).join(' ');
        if (!broadcastText) {
            return context.send('⚠️ Использование: Рассылка [Текст сообщения]');
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

    // Информация о сервере и памяти
    if (command === 'сервер') {
        if (!isOwner) return;

        const mem = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2);
        const uptime = Math.floor(process.uptime());

        return context.send(
            `🖥 Состояние сервера:\n` +
            `• ОЗУ: ${mem} MB\n` +
            `• Аптайм: ${uptime} сек.\n` +
            `• Node.js: ${process.version}`
        );
    }

    // Перезапуск процесса
    if (command === 'рестарт') {
        if (!isOwner) return;

        await context.send('🔄 Перезапускаю бота...');
        setTimeout(() => {
            process.exit(1);
        }, 1000);
    }
});

// Запуск бота
vk.updates.start()
    .then(() => console.log('🤖 Бот с системой ПИН-авторизации запущен!'))
    .catch(console.error);
