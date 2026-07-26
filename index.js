const { VK, Keyboard } = require('vk-io');

// Токен берется из переменных окружения (Environment Variables) на Render
const vk = new VK({
    token: process.env.VK_TOKEN
});

// Ваш ID ВКонтакте для получения уведомлений
const ADMIN_ID = 1021072434;

// Цена за 1 пакетик чая
const TEA_PRICE = 1400;

// Хранилище временного состояния пользователей
const userState = new Map();

// Главное меню с кнопками
const mainMenuKeyboard = Keyboard.builder()
    .textButton({
        label: '🍵 Купить чай',
        payload: { command: 'buy_tea' },
        color: Keyboard.POSITIVE_COLOR
    })
    .textButton({
        label: '⭐ Купить подписку',
        payload: { command: 'buy_sub' },
        color: Keyboard.PRIMARY_COLOR
    })
    .oneTime(false);

vk.updates.on('message_new', async (context) => {
    const userId = context.senderId;
    const text = context.text ? context.text.trim() : '';
    const payload = context.messagePayload;

    // Старт или сброс к главному меню
    if (text.toLowerCase() === 'начать' || text.toLowerCase() === 'start' || text.toLowerCase() === '/start') {
        userState.delete(userId);
        return context.send('Выберите действие:', {
            keyboard: mainMenuKeyboard
        });
    }

    // 1. Обработка нажатий на кнопки
    if (payload) {
        switch (payload.command) {
            case 'buy_tea':
                userState.set(userId, { step: 'awaiting_buy_tea_amount' });
                return context.send('Сколько вы хотите купить чая? (Введите число от 1 до 150)');

            case 'buy_sub':
                userState.set(userId, { step: 'awaiting_sub_days' });
                return context.send('На сколько дней вы хотите купить подписку?');
        }
    }

    // 2. Обработка ответов пользователя в зависимости от состояния
    const state = userState.get(userId);

    if (state) {
        // Покупка чая
        if (state.step === 'awaiting_buy_tea_amount') {
            const amount = parseInt(text, 10);
            if (isNaN(amount) || amount < 1 || amount > 150) {
                return context.send('Пожалуйста, введите корректное число от 1 до 150.');
            }

            userState.delete(userId);

            // Отправка ответа пользователю
            await context.send(
                `Отлично! Вы заказали ${amount} пакет(-ов, -иков) чая! На данный момент 1 пакетик стоит ${TEA_PRICE}! Сумма и вердикт будет вынесен позже.`,
                { keyboard: mainMenuKeyboard }
            );

            // Отправка уведомления админу в ЛС
            try {
                await vk.api.messages.send({
                    user_id: ADMIN_ID,
                    message: `🛒 **Новый заказ на покупку чая!**\n\nОт пользователя: vk.com/id${userId}\nКоличество: ${amount} шт.\nПредварительная стоимость: ${amount * TEA_PRICE} руб.`,
                    random_id: Math.floor(Math.random() * 1000000)
                });
            } catch (error) {
                console.error('Ошибка при отправке сообщения админу:', error);
            }
            return;
        }

        // Покупка подписки
        if (state.step === 'awaiting_sub_days') {
            const days = parseInt(text, 10);
            if (isNaN(days) || days <= 0) {
                return context.send('Пожалуйста, укажите количество дней числом (больше 0).');
            }

            userState.delete(userId);

            await context.send(`Заявка на подписку на ${days} дн. принята!`, {
                keyboard: mainMenuKeyboard
            });

            // Уведомление админу в ЛС
            try {
                await vk.api.messages.send({
                    user_id: ADMIN_ID,
                    message: `⭐ **Заявка на подписку!**\n\nОт пользователя: vk.com/id${userId}\nСрок: ${days} дн.`,
                    random_id: Math.floor(Math.random() * 1000000)
                });
            } catch (error) {
                console.error('Ошибка при отправке сообщения админу:', error);
            }
            return;
        }
    }
});

vk.updates.start()
    .then(() => console.log('Бот успешно запущен!'))
    .catch(console.error);