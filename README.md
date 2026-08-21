# @declarium/crypto

Вход по сертификату и подпись документов в браузере: **Рутокен Плагин**,
**КриптоПро ЭЦП Browser plug-in** и **Контур.Плагин** за одним интерфейсом.

Закрытый ключ не покидает носитель. Сервер в подписи не участвует.

## Установка

```sh
pnpm add @declarium/crypto
```

## Использование

```ts
import { authenticate } from '@declarium/crypto'

const session = await authenticate({
  chooseCertificate: (list) => showDialog(list), // вернуть id выбранного
  requestPin: () => askPin(),                    // нужен только Рутокену
})

session.provider    // 'rutoken' | 'cryptopro' | 'kontur'
session.certificate // разобранный сертификат

const signature = await session.sign(bytes)            // CAdES-BES, открепленная
const verdict = await session.verify(signature, bytes) // { valid, reason? }
```

Средства опрашиваются по очереди — Рутокен, КриптоПро, Контур, — и работа идёт
с первым пригодным. Порядок задаётся: `authenticate({ order: ['kontur'], … })`.
Если не подошло ни одно, бросается `NoProviderError` с причиной по каждому.

Каждому средству нужны обе части: приложение и расширение браузера. Одного
расширения недостаточно.

## Лицензия

MIT
