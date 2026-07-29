// Главная клавиатура под полем ввода (4 кнопки)
const mainKeyboard = {
    inline: false,
    one_time: false,
    buttons: [
        [
            { action: { type: 'text', label: '🛒 Каталог' }, color: 'positive' },
            { action: { type: 'text', label: '📜 Правила' }, color: 'primary' }
        ],
        [
            { action: { type: 'text', label: '🔑 Войти' }, color: 'secondary' },
            { action: { type: 'text', label: '💻 Команды' }, color: 'secondary' }
        ]
    ]
};
