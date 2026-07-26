const { VK, Keyboard } = require('vk-io');
const Database = require('better-sqlite3');

const VK_TOKEN = process.env.VK_TOKEN;
const OWNER_ID = 1021072434;
const ADMIN_PIN = '5480';

if (!VK_TOKEN) {
    console.error('Ошибка: VK_TOKEN не найден!');
    process.exit(1);
}

const vk = new VK({ token: VK_TOKEN });

const db = new Database('database.db');
db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY,
        first_seen INTEGER,
        is_admin INTEGER DEFAULT 0,
        awaiting_pin INTEGER DEFAULT 0
    )
`);

const getUserStmt = db.prepare('SELECT * FROM users WHERE id = ?');
const createUserStmt = db.prepare('INSERT INTO users (id, first_seen, is_admin) VALUES (?, ?, ?)');
const setAdminStatusStmt = db.prepare('UPDATE users SET is_admin = ? WHERE id = ?');
const setAwaitingPinStmt = db.prepare('UPDATE users SET awaiting_pin = ? WHERE id = ?');

function registerUser(userId) {
    let user = getUserStmt.get(userId);
    if (!user) {
        const initialAdmin = (userId === OWNER_ID) ? 1 : 0;
        createUserStmt.run(userId, Math.floor(Date.now() / 1000), initialAdmin);
        user = getUserStmt.get(userId);
    }
    return user;
}

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

vk.updates.on('message_new', async (context) => {
    if (context.isOutbox) return;

    const userId = context.senderId;
    if (!userId || userId < 0) return;

    const user = registerUser(userId);

    let rawText = context.text || '';
    if (context.messagePayload && context.messagePayload.command) {
        rawText = context.messagePayload.command;
    }

    if (!rawText.trim()) return;

    const text = rawText.trim();
    const args = text.split(/\s+/);
    const command = args[0].toLowerCase();
    const isOwner = (userId === OWNER_ID || user.is_admin === 1);

    // Ввод ПИН-кода
    if (user.awaiting_pin === 1) {
        if (text === ADMIN_PIN) {
            setAdminStatusStmt.run(1, userId);
            setAwaitingPinStmt.run(0, userId);

            return context.send({
                message: '🔓 Доступ разрешен! Вход выполнен успешно.',
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

    // Авторизация
    if (command === 'вход' || command === '🔑 вход в айди') {
        if (isOwner) {
            return context.send({
                message: '👑 Вы уже авторизованы!',
                keyboard: getMainMenuKeyboard(true)
            });
        }

        setAwaitingPinStmt.run(1, userId);
        return context.send('🔑 Введите ПИН-код для входа:');
    }

    if (command === 'выход' || command === '🚪 выйти из админки') {
        if (userId === OWNER_ID) {
            return context.send('⚠️ Владелец по ID не может выйти.');
        }

        setAdminStatusStmt.run(0, userId);
        setAwaitingPinStmt.run(0, userId);

        return context.send({
            message: '🔒 Вы вышли из панели администратора.',
            keyboard: getMainMenuKeyboard(false)
        });
    }

    // Команды
    if (command === 'начать' || command === 'помощь' || command === '📜 помощь') {
        let msg = `👋 Привет!\n\n📜 Команды:\n• Помощь\n• Инфо\n• Вход`;

        if (isOwner) {
            msg += `\n\n👑 Вы Владелец!\nНажмите «Панель администратора».`;
        }

        return context.send({
            message: msg,
            keyboard: getMainMenuKeyboard(isOwner)
        });
    }

    if (command === 'инфо' || command === '🤖 инфо') {
        return context.send({
            message: '🤖 Бот работает в штатном режиме!',
            keyboard: getMainMenuKeyboard(isOwner)
        });
    }

    if (command === 'апанель' || command === '👑 панель администратора') {
        if (!isOwner) {
            return context.send({
                message: '❌ У вас нет доступа.',
                keyboard: getMainMenuKeyboard(false)
            });
        }

        return context.send({
            message: `👑 Панель Администратора\n\n• Астата — статистика\n• Сказать [ID] [Текст]\n• Рассылка [Текст]\n• Сервер\n• Выход`,
            keyboard: getMainMenuKeyboard(true)
        });
    }
});

vk.updates.start()
    .then(() => console.log('🤖 Бот запущен!'))
    .catch(console.error);
