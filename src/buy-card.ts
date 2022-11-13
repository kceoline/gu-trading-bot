import amqp, { Channel } from 'amqp-connection-manager';
import type amqplib from 'amqplib';
import axios from 'axios';
import rateLimit from 'axios-rate-limit';
import { ethSigner, starkSigner } from './signers';
import { RABBIT_URL, TRADING, MAX_REQUESTS, REQUESTS_DURATION_MS, RABBIT_PREFETCH } from './config';

const request = rateLimit(axios.create(), { maxRequests: MAX_REQUESTS, perMilliseconds: REQUESTS_DURATION_MS });
const connection = amqp.connect([RABBIT_URL]);

connection.on('connectFailed', () => {
  process.stdout.write(` [Rabbit-client connection failed] `);
  process.exit(0);
});
connection.on('connect', () => {
  process.stdout.write(` [Rabbit-client connected successfully] `);
});
connection.on('disconnect', () => {
  process.stdout.write(` [Rabbit-client disconnected] `);
  process.exit(0);
});

const channelWrapper = connection.createChannel({
  json: true,
  setup: async (channel: Channel) => {
    await channel.prefetch(RABBIT_PREFETCH);
    await channel.assertQueue('buy-card', { durable: true });
    await channel.assertQueue('buy-cancel', { durable: true });
  },
});
channelWrapper.on('error', (err) => {
  process.stdout.write(` Rabbit-client channel error: ${err?.message} `);
  process.exit(0);
});

let isCancelled = false;
let currentOrderIds: number[] = [];

await channelWrapper.consume('buy-cancel', async (msg: amqplib.ConsumeMessage) => {
  isCancelled = true;
  await channelWrapper.ack(msg);
});

await channelWrapper.consume('buy-card', async (msg: amqplib.ConsumeMessage) => {
  try {
    const data = JSON.parse(msg.content.toString());
    let isBought = false;
    while (!isBought && !isCancelled) {
      const ordersResult = await request.get('https://api.x.immutable.com/v1/orders', { params: data.searchParams });
      process.stdout.write('.');
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
          await channelWrapper.ack(msg);
        }
      }
    }
  } catch (err: any) {
    process.stdout.write(` [${err?.message} ${JSON.stringify(err?.response?.data)}] `);
  }

  if (isCancelled) {
    await channelWrapper.ack(msg);
  }
  isCancelled = false;
});