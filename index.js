const { VK } = require('vk-io');
const Database = require('better-sqlite3');

// ----------------------------------------------------
// НАСТРОЙКИ
// ----------------------------------------------------
const VK_TOKEN = process.env.VK_TOKEN;
const OWNER_ID = 1021072434; // Твой VK ID (Владелец)

if (!VK_TOKEN) {
    console.error('Ошибка: Переменная VK_TOKEN не найдена!');
    process.exit(1);
}

const vk = new VK({
    token: VK_TOKEN
});

// Инициализация базы данных для рассылок и статистики
const db = new Database('database.db');
db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY,
        first_seen INTEGER
    )
`);

const getUserStmt = db.prepare('SELECT * FROM users WHERE id = ?');
const createUserStmt = db.prepare('INSERT INTO users (id, first_seen) VALUES (?, ?)');
const getAllUsersStmt = db.prepare('SELECT id FROM users');
const getUsersCountStmt = db.prepare('SELECT COUNT(*) as count FROM users');

function registerUser(userId) {
    let user = getUserStmt.get(userId);
    if (!user) {
        createUserStmt.run(userId, Math.floor(Date.now() / 1000));
    }
}

// ----------------------------------------------------
// ОБРАБОТКА СООБЩЕНИЙ
// ----------------------------------------------------
vk.updates.on('message_new', async (context) => {
    if (context.isOutbox || !context.text) return;

    const userId = context.senderId;
    if (userId < 0) return; // Игнорируем сообщества

    registerUser(userId);

    const isOwner = (userId === OWNER_ID);
    const text = context.text.trim();
    const args = text.split(/\s+/);
    const command = args[0].toLowerCase();

    // ----------------------------------------------------
    // КОМАНДЫ ДЛЯ ОБЫЧНЫХ ПОЛЬЗОВАТЕЛЕЙ
    // ----------------------------------------------------

    if (command === 'начать' || command === 'помощь' || command === 'команды') {
        let msg = `👋 Привет! Я официальный бот сообщества.\n\n` +
                  `📜 Доступные команды:\n` +
                  `• Помощь — список команд\n` +
                  `• Инфо — информация о боте`;

        if (isOwner) {
            msg += `\n\n👑 **Вы Владелец!**\nНапишите **Апанель**, чтобы открыть меню управления.`;
        }

        return context.send(msg);
    }

    if (command === 'инфо') {
        return context.send('🤖 Бот работает в штатном режиме 24/7!');
    }

    // ----------------------------------------------------
    // КОМАНДЫ ТОЛЬКО ДЛЯ ВЛАДЕЛЬЦА (OWNER)
    // ----------------------------------------------------

    if (command === 'апанель' || command === 'админ' || command === 'панель') {
        if (!isOwner) {
            return context.send('❌ У вас нет прав Владельца.');
        }

        return context.send(
            `👑 **Панель Владельца**\n\n` +
            `• **Астата** — статистика пользователей в базе\n` +
            `• **Сказать [ID] [Текст]** — написать пользователю от лица бота\n` +
            `• **Рассылка [Текст]** — сделать рассылку всем юзерам\n` +
            `• **Сервер** — техническое состояние (память, аптайм)\n` +
            `• **Рестарт** — перезапуск бота`
        );
    }

    // Статистика бота
    if (command === 'астата' || command === 'стата') {
        if (!isOwner) return;

        const count = getUsersCountStmt.get().count;
        return context.send(`📊 В базе бота зарегистрировано пользователей: **${count}**`);
    }

    // Написать конкретному юзеру от лица сообщества
    if (command === 'сказать' || command === 'ответить') {
        if (!isOwner) return;

        const targetId = parseInt(args[1]);
        const messageText = args.slice(2).join(' ');

        if (!targetId || !messageText) {
            return context.send('⚠️ Использование: `Сказать [VK ID] [Текст]`');
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
            return context.send('⚠️ Использование: `Рассылка [Текст сообщения]`');
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
            // Задержка, чтобы ВК не заблокировал за спам
            await new Promise(resolve => setTimeout(resolve, 50));
        }

        return context.send(`✅ **Рассылка завершена!**\nУспешно: ${success}\nОшибок: ${failed}`);
    }

    // Информация о сервере и памяти
    if (command === 'сервер') {
        if (!isOwner) return;

        const mem = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2);
        const uptime = Math.floor(process.uptime());

        return context.send(
            `🖥 **Состояние сервера:**\n` +
            `• ОЗУ: ${mem} MB\n` +
            `• Аптайм: ${uptime} сек.\n` +
            `• Node.js: ${process.version}`
        );
    }

    // Перезапуск процесса
    if (command === 'рестарт') {
        if (!isOwner) return;

        await context.send('🔄 Перезапускаю бота...');
        process.exit(0); // Amvera автоматически перезапустит упавший/завершенный процесс
    }
});

// Запуск бота
vk.updates.start()
    .then(() => console.log('🤖 Бот Владельца (ID: 1021072434) запущен!'))
    .catch(console.error);
