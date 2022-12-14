import amqp, { Channel } from 'amqp-connection-manager';
import type amqplib from 'amqplib';
import axios from 'axios';
import rateLimit from 'axios-rate-limit';
import { ethSigner, starkSigner } from './signers';
import { RABBIT_URL, TRADING, MAX_REQUESTS, REQUESTS_DURATION_MS, RABBIT_PREFETCH } from './config';

const request = rateLimit(axios.create(), { maxRequests: MAX_REQUESTS, perMilliseconds: REQUESTS_DURATION_MS });
const connection = amqp.connect([RABBIT_URL]);

let isStopped = false;
let isCancelled = false;
let currentOrderIds: number[] = [];

connection.on('connectFailed', () => {
  process.stdout.write(` [Rabbit-client connection failed] `);
});
connection.on('connect', () => {
  process.stdout.write(` [Rabbit-client connected successfully] `);
});
connection.on('disconnect', () => {
  isStopped = true;
  setTimeout(async () => {
    isStopped = false;
  }, 10000);
  process.stdout.write(` [Rabbit-client disconnected] `);
});

const channelWrapper = connection.createChannel({
  json: true,
  setup: async (channel: Channel) => {
    await channel.prefetch(RABBIT_PREFETCH);
    return channel.assertQueue('buy-card', { durable: true });
  },
});

const channelCancel = connection.createChannel({
  json: true,
  setup: async (channel: Channel) => {
    await channel.prefetch(1);
    return channel.assertQueue('buy-cancel', { durable: true });
  },
});

channelWrapper.on('error', (err) => {
  process.stdout.write(` Rabbit-client channel error: ${err?.message} `);
  process.exit(0);
});

channelCancel.on('error', (err) => {
  process.stdout.write(` Rabbit-client channel error: ${err?.message} `);
  process.exit(0);
});

await channelCancel.consume('buy-cancel', async (msg: amqplib.ConsumeMessage) => {
  isCancelled = true;
  setTimeout(async () => {
    await channelCancel.ack(msg);
    isCancelled = false;
  }, 10000);
});

await channelWrapper.consume('buy-card', async (msg: amqplib.ConsumeMessage) => {
  let isBought = false;

  try {
    const data = JSON.parse(msg.content.toString());
    for (let i = 0; !isBought && !isStopped && !isCancelled && i < 100; i++) {
      const ordersResult = await request.get('https://api.x.immutable.com/v1/orders', { params: data.searchParams });
      if (i % 20 === 0) {
        process.stdout.write('.');
      }
      const orders = ordersResult?.data?.result || [];
      const filteredOrders = orders.filter(
        ({ order_id: id }: { order_id: number }) => !currentOrderIds.includes(id)
      );
      if (filteredOrders.length > 0) {
        const order = filteredOrders[Math.floor(Math.random() * filteredOrders.length)];
        currentOrderIds.push(order.order_id);

        process.stdout.write(` [name=${order.sell.data.properties.name} tokenId=${order.sell.data.token_id}] `);

        const signableResult = await axios.post('https://api.x.immutable.com/v3/signable-trade-details', {
          "order_id": order.order_id,
          "user": (await ethSigner.getAddress()).toLowerCase()
        }, {});

        const {
          signable_message: signableMessage,
          payload_hash: payloadHash,
          ...createTradeRequest
        } = signableResult.data;

        const ethSignature = await ethSigner.signMessage(signableMessage);
        const starkSignature = await starkSigner.signMessage(payloadHash);

        createTradeRequest.order_id = order.order_id;
        createTradeRequest.stark_signature = starkSignature;

        if (Number(createTradeRequest.amount_sell) + Number(createTradeRequest.fee_info.fee_limit) < data.priceLimit) {
          if (TRADING === 'ON') {
            const tradeResult = await axios.post('https://api.x.immutable.com/v1/trades', createTradeRequest, {
              headers: {
                'x-imx-eth-address': (await ethSigner.getAddress()).toLowerCase(),
                'x-imx-eth-signature': ethSignature,
              }
            });
            process.stdout.write(` [Token was bought: ${JSON.stringify(tradeResult.data)}] `);
          } else {
            process.stdout.write(` [Token is available to buy: ${JSON.stringify({
              price: createTradeRequest.amount_sell,
              fee: createTradeRequest.fee_info.fee_limit,
            })}] `);
          }

          isBought = true;
        }
      }
    }
  } catch (err: any) {
    process.stdout.write(` [${err?.message} ${JSON.stringify(err?.response?.data)}] `);
  }

  if (isCancelled || isBought) {
    await channelWrapper.ack(msg);
  } else {
    await channelWrapper.nack(msg);
  }
});