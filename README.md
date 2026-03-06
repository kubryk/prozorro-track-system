# Prozorro Track System

Система для відстеження та завантаження тендерів та контрактів з публічного API Prozorro. Побудована з використанням NestJS, PostgreSQL (Prisma ORM) та BullMQ.

## 🛠 Технології
- **Фреймворк:** NestJS
- **База даних:** PostgreSQL + Prisma
- **Черги та фонові задачі:** BullMQ
- **Документація API:** Swagger (`/api/docs` або `/api`)

## 🚀 Швидкий старт

1. **Встановіть залежності:**
   ```bash
   npm install
   ```

2. **Налаштуйте середовище:**
   Створіть файл `.env` на основі `.env.example` та впишіть свої доступи до БД:
   ```bash
   cp .env.example .env
   ```

3. **Запустіть міграції БД:**
   ```bash
   npx prisma migrate dev
   ```

4. **Запустіть проєкт:**
   ```bash
   npm run start:dev
   ```

## 🗄 Керування даними (Prisma Studio)
Щоб швидко переглянути вміст таблиць через зручний вебінтерфейс:
```bash
npm run studio
```
