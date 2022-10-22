# Gods Unchained Trading Bot

This bot use ImmutableX api to trade Gods Unchained cards.

Use can use these sources to build your own bot or use this bot together 
with a developer, you can receive support at https://twitch.tv/kceoline

#### You need in following steps to start:

- install nodejs and git on your computer
- download sources to some folder
```
git clone https://github.com/kceoline/gu-trade-bot.git
cd gu-trade-bot
```
- install npm modules for a project and copy configuration
```
npm i
cp .env-example .env
```
- run command to create an encoded wallet
```
npm run wallet
```
- edit RABBIT_URL in `.env` file (ask developer for your own data) 
- run command to buy specific card (trading bot will receive commands 
from rabbitmq queue)
```
npm run buy-card
```
