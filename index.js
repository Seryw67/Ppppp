const { VK } = require('vk-io');
const vk = new VK({ token: 'ВАШ_ТОКЕН' });

// ID чата админов или ID ВК админа, куда приходят заказы
const ADMIN_CHAT_ID = 2000000001; 

// Прайс-лист
const PRODUCTS = {
    'retail': { name: 'Розница (пакетики)', price: 1400, max: 100 },
    '50ml': { name: 'Бутылочка 50мл', price: 60000, max: 5 },
    '100ml': { name: 'Бутылка 100мл', price: 110000, max: 5 },
    '1l': { name: 'Бутылка 1 литр', price: 747000, max: 5 },
    '1l_500packs': { name: '1 литр (500 пакетиков)', price: 747000, max: 5 }, // Измени цену, если отличается
    'box_50': { name: 'Коробочка чая 50шт', price: 70000, max: 5 },          // Измени цену, если отличается
    'box_150': { name: 'Коробочка чая 150шт', price: 200000, max: 5 }        // Измени цену, если отличается
};

// Простая память для хранения шагов пользователей (User States)
const userSessions = {};

// 1. Клавиатура выбора товара
const buyTeaKeyboard = {
    inline: true,
    buttons: [
        [
            { action: { type: 'text', label: 'Розница (1400/шт)', payload: JSON.stringify({ item: 'retail' }) }, color: 'primary' },
            { action: { type: 'text', label: 'Бутылочка 50мл', payload: JSON.stringify({ item: '50ml' }) }, color: 'secondary' }
        ],
        [
            { action: { type: 'text', label: 'Бутылка 100мл', payload: JSON.stringify({ item: '100ml' }) }, color: 'secondary' },
            { action: { type: 'text', label: 'Бутылка 1 литр', payload: JSON.stringify({ item: '1l' }) }, color: 'secondary' }
        ],
        [
            { action: { type: 'text', label: '1л (500 пакетиков)', payload: JSON.stringify({ item: '1l_500packs' }) }, color: 'secondary' }
        ],
        [
            { action: { type: 'text', label: 'Коробочка 50шт', payload: JSON.stringify({ item: 'box_50' }) }, color: 'secondary' },
            { action: { type: 'text', label: 'Коробочка 150шт', payload: JSON.stringify({ item: 'box_150' }) }, color: 'secondary' }
        ],
        [
            { action: { type: 'text', label: '◀ Отмена', payload: JSON.stringify({ command: 'cancel' }) }, color: 'negative' }
        ]
    ]
};

// 2. Слушатель сообщений
vk.updates.on('message_new', async (context) => {
    const userId = context.senderId;
    const text = context.text ? context.text.trim() : '';
    let payload = {};

    try {
        if (context.messagePayload) {
            payload = JSON.parse(context.messagePayload);
        }
    } catch (e) {}

    // Если нажали "Купить чай" в главном меню
    if (text === 'Купить чай') {
        userSessions[userId] = { step: 'select_product' };
        return context.send({
            message: `☕ *Выберите товар из списка:*`,
            keyboard: JSON.stringify(buyTeaKeyboard)
        });
    }

    // Если на каком-то шаге нажали "Отмена"
    if (payload.command === 'cancel') {
        delete userSessions[userId];
        return context.send('❌ Заказ отменён.');
    }

    const session = userSessions[userId];
    if (!session) return;

    // ШАГ 1: Выбор товара
    if (payload.item && PRODUCTS[payload.item]) {
        const product = PRODUCTS[payload.item];
        session.productKey = payload.item;
        session.step = 'enter_count';

        return context.send(`Вы выбрали: *${product.name}*\n💰 Цена: ${product.price.toLocaleString()} ИВ за ед.\n\n✏️ Введите количество (от 1 до ${product.max}):`);
    }

    // ШАГ 2: Ввод количества
    if (session.step === 'enter_count') {
        const count = parseInt(text);
        const product = PRODUCTS[session.productKey];

        if (isNaN(count) || count < 1 || count > product.max) {
            return context.send(`⚠️ Некорректное количество! Введите число от 1 до ${product.max}.`);
        }

        session.count = count;
        session.totalPrice = count * product.price;
        session.step = 'enter_nickname';

        return context.send(`Принято: *${count} шт.* на сумму *${session.totalPrice.toLocaleString()} ИВ*.\n\n✏️ Теперь введите ваш игровой ник (например, Ivan_Ivanov):`);
    }

    // ШАГ 3: Ввод ника и оформление заказа
    if (session.step === 'enter_nickname') {
        const nickname = text;
        const product = PRODUCTS[session.productKey];
        const totalPrice = session.totalPrice;
        const count = session.count;

        // Отправка подтверждения пользователю
        await context.send(
`✅ *Ваш заказ успешно оформлен!*

📦 *Товар:* ${product.name}
🔢 *Количество:* ${count} шт.
👤 *Игровой ник:* ${nickname}
💵 *Итоговая сумма:* ${totalPrice.toLocaleString()} ИВ

Администрация свяжется с вами в ближайшее время!`
        );

        // Отправка уведомления администраторам
        await vk.api.messages.send({
            peer_id: ADMIN_CHAT_ID,
            message: 
`📥 *НОВЫЙ ЗАКАЗ ЧАЯ!*

👤 *Пользователь VK:* [id${userId}|Кликни сюда] (ID: ${userId})
🎮 *Ник в игре:* ${nickname}
📦 *Заказано:* ${product.name} (${count} шт.)
💰 *Общая цена:* ${totalPrice.toLocaleString()} ИВ`,
            random_id: 0
        });

        // Очищаем сессию
        delete userSessions[userId];
    }
});

vk.updates.start().then(() => console.log('Бот успешно запущен!'));
